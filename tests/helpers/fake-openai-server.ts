import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 一条脚本对应一次 POST /chat/completions，按到达顺序消耗，耗尽后报错而不是复用。 */
export type ScriptedTurn =
  | { kind: "text"; chunks: string[]; chunkDelayMs?: number }
  /** 发出文本块后直接销毁连接：没有 finish 块、usage 和 [DONE]，用于“说到一半断开”（0B.2 stream-drop） */
  | { kind: "drop"; chunks: string[]; chunkDelayMs?: number }
  | {
      kind: "toolCall";
      name: string;
      args: unknown;
      id?: string;
      /** split：百炼形状，首块带 id/name，续块 id 为 ""；whole：Ollama 形状，一次给全 */
      style?: "split" | "whole";
      chunkDelayMs?: number;
    }
  | { kind: "error"; status: number; body?: unknown };

export interface FakeOpenAIServer {
  baseUrl: string;
  requests: unknown[];
  errors: string[];
  /** 观测用：writes 为已写出的 SSE 块数，inFlight 为尚未结束的 POST 处理函数数 */
  stats: { writes: number; inFlight: number };
  close(): Promise<void>;
}

const FRAGMENTS = 8; // 与 0C.4 观测到的百炼切分段数一致

export async function startFakeOpenAIServer(turns: ScriptedTurn[]): Promise<FakeOpenAIServer> {
  const requests: unknown[] = [];
  const errors: string[] = [];
  const stats = { writes: 0, inFlight: 0 };
  const closing = new AbortController(); // close() 时唤醒所有等待中的延迟
  let next = 0;

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((done) => {
      if (!ms || signal.aborted) return done();
      const t = setTimeout(done, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
    });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const aborted = new AbortController(); // 客户端断线或服务关闭
    res.on("close", () => aborted.abort());
    closing.signal.addEventListener("abort", () => aborted.abort(), { once: true });

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      stats.inFlight++;
      try {
        if (req.method !== "POST" || !req.url?.split("?")[0].endsWith("/chat/completions")) {
          const msg = `unexpected request: ${req.method} ${req.url}`;
          errors.push(msg);
          return sendJson(res, 404, { error: { message: msg } });
        }
        requests.push(JSON.parse(raw));
        const turn = turns[next++];
        if (!turn) {
          const msg = `script exhausted: request #${next} has no scripted turn (耗尽)`;
          errors.push(msg);
          return sendJson(res, 500, { error: { message: msg } });
        }
        if (turn.kind === "error") return sendJson(res, turn.status, turn.body ?? { error: { message: "scripted error" } });
        await stream(res, turn, aborted.signal);
      } catch (e) {
        errors.push(`handler failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) sendJson(res, 500, { error: { message: "fake server failure" } });
        else res.destroy();
      } finally {
        stats.inFlight--;
      }
    });
  });

  async function stream(res: ServerResponse, turn: Exclude<ScriptedTurn, { kind: "error" }>, signal: AbortSignal) {
    const id = `chatcmpl-fake-${next}`;
    const base = { id, object: "chat.completion.chunk", created: 0, model: "fake-model", system_fingerprint: null };
    const choice = (delta: object, finish: string | null = null) => ({ ...base, usage: null, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (o: unknown) => !signal.aborted && (stats.writes++, res.write(`data: ${JSON.stringify(o)}\n\n`));
    const delay = turn.chunkDelayMs ?? 0;

    let finish: string;
    if (turn.kind === "text" || turn.kind === "drop") {
      finish = "stop";
      for (const [i, c] of turn.chunks.entries()) {
        if (i) await sleep(delay, signal);
        send(choice(i ? { content: c } : { role: "assistant", content: c }));
      }
      // 空写的回调在前面的块交出后才触发；直接 destroy 会丢掉 cork 缓冲里的块
      if (turn.kind === "drop") return void res.write("", () => res.destroy());
    } else {
      finish = "tool_calls";
      const id0 = turn.id ?? "call_fake_0";
      const json = JSON.stringify(turn.args);
      const call = (id: string, fn: object) => ({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: fn }] });
      if (turn.style === "whole") {
        send(choice(call(id0, { name: turn.name, arguments: json })));
      } else {
        send(choice(call(id0, { name: turn.name, arguments: "" })));
        const size = Math.max(1, Math.ceil(json.length / FRAGMENTS));
        for (let i = 0; i < json.length; i += size) {
          await sleep(delay, signal);
          send(choice({ tool_calls: [{ index: 0, id: "", type: "function", function: { arguments: json.slice(i, i + size) } }] }));
        }
      }
    }
    send(choice({ content: "" }, finish));
    send({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    if (!signal.aborted) res.write("data: [DONE]\n\n");
    res.end();
  }

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    errors,
    stats,
    close: () =>
      new Promise<void>((ok) => {
        closing.abort();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

/** 有效的 pi 1.5.1 models.json。compat 全关：不发 store/developer 角色/reasoning_effort，请求体最简单。 */
export function fakeModelsJson(baseUrl: string): object {
  return {
    providers: {
      fake: {
        baseUrl,
        api: "openai-completions",
        apiKey: "fake-key",
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
      },
    },
  };
}
