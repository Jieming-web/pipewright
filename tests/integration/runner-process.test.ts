import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { groupAlive, killGroup, spawnRunner, type EngineClient, type RunnerProcess } from "../../packages/engine-client/src/index.js";
import { parseRunnerMessage, type ProtocolError, type RunnerMessage, type SequencedEvent, type StartTask } from "../../packages/engine-protocol/src/index.js";
import { fakeModelsJson, startFakeOpenAIServer, TOOL, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";
import { fifoReader, fillFifo } from "../helpers/fifo.js";

// 跨真实子进程边界：9A CLI 启动 runner，9B 客户端调用。退出证据只用退出码、工具进程组、延迟 marker 与临时目录，不加产品诊断消息
const MAIN = join(import.meta.dirname, "../../packages/engine-runner/src/main.ts");
const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
const TOOL_SLEEP_S = 2;

// 用例超时：WSL2 虚拟机整体卡顿（soft lockup）可达数十秒，留足余量；FIFO 类用例本身要等打开或停止时限（每次 12–17 秒）
const T = 60_000;
const T_FIFO = 90_000;

/**
 * 每条用例在开头调用一次，拿到它自己的临时目录、进程列表与辅助函数。
 * 不用文件级共享变量：用例超时后它的函数仍在后台运行，若共享 root/groups，残留代码会写进下一条用例的目录
 * （WSL 卡顿时出现过 models.json 被覆盖、连带失败）；闭包让残留代码只能碰到自己这一份。
 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fp-rp-")));
  const p = (...s: string[]) => join(root, ...s);
  for (const d of ["model", "work", "sessions", "tmp"]) mkdirSync(p(d));
  const servers: FakeOpenAIServer[] = [];
  const clients: EngineClient[] = [];
  // 结束时强杀的进程组：runner 组（启动者职责）；工具组是测试独有的兜底（经 tool.pid 得知），真实启动者拿不到（engine.md 工具进程）
  const groups: number[] = [];
  const exits: Promise<unknown>[] = [];
  let finished = false;

  // 测试失败或超时也执行：先按进程组兜底杀掉 runner 与工具并等 runner 被回收，再关客户端、假模型服务、删临时目录
  onTestFinished(async () => {
    finished = true;
    try {
      for (const g of groups) killGroup(g);
      await Promise.all(exits);
      await Promise.all(clients.map((c) => c.close()));
      await Promise.all(servers.map((s) => s.close()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** 启动者（engine-client 的 spawnRunner，与 t1-real-run 共用）：runner 放进独立进程组，等 stdout 的 RUNNER_LISTENING 行 */
  async function launch(turns: ScriptedTurn[], args: string[] = [], env: NodeJS.ProcessEnv = {}, stopTimeoutMs?: number) {
    const s = await startFakeOpenAIServer(turns);
    // 用例已结束（超时后的残留代码）：清理已经跑过，不再起新的服务与进程
    if (finished) {
      await s.close();
      throw new Error("test already finished");
    }
    servers.push(s);
    writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(s.baseUrl)));
    const runner = spawnRunner({
      args: ["--import", "tsx", MAIN, "--port", "0", "--models", p("model/models.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), "--idle-timeout-ms", "10000", ...args],
      // TMPDIR 指向测试根目录：引擎 scratchDir 建在 os.tmpdir() 下，便于断言跨进程清理
      env: { ...process.env, TMPDIR: p("tmp"), ...env },
      stopTimeoutMs,
    });
    if (runner.pid !== undefined) groups.push(runner.pid);
    exits.push(runner.exit);
    const port = await runner.listening;
    return { s, port, runner, exit: runner.exit, err: runner.stderr, listeningAt: performance.now() };
  }

  async function connect(r: { runner: RunnerProcess }) {
    const client = await r.runner.connect();
    clients.push(client);
    const events: SequencedEvent[] = [];
    const errors: ProtocolError[] = [];
    client.onEvent((e) => events.push(e));
    client.onError((e) => errors.push(e));
    return { client, events, errors };
  }

  const scratchLeft = () => readdirSync(p("tmp")).filter((n) => n.startsWith("fp-run-"));

  /** 工具不曾执行：runner 已退出，若退出前已派生了 detached 的 bash，touch 也会在毫秒级完成；等 500 ms 再看，避免它在断言之后才出现 */
  async function neverRan(marker: string) {
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(p("work", marker))).toBe(false);
  }

  /** 工具已在运行：读到 pid，且该进程组此刻存活（保证之后的“组已消失”不是空断言） */
  async function toolRunning() {
    const pid = await vi.waitFor(
      () => {
        const m = /^(\d+)\n$/.exec(existsSync(p("work/tool.pid")) ? readFileSync(p("work/tool.pid"), "utf8") : "");
        expect(m).not.toBeNull();
        return Number(m![1]);
      },
      { timeout: 8000, interval: 10 },
    );
    groups.push(pid);
    expect(groupAlive(pid)).toBe(true);
    return { pid, at: performance.now() };
  }

  /** 工具没有存活：进程组已消失；等过工具的睡眠时长后 marker 仍未出现 */
  async function toolGone(tool: { pid: number; at: number }) {
    await vi.waitFor(() => expect(groupAlive(tool.pid)).toBe(false), { timeout: 3000, interval: 20 });
    // 负断言必须等：若 sleep 逃过终止，marker 会在工具启动约 TOOL_SLEEP_S 秒后出现
    const wait = tool.at + TOOL_SLEEP_S * 1000 + 700 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    expect(existsSync(p("work/late.marker"))).toBe(false);
  }

  return { root, p, groups, exits, launch, connect, scratchLeft, neverRan, toolRunning, toolGone };
}

const task = (o: Partial<StartTask> = {}): Omit<StartTask, "type" | "requestId"> => ({
  sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" }, contextFiles: [], interceptMode: "callback", ...o,
});
// 工具先写下自己的 pid（pi 以 detached 启动，pid 即进程组号），睡眠后才写 marker：被正确终止时 marker 永不出现
const SLOW_TOOL = TOOL(`echo $$ > tool.pid; sleep ${TOOL_SLEEP_S}; touch late.marker`);
const SLOW_TEXT: ScriptedTurn[] = [{ kind: "text", chunks: Array.from({ length: 20 }, (_, i) => `t${i} `), chunkDelayMs: 200 }];
const allow = async () => ({ decision: "allow" as const });
const confirm = async () => ({ decision: "confirm" as const, reason: "needs human" });
const never = () => new Promise<never>(() => {});
// 断线后不等重连：取消清理 + 关闭连接（最多 1 秒）之后即退出
const DISCONNECT_EXIT_MS = 2500;

/** 唯一终止事件且在最后 */
function checkFlow(events: SequencedEvent[]) {
  expect(events.filter((e) => TERMINAL.has(e.type))).toHaveLength(1);
  expect(TERMINAL.has(events.at(-1)!.type)).toBe(true);
  return events.map((e) => e.type);
}

describe.sequential("runner 进程：正常结束与空闲退出", () => {
  it("正常结束：唯一 run.settled 在最后，此后无事件，进程 5 秒内以 0 退出，scratchDir 已清理", async () => {
    const { launch, connect, scratchLeft } = setup();
    const r = await launch([{ kind: "text", chunks: ["Hel", "lo"] }]);
    const { client, events, errors } = await connect(r);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    const endAt = performance.now();
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - endAt).toBeLessThan(5000);
    expect(checkFlow(events)).toEqual(["run.started", "text.delta", "text.delta", "model.request.finished", "message.completed", "run.settled"]);
    expect(errors).toEqual([]);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("无客户端：空闲超时后以 0 退出", async () => {
    const { launch } = setup();
    const r = await launch([], ["--idle-timeout-ms", "300"]);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - r.listeningAt).toBeLessThan(3000);
    expect(r.s.requests).toEqual([]);
  }, T);

  it("已连接但一直不启动：空闲超时后关闭连接并以 0 退出", async () => {
    const { launch, connect } = setup();
    const r = await launch([], ["--idle-timeout-ms", "300"]);
    const { client } = await connect(r);
    const connectedAt = performance.now();
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - connectedAt).toBeLessThan(3000);
    expect(r.s.requests).toEqual([]);
  }, T);
});

describe.sequential("runner 进程：取消与断线", () => {
  it("慢流时取消：run.cancelled，模型流未读完，以 0 退出", async () => {
    const { launch, connect, scratchLeft } = setup();
    const r = await launch(SLOW_TEXT);
    const { client, events } = await connect(r);
    client.onEvent((e) => {
      events.push(e);
      if (e.type === "text.delta" && events.filter((x) => x.type === "text.delta").length === 1) client.cancel();
    });
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect(events.filter((e) => e.type === "text.delta").length).toBeLessThan(20);
    expect((await r.exit).code).toBe(0);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("慢流时断线：客户端等待 reject（不伪造 run.cancelled），runner 取消并以 0 退出", async () => {
    const { launch, connect, scratchLeft } = setup();
    const r = await launch(SLOW_TEXT);
    const { client, events } = await connect(r);
    let closedAt = 0;
    client.onEvent((e) => {
      events.push(e);
      if (e.type === "text.delta" && !closedAt) (closedAt = performance.now()), void client.close();
    });
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    expect(events.some((e) => TERMINAL.has(e.type))).toBe(false);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    expect(r.s.stats.writes).toBeLessThan(20); // 20 个文本块全部写完至少 22 次写入
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("工具运行时取消：run.cancelled，工具进程组被终止、延迟 marker 不出现，以 0 退出", async () => {
    const { launch, connect, scratchLeft, toolRunning, toolGone } = setup();
    const r = await launch(SLOW_TOOL);
    const { client, events } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    const tool = await toolRunning();
    client.cancel();
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect((await r.exit).code).toBe(0);
    await toolGone(tool);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("工具运行时断线：runner 取消并以 0 退出，工具进程组被终止、延迟 marker 不出现", async () => {
    const { launch, connect, scratchLeft, toolRunning, toolGone } = setup();
    const r = await launch(SLOW_TOOL);
    const { client } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    const tool = await toolRunning();
    const closedAt = performance.now();
    await client.close();
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    expect(exit.at).toBeLessThan(tool.at + TOOL_SLEEP_S * 1000); // 没有等工具自然结束
    await toolGone(tool);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("等待决定时重复取消：只有一个 run.cancelled、无协议错误，工具不执行，以 0 退出", async () => {
    const { launch, connect, scratchLeft, neverRan } = setup();
    const r = await launch(TOOL("touch never.marker"));
    const { client, events, errors } = await connect(r);
    client.onIntercept(() => {
      client.cancel();
      client.cancel();
      return never();
    });
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect((await r.exit).code).toBe(0);
    expect(errors).toEqual([]);
    await neverRan("never.marker");
    expect(r.s.requests.length).toBe(1);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("等待决定时断线：以 0 退出，工具不执行", async () => {
    const { launch, connect, scratchLeft, neverRan } = setup();
    const r = await launch(TOOL("touch never.marker"));
    const { client } = await connect(r);
    let closedAt = 0;
    client.onIntercept(() => ((closedAt = performance.now()), void client.close(), never()));
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    await neverRan("never.marker");
    expect(r.s.requests.length).toBe(1);
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("等待确认时取消：run.cancelled，工具不执行，以 0 退出", async () => {
    const { launch, connect, scratchLeft, neverRan } = setup();
    const r = await launch(TOOL("touch never.marker"));
    const { client, events } = await connect(r);
    client.onIntercept(confirm);
    client.onConfirm(() => (client.cancel(), never()));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect((await r.exit).code).toBe(0);
    await neverRan("never.marker");
    expect(scratchLeft()).toEqual([]);
  }, T);

  it("等待确认时断线：以 0 退出，工具不执行", async () => {
    const { launch, connect, scratchLeft, neverRan } = setup();
    const r = await launch(TOOL("touch never.marker"));
    const { client } = await connect(r);
    client.onIntercept(confirm);
    let closedAt = 0;
    client.onConfirm(() => ((closedAt = performance.now()), void client.close(), never()));
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    await neverRan("never.marker");
    expect(scratchLeft()).toEqual([]);
  }, T);
});

describe.sequential("runner 进程：协议异常不影响任务", () => {
  it("迟到批准：确认超时按 block，之后到达的批准得到 stale_response，工具不执行，任务正常结束", async () => {
    const { p, launch, connect } = setup();
    // 第二轮模型回复放慢，保证迟到的批准到达时任务仍在运行
    const r = await launch([TOOL("touch denied.marker")[0], { kind: "text", chunks: ["a", "b", "c", "d", "e"], chunkDelayMs: 300 }], ["--confirm-timeout-ms", "200"]);
    const { client, events, errors } = await connect(r);
    client.onIntercept(confirm);
    client.onConfirm(() => new Promise((ok) => setTimeout(() => ok({ approved: true, by: "tester" }), 500)));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(errors).toEqual([expect.objectContaining({ code: "stale_response" })]);
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ isError: true });
    expect(existsSync(p("work/denied.marker"))).toBe(false);
    expect((await r.exit).code).toBe(0);
  }, T);

  it("运行中第二次启动：只拒绝第二次（already_running），原任务完成，以 0 退出", async () => {
    const { p, launch, connect } = setup();
    const r = await launch(TOOL("echo hi > ok.marker"));
    const { client, events, errors } = await connect(r);
    let second: Promise<string> | undefined;
    client.onIntercept(async () => {
      second = client.start(task({ sessionId: "s2" })).then(() => "accepted", (e: Error) => e.message);
      await second;
      return { decision: "allow" };
    });
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled", sessionId: "s1" });
    expect(await second).toMatch(/already_running/);
    expect(errors).toEqual([]);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set(["s1"]));
    expect(readFileSync(p("work/ok.marker"), "utf8")).toBe("hi\n");
    expect((await r.exit).code).toBe(0);
  }, T);

  it("错误 JSON：invalid_message 且无 requestId，runner 保持 idle 不退出，随后正常启动并以 0 退出", async () => {
    const { launch } = setup();
    // 9B 客户端发送前会校验，发不出非法 JSON：这里用 Node 内置 WebSocket 直接发原始帧
    const r = await launch([{ kind: "text", chunks: ["ok"] }]);
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
    const raw: string[] = [];
    // 监听器里只收集，断言放到外面：监听器里抛出的断言错误不会让测试失败
    const msgs = () =>
      raw.map((d) => {
        const parsed = parseRunnerMessage(d);
        expect(parsed.ok, d).toBe(true);
        return (parsed as { message: RunnerMessage }).message;
      });
    const closed = new Promise<number>((ok) => ws.addEventListener("close", (e) => ok(e.code)));
    ws.addEventListener("message", (e) => raw.push(String(e.data)));
    try {
      await new Promise((ok, fail) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", fail, { once: true }); });
      ws.send("{not json");
      await vi.waitFor(() => expect(msgs()).toEqual([expect.objectContaining({ type: "error", code: "invalid_message" })]));
      expect(msgs()[0]).not.toHaveProperty("requestId");
      ws.send(JSON.stringify({ ...task(), type: "start_task", requestId: "A" }));
      expect(await closed).toBe(1000);
      const ev = msgs().flatMap((m) => (m.type === "event" ? [m.event] : []));
      expect(checkFlow(ev).at(-1)).toBe("run.settled");
      expect((await r.exit).code).toBe(0);
    } finally {
      ws.close();
    }
  }, T);
});

describe.sequential("runner 进程：诊断文件打不开属于启动失败（engine.md 第一事件规则）", () => {
  it("诊断文件目录不存在：只发 run.failed，工具不执行，以 0 退出", async () => {
    const { p, launch, connect, neverRan } = setup();
    const r = await launch(TOOL("touch ran.marker"), ["--record-pi-events", p("no-such-dir/raw.jsonl")]);
    const { client, events } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/ENOENT.*no-such-dir/) });
    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
    expect((await r.exit).code).toBe(0);
    await neverRan("ran.marker");
  }, T);

  // 没有读端的 FIFO：打开卡在线程池里，既不成功也不失败
  it("诊断文件是无读端 FIFO：约 5 秒后发 run.failed（原因含 timed out），工具不执行", async () => {
    const { p, launch, connect, neverRan } = setup();
    execFileSync("mkfifo", [p("raw.fifo")]);
    const r = await launch(TOOL("touch ran.marker"), ["--record-pi-events", p("raw.fifo")]);
    const { client, events } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    const t0 = performance.now();
    const end = await client.waitForEnd();
    expect(end).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/timed out/) });
    expect((end as { reason: string }).reason).not.toMatch(/cleanup/);
    expect(performance.now() - t0).toBeGreaterThan(4500);
    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
    // 卡住的打开可能让 runner 无法自行退出：启动者到停止时限强杀也算通过
    const stopped = await r.runner.stop();
    expect(stopped.forced || stopped.code === 0).toBe(true);
    await neverRan("ran.marker");
  }, T_FIFO);

  it("等待打开时收到取消：立即以 run.cancelled 结束，工具不执行", async () => {
    const { p, launch, connect, neverRan } = setup();
    execFileSync("mkfifo", [p("raw.fifo")]);
    const r = await launch(TOOL("touch ran.marker"), ["--record-pi-events", p("raw.fifo")]);
    const { client, events } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    const t0 = performance.now();
    r.runner.cancel();
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(performance.now() - t0).toBeLessThan(2000); // 远短于 5 秒打开时限
    expect(events.map((e) => e.type)).toEqual(["run.cancelled"]);
    const stopped = await r.runner.stop();
    expect(stopped.forced || stopped.code === 0).toBe(true);
    await neverRan("ran.marker");
  }, T_FIFO);
});

describe.sequential("runner 进程：清理失败与超时（故障注入）", () => {
  // 读端在工具拦截时关闭：此时写端必已打开（打开先于会话创建），之后的录制写入得到 EPIPE
  it("清理失败（诊断文件读端关闭，写入 EPIPE）：run.failed 带清理原因，以 1 退出", async () => {
    const { p, launch, connect } = setup();
    const reader = fifoReader(p("raw.fifo"));
    const r = await launch(TOOL("true"), ["--record-pi-events", p("raw.fifo")]);
    const { client } = await connect(r);
    client.onIntercept(async () => (closeSync(reader), { decision: "allow" as const }));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed: .*EPIPE/) });
    expect((await r.exit).code).toBe(1);
    expect(r.err()).toMatch(/cleanup failed/);
  }, T);

  // 读端打开但不读、管道已写满：runner 的录制写入卡在线程池里，录制的 close 永不完成，清理必然超过 5 秒时限
  it("清理超时：run.failed 带超时原因；卡住的写入被解除后 runner 以 1 退出", async () => {
    const { p, launch, connect } = setup();
    const fd = fifoReader(p("raw.fifo"));
    fillFifo(p("raw.fifo"));
    const r = await launch([{ kind: "text", chunks: ["ok"] }], ["--record-pi-events", p("raw.fifo")]);
    const { client } = await connect(r);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed: timed out after 5000 ms/) });
    // 阻塞的系统调用会让 process.exit 卡在 libuv 线程池的回收上：持续读空管道解除阻塞，才能观察到 runner 自己给出的退出码。
    // 读端在 runner 退出前一直保持打开：关闭会让写入改得 EPIPE，不再是本测试要观察的路径
    const buf = Buffer.alloc(65536);
    const drain = setInterval(() => {
      try {
        while (readSync(fd, buf) > 0);
      } catch {} // EAGAIN：写端已打开但暂时没有数据
    }, 20);
    try {
      expect((await r.exit).code).toBe(1);
    } finally {
      clearInterval(drain);
      closeSync(fd);
    }
    expect(r.err()).toMatch(/cleanup failed/);
  }, T);

  it("清理超时且 runner 卡在退出：发出带原因的 run.failed；工具已由 pi 在卡住前结束；启动者到停止时限强杀 runner 组", async () => {
    const { p, groups, launch, connect, toolRunning, toolGone } = setup();
    const fd = fifoReader(p("raw.fifo"));
    fillFifo(p("raw.fifo"));
    try {
      const r = await launch(SLOW_TOOL, ["--record-pi-events", p("raw.fifo")]);
      const { client } = await connect(r);
      client.onIntercept(allow);
      await client.start(task());
      const tool = await toolRunning();
      const t0 = performance.now();
      r.runner.cancel();
      expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed: timed out after 5000 ms/) });
      // 清理顺序是 session.abort/dispose 在前、关闭录制在后：工具在录制卡住之前就被 pi 结束，与启动者无关（组强杀也够不到工具组）
      await toolGone(tool);
      // 启动者的停止时限（engine.md 进程退出，默认 10 秒，从发出取消起算）：到时未退出就强杀 runner 的整个进程组，按非零退出处理
      const stopped = await r.runner.stop();
      expect(stopped.forced || stopped.code === 1).toBe(true); // 卡在退出（强杀）或自行以 1 退出
      // 外部计时：终止事件约 5 秒后才到、stop() 更晚才调用，时限仍须从取消起算
      expect(stopped.at - t0).toBeLessThan(10_000 + 1000);
      expect(groupAlive(groups[0]!)).toBe(false);
    } finally {
      closeSync(fd);
    }
  }, T_FIFO);
});

const toolNames = (req: unknown) => (req as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name);
const sysPrompt = (req: unknown) => String((req as { messages: { role: string; content: unknown }[] }).messages.find((m) => m.role === "system")?.content);
const section = (text: string, name: string) => new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
const toolMessages = (req: unknown) => (req as { messages: { role: string; content: unknown }[] }).messages.filter((m) => m.role === "tool").map((m) => String(m.content));

describe.sequential("runner 进程：激活工具 --tools 与离线（engine.md 激活工具、外部程序与离线）", () => {
  it("未给 --tools：沿用 pi 默认 read/bash/edit/write", async () => {
    const { launch, connect } = setup();
    const r = await launch([{ kind: "text", chunks: ["ok"] }]);
    const { client } = await connect(r);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(toolNames(r.s.requests[0])).toEqual(["read", "bash", "edit", "write"]);
    expect((await r.exit).code).toBe(0);
  }, T);

  it("--tools read,grep：请求只声明这两个工具，系统提示 tools/rules 段随之变化、rules 段没有 bash 规则", async () => {
    const { launch, connect } = setup();
    const r = await launch([{ kind: "text", chunks: ["ok"] }], ["--tools", "read,grep"]);
    const { client } = await connect(r);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(toolNames(r.s.requests[0])).toEqual(["read", "grep"]);
    const sys = sysPrompt(r.s.requests[0]);
    expect(section(sys, "tools")).toMatch(/^- read: .*\n- grep: /);
    const rules = section(sys, "rules")!;
    expect(rules).toBeDefined();
    expect(rules).not.toMatch(/bash/i);
    expect(rules).toContain("Use read to examine files");
    expect((await r.exit).code).toBe(0);
  }, T);

  it.each(["", "nope", "read,nope", "read,", "read,*", "*", "+read", "-bash", "mcp__x", "READ"])("--tools %j：不监听、非零退出、stderr 说明原因", async (tools) => {
    const { p, groups, exits } = setup();
    const runner = spawnRunner({
      args: ["--import", "tsx", MAIN, "--port", "0", "--models", p("model/models.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), `--tools=${tools}`], // = 形式：parseArgs 不会把 -bash 当成选项
      env: { ...process.env, TMPDIR: p("tmp") },
    });
    if (runner.pid !== undefined) groups.push(runner.pid);
    exits.push(runner.exit);
    await expect(runner.listening).rejects.toThrow(/before listening/);
    expect((await runner.exit).code).not.toBe(0);
    expect(runner.stderr()).toMatch(/^runner: --tools /m); // 不是 parseArgs 的 Unknown option
  }, T);

  // 思考级别（engine.md 思考级别）：模型条目须 reasoning:true 加 qwen compat，否则 pi 把级别降为 off，测不出透传
  it("--thinking low 透传为 pi 会话思考级别；未给时为 off", async () => {
    const { p, launch, connect } = setup();
    for (const [args, on] of [[["--thinking", "low"], true], [[], false]] as const) {
      const r = await launch([{ kind: "text", chunks: ["ok"] }], [...args]);
      const cfg = fakeModelsJson(r.s.baseUrl) as { providers: { fake: { compat: object; models: object[] } } };
      Object.assign(cfg.providers.fake.compat, { thinkingFormat: "qwen" });
      Object.assign(cfg.providers.fake.models[0]!, { reasoning: true });
      writeFileSync(p("model/models.json"), JSON.stringify(cfg)); // 任务开始时才读模型配置
      const { client } = await connect(r);
      await client.start(task());
      expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
      expect(r.s.requests[0]).toMatchObject({ enable_thinking: on });
      expect((await r.exit).code).toBe(0);
    }
  }, T);

  it.each(["", "LOW", "none", "on", "low,high", "2048"])("--thinking %j：不监听、非零退出、stderr 说明原因", async (level) => {
    const { p, groups, exits } = setup();
    const runner = spawnRunner({
      args: ["--import", "tsx", MAIN, "--port", "0", "--models", p("model/models.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), `--thinking=${level}`],
      env: { ...process.env, TMPDIR: p("tmp") },
    });
    if (runner.pid !== undefined) groups.push(runner.pid);
    exits.push(runner.exit);
    await expect(runner.listening).rejects.toThrow(/before listening/);
    expect((await runner.exit).code).not.toBe(0);
    expect(runner.stderr()).toMatch(/^runner: --thinking /m);
  }, T);

  // PATH 是空目录（Linux 发行版的 rg 常在 /usr/bin，不能靠去掉 /opt/homebrew 模拟缺 rg）；runner 用 process.execPath 启动，不经 PATH 找 node。
  // HOME 与 PI_CODING_AGENT_DIR 指向空目录：pi 若联网下载，会写到 agent 目录的 bin 下
  it("缺 rg 时 grep 以错误结果返回，不下载、不写 HOME/.pi", async () => {
    const { p, launch, connect } = setup();
    for (const d of ["bin", "home", "agent"]) mkdirSync(p(d));
    const r = await launch(
      [{ kind: "toolCall", name: "grep", args: { pattern: "x" }, id: "g1" }, { kind: "text", chunks: ["done"] }],
      ["--tools", "read,grep"],
      { PATH: p("bin"), HOME: p("home"), PI_CODING_AGENT_DIR: p("agent") },
    );
    const { client } = await connect(r);
    client.onIntercept(allow);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(toolMessages(r.s.requests[1])).toEqual([expect.stringMatching(/ripgrep \(rg\) is not available/)]);
    expect(readdirSync(p("home"))).toEqual([]);
    expect(readdirSync(p("agent"))).toEqual([]);
    expect((await r.exit).code).toBe(0);
  }, T);
});

describe.sequential("启动者：停止时限只从退出信号起算（engine.md 进程退出）", () => {
  // 启动被拒绝不是退出信号：任务比停止时限跑得久，若从拒绝起算，stop() 时已过时限而强杀正常收尾的 runner
  it("启动被拒（not_implemented / 本地校验失败）后在同一连接重试并正常结束：stop() 不强杀，以 0 退出", async () => {
    const { launch, connect } = setup();
    // 模型流约 4.5 秒，明显长于 3 秒停止时限：从拒绝起算必然已过时限
    const r = await launch([{ kind: "text", chunks: Array.from({ length: 15 }, (_, i) => `c${i} `), chunkDelayMs: 300 }], [], {}, 3000);
    const { client } = await connect(r);
    await expect(client.start(task({ interceptMode: "policy" }))).rejects.toThrow(/not_implemented/);
    await expect(client.start(task({ prompt: " " }))).rejects.toThrow(/prompt/);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    const stopped = await r.runner.stop();
    expect(stopped).toMatchObject({ forced: false, code: 0 });
    expect(stopped.signal).not.toBe("SIGKILL");
  }, T);
});

describe.sequential("启动者：runner 进程未能启动", () => {
  // 不存在的 cwd 让 spawn 发 error（ENOENT）而不发 exit，与找不到可执行文件同一路径
  it("listening 带原因 reject、exit 结算、stop 立即返回且不强杀、connect reject，调用方进程不崩溃", async () => {
    const { p } = setup();
    const runner = spawnRunner({ args: [MAIN], cwd: p("no-such-dir") });
    expect(runner.pid).toBeUndefined();
    await expect(runner.listening).rejects.toThrow(/ENOENT/);
    expect(await runner.exit).toMatchObject({ code: null, signal: null, error: expect.objectContaining({ code: "ENOENT" }) });
    await expect(runner.connect()).rejects.toThrow(/ENOENT/);
    runner.terminate();
    const t0 = performance.now();
    expect(await runner.stop()).toMatchObject({ forced: false, code: null });
    expect(performance.now() - t0).toBeLessThan(500);
  }, T);
});
