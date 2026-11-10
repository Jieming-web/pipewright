// 经真实 pi 1.5.1 SDK + Task 2A 假服务录制原始事件样本，规则见 tests/fixtures/pi-events/README.md
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as pi from "@earendil-works/pi-coding-agent";
import { fakeModelsJson, startFakeOpenAIServer, type ScriptedTurn } from "../tests/helpers/fake-openai-server.js";

export type Scenario = "text" | "tool" | "retry" | "retry-drop";

const SCENARIOS: Record<Scenario, { prompt: string; turns: ScriptedTurn[] }> = {
  text: { prompt: "say hello", turns: [{ kind: "text", chunks: ["Hello", ", ", "world"] }] },
  tool: {
    prompt: "read hello.txt",
    turns: [
      { kind: "toolCall", name: "read", args: { path: "hello.txt" }, id: "call_fixture_1" },
      { kind: "text", chunks: ["The file ", "says hello."] },
    ],
  },
  retry: {
    prompt: "say hello",
    turns: [
      { kind: "error", status: 500, body: { error: { message: "scripted internal server error" } } },
      { kind: "text", chunks: ["recov", "ered"] },
    ],
  },
  "retry-drop": {
    prompt: "say hello",
    turns: [
      { kind: "drop", chunks: ["par", "tial-"] },
      { kind: "text", chunks: ["recov", "ered"] },
    ],
  },
};

export async function recordPiFixture(scenario: Scenario, output: string): Promise<void> {
  const { prompt, turns } = SCENARIOS[scenario];
  const server = await startFakeOpenAIServer(turns);
  const root = mkdtempSync(join(tmpdir(), "fp-rec-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "work");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "hello.txt"), "hello from fixture\n");
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(fakeModelsJson(server.baseUrl)));

    // 0A.4 隔离组合；重试用 0B.2 的快速配置；cacheWarming 关掉，避免 settled 后的额外请求
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    const model = modelRuntime.getModel("fake", "fake-model");
    if (!model) throw new Error("fake model not registered");
    const settingsManager = pi.SettingsManager.inMemory(
      { cacheWarming: "off", retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 } },
      { projectTrusted: false },
    );
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: [],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    const { session } = await pi.createAgentSession({
      cwd, agentDir, modelRuntime, model, resourceLoader, settingsManager,
      sessionManager: pi.SessionManager.inMemory(cwd), tools: ["read"],
    });

    // 收到时立即序列化：partial 等字段是会继续变化的共享对象
    const lines: string[] = [];
    const entryIds = new Map<string, string>();
    const stable = (k: string, v: unknown) => {
      if (k === "timestamp" || k === "durationMs") return typeof v === "number" ? 0 : typeof v === "string" ? new Date(0).toISOString() : v;
      // 会话条目的随机 8 位十六进制 id：按首次出现编号，保留引用关系
      if ((k === "id" || k === "parentId" || k === "targetId") && typeof v === "string" && /^[0-9a-f]{8}$/.test(v)) {
        if (!entryIds.has(v)) entryIds.set(v, `<entry-${entryIds.size + 1}>`);
        return entryIds.get(v);
      }
      return v;
    };
    session.subscribe((e) => lines.push(redact(JSON.stringify(e, stable), root)));
    await session.prompt(prompt);
    session.dispose();

    if (server.errors.length) throw new Error(`fake server errors: ${server.errors.join("; ")}`);
    if (server.requests.length !== turns.length) throw new Error(`expected ${turns.length} requests, got ${server.requests.length}`);
    const body = lines.join("\n") + "\n";
    for (const leak of [root, tmpdir(), homedir()]) if (body.includes(leak)) throw new Error(`redaction missed: ${leak}`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, body);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 机器相关路径换成稳定占位；长的先换，免得被家目录规则截断。 */
function redact(line: string, root: string): string {
  const rules: Array<[string, string]> = [
    [pi.getPackageDir(), "<pi-package>"],
    [realpathSync(root), "<tmp>"],
    [root, "<tmp>"],
    [homedir(), "<home>"],
  ];
  for (const [from, to] of rules) line = line.replaceAll(from, to);
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { scenario: { type: "string" }, output: { type: "string" } } });
  if (!values.scenario || !(values.scenario in SCENARIOS) || !values.output) {
    console.error(`usage: pnpm tsx scripts/record-pi-fixtures.ts --scenario <${Object.keys(SCENARIOS).join("|")}> --output <path>`);
    process.exit(2);
  }
  await recordPiFixture(values.scenario as Scenario, values.output);
  console.log(`recorded ${values.scenario} -> ${values.output}`);
}
