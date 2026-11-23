import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineClient } from "../../packages/engine-client/src/index.js";
import { parseRunnerMessage, type ProtocolError, type RunnerMessage, type SequencedEvent, type StartTask } from "../../packages/engine-protocol/src/index.js";
import { fakeModelsJson, startFakeOpenAIServer, TOOL, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 跨真实子进程边界：9A CLI 启动 runner，9B 客户端调用。退出证据只用退出码、工具进程组、延迟 marker 与临时目录，不加产品诊断消息
const MAIN = join(import.meta.dirname, "../../packages/engine-runner/src/main.ts");
const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
const TOOL_SLEEP_S = 2;

let root: string;
let servers: FakeOpenAIServer[];
let clients: EngineClient[];
// afterEach 强杀的进程组：runner 组（启动者职责）；工具组是测试独有的兜底（经 tool.pid 得知），真实启动者拿不到（engine.md 工具进程）
let groups: number[];
let exits: Promise<unknown>[];
const p = (...s: string[]) => join(root, ...s);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-rp-")));
  for (const d of ["model", "work", "sessions", "tmp"]) mkdirSync(p(d));
  servers = [];
  clients = [];
  groups = [];
  exits = [];
});
// 测试失败也执行：先按进程组兜底杀掉 runner 与工具并等 runner 被回收，再关客户端、假模型服务、删临时目录
afterEach(async () => {
  try {
    for (const g of groups) kill(g);
    await Promise.all(exits);
    await Promise.all(clients.map((c) => c.close()));
    await Promise.all(servers.map((s) => s.close()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// macOS 上组内只剩未回收的僵尸时 kill(-pgid) 报 EPERM：视同没有存活进程
const gone = (e: unknown) => ["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code!);
function kill(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch (e) {
    if (!gone(e)) throw e;
  }
}
function groupAlive(group: number) {
  try {
    process.kill(-group, 0);
    return true;
  } catch (e) {
    if (gone(e)) return false;
    throw e;
  }
}

/** 启动者：runner 放进独立进程组（detached），等 stdout 的 RUNNER_LISTENING 行 */
async function launch(turns: ScriptedTurn[], args: string[] = []) {
  const s = await startFakeOpenAIServer(turns);
  servers.push(s);
  writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(s.baseUrl)));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", MAIN, "--port", "0", "--models", p("model/models.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), "--idle-timeout-ms", "10000", ...args],
    // TMPDIR 指向测试根目录：引擎 scratchDir 建在 os.tmpdir() 下，便于断言跨进程清理
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: p("tmp") } },
  );
  groups.push(child.pid!);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exit = new Promise<{ code: number | null; at: number }>((r) => child.on("exit", (code) => r({ code, at: Date.now() })));
  exits.push(exit);
  const port = await vi.waitFor(
    () => {
      const m = /^RUNNER_LISTENING (\d+)\n$/.exec(out);
      expect(m, err).not.toBeNull();
      return Number(m![1]);
    },
    { timeout: 10_000, interval: 20 },
  );
  return { s, port, exit, err: () => err, listeningAt: Date.now() };
}

async function connect(port: number) {
  const client = await EngineClient.connect(`ws://127.0.0.1:${port}`);
  clients.push(client);
  const events: SequencedEvent[] = [];
  const errors: ProtocolError[] = [];
  client.onEvent((e) => events.push(e));
  client.onError((e) => errors.push(e));
  return { client, events, errors };
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
const scratchLeft = () => readdirSync(p("tmp")).filter((n) => n.startsWith("fp-run-"));
// 断线后不等重连：取消清理 + 关闭连接（最多 1 秒）之后即退出
const DISCONNECT_EXIT_MS = 2500;

/** 工具不曾执行：runner 已退出，若退出前已派生了 detached 的 bash，touch 也会在毫秒级完成；等 500 ms 再看，避免它在断言之后才出现 */
async function neverRan(marker: string) {
  await new Promise((r) => setTimeout(r, 500));
  expect(existsSync(p("work", marker))).toBe(false);
}

/** 唯一终止事件且在最后 */
function checkFlow(events: SequencedEvent[]) {
  expect(events.filter((e) => TERMINAL.has(e.type))).toHaveLength(1);
  expect(TERMINAL.has(events.at(-1)!.type)).toBe(true);
  return events.map((e) => e.type);
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
  return { pid, at: Date.now() };
}

/** 工具没有存活：进程组已消失；等过工具的睡眠时长后 marker 仍未出现 */
async function toolGone(tool: { pid: number; at: number }) {
  await vi.waitFor(() => expect(groupAlive(tool.pid)).toBe(false), { timeout: 3000, interval: 20 });
  // 负断言必须等：若 sleep 逃过终止，marker 会在工具启动约 TOOL_SLEEP_S 秒后出现
  const wait = tool.at + TOOL_SLEEP_S * 1000 + 700 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  expect(existsSync(p("work/late.marker"))).toBe(false);
}

describe.sequential("runner 进程：正常结束与空闲退出", () => {
  it("正常结束：唯一 run.settled 在最后，此后无事件，进程 5 秒内以 0 退出，scratchDir 已清理", async () => {
    const r = await launch([{ kind: "text", chunks: ["Hel", "lo"] }]);
    const { client, events, errors } = await connect(r.port);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    const endAt = Date.now();
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - endAt).toBeLessThan(5000);
    expect(checkFlow(events)).toEqual(["run.started", "text.delta", "text.delta", "message.completed", "run.settled"]);
    expect(errors).toEqual([]);
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("无客户端：空闲超时后以 0 退出", async () => {
    const r = await launch([], ["--idle-timeout-ms", "300"]);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - r.listeningAt).toBeLessThan(3000);
    expect(r.s.requests).toEqual([]);
  }, 20_000);

  it("已连接但一直不启动：空闲超时后关闭连接并以 0 退出", async () => {
    const r = await launch([], ["--idle-timeout-ms", "300"]);
    const { client } = await connect(r.port);
    const connectedAt = Date.now();
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - connectedAt).toBeLessThan(3000);
    expect(r.s.requests).toEqual([]);
  }, 20_000);
});

describe.sequential("runner 进程：取消与断线", () => {
  it("慢流时取消：run.cancelled，模型流未读完，以 0 退出", async () => {
    const r = await launch(SLOW_TEXT);
    const { client, events } = await connect(r.port);
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
  }, 20_000);

  it("慢流时断线：客户端等待 reject（不伪造 run.cancelled），runner 取消并以 0 退出", async () => {
    const r = await launch(SLOW_TEXT);
    const { client, events } = await connect(r.port);
    let closedAt = 0;
    client.onEvent((e) => {
      events.push(e);
      if (e.type === "text.delta" && !closedAt) (closedAt = Date.now()), void client.close();
    });
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    expect(events.some((e) => TERMINAL.has(e.type))).toBe(false);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    expect(r.s.stats.writes).toBeLessThan(20); // 20 个文本块全部写完至少 22 次写入
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("工具运行时取消：run.cancelled，工具进程组被终止、延迟 marker 不出现，以 0 退出", async () => {
    const r = await launch(SLOW_TOOL);
    const { client, events } = await connect(r.port);
    client.onIntercept(allow);
    await client.start(task());
    const tool = await toolRunning();
    client.cancel();
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect((await r.exit).code).toBe(0);
    await toolGone(tool);
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("工具运行时断线：runner 取消并以 0 退出，工具进程组被终止、延迟 marker 不出现", async () => {
    const r = await launch(SLOW_TOOL);
    const { client } = await connect(r.port);
    client.onIntercept(allow);
    await client.start(task());
    const tool = await toolRunning();
    const closedAt = Date.now();
    await client.close();
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    expect(exit.at).toBeLessThan(tool.at + TOOL_SLEEP_S * 1000); // 没有等工具自然结束
    await toolGone(tool);
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("等待决定时重复取消：只有一个 run.cancelled、无协议错误，工具不执行，以 0 退出", async () => {
    const r = await launch(TOOL("touch never.marker"));
    const { client, events, errors } = await connect(r.port);
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
  }, 20_000);

  it("等待决定时断线：以 0 退出，工具不执行", async () => {
    const r = await launch(TOOL("touch never.marker"));
    const { client } = await connect(r.port);
    let closedAt = 0;
    client.onIntercept(() => ((closedAt = Date.now()), void client.close(), never()));
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    await neverRan("never.marker");
    expect(r.s.requests.length).toBe(1);
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("等待确认时取消：run.cancelled，工具不执行，以 0 退出", async () => {
    const r = await launch(TOOL("touch never.marker"));
    const { client, events } = await connect(r.port);
    client.onIntercept(confirm);
    client.onConfirm(() => (client.cancel(), never()));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.cancelled" });
    expect(checkFlow(events).at(-1)).toBe("run.cancelled");
    expect((await r.exit).code).toBe(0);
    await neverRan("never.marker");
    expect(scratchLeft()).toEqual([]);
  }, 20_000);

  it("等待确认时断线：以 0 退出，工具不执行", async () => {
    const r = await launch(TOOL("touch never.marker"));
    const { client } = await connect(r.port);
    client.onIntercept(confirm);
    let closedAt = 0;
    client.onConfirm(() => ((closedAt = Date.now()), void client.close(), never()));
    await client.start(task());
    await expect(client.waitForEnd()).rejects.toThrow(/closed/);
    const exit = await r.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - closedAt).toBeLessThan(DISCONNECT_EXIT_MS);
    await neverRan("never.marker");
    expect(scratchLeft()).toEqual([]);
  }, 20_000);
});

describe.sequential("runner 进程：协议异常不影响任务", () => {
  it("迟到批准：确认超时按 block，之后到达的批准得到 stale_response，工具不执行，任务正常结束", async () => {
    // 第二轮模型回复放慢，保证迟到的批准到达时任务仍在运行
    const r = await launch([TOOL("touch denied.marker")[0], { kind: "text", chunks: ["a", "b", "c", "d", "e"], chunkDelayMs: 300 }], ["--confirm-timeout-ms", "200"]);
    const { client, events, errors } = await connect(r.port);
    client.onIntercept(confirm);
    client.onConfirm(() => new Promise((ok) => setTimeout(() => ok({ approved: true, by: "tester" }), 500)));
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.settled" });
    expect(errors).toEqual([expect.objectContaining({ code: "stale_response" })]);
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ isError: true });
    expect(existsSync(p("work/denied.marker"))).toBe(false);
    expect((await r.exit).code).toBe(0);
  }, 20_000);

  it("运行中第二次启动：只拒绝第二次（already_running），原任务完成，以 0 退出", async () => {
    const r = await launch(TOOL("echo hi > ok.marker"));
    const { client, events, errors } = await connect(r.port);
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
  }, 20_000);

  it("错误 JSON：invalid_message 且无 requestId，runner 保持 idle 不退出，随后正常启动并以 0 退出", async () => {
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
  }, 20_000);
});

describe.sequential("runner 进程：清理失败与超时（故障注入）", () => {
  it("清理失败（诊断文件目录不存在）：run.failed 带清理原因，以 1 退出", async () => {
    const r = await launch([{ kind: "text", chunks: ["ok"] }], ["--record-pi-events", p("no-such-dir/raw.jsonl")]);
    const { client } = await connect(r.port);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed/) });
    expect((await r.exit).code).toBe(1);
    expect(r.err()).toMatch(/cleanup failed/);
  }, 20_000);

  // 故障注入不加产品开关：诊断文件指向没有读端的 FIFO，runner 打开它的线程池线程一直阻塞，录制的 close 永不完成，清理必然超过 5 秒时限
  it("清理超时：run.failed 带超时原因；卡住的打开被解除后 runner 以 1 退出", async () => {
    execFileSync("mkfifo", [p("raw.fifo")]);
    const r = await launch([{ kind: "text", chunks: ["ok"] }], ["--record-pi-events", p("raw.fifo")]);
    const { client } = await connect(r.port);
    await client.start(task());
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed: timed out after 5000 ms/) });
    // 阻塞的系统调用会让 process.exit 卡在 libuv 线程池的回收上：以非阻塞方式打开读端解除阻塞并持续读空，才能观察到 runner 自己给出的退出码。
    // 读端在 runner 退出前一直保持打开：读到 EOF 就关闭会与写端的打开竞态，写端又会阻塞
    const fd = openSync(p("raw.fifo"), constants.O_RDONLY | constants.O_NONBLOCK);
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
  }, 20_000);

  it("清理超时且 runner 卡在退出：发出带原因的 run.failed；工具已由 pi 在卡住前结束；启动者到停止时限强杀 runner 组", async () => {
    execFileSync("mkfifo", [p("raw.fifo")]);
    const r = await launch(SLOW_TOOL, ["--record-pi-events", p("raw.fifo")]);
    const { client } = await connect(r.port);
    client.onIntercept(allow);
    await client.start(task());
    const tool = await toolRunning();
    const t0 = Date.now();
    client.cancel();
    expect(await client.waitForEnd()).toMatchObject({ type: "run.failed", reason: expect.stringMatching(/cleanup failed: timed out after 5000 ms/) });
    // 清理顺序是 session.abort/dispose 在前、关闭录制在后：工具在 FIFO 卡住之前就被 pi 结束，与启动者无关（组强杀也够不到工具组）
    await toolGone(tool);
    // 启动者的停止时限（engine.md 进程退出，默认 10 秒）：到时未退出就强杀 runner 的整个进程组，按非零退出处理
    const exit = await Promise.race([r.exit, new Promise<undefined>((ok) => setTimeout(ok, 10_000 - (Date.now() - t0)))]);
    expect([undefined, 1]).toContain(exit?.code); // 卡在退出（undefined）或自行以 1 退出
    kill(groups[0]);
    await r.exit;
    expect(groupAlive(groups[0])).toBe(false);
  }, 30_000);
});
