import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitContextFiles } from "../../packages/engine-client/src/git-context.js";
import { SequencedEventSchema, type RunnerMessage, type SequencedEvent, type StartTask } from "../../packages/engine-protocol/src/index.js";
import { createInterceptCoordinator } from "../../packages/engine-runner/src/intercept-coordinator.js";
import { PiEngine } from "../../packages/engine-runner/src/pi-engine.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

type Coordinator = ReturnType<typeof createInterceptCoordinator>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
const SECRET = "SECRET-KEY-8b-do-not-leak";
const FAST_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 20 }; // 0B.2 的测试重试配置

let root: string;
let servers: FakeOpenAIServer[];
const p = (...s: string[]) => join(root, ...s);
const saved = { key: process.env.FP_TEST_KEY, tmp: process.env.TMPDIR };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-pe-")));
  for (const d of ["model", "work", "sessions", "tmp"]) mkdirSync(p(d));
  process.env.TMPDIR = p("tmp"); // 引擎的 scratchDir 建在 os.tmpdir() 下：放进本测试根目录以便断言清理
  process.env.FP_TEST_KEY = SECRET;
  servers = [];
  // pi 默认重试要 14 秒才耗尽；平台设置只经 SettingsManager.inMemory 创建，测试在这里叠加 0B.2 的快速配置
  const inMemory = SettingsManager.inMemory.bind(SettingsManager);
  vi.spyOn(SettingsManager, "inMemory").mockImplementation((s, o) => inMemory({ ...s, retry: FAST_RETRY }, o));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => s.close()));
  for (const [k, v] of [["FP_TEST_KEY", saved.key], ["TMPDIR", saved.tmp]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

const serve = async (turns: ScriptedTurn[]) => { const s = await startFakeOpenAIServer(turns); servers.push(s); return s; };
const writeModels = (baseUrl: string) => {
  const cfg = fakeModelsJson(baseUrl) as any;
  cfg.providers.fake.apiKey = "$FP_TEST_KEY";
  writeFileSync(p("model/models.json"), JSON.stringify(cfg));
};
const task = (o: Partial<StartTask> = {}): StartTask => ({
  type: "start_task", requestId: "r1", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" },
  contextFiles: [{ repo: "alpha", path: "AGENTS.md", content: "rule alpha", sourceCommit: "c1" }], interceptMode: "callback", ...o,
});
const scratchLeft = () => readdirSync(p("tmp")).filter((n) => n.startsWith("fp-run-"));
const lastReq = (s: FakeOpenAIServer) => JSON.stringify(s.requests.at(-1));

type Hooks = {
  /** runner → caller 消息；默认对 intercept_request 回 allow */
  onSend?: (m: RunnerMessage, c: Coordinator, engine: PiEngine) => void;
  onEvent?: (e: SequencedEvent, engine: PiEngine) => void;
  interceptTimeoutMs?: number;
  recordPiEventsPath?: string;
  workDir?: string;
};
const allow = (m: RunnerMessage, c: Coordinator) => {
  if (m.type === "intercept_request") c.respond({ type: "intercept_decision", requestId: "d", callId: m.callId, decision: "allow" });
};

function makeEngine(h: Hooks = {}) {
  const events: SequencedEvent[] = [];
  const sent: RunnerMessage[] = [];
  const onSend = h.onSend ?? allow;
  const coordinator: Coordinator = createInterceptCoordinator({
    send: (m) => { sent.push(m); queueMicrotask(() => onSend(m, coordinator, engine)); },
    interceptTimeoutMs: h.interceptTimeoutMs ?? 20_000,
    confirmTimeoutMs: 20_000,
  });
  const engine: PiEngine = new PiEngine({
    modelsPath: p("model/models.json"), workDir: h.workDir ?? p("work"), sessionsRoot: p("sessions"), coordinator,
    emit: (e) => { events.push(e); h.onEvent?.(e, engine); },
    recordPiEventsPath: h.recordPiEventsPath,
  });
  return { engine, coordinator, events, sent };
}

/** 序号连续、恰好一个终止且在最后、首事件是 run.started 或 run.failed、全部符合 schema；返回类型列表 */
function checkStream(events: SequencedEvent[]): string[] {
  for (const e of events) expect(SequencedEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set(["s1"]));
  const terminals = events.filter((e) => TERMINAL.has(e.type));
  expect(terminals).toHaveLength(1);
  expect(events.at(-1)).toBe(terminals[0]);
  expect(["run.started", "run.failed"]).toContain(events[0]!.type);
  return events.map((e) => e.type);
}
const terminal = (events: SequencedEvent[]) => events.at(-1) as any;

describe.sequential("PiEngine 运行", () => {
  it("纯文本：run.started(snapshot) → 文本 → run.settled，清理完成", async () => {
    const s = await serve([{ kind: "text", chunks: ["Hel", "lo"] }]);
    writeModels(s.baseUrl);
    const { engine, events, coordinator } = makeEngine();
    expect(engine.disposed).toBe(false);
    await engine.run(task());
    expect(checkStream(events)).toEqual(["run.started", "text.delta", "text.delta", "message.completed", "run.settled"]);
    expect((events[0] as any).snapshot).toMatchObject({ engine: { name: "pi" }, model: { provider: "fake", id: "fake-model" }, contextFiles: [{ repo: "alpha", sha256: sha("rule alpha") }] });
    expect((events[3] as any).text).toBe("Hello");
    expect(engine.disposed).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
    expect(scratchLeft()).toEqual([]);
    expect(s.requests.length).toBe(1);
    expect(s.errors).toEqual([]);
  }, 10_000);

  it("工具后继续回答：allow 时真实 bash 在临时目录产生 marker", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "echo hi > allow.marker" }, id: "call_1" }, { kind: "text", chunks: ["done"] }]);
    writeModels(s.baseUrl);
    const { engine, events, sent } = makeEngine();
    await engine.run(task());
    expect(checkStream(events)).toEqual(["run.started", "tool.started", "tool.finished", "text.delta", "message.completed", "run.settled"]);
    expect(events[1]).toMatchObject({ callId: "call_1", toolName: "bash" });
    expect(events[2]).toMatchObject({ callId: "call_1", isError: false });
    expect(sent.map((m) => m.type)).toEqual(["intercept_request"]);
    expect(readFileSync(p("work/allow.marker"), "utf8")).toBe("hi\n");
    expect(s.requests.length).toBe(2);
  }, 10_000);

  describe("工具未放行：无 marker，模型收到原因", () => {
    const cases: [string, Hooks, RegExp][] = [
      ["block", { onSend: (m, c) => m.type === "intercept_request" && c.respond({ type: "intercept_decision", requestId: "d", callId: m.callId, decision: "block", reason: "NO_TOUCH" }) }, /NO_TOUCH/],
      ["确认拒绝", {
        onSend: (m, c) => {
          if (m.type === "intercept_request") c.respond({ type: "intercept_decision", requestId: "d", callId: m.callId, decision: "confirm", reason: "needs human" });
          if (m.type === "confirm_request") c.respond({ type: "confirm_response", requestId: "c", confirmId: m.confirmId, approved: false, by: "tester", reason: "DENIED_BY_TESTER" });
        },
      }, /rejected by tester: DENIED_BY_TESTER/],
      ["拦截超时", { onSend: () => {}, interceptTimeoutMs: 100 }, /intercept timed out/],
    ];
    it.each(cases)("%s", async (_n, hooks, reason) => {
      const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "touch denied.marker" }, id: "call_1" }, { kind: "text", chunks: ["ok"] }]);
      writeModels(s.baseUrl);
      const { engine, events } = makeEngine(hooks);
      await engine.run(task());
      expect(checkStream(events).at(-1)).toBe("run.settled");
      expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ isError: true });
      expect(existsSync(p("work/denied.marker"))).toBe(false);
      expect(lastReq(s)).toMatch(reason);
    }, 10_000);
  });

  it("重试后最终结束：中间失败不终止，只有一个 run.settled", async () => {
    const s = await serve([{ kind: "error", status: 500 }, { kind: "text", chunks: ["recovered"] }]);
    writeModels(s.baseUrl);
    const { engine, events } = makeEngine();
    await engine.run(task());
    expect(checkStream(events)).toEqual(["run.started", "text.delta", "message.completed", "run.settled"]);
    expect(s.requests.length).toBe(2);
  }, 10_000);

  it("重试耗尽：run.failed 带模型错误", async () => {
    const s = await serve([{ kind: "error", status: 500 }, { kind: "error", status: 500 }, { kind: "error", status: 500 }]);
    writeModels(s.baseUrl);
    const { engine, events } = makeEngine();
    await engine.run(task());
    expect(checkStream(events)).toEqual(["run.started", "run.failed"]);
    expect(terminal(events).reason).toMatch(/500/);
    expect(s.requests.length).toBe(3);
    expect(engine.disposed).toBe(true);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("不可达：run.failed 带连接错误", async () => {
    const port = await new Promise<number>((ok) => { const srv = createServer().listen(0, "127.0.0.1", () => { const a = srv.address() as any; srv.close(() => ok(a.port)); }); });
    writeModels(`http://127.0.0.1:${port}/v1`);
    const { engine, events } = makeEngine();
    await engine.run(task());
    expect(checkStream(events)).toEqual(["run.started", "run.failed"]);
    expect(terminal(events).reason).toMatch(/ECONNREFUSED|Connection error/);
    expect(engine.disposed).toBe(true);
  }, 10_000);

  describe("初始化失败：只有 run.failed，没有 run.started", () => {
    it.each([
      ["加载器失败（重复规则标签）", task({ contextFiles: [{ repo: "a", path: "X.md", content: "1", sourceCommit: "c" }, { repo: "a", path: "X.md", content: "2", sourceCommit: "c" }] }), /duplicate context file label/],
      ["会话创建失败（模型不存在）", task({ model: { provider: "fake", id: "nope" } }), /model not found/],
    ])("%s", async (_n, t, reason) => {
      const s = await serve([]);
      writeModels(s.baseUrl);
      const { engine, events } = makeEngine();
      await engine.run(t);
      expect(checkStream(events)).toEqual(["run.failed"]);
      expect(terminal(events).reason).toMatch(reason);
      expect(s.requests.length).toBe(0);
      expect(engine.disposed).toBe(true);
      expect(scratchLeft()).toEqual([]);
    }, 10_000);
  });

  it("诊断录制来自 SDK 原始订阅，原始事件与密钥不经 emit 泄漏", async () => {
    mkdirSync(p("diag"));
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "echo hi" }, id: "call_1" }, { kind: "text", chunks: ["done"] }]);
    writeModels(s.baseUrl);
    const { engine, events } = makeEngine({ recordPiEventsPath: p("diag/raw.jsonl") });
    await engine.run(task());
    checkStream(events);
    const raw = readFileSync(p("diag/raw.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const types = raw.map((e) => e.type);
    for (const t of ["agent_start", "message_update", "tool_execution_start", "agent_end", "agent_settled"]) expect(types).toContain(t);
    expect(types.at(-1)).toBe("agent_settled"); // 关闭完成后录制完整
    const emitted = JSON.stringify(events);
    expect(emitted).not.toMatch(/assistantMessageEvent|agent_settled|message_update|toolCallId/);
    expect(emitted).not.toContain(SECRET);
    expect(readFileSync(p("diag/raw.jsonl"), "utf8")).not.toContain(SECRET);
  }, 10_000);
});

describe.sequential("PiEngine 取消", () => {
  const SLOW: ScriptedTurn = { kind: "text", chunks: Array.from({ length: 20 }, (_, i) => `c${i} `), chunkDelayMs: 100 };

  async function expectCancelled(engine: PiEngine, events: SequencedEvent[], coordinator: Coordinator) {
    expect(checkStream(events).at(-1)).toBe("run.cancelled");
    expect(engine.disposed).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
    expect(scratchLeft()).toEqual([]);
  }

  it("慢流中取消：连接被关闭，不再有请求", async () => {
    const s = await serve([SLOW]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    const { engine, events, coordinator } = makeEngine({ onEvent: (e, en) => { if (e.type === "text.delta") cancel ??= en.cancel(); } });
    const t0 = Date.now();
    await engine.run(task());
    await cancel;
    expect(Date.now() - t0).toBeLessThan(1500);
    await expectCancelled(engine, events, coordinator);
    expect(events.some((e) => e.type === "message.completed")).toBe(false);
    await vi.waitFor(() => expect(s.stats.inFlight).toBe(0));
    expect(s.requests.length).toBe(1);
  }, 10_000);

  it("等待拦截决定时取消：等待被释放，工具不执行", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "touch wait.marker" }, id: "call_1" }, { kind: "text", chunks: ["never"] }]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    const { engine, events, coordinator } = makeEngine({ onSend: (m, _c, en) => { if (m.type === "intercept_request") cancel = en.cancel(); } });
    const t0 = Date.now();
    await engine.run(task());
    await cancel;
    expect(Date.now() - t0).toBeLessThan(3000); // 远小于 20 秒拦截超时
    await expectCancelled(engine, events, coordinator);
    expect(existsSync(p("work/wait.marker"))).toBe(false);
    expect(s.requests.length).toBe(1);
  }, 10_000);

  it("等待确认时取消：等待被释放，工具不执行", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "touch confirm.marker" }, id: "call_1" }, { kind: "text", chunks: ["never"] }]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    const { engine, events, coordinator, sent } = makeEngine({
      onSend: (m, c, en) => {
        if (m.type === "intercept_request") c.respond({ type: "intercept_decision", requestId: "d", callId: m.callId, decision: "confirm", reason: "ask" });
        if (m.type === "confirm_request") cancel = en.cancel();
      },
    });
    const t0 = Date.now();
    await engine.run(task());
    await cancel;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(sent.map((m) => m.type)).toEqual(["intercept_request", "confirm_request"]);
    await expectCancelled(engine, events, coordinator);
    expect(existsSync(p("work/confirm.marker"))).toBe(false);
  }, 10_000);

  it("正在运行的延迟 marker 工具被取消：过了原定时间仍无副作用", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "sleep 1 && touch late.marker" }, id: "call_1" }, { kind: "text", chunks: ["never"] }]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    let started = 0;
    const { engine, events, coordinator } = makeEngine({
      onEvent: (e, en) => { if (e.type === "tool.started") { started = Date.now(); setTimeout(() => (cancel = en.cancel()), 300); } },
    });
    await engine.run(task());
    await cancel;
    await expectCancelled(engine, events, coordinator);
    expect(Date.now() - started).toBeLessThan(1000); // 没有等工具自己结束
    await new Promise((r) => setTimeout(r, Math.max(0, started + 1600 - Date.now())));
    expect(existsSync(p("work/late.marker"))).toBe(false);
    expect(s.requests.length).toBe(1);
  }, 10_000);

  it("取消幂等：未运行时无操作；并发重复取消只有一个终止；结束后再取消不再发事件", async () => {
    const s = await serve([SLOW]);
    writeModels(s.baseUrl);
    const cancels: Promise<void>[] = [];
    const { engine, events, coordinator } = makeEngine({ onEvent: (e, en) => { if (e.type === "text.delta" && !cancels.length) cancels.push(en.cancel(), en.cancel()); } });
    await engine.cancel(); // idle
    expect(events).toEqual([]);
    const run = engine.run(task());
    await Promise.all([run, ...cancels]);
    expect(cancels).toHaveLength(2);
    await expectCancelled(engine, events, coordinator);
    const n = events.length;
    await engine.cancel();
    expect(events.length).toBe(n);
  }, 10_000);

  it("结束竞态：在最终文本或终止事件处取消，仍只有一个终止且不被覆盖", async () => {
    for (const at of ["message.completed", "run.settled"]) {
      const s = await serve([{ kind: "text", chunks: ["fin"] }]);
      writeModels(s.baseUrl);
      let cancel: Promise<void> | undefined;
      const { engine, events } = makeEngine({ onEvent: (e, en) => { if (e.type === at) cancel ??= en.cancel(); } });
      await engine.run(task());
      await cancel;
      const types = checkStream(events);
      expect(["run.settled", "run.cancelled"]).toContain(types.at(-1));
      if (at === "run.settled") expect(types.at(-1)).toBe("run.settled");
      expect(engine.disposed).toBe(true);
    }
  }, 10_000);
});

describe.sequential("PiEngine 清理失败", () => {
  it("录制关闭失败：同一发布器发一次带清理原因的 run.failed，run 拒绝，disposed=false", async () => {
    const s = await serve([{ kind: "text", chunks: ["ok"] }]);
    writeModels(s.baseUrl);
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const { engine, events } = makeEngine({ recordPiEventsPath: p("no-such-dir/raw.jsonl") });
    await expect(engine.run(task())).rejects.toThrow(/cleanup/);
    expect(checkStream(events).at(-1)).toBe("run.failed");
    expect(terminal(events).reason).toMatch(/cleanup.*no-such-dir|cleanup.*ENOENT/);
    expect(engine.disposed).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scratchLeft()).toEqual([]); // 录制失败也照样删除 scratchDir
  }, 10_000);

  it("abort 抛错：后续步骤照常执行（dispose 停掉工具、删除 scratchDir），run.failed 带第一个错误", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "sleep 1 && touch late.marker" }, id: "call_1" }, { kind: "text", chunks: ["never"] }]);
    writeModels(s.baseUrl);
    vi.spyOn(AgentSession.prototype, "abort").mockRejectedValue(new Error("ABORT_BOOM"));
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    let cancel: Promise<void> | undefined;
    let started = 0;
    const { engine, events } = makeEngine({
      onEvent: (e, en) => { if (e.type === "tool.started") { started = Date.now(); setTimeout(() => (cancel = en.cancel()), 300); } },
    });
    await expect(engine.run(task())).rejects.toThrow(/cleanup failed: ABORT_BOOM/);
    await expect(cancel).rejects.toThrow(/ABORT_BOOM/);
    expect(checkStream(events).at(-1)).toBe("run.failed");
    expect(terminal(events).reason).toBe("cleanup failed: ABORT_BOOM");
    expect(engine.disposed).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scratchLeft()).toEqual([]);
    await new Promise((r) => setTimeout(r, Math.max(0, started + 1600 - Date.now())));
    expect(existsSync(p("work/late.marker"))).toBe(false); // dispose 停掉了工具
  }, 10_000);

  it("启动失败后清理也失败：reason 同时保留清理原因与原失败原因", async () => {
    const s = await serve([]);
    writeModels(s.baseUrl);
    const { engine, events } = makeEngine({ recordPiEventsPath: p("no-such-dir/raw.jsonl") });
    await expect(engine.run(task({ model: { provider: "fake", id: "nope" } }))).rejects.toThrow(/cleanup failed/);
    expect(checkStream(events)).toEqual(["run.failed"]);
    expect(terminal(events).reason).toMatch(/^cleanup failed: .*ENOENT.*; run failed: model not found: fake\/nope$/);
    expect(engine.disposed).toBe(false);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);

  it("第二次 run 返回被拒绝的 promise，不同步抛错，也不影响第一次", async () => {
    const s = await serve([{ kind: "text", chunks: ["ok"] }]);
    writeModels(s.baseUrl);
    const { engine, events } = makeEngine();
    const first = engine.run(task());
    let second: Promise<void> | undefined;
    expect(() => (second = engine.run(task()))).not.toThrow();
    await expect(second).rejects.toThrow(/only one task/);
    await first;
    expect(checkStream(events).at(-1)).toBe("run.settled");
  }, 10_000);

  it("清理超过 5 秒：run.failed 带超时原因，cancel 与 run 都拒绝，disposed=false", async () => {
    const s = await serve([{ kind: "text", chunks: Array.from({ length: 10 }, (_, i) => `c${i}`), chunkDelayMs: 100 }]);
    writeModels(s.baseUrl);
    vi.spyOn(AgentSession.prototype, "abort").mockImplementation(() => new Promise<void>(() => {})); // abort 永不返回
    let cancel: Promise<void> | undefined;
    const { engine, events } = makeEngine({ onEvent: (e, en) => { if (e.type === "text.delta") cancel ??= en.cancel(); } });
    const t0 = Date.now();
    const run = engine.run(task());
    await expect(run).rejects.toThrow(/timed out/);
    await expect(cancel).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(7000);
    expect(checkStream(events).at(-1)).toBe("run.failed");
    expect(terminal(events).reason).toMatch(/cleanup.*timed out/);
    expect(engine.disposed).toBe(false);
  }, 15_000);

  it("prompt 永不返回且 abort 挂起：cancel 后仍在时限内 run.failed，run 与 cancel 都拒绝", async () => {
    const s = await serve([]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    // prompt 已开始、永不返回时再取消（在 run.started 处取消会跳过 prompt，测不到这条路径）
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => { setTimeout(() => (cancel = engine.cancel()), 50); return new Promise<void>(() => {}); });
    vi.spyOn(AgentSession.prototype, "abort").mockImplementation(() => new Promise<void>(() => {}));
    const { engine, events } = makeEngine();
    const t0 = Date.now();
    const run = engine.run(task());
    await expect(run).rejects.toThrow(/timed out/);
    await expect(cancel).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(7000);
    expect(checkStream(events)).toEqual(["run.started", "run.failed"]);
    expect(terminal(events).reason).toMatch(/cleanup.*timed out/);
    expect(engine.disposed).toBe(false);
  }, 15_000);

  it("prompt 永不返回但清理成功：run 与 cancel 都 resolve，只有一个 run.cancelled", async () => {
    const s = await serve([]);
    writeModels(s.baseUrl);
    let cancel: Promise<void> | undefined;
    // prompt 已开始、永不返回时再取消（在 run.started 处取消会跳过 prompt，测不到这条路径）
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => { setTimeout(() => (cancel = engine.cancel()), 50); return new Promise<void>(() => {}); });
    const { engine, events, coordinator } = makeEngine();
    await engine.run(task());
    await cancel;
    expect(cancel).toBeDefined();
    expect(checkStream(events)).toEqual(["run.started", "run.cancelled"]);
    expect(engine.disposed).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
    expect(scratchLeft()).toEqual([]);
  }, 10_000);
});

describe.sequential("PiEngine 规则来源（T1 验收 11）", () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: p("work"), env, encoding: "utf8" }).trim();

  it("修改任务分支后启动两次独立引擎：规则不变，两次 snapshot 哈希相同且等于基准引用内容", async () => {
    const BASE_RULE = "# base rule\n只信任基准引用\n";
    git("init", "-q", "-b", "main");
    git("config", "user.name", "t"); git("config", "user.email", "t@t"); git("config", "commit.gpgsign", "false");
    writeFileSync(p("work/AGENTS.md"), BASE_RULE);
    git("add", "-A"); git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "task");
    writeFileSync(p("work/AGENTS.md"), "TASK_BRANCH_RULE 改过的规则\n");
    git("commit", "-qam", "task edit");
    writeFileSync(p("work/AGENTS.md"), "UNCOMMITTED_RULE\n");

    const s = await serve([{ kind: "text", chunks: ["a"] }, { kind: "text", chunks: ["b"] }]);
    writeModels(s.baseUrl);
    const snapshots = [];
    for (let i = 0; i < 2; i++) {
      const contextFiles = await readGitContextFiles([{ repo: "repo", repoDir: p("work"), baseRef: "refs/heads/main", paths: ["AGENTS.md"] }]);
      expect(contextFiles.map((f) => f.content)).toEqual([BASE_RULE]);
      const { engine, events } = makeEngine({ workDir: p("work") });
      await engine.run(task({ contextFiles }));
      expect(checkStream(events).at(-1)).toBe("run.settled");
      snapshots.push((events[0] as any).snapshot.contextFiles);
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toEqual([{ repo: "repo", path: "AGENTS.md", sourceCommit: git("rev-parse", "main"), sha256: sha(execFileSync("git", ["show", "main:AGENTS.md"], { cwd: p("work"), env, encoding: "utf8" })) }]);
    for (const r of s.requests) {
      expect(JSON.stringify(r)).toContain("只信任基准引用");
      expect(JSON.stringify(r)).not.toMatch(/TASK_BRANCH_RULE|UNCOMMITTED_RULE/);
    }
  }, 15_000);
});
