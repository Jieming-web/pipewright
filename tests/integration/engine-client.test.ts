import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as WsSocket, WebSocketServer as WsServer } from "ws";
import { EngineClient } from "../../packages/engine-client/src/index.js";
import type { ProtocolError, SequencedEvent, StartTask } from "../../packages/engine-protocol/src/index.js";
import { startRunnerServer } from "../../packages/engine-runner/src/runner-server.js";
import { fakeModelsJson, startFakeOpenAIServer, TOOL, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 根包不依赖 ws：桩服务端借用 engine-client 包的 ws
const { WebSocketServer } = createRequire(join(import.meta.dirname, "../../packages/engine-client/package.json"))("ws") as typeof import("ws");

type Runner = Awaited<ReturnType<typeof startRunnerServer>>;
let root: string;
let servers: FakeOpenAIServer[];
let runners: Runner[];
let clients: EngineClient[];
let stubs: WsServer[];
const p = (...s: string[]) => join(root, ...s);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-ec-")));
  for (const d of ["model", "work", "sessions"]) mkdirSync(p(d));
  servers = [];
  runners = [];
  clients = [];
  stubs = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(runners.map((r) => r.close()));
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(stubs.map((w) => new Promise((r) => { for (const c of w.clients) c.terminate(); w.close(r); })));
  rmSync(root, { recursive: true, force: true });
});

async function setup(turns: ScriptedTurn[], o: Partial<Parameters<typeof startRunnerServer>[0]> = {}) {
  const s = await startFakeOpenAIServer(turns);
  servers.push(s);
  writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(s.baseUrl)));
  const runner = await startRunnerServer({ port: 0, modelsPath: p("model/models.json"), workDir: p("work"), sessionsRoot: p("sessions"), idleTimeoutMs: 5000, ...o });
  runners.push(runner);
  const client = await EngineClient.connect(`ws://127.0.0.1:${runner.port}`);
  clients.push(client);
  const events: SequencedEvent[] = [];
  const errors: ProtocolError[] = [];
  client.onEvent((e) => events.push(e));
  client.onError((e) => errors.push(e));
  return { s, runner, client, events, errors };
}

/** 行为不规范的服务端：收到消息时由 onMessage 决定怎么回 */
async function stub(onMessage: (m: { type: string; requestId: string }, ws: WsSocket) => void) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  stubs.push(wss);
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (ws) => ws.on("message", (d) => onMessage(JSON.parse(String(d)), ws)));
  const client = await EngineClient.connect(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  clients.push(client);
  return client;
}

const task = (o: Partial<StartTask> = {}): Omit<StartTask, "type" | "requestId"> => ({
  sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" }, contextFiles: [], interceptMode: "callback", ...o,
});
const lastReq = (s: FakeOpenAIServer) => JSON.stringify(s.requests.at(-1));
const types = (ev: SequencedEvent[]) => ev.map((e) => e.type);

describe.sequential("engine-client：启动与终止", () => {
  it("文本/终止：start 在 accepted 后 resolve，事件经 onEvent 送达，waitForEnd 返回 run.settled；随后的正常关闭不覆盖结果，重复调用得到缓存结果", async () => {
    const { runner, client, events, errors } = await setup([{ kind: "text", chunks: ["Hel", "lo"] }]);
    await client.start(task());
    const end = await client.waitForEnd();
    expect(end).toMatchObject({ type: "run.settled", sessionId: "s1" });
    expect(types(events)).toEqual(["run.started", "text.delta", "text.delta", "message.completed", "run.settled"]);
    expect(events.at(-1)).toBe(end);
    expect(await runner.done).toEqual({ ok: true });
    await client.close(); // 确保客户端已处理完 close 事件
    expect(await client.waitForEnd()).toBe(end);
    expect(errors).toEqual([]);
  }, 10_000);

  it("accepted 后第一个事件就是 run.failed（没有 run.started）：waitForEnd 正常返回该终止事件", async () => {
    const { client, events } = await setup([]);
    await client.start(task({ model: { provider: "fake", id: "nope" } }));
    const end = await client.waitForEnd();
    expect(end).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/nope/) });
    expect(types(events)).toEqual(["run.failed"]);
  }, 10_000);

  it("启动拒绝不挂起：初次启动被拒（not_implemented / 本地校验失败）时 start 与 waitForEnd 都 reject，不进 onError；修正后可在同一连接重试", async () => {
    const { s, client, errors } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const waiting = client.waitForEnd();
    await expect(client.start(task({ interceptMode: "policy" }))).rejects.toThrow(/not_implemented/);
    await expect(waiting).rejects.toThrow(/not_implemented/);
    await expect(client.start(task({ prompt: " " }))).rejects.toThrow(/prompt/);
    await expect(client.waitForEnd()).rejects.toThrow(/prompt/);
    expect(errors).toEqual([]);
    expect(s.requests.length).toBe(0);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
  }, 10_000);

  it("运行中第二次 start 被拒绝：只 reject 第二次 start，原有等待不受影响", async () => {
    const { client, errors } = await setup(TOOL("echo hi > ok.marker"));
    let second: Promise<unknown> | undefined;
    client.onIntercept(async () => {
      second = client.start(task({ sessionId: "s2" })).then(() => "accepted", (e: Error) => e.message);
      await second;
      return { decision: "allow" };
    });
    const waiting = client.waitForEnd();
    await client.start(task());
    expect(await waiting).toMatchObject({ type: "run.settled", sessionId: "s1" });
    expect(await second).toMatch(/already_running/);
    expect(errors).toEqual([]);
    expect(existsSync(p("work/ok.marker"))).toBe(true);
  }, 10_000);
});

describe.sequential("engine-client：拦截与确认", () => {
  it("block 的拒绝原因透传给模型，工具不执行", async () => {
    const { s, client, events } = await setup(TOOL("touch denied.marker"));
    const seen: unknown[] = [];
    client.onIntercept(async (req) => (seen.push(req), { decision: "block", reason: "NO_TOUCH" }));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(seen).toEqual([{ callId: "c1", toolName: "bash", input: { command: "touch denied.marker" } }]);
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ isError: true });
    expect(existsSync(p("work/denied.marker"))).toBe(false);
    expect(lastReq(s)).toMatch(/NO_TOUCH/);
  }, 10_000);

  it("确认：onConfirm 收到 ConfirmRequest；拒绝时确认人的 by 与理由透传给模型", async () => {
    const { s, client } = await setup(TOOL("touch denied.marker"));
    const seen: unknown[] = [];
    client.onIntercept(async () => ({ decision: "confirm", reason: "needs human" }));
    client.onConfirm(async (req) => (seen.push(req), { approved: false, by: "tester", reason: "DENIED_BY_TESTER" }));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(seen).toEqual([expect.objectContaining({ callId: "c1", toolName: "bash", reason: "needs human", input: { command: "touch denied.marker" } })]);
    expect(existsSync(p("work/denied.marker"))).toBe(false);
    expect(lastReq(s)).toMatch(/rejected by tester: DENIED_BY_TESTER/);
  }, 10_000);

  it("确认批准：工具执行", async () => {
    const { client } = await setup(TOOL("echo hi > ok.marker"));
    client.onIntercept(async () => ({ decision: "confirm", reason: "needs human" }));
    client.onConfirm(async () => ({ approved: true, by: "tester" }));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(existsSync(p("work/ok.marker"))).toBe(true);
  }, 10_000);

  const confirm = async () => ({ decision: "confirm" as const, reason: "needs human" });
  it.each<[string, (c: EngineClient) => void, RegExp]>([
    ["没有 onIntercept", () => {}, /engine-client.*onIntercept/],
    ["onIntercept 抛错", (c) => c.onIntercept(async () => { throw new Error("BOOM_I"); }), /BOOM_I/],
    ["onIntercept 返回非法 Decision（block 无理由）", (c) => c.onIntercept(async () => ({ decision: "block" }) as never), /engine-client.*invalid/],
    ["没有 onConfirm", (c) => c.onIntercept(confirm), /rejected by engine-client: .*onConfirm/],
    ["onConfirm 抛错", (c) => { c.onIntercept(confirm); c.onConfirm(() => { throw new Error("BOOM_C"); }); }, /rejected by engine-client: .*BOOM_C/],
    ["onConfirm 抛出空消息的错误", (c) => { c.onIntercept(confirm); c.onConfirm(async () => { throw new Error(""); }); }, /rejected by engine-client: handler failed/],
    ["onConfirm 抛出无法转成字符串的值", (c) => { c.onIntercept(confirm); c.onConfirm(async () => { throw Object.create(null); }); }, /rejected by engine-client: handler failed/],
    ["onConfirm 返回非法 Confirmation（拒绝无理由）", (c) => { c.onIntercept(confirm); c.onConfirm(async () => ({ approved: false, by: "tester" })); }, /rejected by engine-client: .*invalid/],
  ])("%s：发送带原因的拒绝，工具不执行", async (_n, register, reason) => {
    const { s, client, errors } = await setup(TOOL("touch denied.marker"));
    register(client);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(existsSync(p("work/denied.marker"))).toBe(false);
    expect(lastReq(s)).toMatch(reason);
    expect(errors).toEqual([]);
  }, 10_000);

  it("与调用无关的协议错误（超时后迟到的决定 → stale_response）进 onError，任务正常结束", async () => {
    // 第二轮模型回复放慢，保证迟到的决定到达时任务仍在运行
    const turns: ScriptedTurn[] = [TOOL("touch denied.marker")[0], { kind: "text", chunks: ["a", "b", "c"], chunkDelayMs: 200 }];
    const { client, errors } = await setup(turns, { interceptTimeoutMs: 100 });
    client.onIntercept(() => new Promise((r) => setTimeout(() => r({ decision: "allow" }), 200)));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    await vi.waitFor(() => expect(errors).toEqual([expect.objectContaining({ code: "stale_response", requestId: expect.any(String) })]));
    expect(existsSync(p("work/denied.marker"))).toBe(false);
  }, 10_000);
});

describe.sequential("engine-client：连接失败与关闭", () => {
  it("终止事件之前断线：waitForEnd reject，不伪造 run.cancelled", async () => {
    const events: SequencedEvent[] = [];
    const client = await stub((m, ws) => {
      ws.send(JSON.stringify({ type: "accepted", requestId: m.requestId, sessionId: "s1" }));
      ws.close(1000);
    });
    client.onEvent((e) => events.push(e));
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    expect(events).toEqual([]);
  });

  it("两个 start 同时挂起：第一个在 accepted 前被拒绝、第二个被接受时，waitForEnd（早拿的与晚拿的）都得到第二个任务的终止事件", async () => {
    const got: { requestId: string }[] = [];
    const client = await stub((m, ws) => {
      got.push(m);
      if (got.length < 2) return;
      ws.send(JSON.stringify({ type: "error", requestId: got[0].requestId, code: "not_implemented", message: "no" }));
      ws.send(JSON.stringify({ type: "accepted", requestId: got[1].requestId, sessionId: "s2" }));
      ws.send(JSON.stringify({ type: "event", event: { type: "run.settled", sessionId: "s2", seq: 1, at: new Date().toISOString() } }));
    });
    const early = client.waitForEnd();
    const first = client.start(task({ interceptMode: "policy" }));
    const second = client.start(task({ sessionId: "s2" }));
    await expect(first).rejects.toThrow(/not_implemented/);
    await second;
    expect(await early).toMatchObject({ type: "run.settled", sessionId: "s2" });
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled", sessionId: "s2" });
  });

  it("onEvent / onError 回调抛错：被客户端捕获并写 stderr，之后的事件照常送达，终止结果照常结算", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = await stub((m, ws) => {
      ws.send(JSON.stringify({ type: "error", requestId: "unrelated", code: "stale_response", message: "late" }));
      ws.send(JSON.stringify({ type: "accepted", requestId: m.requestId, sessionId: "s1" }));
      const at = new Date().toISOString();
      ws.send(JSON.stringify({ type: "event", event: { type: "text.delta", text: "hi", sessionId: "s1", seq: 1, at } }));
      ws.send(JSON.stringify({ type: "event", event: { type: "run.settled", sessionId: "s1", seq: 2, at } }));
    });
    const seen: string[] = [];
    client.onEvent((e) => { seen.push(e.type); throw new Error("EVENT_BOOM"); });
    client.onError(() => { throw new Error("ERROR_BOOM"); });
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(seen).toEqual(["text.delta", "run.settled"]);
    const out = stderr.mock.calls.map((a) => String(a[0])).join("");
    expect(out).toMatch(/onError.*ERROR_BOOM/);
    expect(out.match(/onEvent.*EVENT_BOOM/g)).toHaveLength(2);
  });

  it("非法服务端消息：连接失败，挂起的 start 与 waitForEnd 都 reject，之后的 start 也 reject", async () => {
    const client = await stub((_m, ws) => ws.send(JSON.stringify({ type: "accepted" })));
    const waiting = client.waitForEnd();
    await expect(client.start(task())).rejects.toThrow(/invalid runner message/);
    await expect(waiting).rejects.toThrow(/invalid runner message/);
    await expect(client.start(task())).rejects.toThrow();
  });

  it("运行中出现非法服务端消息：已 accepted 的等待被 reject", async () => {
    const client = await stub((m, ws) => {
      ws.send(JSON.stringify({ type: "accepted", requestId: m.requestId, sessionId: "s1" }));
      ws.send(JSON.stringify({ type: "event", event: { type: "run.settled" } }));
    });
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/invalid runner message/);
  });

  it("close()：未启动时关闭连接并结算等待；之后 start 被拒绝", async () => {
    const { runner, client } = await setup([]);
    const waiting = client.waitForEnd();
    await client.close();
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(client.start(task())).rejects.toThrow(/closed/);
    expect(await runner.done).toEqual({ ok: true });
  }, 10_000);

  it("cancel()：运行中取消得到 run.cancelled，工具不执行", async () => {
    const { client } = await setup(TOOL("touch never.marker"));
    client.onIntercept(() => {
      client.cancel();
      return new Promise(() => {}); // 决定永不到达，由取消释放等待
    });
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(existsSync(p("work/never.marker"))).toBe(false);
  }, 10_000);
});
