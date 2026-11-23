import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextFile } from "../../packages/engine-protocol/src/index.js";
import { createRestrictedResourceLoader } from "../../packages/engine-runner/src/restricted-resource-loader.js";
import { fakeModelsJson, startFakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/hostile-repo");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CALLER: ContextFile[] = [
  { repo: "alpha", path: "AGENTS.md", content: "CALLER_RULE_ALPHA 先跑测试", sourceCommit: "c1" },
  { repo: "beta", path: "AGENTS.md", content: "CALLER_RULE_BETA 不要改 lockfile", sourceCommit: "c2" },
];

let root: string;
const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, M: process.env.HOSTILE_MARKER_DIR };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const p = (...s: string[]) => join(root, ...s);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-rl-")));
  for (const d of ["markers", "scratch", "model", "repo", "home", "envagent"]) mkdirSync(p(d));
  process.env.HOSTILE_MARKER_DIR = p("markers");
});
afterEach(() => {
  restore("HOME", saved.HOME);
  restore("PI_CODING_AGENT_DIR", saved.PI_CODING_AGENT_DIR);
  restore("HOSTILE_MARKER_DIR", saved.M);
  rmSync(root, { recursive: true, force: true });
});

/** 把敌意 fixture 铺到 dir 下（项目布局：.pi/、.agents/ 和根目录规则文件）。 */
const hostileProject = (dir: string) => cpSync(FIXTURE, dir, { recursive: true });
/** 用户目录布局：agentDir=<base>/.pi/agent，sentinel 在 <base>/.pi/sentinel，.agents 在 <base>/.agents。 */
function hostileUser(base: string, agentDir: string) {
  cpSync(join(FIXTURE, ".pi"), agentDir, { recursive: true });
  cpSync(join(FIXTURE, "sentinel"), join(agentDir, "../sentinel"), { recursive: true });
  cpSync(join(FIXTURE, ".agents"), join(base, ".agents"), { recursive: true });
  cpSync(join(FIXTURE, "AGENTS.md"), join(agentDir, "AGENTS.md"));
  cpSync(join(FIXTURE, "CLAUDE.md"), join(agentDir, "CLAUDE.md"));
}

const sysText = (req: any) =>
  req.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

async function run(opts: { cwd: string; turns: ScriptedTurn[]; contextFiles?: ContextFile[]; extensionFactories?: ((api: pi.ExtensionAPI) => void)[] }) {
  const server = await startFakeOpenAIServer(opts.turns);
  try {
    writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(server.baseUrl)));
    const restricted = await createRestrictedResourceLoader({
      scratchDir: p("scratch"), contextFiles: opts.contextFiles ?? CALLER, extensionFactories: opts.extensionFactories ?? [],
    });
    const modelRuntime = await pi.ModelRuntime.create({ authPath: p("model/auth.json"), modelsPath: p("model/models.json") });
    const model = modelRuntime.getModel("fake", "fake-model")!;
    const settingsManager = pi.SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted: false });
    const { session } = await pi.createAgentSession({
      cwd: opts.cwd, agentDir: p("scratch"), modelRuntime, model, resourceLoader: restricted.loader, settingsManager,
      sessionManager: pi.SessionManager.inMemory(opts.cwd), tools: ["read", "bash"],
    });
    await session.bindExtensions({});
    await session.prompt("go");
    session.dispose();
    expect(server.errors).toEqual([]);
    expect(server.requests.length).toBe(opts.turns.length); // cacheWarming=off：不会多出请求
    return { restricted, requests: server.requests as any[] };
  } finally {
    await server.close();
  }
}
const TEXT: ScriptedTurn[] = [{ kind: "text", chunks: ["ok"] }];

describe("受限资源加载器", () => {
  it("调用方规则出现在首个请求，同名规则带 /<repo>/<path> 来源标签", async () => {
    const { requests } = await run({ cwd: p("repo"), turns: TEXT });
    const s = sysText(requests[0]);
    for (const f of CALLER) {
      expect(s).toContain(`/${f.repo}/${f.path}`);
      expect(s).toContain(f.content);
    }
  });

  it("loadedContextFiles 从 pi 回读：sha256 与首个请求中的规则内容一致，且无禁止来源", async () => {
    hostileProject(p("repo"));
    const { restricted, requests } = await run({ cwd: p("repo"), turns: TEXT });
    const loaded = restricted.loadedContextFiles();
    expect(loaded).toEqual(CALLER.map((f) => ({ repo: f.repo, path: f.path, sourceCommit: f.sourceCommit, sha256: sha(f.content) })));
    const s = sysText(requests[0]);
    for (const f of CALLER) expect(s).toContain(f.content); // 哈希对应的内容确实在请求里
    expect(loaded.map((f) => f.repo).sort()).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(requests)).not.toContain("HOSTILE_");
  });

  it("pi 持有的标签映射不回输入文件时抛错，不编造条目", async () => {
    const { restricted } = await run({ cwd: p("repo"), turns: TEXT });
    const real = restricted.loader.getAgentsFiles();
    vi.spyOn(restricted.loader, "getAgentsFiles").mockReturnValue({ agentsFiles: [...real.agentsFiles, { path: "/ghost/AGENTS.md", content: "x" }] });
    expect(() => restricted.loadedContextFiles()).toThrow(/ghost/);
  });

  describe.each(["worktree", "ancestor", "user"] as const)("敌意资源位于 %s", (where) => {
    beforeEach(() => {
      if (where === "worktree") hostileProject(p("repo"));
      if (where === "ancestor") hostileProject(root); // repo 的上级目录
      if (where === "user") {
        process.env.HOME = p("home");
        process.env.PI_CODING_AGENT_DIR = p("envagent");
        hostileUser(p("home"), p("home/.pi/agent"));
        hostileUser(p("home"), p("envagent"));
      }
    });

    it("不加载规则/扩展/skill/提示词/系统提示覆盖，settings 行为不生效", async () => {
      writeFileSync(p("repo/cwd-marker.txt"), "CWD_MARKER_CONTENT\n");
      const { restricted, requests } = await run({
        cwd: p("repo"),
        turns: [{ kind: "toolCall", name: "bash", args: { command: "pwd; cat cwd-marker.txt" }, id: "call_1" }, { kind: "text", chunks: ["done"] }],
      });
      const l = restricted.loader;
      // 加载副作用没有发生
      expect(readdirSync(p("markers"))).toEqual([]);
      // 发现列表为空 / 只有平台来源
      expect(l.getSkills().skills).toEqual([]);
      expect(l.getPrompts().prompts).toEqual([]);
      expect(l.getExtensions().extensions).toEqual([]);
      expect(l.getSystemPromptSource()).toBeUndefined();
      expect(l.getAppendSystemPrompt()).toEqual([]);
      expect(l.getAgentsFiles().agentsFiles.map((f) => f.path).sort()).toEqual(["/alpha/AGENTS.md", "/beta/AGENTS.md"]);
      // 没有任何标记注入请求（含 AGENTS/CLAUDE/SYSTEM/APPEND/skill/prompt）
      expect(JSON.stringify(requests)).not.toContain("HOSTILE_");
      // settings.defaultTools=["ls"] 不生效；shellCommandPrefix 不生效；工具 cwd 是会话的 cwd
      const names = requests[0].tools.map((t: any) => t.function.name);
      expect(names).not.toContain("ls");
      expect(names).toContain("bash");
      const toolMsg = requests[1].messages.find((m: any) => m.role === "tool");
      expect(JSON.stringify(toolMsg)).toContain(p("repo"));
      expect(JSON.stringify(toolMsg)).toContain("CWD_MARKER_CONTENT");
    });
  });

  it("显式平台扩展仍然运行，且能拦截 tool_call", async () => {
    const seen: string[] = [];
    const factory = (api: pi.ExtensionAPI) => {
      writeFileSync(p("markers/platform-ext"), "x");
      api.on("tool_call", async (e) => void seen.push(e.toolName));
    };
    await run({
      cwd: p("repo"), extensionFactories: [factory],
      turns: [{ kind: "toolCall", name: "bash", args: { command: "pwd" }, id: "call_1" }, { kind: "text", chunks: ["done"] }],
    });
    expect(existsSync(p("markers/platform-ext"))).toBe(true);
    expect(seen).toEqual(["bash"]);
  });

  it("对照：pi 默认加载会加载同一棵敌意树（证明 fixture 可检测）", async () => {
    hostileProject(p("repo"));
    process.env.HOME = p("home");
    process.env.PI_CODING_AGENT_DIR = p("envagent");
    hostileUser(p("home"), p("envagent"));
    const settingsManager = pi.SettingsManager.create(p("repo"), p("envagent"));
    const loader = new pi.DefaultResourceLoader({ cwd: p("repo"), agentDir: p("envagent"), settingsManager });
    await loader.reload();
    expect(readdirSync(p("markers")).sort()).toEqual(["ext-marker-loaded", "ext-sentinel-loaded"]);
    expect(loader.getSystemPrompt()).toContain("HOSTILE_SYSTEM_MD");
    expect(loader.getAppendSystemPrompt().join()).toContain("HOSTILE_APPEND_MD");
    expect(JSON.stringify(loader.getAgentsFiles())).toContain("HOSTILE_AGENTS_MD");
    const skills = JSON.stringify(loader.getSkills().skills.map((s) => s.description));
    for (const m of ["HOSTILE_SKILL_PI", "HOSTILE_SKILL_AGENTS", "HOSTILE_SKILL_SENTINEL"]) expect(skills).toContain(m);
    const prompts = JSON.stringify(loader.getPrompts().prompts.map((s) => s.description));
    for (const m of ["HOSTILE_PROMPT_PI", "HOSTILE_PROMPT_SENTINEL"]) expect(prompts).toContain(m);
  });
});
