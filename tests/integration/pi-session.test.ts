import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartTask } from "../../packages/engine-protocol/src/index.js";
import type { FinalDecision } from "../../packages/engine-runner/src/intercept-coordinator.js";
import { loadModelRuntime } from "../../packages/engine-runner/src/model-config.js";
import { createPiSession, PI_BUILTIN_TOOLS } from "../../packages/engine-runner/src/pi-session.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 与 runner 进程同一设置（engine.md 外部程序与离线）：本文件在进程内建会话，缺 rg 时也不得下载到 ~/.pi
process.env.PI_OFFLINE = "1";
const FIXTURE = join(import.meta.dirname, "../fixtures/hostile-repo");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RULES = [{ repo: "alpha", path: "AGENTS.md", content: "CALLER_RULE_ALPHA 先跑测试", sourceCommit: "c1" }];
const TEXT: ScriptedTurn[] = [{ kind: "text", chunks: ["ok"] }];
const EXAMPLE = join(import.meta.dirname, "../../config/models.example.json");
const QWEN = JSON.parse(readFileSync(EXAMPLE, "utf8")).providers["qwen-api"];

let root: string;
let servers: FakeOpenAIServer[];
const p = (...s: string[]) => join(root, ...s);
const saved = process.env.FP_TEST_KEY;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-ps-")));
  for (const d of ["scratch", "model", "work", "sessions"]) mkdirSync(p(d));
  servers = [];
});
afterEach(async () => {
  try {
    await Promise.all(servers.map((s) => s.close()));
    if (saved === undefined) delete process.env.FP_TEST_KEY; else process.env.FP_TEST_KEY = saved;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const serve = async (turns: ScriptedTurn[]) => { const s = await startFakeOpenAIServer(turns); servers.push(s); return s; };
const writeModels = (providers: Record<string, object>) => writeFileSync(p("model/models.json"), JSON.stringify({ providers }));
const fakeProvider = (baseUrl: string, patch: object = {}) => ({ ...(fakeModelsJson(baseUrl) as any).providers.fake, ...patch });
const task = (o: Partial<StartTask> = {}): StartTask => ({
  type: "start_task", requestId: "r1", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" },
  contextFiles: RULES, interceptMode: "callback", ...o,
});
const allow = () => vi.fn(async (): Promise<FinalDecision> => ({ decision: "allow" }));

async function open(o: { task?: StartTask; decide?: ReturnType<typeof allow>; workDir?: string; sessionsRoot?: string; tools?: string[] } = {}) {
  return createPiSession({
    task: o.task ?? task(), modelsPath: p("model/models.json"), workDir: o.workDir ?? p("work"), scratchDir: p("scratch"), tools: o.tools,
    sessionsRoot: o.sessionsRoot ?? p("sessions"), decide: o.decide ?? allow(), signal: new AbortController().signal,
  });
}
const sysText = (req: any) =>
  req.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
/** 递归列出 dir 下所有文件（相对路径） */
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

describe.sequential("createPiSession", () => {
  it("两份 fake provider 配置命中各自的假服务，snapshot.model 是实际注册的模型", async () => {
    const a = await serve(TEXT), b = await serve(TEXT);
    writeModels({ fakeA: fakeProvider(a.baseUrl), fakeB: fakeProvider(b.baseUrl) });
    for (const prov of ["fakeA", "fakeB"]) {
      const { session, snapshot } = await open({ task: task({ model: { provider: prov, id: "fake-model" } }) });
      expect(snapshot.model).toEqual({ provider: prov, id: "fake-model" });
      expect(snapshot.engine).toEqual({ name: "pi", version: VERSION });
      expect(session.model?.provider).toBe(prov);
      await session.prompt("go");
      session.dispose();
    }
    expect(a.requests.length).toBe(1);
    expect(b.requests.length).toBe(1);
  });

  it("workDir 只影响工具；contextFiles 的 sha256 与首个请求里的规则一致；请求数等于脚本轮数", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "pwd" }, id: "call_1" }, { kind: "text", chunks: ["done"] }]);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const decide = allow();
    const { session, snapshot } = await open({ decide });
    await session.prompt("go");
    session.dispose();
    expect(s.errors).toEqual([]);
    expect(s.requests.length).toBe(2); // cacheWarming=off：没有多余请求
    expect(JSON.stringify((s.requests[1] as any).messages.find((m: any) => m.role === "tool"))).toContain(p("work"));
    expect(sysText(s.requests[0])).toContain(RULES[0].content);
    expect(snapshot.contextFiles).toEqual([{ repo: "alpha", path: "AGENTS.md", sourceCommit: "c1", sha256: sha(RULES[0].content) }]);
    expect(decide).toHaveBeenCalledTimes(1); // 拦截扩展从创建起就在
  });

  it("bash 调用经过 decide，被拦截时不执行", async () => {
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "touch blocked.txt" }, id: "call_1" }, { kind: "text", chunks: ["done"] }]);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const decide = vi.fn(async (): Promise<FinalDecision> => ({ decision: "block", reason: "NO_BASH" }));
    const { session } = await open({ decide });
    await session.prompt("go");
    session.dispose();
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "bash", callId: "call_1" }), expect.anything());
    expect(existsSync(p("work/blocked.txt"))).toBe(false);
    expect(JSON.stringify(s.requests[1])).toContain("NO_BASH");
  });

  it("端到端：敌意仓库作为 workDir，工具列表与 shell 前缀不受影响，项目不受信任", async () => {
    cpSync(FIXTURE, p("work"), { recursive: true });
    const s = await serve([{ kind: "toolCall", name: "bash", args: { command: "echo hi" }, id: "call_1" }, { kind: "text", chunks: ["done"] }]);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const { session } = await open(); // 不传 tools：defaultTools 若生效会被看到
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
    expect(session.getActiveToolNames()).toContain("bash");
    expect(session.getActiveToolNames()).not.toEqual(["ls"]);
    await session.prompt("go");
    session.dispose();
    expect((s.requests[0] as any).tools.map((t: any) => t.function.name)).toContain("bash");
    const toolMsg = JSON.stringify((s.requests[1] as any).messages.find((m: any) => m.role === "tool"));
    expect(toolMsg).toContain("hi");
    expect(toolMsg).not.toContain("HOSTILE_SHELL_PREFIX");
    expect(JSON.stringify(s.requests)).not.toContain("HOSTILE_");
  });

  it("qwen 风格配置（compat + reasoning:true）发送 enable_thinking:false", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl, { compat: QWEN.compat, models: [{ ...QWEN.models[0], id: "fake-model" }] }) });
    const { session } = await open();
    await session.prompt("go");
    session.dispose();
    expect((s.requests[0] as any).enable_thinking).toBe(false);
  });

  it("API key 只从环境引用获得；缺密钥报明确错误", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl, { apiKey: "$FP_TEST_KEY" }) });
    delete process.env.FP_TEST_KEY;
    await expect(open()).rejects.toThrow(/FP_TEST_KEY/);
    process.env.FP_TEST_KEY = "from-env";
    const { session } = await open();
    await session.prompt("go");
    session.dispose();
    expect(s.requests.length).toBe(1);
  });

  it("缺少模型时报明确错误", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    await expect(open({ task: task({ model: { provider: "fake", id: "nope" } }) })).rejects.toThrow(/model not found.*fake\/nope/);
    expect(s.requests.length).toBe(0);
  });

  it("loadModelRuntime 返回 ModelRuntime 并暴露已注册模型", async () => {
    writeModels({ fake: fakeProvider("http://127.0.0.1:1/v1") });
    expect((await loadModelRuntime(p("model/models.json"), p("scratch"))).getModel("fake", "fake-model")?.id).toBe("fake-model");
  });

  it("加载配置不在 models 文件目录写任何文件，pi 状态文件落在 stateDir", async () => {
    mkdirSync(p("cfg")); mkdirSync(p("state"));
    cpSync(EXAMPLE, p("cfg/models.example.json"));
    const rt = await loadModelRuntime(p("cfg/models.example.json"), p("state"));
    for (const [prov, id] of [["fake", "fake-model"], ["qwen-api", "qwen3.6-35b-a3b"], ["ollama", "qwen3-4b-instruct-2507-ctx16k"]]) expect(rt.getModel(prov, id)?.id).toBe(id);
    await rt.setRuntimeApiKey("fake", "k"); // 触发 pi 写状态的路径之一
    expect(readdirSync(p("cfg"))).toEqual(["models.example.json"]);
    expect(readdirSync(p("state")).length).toBeGreaterThan(0);
  });

  it("默认内存会话：不写任何会话文件", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const { session } = await open();
    await session.prompt("go");
    session.dispose();
    expect(session.sessionFile).toBeUndefined();
    expect(files(p("sessions"))).toEqual([]);
  });

  it("指定 sessionDir 使用 pi 持久化，清理后文件仍在 sessionsRoot 内", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const { session } = await open({ task: task({ sessionDir: "run1/nested" }) });
    await session.prompt("go");
    const file = session.sessionFile!;
    session.dispose();
    expect(file.startsWith(p("sessions/run1/nested"))).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("go");
  });

  it("名为 ..foo 的合法子目录被接受并留在根内", async () => {
    const s = await serve(TEXT);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const { session } = await open({ task: task({ sessionDir: "..foo/run1" }) });
    await session.prompt("go");
    const file = session.sessionFile!;
    session.dispose();
    expect(file.startsWith(p("sessions/..foo/run1"))).toBe(true);
  });

  it("runner 自带的内置工具名单与 pi 内部 allToolNames 一致（pi 未导出它，按文件路径导入，防升级漂移）", async () => {
    const pkg = realpathSync(join(import.meta.dirname, "../../packages/engine-runner/node_modules/@earendil-works/pi-coding-agent"));
    const { allToolNames } = await import(join(pkg, "dist/core/tools/index.js"));
    expect([...PI_BUILTIN_TOOLS].sort()).toEqual([...allToolNames].sort());
  });

  // 真实 pi grep + PATH 上的 rg：遍历时不跟随软链接（无 -L），副本内指向外部的文件和目录链接都搜不到
  it("tools 传入激活工具；grep 搜索 . 时不跟随指向工作目录外的软链接", async () => {
    mkdirSync(p("outside"));
    writeFileSync(p("outside/secret.py"), "OUTSIDE_SECRET_1\n");
    writeFileSync(p("work/in.py"), "INSIDE_MARK\nOUTSIDE_SECRET_0 not here\n");
    symlinkSync(p("outside/secret.py"), p("work/link.py"));
    symlinkSync(p("outside"), p("work/linkdir"));
    const s = await serve([
      { kind: "toolCall", name: "grep", args: { pattern: "OUTSIDE_SECRET_1" }, id: "g1" },
      { kind: "toolCall", name: "grep", args: { pattern: "INSIDE_MARK" }, id: "g2" },
      { kind: "text", chunks: ["done"] },
    ]);
    writeModels({ fake: fakeProvider(s.baseUrl) });
    const { session } = await open({ tools: ["grep"] });
    expect(session.getActiveToolNames()).toEqual(["grep"]);
    await session.prompt("go");
    session.dispose();
    expect(s.errors).toEqual([]);
    const toolMsgs = (req: any) => req.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
    expect(toolMsgs(s.requests[1])).toEqual(["No matches found"]);
    expect(toolMsgs(s.requests[2])[1]).toBe("in.py:1: INSIDE_MARK"); // 正向对照：rg 可用，结果带行号
  });

  describe("sessionDir 越界", () => {
    const outside = () => p("outside");
    beforeEach(() => { mkdirSync(outside()); symlinkSync(outside(), p("sessions/link")); });
    it.each([
      ["绝对路径", () => p("outside/abs")],
      ["根内的绝对路径", () => p("sessions/run1")],
      ["含 .. 越界", () => "../outside/dotdot"],
      ["软链接跳出根目录", () => "link/escaped"],
    ])("%s：报错、不创建会话、根目录之外没有写入", async (_n, dir) => {
      const s = await serve(TEXT);
      writeModels({ fake: fakeProvider(s.baseUrl) });
      await expect(open({ task: task({ sessionDir: dir() }) })).rejects.toThrow(/sessionDir/);
      expect(files(outside())).toEqual([]);
      expect(readdirSync(outside())).toEqual([]); // 也没有新建目录
      expect(s.requests.length).toBe(0);
    });
  });
});

