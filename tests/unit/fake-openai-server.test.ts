import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeModelsJson, startFakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

type Fake = Awaited<ReturnType<typeof startFakeOpenAIServer>>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(turns: ScriptedTurn[]): Promise<Fake> {
  const s = await startFakeOpenAIServer(turns);
  cleanups.push(() => s.close());
  return s;
}

const post = (s: Fake, body: unknown = { messages: [] }, signal?: AbortSignal) =>
  fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

interface Chunk {
  choices: Array<{ delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }>;
  usage?: unknown;
}

/** 极简 SSE 读取：按 OpenAI 客户端方式解析 data: 行，返回所有 JSON 块和是否见到 [DONE]。 */
async function readSse(res: Response): Promise<{ chunks: Chunk[]; done: boolean }> {
  const text = await res.text();
  const chunks: Chunk[] = [];
  let done = false;
  for (const block of text.split("\n\n")) {
    if (!block.startsWith("data: ")) continue;
    const data = block.slice(6);
    if (data === "[DONE]") done = true;
    else chunks.push(JSON.parse(data));
  }
  return { chunks, done };
}

describe("fake OpenAI server", () => {
  it("重组分块文本，以 stop 结束，usage 块在 [DONE] 之前", async () => {
    const s = await start([{ kind: "text", chunks: ["pel", "i", "can"], chunkDelayMs: 5 }]);
    const res = await post(s);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { chunks, done } = await readSse(res);
    expect(done).toBe(true);
    expect(chunks.flatMap((c) => c.choices.map((x) => x.delta.content ?? "")).join("")).toBe("pelican");
    const finish = chunks.filter((c) => c.choices[0]?.finish_reason);
    expect(finish.map((c) => c.choices[0].finish_reason)).toEqual(["stop"]);
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).toBeTruthy();
    expect(s.errors).toEqual([]);
  });

  it("分段工具调用：首块带 id/name，续块 id 为空串，参数重组为原 JSON", async () => {
    const args = { path: "hello.txt", extra: "x".repeat(40) };
    const s = await start([{ kind: "toolCall", name: "read", args, id: "call_1" }]);
    const { chunks } = await readSse(await post(s));
    const calls = chunks.flatMap((c) => c.choices.flatMap((x) => x.delta.tool_calls ?? []));
    expect(calls.length).toBeGreaterThan(2);
    expect(calls[0]).toMatchObject({ index: 0, id: "call_1", function: { name: "read", arguments: "" } });
    expect(calls.slice(1).every((c) => c.id === "")).toBe(true);
    expect(JSON.parse(calls.map((c) => c.function?.arguments ?? "").join(""))).toEqual(args);
    expect(chunks.filter((c) => c.choices[0]?.finish_reason).map((c) => c.choices[0].finish_reason)).toEqual(["tool_calls"]);
    expect(s.errors).toEqual([]);
  });

  it("一次给全的工具调用（Ollama 形状）只有一个工具块", async () => {
    const s = await start([{ kind: "toolCall", name: "read", args: { path: "a" }, style: "whole" }]);
    const { chunks } = await readSse(await post(s));
    const calls = chunks.flatMap((c) => c.choices.flatMap((x) => x.delta.tool_calls ?? []));
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBeTruthy();
    expect(JSON.parse(calls[0].function!.arguments!)).toEqual({ path: "a" });
    expect(s.errors).toEqual([]);
  });

  it("HTTP 错误：返回脚本指定的状态码与 JSON 体，且不算服务端 errors", async () => {
    const s = await start([{ kind: "error", status: 429, body: { error: { message: "slow down" } } }]);
    const res = await post(s);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "slow down" } });
    expect(s.requests).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  it("按到达顺序记录请求体，每次请求消耗一条脚本", async () => {
    const s = await start([
      { kind: "text", chunks: ["one"] },
      { kind: "text", chunks: ["two"] },
    ]);
    await (await post(s, { n: 1 })).text();
    const second = await readSse(await post(s, { n: 2 }));
    expect(s.requests).toEqual([{ n: 1 }, { n: 2 }]);
    expect(second.chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("two");
    expect(s.errors).toEqual([]);
  });

  it("脚本耗尽：返回非 200 并写入 errors，不复用最后一条", async () => {
    const s = await start([{ kind: "text", chunks: ["only"] }]);
    await (await post(s)).text();
    const res = await post(s);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("only");
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toMatch(/exhaust|耗尽/i);
    s.errors.length = 0; // 预期内的错误，已断言
  });

  it("断线清理：客户端中途断开后服务端停止写入，处理函数在脚本结束前退出（close 之前观察）", async () => {
    const s = await start([{ kind: "text", chunks: Array.from({ length: 50 }, () => "x"), chunkDelayMs: 100 }]); // 脚本全长约 5s
    const ac = new AbortController();
    const res = await post(s, { messages: [] }, ac.signal);
    const reader = res.body!.getReader();
    await reader.read(); // 收到至少一块后断开
    ac.abort();
    await reader.read().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150)); // 留出服务端发现断线的时间
    const writesAfterAbort = s.stats.writes;
    await new Promise((r) => setTimeout(r, 400)); // 若仍在写，每 100ms 一块，这里至少多 3 块
    expect(s.stats.writes).toBe(writesAfterAbort);
    expect(writesAfterAbort).toBeLessThan(10);
    expect(s.stats.inFlight).toBe(0);
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.errors).toEqual([]);
  });

  it("意外请求（其它方法或路径）返回 404 并写入 errors", async () => {
    const s = await start([]);
    const res = await fetch(`${s.baseUrl}/models`);
    expect(res.status).toBe(404);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("/models");
    expect(s.requests).toEqual([]);
    s.errors.length = 0; // 预期内的错误，已断言
  });

  it("fakeModelsJson 生成 provider fake / model fake-model", () => {
    const m = fakeModelsJson("http://127.0.0.1:1/v1") as any;
    expect(m.providers.fake).toMatchObject({ baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" });
    expect(m.providers.fake.apiKey).not.toMatch(/^[$!]/);
    expect(m.providers.fake.models.map((x: any) => x.id)).toEqual(["fake-model"]);
  });

  it("真实 pi 1.5.1 经 SDK 用 fakeModelsJson 完成一轮文本对话", async () => {
    const s = await start([{ kind: "text", chunks: ["pel", "ican"] }]);
    const dir = mkdtempSync(join(tmpdir(), "fp-fake-pi-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "work");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(fakeModelsJson(s.baseUrl)));

    const pi: any = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    const model = modelRuntime.getModel("fake", "fake-model");
    expect(model).toBeTruthy();
    const settingsManager = pi.SettingsManager.inMemory({}, { projectTrusted: false });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: [],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    const { session } = await pi.createAgentSession({
      cwd, agentDir, modelRuntime, model, resourceLoader, settingsManager,
      sessionManager: pi.SessionManager.inMemory(cwd), tools: [],
    });
    let text = "";
    session.subscribe((e: any) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
    });
    await session.prompt("say the word");
    session.dispose?.();
    expect(text).toBe("pelican");
    expect(s.requests).toHaveLength(1);
    expect((s.requests[0] as any).model).toBe("fake-model");
    expect(s.errors).toEqual([]);
  });
});
