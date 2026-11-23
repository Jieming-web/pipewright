import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRunnerMessage, type RunnerMessage, type StartTask } from "../../packages/engine-protocol/src/index.js";
import { PiEngine } from "../../packages/engine-runner/src/pi-engine.js";
import { startRunnerServer } from "../../packages/engine-runner/src/runner-server.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
type Runner = Awaited<ReturnType<typeof startRunnerServer>>;

let root: string;
let servers: FakeOpenAIServer[];
let runners: Runner[];
const p = (...s: string[]) => join(root, ...s);
const savedTmp = process.env.TMPDIR;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-rs-")));
  for (const d of ["model", "work", "sessions", "tmp"]) mkdirSync(p(d));
  process.env.TMPDIR = p("tmp"); // 引擎 scratchDir 建在 os.tmpdir() 下：放进本测试根目录以便断言清理
  servers = [];
  runners = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runners.map((r) => r.close()));
  await Promise.all(servers.map((s) => s.close()));
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});

async function setup(turns: ScriptedTurn[], o: Partial<Parameters<typeof startRunnerServer>[0]> = {}) {
  const s = await startFakeOpenAIServer(turns);
  servers.push(s);
  writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(s.baseUrl)));
  const runner = await startRunnerServer({ port: 0, modelsPath: p("model/models.json"), workDir: p("work"), sessionsRoot: p("sessions"), ...o });
  runners.push(runner);
  return { s, runner };
}

const start = (o: Partial<StartTask> = {}): StartTask => ({
  type: "start_task", requestId: "A", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" },
  contextFiles: [], interceptMode: "callback", ...o,
});

/** 原生 WebSocket 客户端（Node 内置，不依赖 9B）：收集全部消息（逐条按 schema 校验），onMessage 可即时应答 */
async function connect(port: number, onMessage?: (m: RunnerMessage, send: (x: unknown) => void) => void) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: RunnerMessage[] = [];
  const send = (x: unknown) => ws.send(typeof x === "string" ? x : JSON.stringify(x));
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  ws.addEventListener("message", (e) => {
    const parsed = parseRunnerMessage(String(e.data));
    expect(parsed.ok, String(e.data)).toBe(true);
    if (!parsed.ok) return;
    msgs.push(parsed.message);
    onMessage?.(parsed.message, send);
  });
  await new Promise((ok, fail) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", fail, { once: true }); });
  const until = (pred: (m: RunnerMessage) => boolean) =>
    vi.waitFor(() => { const m = msgs.find(pred); expect(m).toBeDefined(); return m!; }, { timeout: 8000, interval: 10 });
  const events = () => msgs.flatMap((m) => (m.type === "event" ? [m.event] : []));
  return { ws, msgs, send, closed, until, events };
}
type Client = Awaited<ReturnType<typeof connect>>;

const allow = (m: RunnerMessage, send: (x: unknown) => void) => {
  if (m.type === "intercept_request") send({ type: "intercept_decision", requestId: `d-${m.callId}`, callId: m.callId, decision: "allow" });
};
const errors = (c: Client) => c.msgs.filter((m) => m.type === "error");
const scratchLeft = () => readdirSync(p("tmp")).filter((n) => n.startsWith("fp-run-"));
const portClosed = (port: number) =>
  new Promise<boolean>((ok) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.addEventListener("open", () => { ws.close(); ok(false); }); ws.addEventListener("error", () => ok(true)); });

/** 恰好一个终止事件且在最后；accepted 在全部事件之前 */
function checkFlow(c: Client) {
  const i = c.msgs.findIndex((m) => m.type === "accepted");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(c.msgs.findIndex((m) => m.type === "event")).toBeGreaterThan(i);
  const ev = c.events();
  expect(ev.filter((e) => TERMINAL.has(e.type))).toHaveLength(1);
  expect(TERMINAL.has(ev.at(-1)!.type)).toBe(true);
  return ev.map((e) => e.type);
}

const TOOL = (cmd: string): ScriptedTurn[] => [{ kind: "toolCall", name: "bash", args: { command: cmd }, id: "c1" }, { kind: "text", chunks: ["done"] }];

describe.sequential("runner 服务：正常流程", () => {
  it("accepted 回显 requestId → 事件流 → run.settled；之后关闭连接与监听，done ok", async () => {
    const { runner } = await setup([{ kind: "text", chunks: ["Hel", "lo"] }]);
    const c = await connect(runner.port);
    c.send(start());
    expect(await c.closed).toBe(1000);
    expect(c.msgs[0]).toEqual({ type: "accepted", requestId: "A", sessionId: "s1" });
    expect(checkFlow(c)).toEqual(["run.started", "text.delta", "text.delta", "message.completed", "run.settled"]);
    expect(await runner.done).toEqual({ ok: true });
    expect(await portClosed(runner.port)).toBe(true);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("决定/确认往返：confirm → 批准后工具执行；重复的决定与确认得到 stale_response（带各自 requestId），已完成的决定不变", async () => {
    const { runner } = await setup(TOOL("echo hi > ok.marker"));
    const c = await connect(runner.port, (m, send) => {
      if (m.type === "intercept_request") {
        send({ type: "intercept_decision", requestId: "D1", callId: m.callId, decision: "confirm", reason: "needs human" });
        send({ type: "intercept_decision", requestId: "D2", callId: m.callId, decision: "block", reason: "late" });
      }
      if (m.type === "confirm_request") {
        expect(m).toMatchObject({ callId: "c1", toolName: "bash", reason: "needs human", input: { command: "echo hi > ok.marker" } });
        send({ type: "confirm_response", requestId: "C1", confirmId: m.confirmId, approved: true, by: "tester" });
        send({ type: "confirm_response", requestId: "C2", confirmId: m.confirmId, approved: false, by: "tester", reason: "too late" });
      }
    });
    c.send(start());
    await c.closed;
    expect(checkFlow(c).at(-1)).toBe("run.settled");
    expect(c.events().find((e) => e.type === "tool.finished")).toMatchObject({ isError: false });
    expect(readFileSync(p("work/ok.marker"), "utf8")).toBe("hi\n");
    expect(errors(c)).toEqual([
      expect.objectContaining({ requestId: "D2", code: "stale_response" }),
      expect.objectContaining({ requestId: "C2", code: "stale_response" }),
    ]);
    expect(await runner.done).toEqual({ ok: true });
  }, 10_000);

  it("模型最终失败：accepted 后 run.failed，任务失败不影响 done（ok:true）", async () => {
    const { runner } = await setup([]);
    const c = await connect(runner.port);
    c.send(start({ model: { provider: "fake", id: "nope" } }));
    await c.closed;
    expect(checkFlow(c)).toEqual(["run.failed"]);
    expect(await runner.done).toEqual({ ok: true });
  }, 10_000);
});

describe.sequential("runner 服务：启动前拒绝与协议错误", () => {
  it("policy / resume 返回 not_implemented：不创建会话、不请求模型，保持 idle 后可正常启动", async () => {
    const { s, runner } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const c = await connect(runner.port);
    c.send(start({ requestId: "P", interceptMode: "policy", sessionDir: "sp" }));
    c.send(start({ requestId: "R", resume: { sessionFileRef: "x" }, sessionDir: "sr" }));
    await c.until((m) => m.type === "error" && m.requestId === "R");
    expect(errors(c)).toEqual([
      expect.objectContaining({ requestId: "P", code: "not_implemented" }),
      expect.objectContaining({ requestId: "R", code: "not_implemented" }),
    ]);
    expect(readdirSync(p("sessions"))).toEqual([]);
    expect(s.requests.length).toBe(0);
    expect(scratchLeft()).toEqual([]);
    c.send(start());
    await c.closed;
    expect(checkFlow(c).at(-1)).toBe("run.settled");
  }, 10_000);

  it("格式错误：非法 JSON 无 requestId；可解析但字段非法时回显 requestId；保持 idle", async () => {
    const { runner } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const c = await connect(runner.port);
    c.send("{not json");
    c.send({ type: "start_task", requestId: "BAD", sessionId: "s1" });
    c.send({ type: "nope" });
    await c.until((m) => m.type === "error" && m.requestId === "BAD");
    await vi.waitFor(() => expect(errors(c)).toHaveLength(3));
    expect(errors(c).map((e) => e.type === "error" && [e.code, e.requestId])).toEqual([
      ["invalid_message", undefined], ["invalid_message", "BAD"], ["invalid_message", undefined],
    ]);
    c.send(start());
    await c.closed;
    expect(checkFlow(c).at(-1)).toBe("run.settled");
  }, 10_000);

  it("idle 时迟到的决定得到 stale_response；cancel 无操作且不退出", async () => {
    const { runner } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const c = await connect(runner.port);
    c.send({ type: "cancel", requestId: "X" });
    c.send({ type: "intercept_decision", requestId: "D", callId: "ghost", decision: "allow" });
    await c.until((m) => m.type === "error");
    expect(errors(c)).toEqual([expect.objectContaining({ requestId: "D", code: "stale_response" })]);
    c.send(start());
    await c.closed;
    expect(checkFlow(c).at(-1)).toBe("run.settled");
  }, 10_000);

  it("带 Origin 头的连接在握手时被拒绝，且不占用唯一客户端位置", async () => {
    const { runner } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const sock = tcpConnect(runner.port, "127.0.0.1");
    let reply = "";
    sock.on("data", (d) => (reply += d));
    await new Promise((ok) => sock.once("connect", ok));
    sock.write(["GET / HTTP/1.1", "Host: 127.0.0.1", "Origin: http://evil.example", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
    await new Promise((ok) => sock.once("close", ok));
    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
    expect(reply).not.toMatch(/"type"/); // 没有任何 runner 消息
    const c = await connect(runner.port);
    c.send(start());
    expect(await c.closed).toBe(1000);
    expect(c.msgs[0]).toEqual({ type: "accepted", requestId: "A", sessionId: "s1" });
    expect(checkFlow(c).at(-1)).toBe("run.settled");
  }, 10_000);

  it("第二个连接被拒绝，原连接与任务不受影响", async () => {
    const { runner } = await setup(TOOL("echo hi > ok.marker"));
    const c = await connect(runner.port, allow);
    const second = await connect(runner.port);
    expect(await second.closed).toBe(1008);
    expect(second.msgs).toEqual([]);
    c.send(start());
    await c.closed;
    expect(checkFlow(c).at(-1)).toBe("run.settled");
    expect(existsSync(p("work/ok.marker"))).toBe(true);
  }, 10_000);

  it("运行中第二次 start_task：already_running 带第二次的 requestId，原任务继续", async () => {
    const { runner } = await setup(TOOL("echo hi > ok.marker"));
    const c = await connect(runner.port, (m, send) => {
      if (m.type === "intercept_request") {
        send(start({ requestId: "B", sessionId: "s2" }));
        allow(m, send);
      }
    });
    c.send(start());
    await c.closed;
    expect(c.msgs.filter((m) => m.type === "accepted")).toEqual([{ type: "accepted", requestId: "A", sessionId: "s1" }]);
    expect(errors(c)).toEqual([expect.objectContaining({ requestId: "B", code: "already_running" })]);
    expect(checkFlow(c).at(-1)).toBe("run.settled");
    expect(new Set(c.events().map((e) => e.sessionId))).toEqual(new Set(["s1"]));
    expect(existsSync(p("work/ok.marker"))).toBe(true);
  }, 10_000);
});

describe.sequential("runner 服务：取消、断线与退出", () => {
  it("等待决定时 cancel（重复两次）：只有一个 run.cancelled，工具不执行，关闭后 done ok", async () => {
    const { s, runner } = await setup(TOOL("touch never.marker"));
    const c = await connect(runner.port, (m, send) => {
      if (m.type === "intercept_request") { send({ type: "cancel", requestId: "X1" }); send({ type: "cancel", requestId: "X2" }); }
    });
    c.send(start());
    expect(await c.closed).toBe(1000);
    expect(checkFlow(c).at(-1)).toBe("run.cancelled");
    expect(errors(c)).toEqual([]);
    expect(await runner.done).toEqual({ ok: true });
    expect(existsSync(p("work/never.marker"))).toBe(false);
    expect(s.requests.length).toBe(1);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("运行中客户端断线：取消并退出，不等重连；工具不执行，done ok", async () => {
    const { s, runner } = await setup(TOOL("touch never.marker"));
    const c = await connect(runner.port, (m) => { if (m.type === "intercept_request") c.ws.close(); });
    c.send(start());
    expect(await runner.done).toEqual({ ok: true });
    expect(await portClosed(runner.port)).toBe(true);
    expect(existsSync(p("work/never.marker"))).toBe(false);
    expect(s.requests.length).toBe(1);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("idle 时客户端断线：直接退出，done ok", async () => {
    const { runner } = await setup([]);
    const c = await connect(runner.port);
    c.ws.close();
    expect(await runner.done).toEqual({ ok: true });
  }, 10_000);

  it("空闲超时：无客户端时退出；已连接但一直未启动时关闭连接并退出", async () => {
    const { runner } = await setup([], { idleTimeoutMs: 200 });
    expect(await runner.done).toEqual({ ok: true });
    expect(await portClosed(runner.port)).toBe(true);

    const r2 = await startRunnerServer({ port: 0, modelsPath: p("model/models.json"), workDir: p("work"), sessionsRoot: p("sessions"), idleTimeoutMs: 300 });
    runners.push(r2);
    const c = await connect(r2.port);
    expect(await c.closed).toBe(1000);
    expect(await r2.done).toEqual({ ok: true });
  }, 10_000);

  it("收尾已开始（未启动时 close()）后到达的 start_task：不 accepted、不启动引擎", async () => {
    const { s, runner } = await setup([{ kind: "text", chunks: ["ok"] }]);
    const c = await connect(runner.port);
    const closing = runner.close();
    c.send(start());
    await closing;
    expect(await runner.done).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 500)); // 给可能被误启动的引擎留出建 scratchDir、请求模型的时间
    expect(c.msgs.filter((m) => m.type === "accepted")).toEqual([]);
    expect(s.requests.length).toBe(0);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("客户端不回 close 帧：done 仍在数秒内 resolve，不受 ws 30 秒握手超时拖延", async () => {
    const { runner } = await setup([]);
    // 手工完成 WebSocket 升级后不再读写任何帧，模拟不回 close 帧的客户端
    const sock = tcpConnect(runner.port, "127.0.0.1");
    await new Promise((ok) => sock.once("connect", ok));
    sock.write(["GET / HTTP/1.1", "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
    await new Promise((ok) => sock.once("data", ok)); // 101 Switching Protocols
    try {
      const t0 = Date.now();
      await runner.close();
      expect(await runner.done).toEqual({ ok: true });
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      sock.destroy();
    }
  }, 40_000);

  it("运行中外部 close()：客户端收到 run.cancelled 后连接关闭，close 与 done 都完成", async () => {
    const { runner } = await setup(TOOL("touch never.marker"));
    let closing: Promise<void> | undefined;
    const c = await connect(runner.port, (m) => { if (m.type === "intercept_request") closing = runner.close(); });
    c.send(start());
    expect(await c.closed).toBe(1000);
    await closing;
    expect(checkFlow(c).at(-1)).toBe("run.cancelled");
    expect(await runner.done).toEqual({ ok: true });
    expect(existsSync(p("work/never.marker"))).toBe(false);
  }, 10_000);

  it("引擎清理失败：只转发引擎发布的 run.failed，done ok:false，并在 stderr 记录", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { runner } = await setup([{ kind: "text", chunks: ["ok"] }], { recordPiEventsPath: p("no-such-dir/raw.jsonl") });
    const c = await connect(runner.port);
    c.send(start());
    await c.closed;
    expect(checkFlow(c)).toEqual(["run.started", "text.delta", "message.completed", "run.failed"]);
    expect((c.events().at(-1) as { reason: string }).reason).toMatch(/cleanup failed/);
    expect(await runner.done).toEqual({ ok: false });
    expect(stderr.mock.calls.map((a) => String(a[0])).join("")).toMatch(/cleanup failed/);
  }, 10_000);

  it("引擎 run 永不结束：close() 后 done 仍在兜底时限内 resolve 为 ok:false", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(PiEngine.prototype, "run").mockReturnValue(new Promise<void>(() => {}));
    const { runner } = await setup([]);
    const c = await connect(runner.port);
    c.send(start());
    await c.until((m) => m.type === "accepted");
    const t0 = Date.now();
    await runner.close();
    expect(await runner.done).toEqual({ ok: false });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(await c.closed).toBe(1000);
  }, 15_000);
});

describe.sequential("runner 进程入口", () => {
  const MAIN = join(import.meta.dirname, "../../packages/engine-runner/src/main.ts");
  const run = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    return { child, exit, out: () => out, err: () => err };
  };

  it("端口已被占用：stderr 报 failed to listen，以 1 退出", async () => {
    const busy = createServer();
    const port = await new Promise<number>((ok) => busy.listen(0, "127.0.0.1", () => ok((busy.address() as { port: number }).port)));
    try {
      const r = run(["--port", String(port), "--models", p("m.json"), "--workdir", p("work"), "--sessions-root", p("sessions")]);
      expect(await r.exit).toBe(1);
      expect(r.err()).toMatch(/failed to listen/);
      expect(r.out()).toBe("");
    } finally {
      busy.close();
    }
  }, 15_000);

  it("整数参数非法（--idle-timeout-ms abc）：非零退出，不监听", async () => {
    const r = run(["--port", "0", "--models", p("m.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), "--idle-timeout-ms", "abc"]);
    expect(await r.exit).not.toBe(0);
    expect(r.err()).toMatch(/--idle-timeout-ms/);
    expect(r.out()).toBe("");
  }, 15_000);

  it("缺 --sessions-root：stderr 报错、非零退出、不监听", async () => {
    const r = run(["--port", "0", "--models", p("m.json"), "--workdir", p("work")]);
    expect(await r.exit).not.toBe(0);
    expect(r.err()).toMatch(/--sessions-root/);
    expect(r.out()).toBe("");
  }, 15_000);

  it("stdout 只有一行 RUNNER_LISTENING <port>；SIGTERM 后清理并以 0 退出", async () => {
    const r = run(["--port", "0", "--models", p("m.json"), "--workdir", p("work"), "--sessions-root", p("sessions")]);
    await vi.waitFor(() => expect(r.out()).toMatch(/\n$/), { timeout: 10_000, interval: 20 });
    const m = /^RUNNER_LISTENING (\d+)\n$/.exec(r.out());
    expect(m).not.toBeNull(); // 不在这里连接探测：客户端断开本身就会让 runner 退出
    r.child.kill("SIGTERM");
    expect(await r.exit).toBe(0);
    expect(r.out()).toBe(m![0]);
  }, 15_000);
});
