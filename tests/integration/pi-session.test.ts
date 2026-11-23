import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartTask } from "../../packages/engine-protocol/src/index.js";
import type { FinalDecision } from "../../packages/engine-runner/src/intercept-coordinator.js";
import { loadModelRuntime } from "../../packages/engine-runner/src/model-config.js";
import { createPiSession } from "../../packages/engine-runner/src/pi-session.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/hostile-repo");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RULES = [{ repo: "alpha", path: "AGENTS.md", content: "CALLER_RULE_ALPHA 先跑测试", sourceCommit: "c1" }];
const TEXT: ScriptedTurn[] = [{ kind: "text", chunks: ["ok"] }];
const QWEN_COMPAT = { thinkingFormat: "qwen", supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false };

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
  await Promise.all(servers.map((s) => s.close()));
  if (saved === undefined) delete process.env.FP_TEST_KEY; else process.env.FP_TEST_KEY = saved;
  rmSync(root, { recursive: true, force: true });
});

const serve = async (turns: ScriptedTurn[]) => { const s = await startFakeOpenAIServer(turns); servers.push(s); return s; };
const writeModels = (providers: Record<string, object>) => writeFileSync(p("model/models.json"), JSON.stringify({ providers }));
const fakeProvider = (baseUrl: string, patch: object = {}) => ({ ...(fakeModelsJson(baseUrl) as any).providers.fake, ...patch });
const task = (o: Partial<StartTask> = {}): StartTask => ({
  type: "start_task", requestId: "r1", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" },
  contextFiles: RULES, interceptMode: "callback", ...o,
});
const allow = () => vi.fn(async (): Promise<FinalDecision> => ({ decision: "allow" }));

async function open(o: { task?: StartTask; decide?: ReturnType<typeof allow>; workDir?: string; sessionsRoot?: string } = {}) {
  return createPiSession({
    task: o.task ?? task(), modelsPath: p("model/models.json"), workDir: o.workDir ?? p("work"), scratchDir: p("scratch"),
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
    writeModels({ fake: fakeProvider(s.baseUrl, { compat: QWEN_COMPAT, models: [{ id: "fake-model", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 }] }) });
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
    expect((await loadModelRuntime(p("model/models.json"))).getModel("fake", "fake-model")?.id).toBe("fake-model");
  });

  it("config/models.example.json 可被 pi 加载，含 fake、qwen-api、ollama", async () => {
    const rt = await loadModelRuntime(join(import.meta.dirname, "../../config/models.example.json"));
    for (const [prov, id] of [["fake", "fake-model"], ["qwen-api", "qwen3.6-35b-a3b"], ["ollama", "qwen3-4b-instruct-2507-ctx16k"]]) expect(rt.getModel(prov, id)?.id).toBe(id);
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

  describe("sessionDir 越界", () => {
    const outside = () => p("outside");
    beforeEach(() => { mkdirSync(outside()); symlinkSync(outside(), p("sessions/link")); });
    it.each([
      ["绝对路径", () => p("outside/abs")],
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

