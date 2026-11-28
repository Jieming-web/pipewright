import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartTask } from "../../packages/engine-protocol/src/index.js";
import { loadModelRuntime } from "../../packages/engine-runner/src/model-config.js";
import { createPiSession, type ThinkingLevel } from "../../packages/engine-runner/src/pi-session.js";
import { createRestrictedResourceLoader } from "../../packages/engine-runner/src/restricted-resource-loader.js";
import { startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 确定地观察 pi 1.5.1 发给 OpenAI 兼容端点的请求体（实测报告 .superpowers/sdd/2026-11-25-T2-eval-framework/request-capture-report.md）
process.env.PI_OFFLINE = "1";
const SECRET = "SECRET-THOUGHT-1";
// 与 eval/configs/qwen3.6.yaml 的 model.compat / model.pi 逐字一致
const QWEN_COMPAT = { thinkingFormat: "qwen", supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, thinkingTokenBudgetField: "thinking_budget" };
const QWEN_MODEL = { id: "fake-model", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 8192 };
const EVAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TOOL_THEN_TEXT: ScriptedTurn[] = [
  { kind: "toolCall", name: "bash", args: { command: "echo hi" }, id: "c1", reasoning: [SECRET.slice(0, 7), SECRET.slice(7)] },
  { kind: "text", chunks: ["done"] },
];

let root: string;
let servers: FakeOpenAIServer[];
const p = (...s: string[]) => join(root, ...s);
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-cap-")));
  for (const d of ["scratch", "model", "work", "sessions"]) mkdirSync(p(d));
  servers = [];
});
afterEach(async () => {
  try { await Promise.all(servers.map((s) => s.close())); } finally { rmSync(root, { recursive: true, force: true }); }
});

const task: StartTask = { type: "start_task", requestId: "r1", sessionId: "s1", prompt: "go", model: { provider: "fake", id: "fake-model" }, contextFiles: [], interceptMode: "callback" };
const decide = async () => ({ decision: "allow" as const });

/** 按 runner 的方式（createPiSession）跑一次 prompt，返回假服务收到的全部请求体 */
async function capture(o: { turns: ScriptedTurn[]; compat?: object; model?: object; thinkingLevel?: ThinkingLevel; extension?: (pi: ExtensionAPI) => void }) {
  const s = await startFakeOpenAIServer(o.turns);
  servers.push(s);
  const providers = { fake: { baseUrl: s.baseUrl, api: "openai-completions", apiKey: "fake-key", compat: { ...QWEN_COMPAT, ...o.compat }, models: [{ ...QWEN_MODEL, ...o.model }] } };
  writeFileSync(p("model/models.json"), JSON.stringify({ providers }));
  const signal = new AbortController().signal;
  const thinkingLevel = o.thinkingLevel ?? "low";
  let session;
  if (!o.extension) {
    ({ session } = await createPiSession({ task, modelsPath: p("model/models.json"), workDir: p("work"), scratchDir: p("scratch"), sessionsRoot: p("sessions"), tools: EVAL_TOOLS, thinkingLevel, decide, signal }));
  } else {
    // 与 createPiSession 相同的组装，只多一个平台扩展（createPiSession 不接受额外扩展）
    const modelRuntime = await loadModelRuntime(p("model/models.json"), p("scratch"));
    const restricted = await createRestrictedResourceLoader({ scratchDir: p("scratch"), contextFiles: [], extensionFactories: [o.extension] });
    ({ session } = await createAgentSession({
      cwd: p("work"), agentDir: p("scratch"), modelRuntime, model: modelRuntime.getModel("fake", "fake-model")!, thinkingLevel, tools: EVAL_TOOLS,
      resourceLoader: restricted.loader, settingsManager: restricted.settingsManager, sessionManager: SessionManager.inMemory(p("work")),
    }));
  }
  await session.prompt("go");
  session.dispose();
  expect(s.errors).toEqual([]);
  expect(s.requests.length).toBe(o.turns.length);
  return s.requests as any[];
}
const assistantOf = (req: any) => req.messages.find((m: any) => m.role === "assistant");

describe.sequential("pi 1.5.1 请求体捕获：上一轮思考是否回传", () => {
  it("评测 Qwen 配置（thinkingFormat qwen、low）：pi 1.5.1 把上一轮思考以 assistant.reasoning_content 原文回传", async () => {
    const [first, second] = await capture({ turns: TOOL_THEN_TEXT });
    expect(first).toMatchObject({ enable_thinking: true, thinking_budget: 2048, max_completion_tokens: 8192 });
    expect(assistantOf(second)).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: SECRET, // 两个流式增量拼回原文
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
    });
    expect(JSON.stringify(second).split(SECRET).length - 1).toBe(1); // 只在这一处
  });

  it("compat.requiresThinkingAsText:true：不关闭回传，只是把思考改放进 assistant.content 文本", async () => {
    const [, second] = await capture({ turns: TOOL_THEN_TEXT, compat: { requiresThinkingAsText: true } });
    const a = assistantOf(second);
    expect(a.content).toEqual([{ type: "text", text: SECRET }]);
    expect(a).not.toHaveProperty("reasoning_content");
  });

  it.each([
    ["thinkingLevel off（enable_thinking:false，但端点仍返回 reasoning_content）", { thinkingLevel: "off" as const }],
    ["model.reasoning:false", { model: { reasoning: false } }],
    ["compat.thinkingFormat openai", { compat: { thinkingFormat: "openai" } }],
    ["compat.requiresReasoningContentOnAssistantMessages:false", { compat: { requiresReasoningContentOnAssistantMessages: false } }],
  ])("%s：仍以 reasoning_content 回传（不是关闭开关）", async (_name, o) => {
    const [, second] = await capture({ turns: TOOL_THEN_TEXT, ...o });
    expect(assistantOf(second).reasoning_content).toBe(SECRET);
  });

  it("平台扩展的 context 事件删掉 thinking 内容项：第二个请求里不再有思考（不改 pi 的唯一已验证关闭方式）", async () => {
    const strip = (pi: ExtensionAPI) => {
      pi.on("context", (event) => ({
        messages: event.messages.map((m: any) => (m.role === "assistant" ? { ...m, content: m.content.filter((b: any) => b.type !== "thinking") } : m)),
      }));
    };
    const [, second] = await capture({ turns: TOOL_THEN_TEXT, extension: strip });
    expect(JSON.stringify(second)).not.toContain(SECRET);
    expect(assistantOf(second)).not.toHaveProperty("reasoning_content");
    expect(assistantOf(second).tool_calls[0].id).toBe("c1"); // 工具调用本身保留
  });
});

describe.sequential("pi 1.5.1 请求体捕获：contextWindow 的影响", () => {
  const TEXT: ScriptedTurn[] = [{ kind: "text", chunks: ["ok"] }];

  it("短对话：contextWindow 262144 与 65536 的首个请求体逐字相同", async () => {
    const [big] = await capture({ turns: TEXT });
    const [small] = await capture({ turns: TEXT, model: { contextWindow: 65536 } });
    expect(small).toEqual(big);
    expect(big).toMatchObject({ max_completion_tokens: 8192, thinking_budget: 2048 });
  });

  // clampMaxTokensToContext（pi-ai dist/api/simple-options.js:13）：窗口剩余不足时压低输出上限，思考预算跟着上限再夹
  it("窗口很小（8000）时 max_completion_tokens 被压到窗口余量，thinking_budget 再按新上限夹小；其余字段不变", async () => {
    const [big] = await capture({ turns: TEXT });
    const [tiny] = await capture({ turns: TEXT, model: { contextWindow: 8000 } });
    expect(tiny.max_completion_tokens).toBeLessThan(8192);
    expect(tiny.thinking_budget).toBe(tiny.max_completion_tokens - 1024); // < 2048：给回答留 1024
    const { max_completion_tokens: _a, thinking_budget: _b, ...restTiny } = tiny;
    const { max_completion_tokens: _c, thinking_budget: _d, ...restBig } = big;
    expect(restTiny).toEqual(restBig);
  });
});
