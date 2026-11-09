# T1 接入 pi 与本地模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让调用方通过统一引擎接口（跨进程 WebSocket 协议）驱动 pi-coding-agent 完成任务，事件转换为本项目协议，规则只来自调用方，仓库内 `.pi/` 资源不被加载，模型可在 Qwen API 与 Mac 本地小模型之间仅靠配置切换。

**Architecture:** 一个 TypeScript 的 pnpm 工作区，三个包：`engine-protocol`（协议类型与校验，被所有调用方共享）、`engine-runner`（一个会话一个进程，内部用 pi SDK 运行任务，经 WebSocket 对外）、`engine-client`（TS 客户端）。runner 用自建的受限资源加载器：发现目录指向一个空的临时目录，只装我们自己的扩展，`AGENTS.md` 只来自启动参数。单元与集成测试用一个"假的 OpenAI 兼容服务"驱动真实的 pi，不调用真实模型。

**Tech Stack:** Node.js 24（要求 ≥ 22.19）、TypeScript（strict）、pnpm workspace、vitest、`ws`（WebSocket）、`zod`（消息校验）、`@earendil-works/pi-coding-agent`（锁定版本）、Ollama（本地小模型）。

**Spec:**
- `docs/specs/tasks.md` 的 T1（验收标准 1–10）
- `docs/specs/design.md`：第 1 节原则 1、4、5、7；第 2 节"pi""统一引擎接口""模型客户端"；3.6；3.14；3.15.3；8.2、8.3
- `docs/specs/proposal.md`：R1、R9、S3；第 5 节"模型""硬件"
- `docs/specs/decisions/001、003、005、008、014、015`
- 本任务产出的契约：`docs/specs/contracts/engine.md`、`docs/specs/contracts/agent-events.md`

## Global Constraints

- pi 以**锁定的确切版本**依赖（不用 `^`、`~`），不修改、不 fork、不打补丁（S3）。
- 单元测试与集成测试中，模型一律用假服务；只有 Task 9 的手动运行调用真实模型。
- 工具执行前拦截的默认行为是**不可用即拒绝**：拿不到决定就阻止执行。
- 仓库内容（`AGENTS.md`、`.pi/`、文件内容）是数据，不是规则；规则只来自启动参数里的上下文文件。
- 分支：`step-01-pi-integration`，在隔离工作区进行（superpowers:using-git-worktrees）；提交信息格式 `类型(step01): 说明`，类型取 feat、fix、test、refactor、docs。
- 文档用中文；代码标识符用英文。
- 推送、合并回 main 需作者同意（只做本地提交）。

## Review Focus

以下输入或状况，规范隐含要求但验收标准没有直接测，最容易出问题，均已在对应任务里加了测试：

1. 调用方在任务运行中途断开连接：runner 应取消任务、释放 pi 会话，不留下孤儿进程（Task 8）。
2. 调用方发来格式错误或未知类型的消息：返回错误消息，runner 不崩溃，正在跑的任务不受影响（Task 3、Task 8）。
3. 模型服务返回错误或地址不可达：任务以 `run.failed` 结束并带原因，不会一直挂着（Task 5）。
4. 任务运行中又收到一个 `start_task`：拒绝，原任务不受影响（Task 8）。
5. 多个仓库的上下文文件路径相同（如都叫 `AGENTS.md`）：都要传给 pi，并能区分来源仓库（Task 7）。

---

## 开工前环境（2026-11-09 检查）

| 项 | 状态 | 影响 |
|---|---|---|
| Node.js | v24.15.0 ✅（要求 ≥ 22.19） | — |
| pnpm | 10.34.9 ✅ | — |
| `@earendil-works/pi-coding-agent` | npm 上最新 1.5.0 ✅ | Task 1 锁定 |
| Docker | 已安装，**守护进程未运行** | T1 不需要；T2 起需要 |
| **Ollama** | **未安装** ❌ | 阻塞 Task 9 的本地小模型部分（验收 3、4） |
| **Qwen API key** | **未设置** ❌（未检测到百炼或硅基流动的环境变量） | 阻塞 Task 0 的部分核实与 Task 9（验收 3、4） |
| Mac 内存 | 16GB | 只运行小模型 |

Task 1–8 不依赖这两项，可以先做；Task 0 中需要 key 的核实和 Task 9 要等作者补齐。

---

### Task 0：开工核实（不写产品代码）

**目标**：把 T1 验收标准要求"开工时核实"的事项查清并记录，任何一项不成立就停下来报告作者。

**Files:**
- Create: `docs/reviews/step01-pi-integration.md`（按 `docs/templates/review.md`，本任务先只写"开工核实"一节）

- [ ] **Step 1：核实 pi 的资源发现与项目信任**（验收 8 的前提）
  阅读 pi-coding-agent 1.5.0 的 `docs/sdk.md`、`docs/security.md`、`docs/extensions.md`（`project_trust`）与类型声明，确认三件事并记录出处：
  (a) `DefaultResourceLoader` 的发现是否只从其构造参数 `cwd`、`agentDir` 出发；
  (b) `createAgentSession({ cwd })` 中的 `cwd` 在提供了 `resourceLoader` 时是否只影响工具路径；
  (c) 内联扩展能否处理 `project_trust` 事件。
  结论决定 Task 7 的做法：默认做法是"发现目录指向空临时目录 + `SettingsManager.inMemory()`"；若 (a)(b) 不成立，停下来报告。
- [ ] **Step 2：核实 MCP 的配置方式**（验收 9）
  按 `docs/sdk.md` 第 116 行与示例 `examples/sdk/14-codemode-mcp.ts`，记录：SDK 会话需要把 `createMcpExtension()` 加入 `extensionFactories` 并调用 `session.bindExtensions()`；MCP 服务器配置文件的位置与格式（用户级还是项目级）。若 1.5.0 中不存在这些 API，停下来报告。
- [ ] **Step 3：核实 Claude Agent SDK 的对应能力**（验收 1 的设计前提）
  查阅 Claude Agent SDK（TypeScript）官方文档，记录与本项目引擎接口对应的能力：工具执行前拦截（如 `canUseTool` 或 PreToolUse 钩子）能否阻止或改写、确认如何表达、取消、流式事件、会话恢复。写一张"能力 × pi × Claude Agent SDK"对照表，供 Task 3 的契约使用。
- [ ] **Step 4（需要 API key）：核实模型**（验收 3）
  作者提供 key 后：确认 Qwen3.6-35B-A3B 与 Qwen3-Coder-Next 在哪个平台有 API（阿里云百炼、硅基流动）、模型 ID、价格；查各模型官方卡片上的训练截止日期与许可证；记录要锁定的版本号。没有 key 时标注"未执行"，不当作已通过。
- [ ] **Step 5：提交**
  `git commit -m "docs(step01): 开工核实记录"`

---

### Task 1：工作区脚手架与 pi 版本锁定

**目标**：可运行测试的 TS 工作区；pi 以确切版本引入；有一个检查脚本证明没有被修改或 fork（验收 6）。

**Files:**
- Create: `package.json`（root，`private: true`，脚本 `test`、`build`、`check:pi`）
- Create: `pnpm-workspace.yaml`（`packages/*`）
- Create: `tsconfig.base.json`（`strict: true`，`module: nodenext`）
- Create: `vitest.config.ts`
- Create: `packages/engine-protocol/package.json`、`packages/engine-runner/package.json`、`packages/engine-client/package.json`
- Create: `scripts/check-pi-pinned.mjs`
- Test: `tests/unit/check-pi-pinned.test.ts`
- Modify: `.gitignore`（加入 `node_modules/`、`dist/`、`.tmp/`）

**Interfaces:**
- Produces: `checkPiPinned(rootDir: string): { ok: boolean; problems: string[] }`，由 `scripts/check-pi-pinned.mjs` 导出，命令行调用时 `ok=false` 则退出码 1。

- [ ] **Step 1：写失败的测试** `tests/unit/check-pi-pinned.test.ts`

```ts
test("rejects caret or tilde versions for @earendil-works packages", () => {
  const dir = makeTempWorkspace({ "@earendil-works/pi-coding-agent": "^1.5.0" });
  expect(checkPiPinned(dir).ok).toBe(false);
});
test("rejects pnpm patchedDependencies for @earendil-works packages", () => {
  const dir = makeTempWorkspace({ "@earendil-works/pi-coding-agent": "1.5.0" }, { patched: true });
  expect(checkPiPinned(dir).problems.join()).toContain("patch");
});
test("accepts the real workspace", () => {
  expect(checkPiPinned(process.cwd()).ok).toBe(true);
});
```
（`makeTempWorkspace` 是测试内的辅助函数：在临时目录写一个 `package.json`，可选写入 `pnpm.patchedDependencies`。）

- [ ] **Step 2：运行，确认失败**
  Run: `pnpm vitest run tests/unit/check-pi-pinned.test.ts`
  Expected: FAIL（`checkPiPinned` 不存在）
- [ ] **Step 3：建工作区并安装依赖**
  `packages/engine-runner` 依赖 `@earendil-works/pi-coding-agent` 的**确切版本**（Task 0 记录的版本，当前为 `1.5.0`），以及 `ws`、`zod`；root 的 devDependencies：`typescript`、`vitest`、`@types/node`、`@types/ws`、`tsx`。运行 `pnpm install`，提交 `pnpm-lock.yaml`。
- [ ] **Step 4：实现 `checkPiPinned`**
  扫描 root 与 `packages/*/package.json` 中所有 `@earendil-works/*` 依赖：版本必须是确切的 semver；`pnpm.patchedDependencies` 中不得出现 `@earendil-works/*`；不得存在 `vendor/pi` 或类似拷贝目录。
- [ ] **Step 5：运行，确认通过**
  Run: `pnpm vitest run tests/unit/check-pi-pinned.test.ts && pnpm check:pi`
  Expected: PASS；`check:pi` 退出码 0
- [ ] **Step 6：提交**
  `git commit -m "feat(step01): 工作区脚手架与 pi 版本锁定检查"`

---

### Task 2：本项目事件协议与 pi 事件转换

**目标**：定义本项目事件（`contracts/agent-events.md`），实现 pi 事件 → 本项目事件的转换，用录制的 pi 事件做单元测试（验收 2）。

**Files:**
- Create: `packages/engine-protocol/src/agent-events.ts`
- Create: `packages/engine-runner/src/pi-event-converter.ts`
- Create: `tests/fixtures/pi-events/text-only.jsonl`、`tool-call-then-text.jsonl`、`retry-after-agent-end.jsonl`
- Test: `tests/unit/pi-event-converter.test.ts`
- Create: `docs/specs/contracts/agent-events.md`（按 `docs/templates/contract.md`）

**Interfaces:**
- Produces（`engine-protocol`）：

```ts
type AgentEvent =
  | { type: "run.started"; sessionId: string }
  | { type: "text.delta"; text: string }
  | { type: "message.completed"; role: "assistant"; text: string }
  | { type: "tool.started"; callId: string; toolName: string; input: unknown }
  | { type: "tool.finished"; callId: string; toolName: string; isError: boolean; output: string }
  | { type: "run.settled" }
  | { type: "run.failed"; reason: string }
  | { type: "run.cancelled" };
type SequencedEvent = AgentEvent & { seq: number; sessionId: string; at: string }; // at: ISO 时间
```
- Produces（`engine-runner`）：`createPiEventConverter(sessionId: string): { convert(piEvent: unknown): SequencedEvent[] }` —— 有状态，`seq` 在单个会话内从 1 开始严格递增；不认识的 pi 事件返回 `[]`。

- [ ] **Step 1：写录制事件**
  按 pi 1.5.0 文档中的事件形状（`message_update`/`text_delta`、`message_end`、`tool_execution_start`、`tool_execution_end`、`agent_end`、`agent_settled`）手写三个 JSONL 文件；`retry-after-agent-end.jsonl` 表示"`agent_end` 之后又有重试，最后才 `agent_settled`"。Task 9 会用真实录制替换或补充。
- [ ] **Step 2：写失败的测试**

```ts
test("text deltas map to text.delta in order with increasing seq", ...);   // seq 为 1,2,3...
test("agent_end alone does not produce run.settled", ...);                 // retry-after-agent-end
test("agent_settled produces exactly one run.settled as the last event", ...);
test("tool_execution_start/end map to tool.started/tool.finished with the same callId", ...);
test("unknown pi event types are ignored without throwing", ...);
```
- [ ] **Step 3：运行，确认失败** — `pnpm vitest run tests/unit/pi-event-converter.test.ts`，Expected: FAIL
- [ ] **Step 4：实现类型与转换器**
- [ ] **Step 5：运行，确认通过**
- [ ] **Step 6：写契约** `docs/specs/contracts/agent-events.md`：事件表、与 pi 事件的对应关系、序号规则（runner 在会话内分配 `seq`；全局序号由宿主或存储分配，见 design 原则 5）、"任务结束以 `run.settled`/`run.failed`/`run.cancelled` 三者之一为准，`agent_end` 不代表结束"。
- [ ] **Step 7：提交** `feat(step01): 事件协议与 pi 事件转换`

---

### Task 3：引擎接口消息与契约

**目标**：定义统一引擎接口的消息（与语言无关的 JSON over WebSocket），用 zod 校验；写 `contracts/engine.md`（验收 1 的契约部分）。

**Files:**
- Create: `packages/engine-protocol/src/engine-messages.ts`
- Create: `packages/engine-protocol/src/index.ts`
- Test: `tests/unit/engine-messages.test.ts`
- Create: `docs/specs/contracts/engine.md`

**Interfaces:**
- Produces：

```ts
// 调用方 → runner
type StartTask = {
  type: "start_task";
  sessionId: string;
  prompt: string;
  model: { provider: string; id: string };
  contextFiles: { repo: string; path: string; content: string }[];
  interceptMode: "callback" | "policy";        // policy 在 T3 实现
  resume?: { sessionFileRef: string };          // T5 实现
  sessionDir?: string;                          // 会话文件持久化目录；缺省为内存
};
type InterceptDecision = { type: "intercept_decision"; callId: string; decision: "allow" | "block" | "confirm"; reason?: string };
type ConfirmResponse = { type: "confirm_response"; confirmId: string; approved: boolean; by: string };
type Cancel = { type: "cancel" };
type ClientMessage = StartTask | InterceptDecision | ConfirmResponse | Cancel;

// runner → 调用方
type RunnerMessage =
  | { type: "event"; event: SequencedEvent }
  | { type: "intercept_request"; callId: string; toolName: string; input: unknown }
  | { type: "confirm_request"; confirmId: string; callId: string; toolName: string; input: unknown; reason?: string }
  | { type: "error"; code: "invalid_message" | "already_running" | "not_implemented" | "internal"; message: string };

function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: string };
```

- [ ] **Step 1：写失败的测试**

```ts
test("parses a valid start_task with two context files from different repos", ...);
test("rejects start_task without contextFiles array", ...);       // ok=false
test("rejects unknown message type", ...);                         // ok=false, 不抛异常
test("rejects non-JSON input", ...);                               // ok=false
```
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现 zod schema 与 `parseClientMessage`**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：写契约** `docs/specs/contracts/engine.md`：传输方式（JSON 文本帧 over WebSocket，一个 runner 进程服务一个会话）、全部消息与字段、生命周期（连接 → `start_task` → 事件流 → 三种结束事件之一）、拦截决策方可配置（`callback`：每次工具调用前发 `intercept_request`，调用方在超时内（默认 30 秒，可配置）答复，超时或断开按 `block`；`policy`：T3 实现）、确认流程、取消、错误码；附 Task 0 Step 3 的"pi × Claude Agent SDK"能力对照表与差异说明；注明 Python 客户端在 T2 交付。
- [ ] **Step 6：提交** `feat(step01): 引擎接口消息与契约`

---

### Task 4：假的 OpenAI 兼容模型服务（测试辅助）

**目标**：一个可编排回复的本地 HTTP 服务，让测试驱动真实的 pi 而不调用真实模型，并记录 pi 发出的请求（用于检查系统提示词里的规则）。

**Files:**
- Create: `tests/helpers/fake-openai-server.ts`
- Test: `tests/unit/fake-openai-server.test.ts`

**Interfaces:**
- Produces：

```ts
type ScriptedTurn =
  | { kind: "text"; text: string; chunkDelayMs?: number }
  | { kind: "tool_call"; toolName: string; args: Record<string, unknown> }
  | { kind: "http_error"; status: number };
function startFakeOpenAIServer(turns: ScriptedTurn[]): Promise<{
  baseUrl: string;                 // 形如 http://127.0.0.1:<port>/v1
  requests: unknown[];             // 收到的请求体，按顺序
  close(): Promise<void>;
}>;
function fakeModelsJson(baseUrl: string): object; // pi models.json：provider "fake"，api "openai-completions"，model id "fake-model"
```
每收到一次 `POST /v1/chat/completions`（`stream: true`）就按顺序消费一个 `ScriptedTurn`，以 OpenAI 流式格式（`data: {...}` 分块，结尾 `data: [DONE]`）返回；`tool_call` 以 `delta.tool_calls` 返回；回合用完时返回最后一个 `text`。

- [ ] **Step 1：写失败的测试**：用 `fetch` 发两次流式请求，断言第一次拼出文本、第二次拿到 `tool_calls` 名称与参数、`requests.length === 2`；`http_error` 回合返回对应状态码。
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**（用 Node 内置 `http`）
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `test(step01): 假的 OpenAI 兼容模型服务`

---

### Task 5：pi 引擎核心（创建会话、运行、结束判定）

**目标**：在进程内用 pi SDK 运行一条任务，输出本项目事件；正确判断结束（验收 1 的"不会提前结束"）；模型配置只靠 `models.json` 切换（验收 3 的代码部分）。

**Files:**
- Create: `packages/engine-runner/src/model-config.ts`
- Create: `packages/engine-runner/src/pi-engine.ts`
- Test: `tests/integration/pi-engine.test.ts`
- Create: `config/models.example.json`（三个 provider 示例：`fake`、`qwen-api`（百炼或硅基流动，OpenAI 兼容）、`ollama`（`http://localhost:11434/v1`））

**Interfaces:**
- Consumes：`createPiEventConverter`（Task 2）、`StartTask`（Task 3）、`startFakeOpenAIServer`、`fakeModelsJson`（Task 4）
- Produces：

```ts
type EngineHooks = {
  emit(msg: RunnerMessage): void;
  decideToolCall(req: { callId: string; toolName: string; input: unknown }): Promise<"allow" | { block: string }>;
};
class PiEngine {
  constructor(opts: { modelsPath: string; workDir: string; scratchDir: string; hooks: EngineHooks });
  run(task: StartTask): Promise<void>;   // 结束时已发出 run.settled / run.failed / run.cancelled 之一
  cancel(): Promise<void>;               // 中止并 dispose pi 会话
  readonly disposed: boolean;
}
function loadModelRuntime(modelsPath: string): Promise<unknown>; // 包装 pi 的 ModelRuntime.create({ modelsPath, authPath })，API key 从环境变量注入
```
`workDir` 是仓库所在目录（工具路径），`scratchDir` 是空的临时目录（资源发现目录，见 Task 7）。设置用 `SettingsManager.inMemory()`；会话用 `SessionManager.inMemory()`，给了 `sessionDir` 时用持久化的会话管理器写到该目录。`decideToolCall` 在本任务由 Task 6 接入，这里先默认 `allow`。

- [ ] **Step 1：写失败的测试**

```ts
test("text-only task emits run.started, text.delta..., run.settled last", ...);
test("tool call then text: run.settled comes only after the final text", ...);    // 断言 settled 之前已有 tool.finished 和后续 text.delta
test("model HTTP 500 ends with run.failed carrying a reason, not a hang", ...);    // Review Focus 3；设超时 10 秒
test("unreachable baseUrl ends with run.failed", ...);                             // Review Focus 3
test("switching provider in models.json needs no code change", ...);               // 同一 PiEngine 代码，两份 models.json（fake-a、fake-b 两个假服务），分别命中各自的服务
```
- [ ] **Step 2：运行，确认失败** — `pnpm vitest run tests/integration/pi-engine.test.ts`
- [ ] **Step 3：实现 `loadModelRuntime` 与 `PiEngine`**
  用 `createAgentSession({ cwd: workDir, model, modelRuntime, resourceLoader, sessionManager, settingsManager })`；`session.subscribe` 把事件交给转换器；以 `agent_settled` 判定结束；`prompt` 抛错或模型报错时发 `run.failed`。资源加载器先用一个临时实现（`DefaultResourceLoader`，`cwd`/`agentDir` 都指向 `scratchDir`），Task 7 替换为正式实现。
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat(step01): pi 引擎核心与模型配置`

---

### Task 6：工具执行前拦截与确认

**目标**：用一个内联扩展在 `tool_call` 时询问决策方；支持放行、阻止、需要确认；拿不到决定就阻止（验收 1 的拦截与确认）。

**Files:**
- Create: `packages/engine-runner/src/intercept-extension.ts`
- Modify: `packages/engine-runner/src/pi-engine.ts`（接入扩展与 `decideToolCall`）
- Test: `tests/integration/intercept.test.ts`

**Interfaces:**
- Consumes：`PiEngine`、`EngineHooks`（Task 5）
- Produces：`createInterceptExtension(decide: EngineHooks["decideToolCall"]): (pi: ExtensionAPI) => void` —— 在 `tool_call` 中调用 `decide`，`{ block }` 时返回 `{ block: true, reason }`。确认由 runner 层实现：决策为 `confirm` 时发 `confirm_request`，等 `confirm_response`，`approved=false` 或超时即阻止。

- [ ] **Step 1：写失败的测试**（假模型先要求调用 `bash`，再给最终文本）

```ts
test("allow: bash runs and tool.finished has isError=false", ...);
test("block: bash does not run and the model receives the reason", ...);           // 检查假服务第二次请求里的工具结果包含 reason
test("confirm then approved: tool runs after confirm_response approved=true", ...);
test("confirm then rejected: tool does not run", ...);
test("no decision within timeout: tool is blocked (fail-closed)", ...);            // 超时设 200ms
test("interceptMode=policy returns error not_implemented and runs nothing", ...);
test("start_task with resume returns error not_implemented (resume is T5)", ...);
```
"bash 是否真的执行"用副作用判断：命令为 `touch <scratch>/ran.txt`，断言文件是否存在。
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现扩展与确认流程**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat(step01): 工具执行前拦截与确认`

---

### Task 7：规则只来自调用方，不加载仓库 `.pi/` 资源

**目标**：正式的受限资源加载器（验收 7、8、10）。

**Files:**
- Create: `packages/engine-runner/src/restricted-resource-loader.ts`
- Modify: `packages/engine-runner/src/pi-engine.ts`（替换 Task 5 的临时加载器）
- Create: `tests/fixtures/hostile-repo/`：`AGENTS.md`（内容含 `REPO_RULE_SHOULD_NOT_APPEAR`）、`.pi/extensions/marker.ts`（加载时在 `process.env.MARKER_DIR` 写 `extension-loaded.txt`）、`.pi/settings.json`、`.pi/APPEND_SYSTEM.md`（含 `REPO_APPEND_SHOULD_NOT_APPEAR`）、`.agents/skills/evil/SKILL.md`
- Test: `tests/integration/restricted-loader.test.ts`

**Interfaces:**
- Consumes：`StartTask["contextFiles"]`（Task 3）、`createInterceptExtension`（Task 6）
- Produces：`createRestrictedResourceLoader(opts: { scratchDir: string; contextFiles: StartTask["contextFiles"]; extensionFactories: ((pi: ExtensionAPI) => void)[] }): Promise<ResourceLoader>` —— 发现目录（`cwd`、`agentDir`）都是空的 `scratchDir`；`agentsFilesOverride` 只返回 `contextFiles`，每个文件的 `path` 写成 `/<repo>/<path>` 以区分来源；扩展只来自 `extensionFactories`；若 Task 0 确认内联扩展能处理 `project_trust`，再加一个一律回答"不信任"的扩展作为第二道保险。

- [ ] **Step 1：写失败的测试**（工作目录为 `hostile-repo` 的临时拷贝，并在其中 `git init`、提交）

```ts
test("system prompt contains the caller's AGENTS.md and not the repo's", ...);
// 断言假服务收到的首个请求的 system 内容包含 "CALLER_RULE" 且不含 "REPO_RULE_SHOULD_NOT_APPEAR"
test("editing AGENTS.md on a local branch inside the workdir does not change the rules", ...);  // 验收 10
test("repo .pi/extensions is not loaded (no extension-loaded.txt)", ...);                        // 验收 8
test("repo .pi/APPEND_SYSTEM.md does not reach the system prompt", ...);
test("two repos each with AGENTS.md: both reach pi, labeled /<repo>/AGENTS.md", ...);            // Review Focus 5
```
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现 `createRestrictedResourceLoader` 并接入 `PiEngine`**
  任何一个测试在正确实现后仍无法通过（说明 pi 仍从仓库加载了资源），**停下来报告作者**（验收 8 的要求）。
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat(step01): 受限资源加载器，规则只来自调用方`

---

### Task 8：runner 进程与 TS 客户端（跨进程、取消、断线）

**目标**：把 `PiEngine` 包成独立进程，经 WebSocket 对外；TS 客户端；取消与清理（验收 1、5）。

**Files:**
- Create: `packages/engine-runner/src/runner-server.ts`
- Create: `packages/engine-runner/src/main.ts`（启动参数：`--port`（0 表示随机）、`--models`、`--workdir`；启动后向 stdout 打印一行 `RUNNER_LISTENING <port>`）
- Create: `packages/engine-client/src/engine-client.ts`、`packages/engine-client/src/index.ts`
- Test: `tests/integration/runner-process.test.ts`

**Interfaces:**
- Consumes：`PiEngine`（Task 5–7）、`parseClientMessage`、消息类型（Task 3）
- Produces：

```ts
// engine-runner
function startRunnerServer(opts: { port: number; modelsPath: string; workDir: string; interceptTimeoutMs?: number }): Promise<{ port: number; close(): Promise<void> }>;
// engine-client
class EngineClient {
  static connect(url: string): Promise<EngineClient>;
  start(task: Omit<StartTask, "type">): void;
  onEvent(cb: (e: SequencedEvent) => void): void;
  onIntercept(cb: (req: { callId: string; toolName: string; input: unknown }) => Promise<"allow" | "block" | "confirm">): void;
  onConfirm(cb: (req: { confirmId: string; toolName: string; input: unknown }) => Promise<boolean>): void;
  cancel(): void;
  waitForEnd(): Promise<SequencedEvent>; // 解析为 run.settled / run.failed / run.cancelled
  close(): Promise<void>;
}
```

- [ ] **Step 1：写失败的测试**（用 `tsx packages/engine-runner/src/main.ts` 启动真实子进程，假模型服务）

```ts
test("client starts a task in a separate runner process and receives run.settled", ...);
test("intercept roundtrip works across processes", ...);
test("cancel during a slow stream ends with run.cancelled and the pi session is disposed", ...);   // 验收 5：之后不再有事件；runner 上报 disposed
test("client disconnect mid-run cancels the task and the runner frees the session", ...);          // Review Focus 1
test("a second start_task while running gets error already_running; first task unaffected", ...); // Review Focus 4
test("malformed message gets error invalid_message; running task unaffected", ...);              // Review Focus 2
```
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现 runner 服务、`main.ts` 与客户端**
- [ ] **Step 4：运行，确认通过**；再跑全部测试 `pnpm test`
- [ ] **Step 5：提交** `feat(step01): runner 进程与 TS 客户端`

---

### Task 9：示例仓库、真实模型手动运行与录制（需要 API key 与 Ollama）

**目标**：验收 3、4 的真实运行；用真实录制补充 Task 2 的事件样本。

**Files:**
- Create: `tests/fixtures/sample-repo/`（一个小型 Python 包，约 6–8 个模块，至少 5 个函数各有 1–3 处调用点，含跨模块调用与同名函数干扰项）
- Create: `tests/fixtures/sample-repo-questions.json`：5 个"某函数在哪里被调用"的问题及标准答案（文件路径 + 行号集合）
- Create: `scripts/t1-real-run.ts`：用 `EngineClient` 依次问 5 个问题，拦截一律 `allow`（只读问答），把回答与标准答案对照，输出结果表；可选 `--record <file>` 保存 pi 原始事件
- Modify: `tests/fixtures/pi-events/`（加入真实录制，并让 Task 2 的测试也覆盖它）
- Modify: `docs/reviews/step01-pi-integration.md`（记录运行结果）

- [ ] **Step 1：写示例仓库与问题集**，并写一个单元测试 `tests/unit/sample-repo-answers.test.ts`：用 `grep` 风格的扫描验证每个标准答案的行号上确实有该函数的调用（防止答案本身写错）。
- [ ] **Step 2：运行该测试，确认通过**
- [ ] **Step 3（需要 key）：用 Qwen 主模型候选的 API 版本运行**
  Run: `pnpm tsx scripts/t1-real-run.ts --models config/models.local.json --model qwen-api/<候选ID> --record tests/fixtures/pi-events/real-qwen-api.jsonl`
  Expected：5/5 答对（验收 4）；不对时按 3.3 停下来分析是实现问题还是模型问题，不改问题去迁就结果。
- [ ] **Step 4（需要 Ollama）：用本地小模型运行**
  `ollama pull <Task 0 确定的 Qwen 4B 左右型号>` 后，同一脚本改 `--model ollama/<id>`；结果如实记录，完成不了不算阻塞（验收 3、4）。
- [ ] **Step 5：确认两次运行之间只改了配置**：`git diff` 中两次运行没有代码改动，只有 `--model` 参数与 `config/models.local.json`（该文件含 key 的引用方式而非 key 本身，不提交 key）。
- [ ] **Step 6：把真实录制加入 Task 2 的测试并运行** `pnpm vitest run tests/unit/pi-event-converter.test.ts`
- [ ] **Step 7：提交** `test(step01): 示例仓库、真实模型运行记录与录制`

---

### Task 10：任务收尾准备

**目标**：把 T1 带到"收尾关卡"（workflow 3.4）之前的状态；标 `[x]` 需作者同意。

**Files:**
- Modify: `docs/reviews/step01-pi-integration.md`（补全：做了什么、设计意图、代码地图、与计划的偏差、验证记录、已知限制、讲解自测题 3–5 道）
- Modify: `docs/specs/tasks.md`（T1 的"计划""实现说明"两栏填路径；状态改 `[~]`，不改 `[x]`）

- [ ] **Step 1：逐条对照 T1 验收标准 1–10**，在实现说明里写"验收核对表"：每条写证据（测试名、命令输出、文档位置）；未执行的明确标注"未执行"及原因。
- [ ] **Step 2：运行全部检查** — `pnpm test && pnpm check:pi`，把输出摘要写进"验证记录"。
- [ ] **Step 3：收尾一致性检查**（workflow 4.6）：`CLAUDE.md` 索引、文档链接、契约与代码一致。
- [ ] **Step 4：提交** `docs(step01): 实现说明与验收核对`
- [ ] **Step 5：请求整体代码审查**（superpowers:requesting-code-review），然后进入收尾关卡：讲解自测、作者同意。
