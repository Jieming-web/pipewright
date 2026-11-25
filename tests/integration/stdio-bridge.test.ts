import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeModelsJson, startFakeOpenAIServer, TOOL, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 桥是真实子进程（构建产物，与 runner 一样），经 stdin/stdout 说话；假模型服务代替真模型
const BRIDGE = join(import.meta.dirname, "../../packages/engine-client/dist/stdio-bridge.js");
const RUNNER = join(import.meta.dirname, "../../packages/engine-runner/dist/main.js");

let root: string;
let servers: FakeOpenAIServer[];
let bridges: ChildProcessWithoutNullStreams[];
const p = (...s: string[]) => join(root, ...s);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-sb-")));
  for (const d of ["work", "sessions"]) mkdirSync(p(d));
  servers = [];
  bridges = [];
});
afterEach(async () => {
  for (const b of bridges) b.kill("SIGKILL");
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true });
});

async function launch(turns: ScriptedTurn[]) {
  const s = await startFakeOpenAIServer(turns);
  servers.push(s);
  writeFileSync(p("models.json"), JSON.stringify(fakeModelsJson(s.baseUrl)));
  const b = spawn(process.execPath, [BRIDGE, "--runner", RUNNER, "--", "--port", "0", "--models", p("models.json"), "--workdir", p("work"), "--sessions-root", p("sessions"), "--idle-timeout-ms", "10000"], { env: { ...process.env, TMPDIR: root } });
  bridges.push(b);
  const lines: string[] = [];
  let err = "";
  b.stderr.on("data", (d) => (err += d));
  const waiters: (() => void)[] = [];
  createInterface({ input: b.stdout }).on("line", (l) => {
    lines.push(l);
    waiters.splice(0).forEach((w) => w());
  });
  const exit = new Promise<number | null>((ok) => b.on("close", (code) => ok(code)));
  const send = (m: unknown) => b.stdin.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
  /** 读到满足条件的下一行（含已到的），返回其解析结果 */
  const until = async (type: string) => {
    for (;;) {
      for (; seen < lines.length; seen++) {
        const m = JSON.parse(lines[seen]!);
        if ((m.type === "event" ? m.event.type : m.type) === type) return (seen++, m);
      }
      await Promise.race([new Promise<void>((ok) => waiters.push(ok)), new Promise<void>((_, no) => setTimeout(() => no(new Error(`timeout waiting ${type}; got ${lines.join("|")}; stderr ${err}`)), 15000))]);
    }
  };
  let seen = 0;
  return { b, lines, send, until, exit, err: () => err };
}

const START = { type: "start_task", requestId: "A", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" }, contextFiles: [], interceptMode: "callback" };

describe.sequential("stdio 桥", () => {
  it("start_task → accepted → 事件 → run.settled，每条消息一行；EOF 后以 runner 的退出码 0 退出", async () => {
    const r = await launch([{ kind: "text", chunks: ["Hel", "lo"] }]);
    r.send(START);
    expect(await r.until("accepted")).toMatchObject({ requestId: "A" });
    await r.until("run.settled");
    r.b.stdin.end();
    expect(await r.exit).toBe(0);
    for (const l of r.lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.lines.map((l) => JSON.parse(l).type)).toContain("event");
  }, 30000);

  it("callback 拦截一来一回之后工具才执行", async () => {
    const r = await launch(TOOL("touch ran.marker"));
    r.send(START);
    const req = await r.until("intercept_request");
    expect(existsSync(p("work/ran.marker"))).toBe(false);
    r.send({ type: "intercept_decision", requestId: "D1", callId: req.callId, decision: "allow" });
    await r.until("run.settled");
    expect(existsSync(p("work/ran.marker"))).toBe(true);
    r.b.stdin.end();
    expect(await r.exit).toBe(0);
  }, 30000);

  it("非法 JSON 行原样转发，stdout 收到 invalid_message", async () => {
    const r = await launch([]);
    r.send("{not json");
    expect(await r.until("error")).toMatchObject({ code: "invalid_message" });
    r.b.stdin.end();
    expect(await r.exit).toBe(0);
  }, 30000);

  it("runner 在监听前退出：写出其 stderr，以其退出码退出", async () => {
    const b = spawn(process.execPath, [BRIDGE, "--runner", RUNNER, "--", "--port", "0"]);
    let err = "";
    b.stderr.on("data", (d) => (err += d));
    const code = await new Promise((ok) => b.on("close", ok));
    expect(code).not.toBe(0);
    expect(err.length).toBeGreaterThan(0);
  }, 30000);
});
