import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// T2 计划 Task 7：评测模型代理（D1）。代理作为子进程运行，上游是本文件内的假服务，记录收到的请求。
const PROXY = join(import.meta.dirname, "../../eval/runtime/model-proxy.mjs");
const KEY = "sk-test-proxy-secret-7f3a";

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: string }
type Handler = (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function upstream(handler: Handler) {
  const seen: Seen[] = [];
  const closed: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.on("close", () => closed.push(req.url!));
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, closed };
}

async function proxy(routes: unknown, env: Record<string, string> = { DASHSCOPE_API_KEY: KEY }) {
  const child: ChildProcess = spawn(process.execPath, [PROXY], {
    env: { PATH: process.env.PATH, FP_PROXY_PORT: "0", FP_PROXY_ROUTES: JSON.stringify(routes), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (c) => (out += c));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const port = await new Promise<number | null>((resolve) => {
    child.stderr!.on("data", (c) => {
      err += c;
      const m = /model-proxy listening on (\d+)/.exec(err);
      if (m) resolve(Number(m[1]));
    });
    void exited.then(() => resolve(null));
  });
  cleanups.push(async () => { child.kill("SIGKILL"); await exited; });
  return { url: port === null ? "" : `http://127.0.0.1:${port}`, logs: () => out, stderr: () => err, exited };
}

const routesFor = (base: string) => ({ qwen: { base, keyEnv: "DASHSCOPE_API_KEY", model: "qwen3.6-35b-a3b" } });
const logLines = (s: string) => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const okJson: Handler = (_req, _body, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("model-proxy", () => {
  it("转发到 base/chat/completions：改写 model、删联网搜索参数、只留 function 工具、替换 authorization", async () => {
    const up = await upstream(okJson);
    const p = await proxy(routesFor(up.base));
    const res = await post(`${p.url}/qwen/chat/completions`, {
      model: "whatever",
      stream: true,
      temperature: 0.6,
      top_p: 0.95,
      enable_thinking: true,
      enable_search: true,
      search_options: { forced_search: true },
      web_search: { enable: true },
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "web_search" },
        { type: "function", function: { name: "bash" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(up.seen).toHaveLength(1);
    const s = up.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/v1/chat/completions");
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(s.body);
    expect(body).toEqual({
      model: "qwen3.6-35b-a3b",
      stream: true,
      temperature: 0.6,
      top_p: 0.95,
      enable_thinking: true,
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "bash" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("工具全是非 function 时删除 tools 字段", async () => {
    const up = await upstream(okJson);
    const p = await proxy(routesFor(up.base));
    await post(`${p.url}/qwen/chat/completions`, { model: "x", tools: [{ type: "web_search" }], messages: [] });
    expect(JSON.parse(up.seen[0]!.body)).not.toHaveProperty("tools");
  });

  it("其他路径、未知路由、GET 一律 404，不访问上游", async () => {
    const up = await upstream(okJson);
    const p = await proxy(routesFor(up.base));
    expect((await post(`${p.url}/qwen/completions`, {})).status).toBe(404);
    expect((await post(`${p.url}/qwen/models`, {})).status).toBe(404);
    expect((await post(`${p.url}/other/chat/completions`, {})).status).toBe(404);
    expect((await post(`${p.url}/qwen/chat/completions/x`, {})).status).toBe(404);
    expect((await fetch(`${p.url}/qwen/chat/completions`)).status).toBe(404);
    expect(up.seen).toHaveLength(0);
  });

  it("上游 429 原样回传（状态、retry-after、正文）", async () => {
    const up = await upstream((_q, _b, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end('{"error":{"code":"Throttling"}}');
    });
    const p = await proxy(routesFor(up.base));
    const res = await post(`${p.url}/qwen/chat/completions`, { messages: [] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.text()).toBe('{"error":{"code":"Throttling"}}');
  });

  it("上游重定向不跟随：3xx 原样回给客户端，请求体不发到别的主机", async () => {
    const other = await upstream(okJson);
    const up = await upstream((_q, _b, res) => {
      res.writeHead(307, { location: `${other.base}/chat/completions` });
      res.end();
    });
    const p = await proxy(routesFor(up.base));
    const res = await fetch(`${p.url}/qwen/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(up.seen).toHaveLength(1);
    expect(other.seen).toHaveLength(0);
    await expect.poll(() => logLines(p.logs()).at(-1)?.status).toBe(307);
  });

  it("SSE 不缓冲：上游每发一块，客户端在下一块之前就收到", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const up = await upstream(async (_q, _b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      await gate;
      res.write("data: 2\n\n");
      res.end("data: [DONE]\n\n");
    });
    const p = await proxy(routesFor(up.base));
    const res = await post(`${p.url}/qwen/chat/completions`, { stream: true, messages: [] });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toBe("data: 1\n\n"); // 第二块还被上游扣着，说明是逐块转发
    release();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += dec.decode(r.value);
    expect(rest).toBe("data: 2\n\ndata: [DONE]\n\n");
  });

  it("客户端中途断开：代理中止上游请求", async () => {
    const up = await upstream((_q, _b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n"); // 之后不再发送，也不结束
    });
    const p = await proxy(routesFor(up.base));
    const ac = new AbortController();
    const res = await fetch(`${p.url}/qwen/chat/completions`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: ac.signal,
    });
    await res.body!.getReader().read();
    ac.abort();
    await expect.poll(() => up.closed.length, { timeout: 3000 }).toBe(1);
  });

  it("上游连不上返回 502；请求体不是 JSON 对象返回 400 且不访问上游", async () => {
    const p = await proxy(routesFor("http://127.0.0.1:1/v1"));
    expect((await post(`${p.url}/qwen/chat/completions`, { messages: [] })).status).toBe(502);
    const up = await upstream(okJson);
    const p2 = await proxy(routesFor(up.base));
    expect((await post(`${p2.url}/qwen/chat/completions`, "not json")).status).toBe(400);
    expect((await post(`${p2.url}/qwen/chat/completions`, "[1]")).status).toBe(400);
    expect(up.seen).toHaveLength(0);
  });

  it("每个请求一行 JSON 日志：route、status、已排序的顶层字段名、出现的采样参数；不含请求内容与 key", async () => {
    const up = await upstream((_q, _b, res) => { res.writeHead(429); res.end(); });
    const p = await proxy(routesFor(up.base));
    await post(`${p.url}/qwen/chat/completions`, {
      model: "m", temperature: 0.6, max_tokens: 100, enable_thinking: true, enable_search: true,
      messages: [{ role: "user", content: "SECRET-PROMPT-TEXT" }],
    });
    await post(`${p.url}/nope/chat/completions`, {});
    await expect.poll(() => logLines(p.logs()).length).toBe(2);
    const [a, b] = logLines(p.logs());
    expect(a).toEqual({
      route: "qwen",
      status: 429,
      fields: ["enable_search", "enable_thinking", "max_tokens", "messages", "model", "temperature"],
      sampling: { temperature: 0.6, max_tokens: 100, enable_thinking: true },
    });
    expect(b).toMatchObject({ route: null, status: 404 });
    const all = p.logs() + p.stderr();
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("SECRET-PROMPT-TEXT");
    expect(all).not.toContain("client-token");
  });

  it("路由带 params 时覆盖请求体的 temperature、top_p，日志记覆盖后的值；不带 params 的路由保持原样", async () => {
    const up = await upstream(okJson);
    const p = await proxy({
      qwen: { base: up.base, keyEnv: "DASHSCOPE_API_KEY", model: "m", params: { temperature: 1.0, top_p: 0.95 } },
      plain: { base: up.base, keyEnv: "DASHSCOPE_API_KEY", model: "m" },
    });
    await post(`${p.url}/qwen/chat/completions`, { model: "x", temperature: 0.6, max_tokens: 10, messages: [] });
    await post(`${p.url}/plain/chat/completions`, { model: "x", temperature: 0.6, messages: [] });
    expect(JSON.parse(up.seen[0]!.body)).toEqual({ model: "m", temperature: 1.0, top_p: 0.95, max_tokens: 10, messages: [] });
    expect(JSON.parse(up.seen[1]!.body)).toEqual({ model: "m", temperature: 0.6, messages: [] });
    await expect.poll(() => logLines(p.logs()).length).toBe(2);
    const [a, b] = logLines(p.logs());
    expect(a.sampling).toEqual({ temperature: 1.0, top_p: 0.95, max_tokens: 10 });
    expect(b.sampling).toEqual({ temperature: 0.6 });
  });

  it("params 不是对象或含 temperature、top_p 以外的字段：启动失败，退出码 2", async () => {
    const route = (params: unknown) => ({ qwen: { base: "http://x/v1", keyEnv: "DASHSCOPE_API_KEY", model: "m", params } });
    expect(await (await proxy(route("hot"))).exited).toBe(2);
    expect(await (await proxy(route({ temperature: 1, model: "evil" }))).exited).toBe(2);
  });

  it("路由的 key 环境变量缺失或配置不是对象：启动失败，退出码 2，不写出 key", async () => {
    const p = await proxy({ qwen: { base: "http://x/v1", keyEnv: "MISSING_KEY", model: "m" } }, {});
    expect(await p.exited).toBe(2);
    expect(p.stderr()).toContain("MISSING_KEY");
    const p2 = await proxy("not-an-object");
    expect(await p2.exited).toBe(2);
  });
});
