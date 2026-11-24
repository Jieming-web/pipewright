# 契约：引擎消息与生命周期（engine）

> 职责：调用方与 runner 之间 JSON over WebSocket 的全部消息、任务生命周期、错误与超时语义。不写内部实现。

- **提供方**：`packages/engine-protocol`（schema 与解析器）；runner 服务（T1-9A）实现服务端语义
- **调用方**：TS 客户端（T1-9B）；Python 客户端（T2）；策略直连（T3）；恢复（T5）
- **相关设计**：design.md 引擎层；事件类型见 `agent-events.md`（本文不重复）

## 1. 接口

每条消息是一个 JSON 文本帧，含与消息同名的 `type` 判别字段。所有 string 字段除特别说明外必须非空（纯空白也算空）；例外：`ContextFile.content` 可为空串（空文件存在）。**未知字段被忽略**：不报错，也不出现在解析结果中。标为 `input` 的字段键必须存在，值可为任意 JSON（含 `null`）。事件的 `at` 是以 `Z` 结尾的 UTC ISO 时间（`z.string().datetime()`）。校验实现为 `packages/engine-protocol/src/engine-messages.ts`；`parseClientMessage(raw)` / `parseRunnerMessage(raw)` 返回 `{ok:true, message}` 或 `{ok:false, error}`，**不抛异常**（非法 JSON 也返回 `ok:false`）。一个方向的消息会被另一方向的解析器拒绝。

### 1.1 caller → runner（`ClientMessage`）

| type | 字段 | 说明 |
|---|---|---|
| `start_task` | `requestId, sessionId, prompt: string`；`model: {provider, id}`；`contextFiles: ContextFile[]`（必传，可为空）；`interceptMode: "callback" \| "policy"`；`resume?: {sessionFileRef}`；`sessionDir?: string` | 启动任务 |
| `intercept_decision` | `requestId, callId` + `Decision` | 回答 `intercept_request` |
| `confirm_response` | `requestId, confirmId` + `Confirmation` | 回答 `confirm_request` |
| `cancel` | `requestId` | 取消任务 |

### 1.2 runner → caller（`RunnerMessage`）

| type | 字段 | 说明 |
|---|---|---|
| `accepted` | `requestId, sessionId` | 仅用于启动确认；`requestId` 回显 `start_task` 的 |
| `event` | `event: SequencedEvent` | 事件，见 `agent-events.md`；`sessionId` 非空，`seq` 正整数，`at` 为 UTC ISO 时间，以 Z 结尾 |
| `intercept_request` | `ToolRequest`（无 `requestId`） | 仅 `interceptMode: "callback"`，同一时刻最多一个在等待 |
| `confirm_request` | `ConfirmRequest`（无 `requestId`） | 决定为 `confirm` 后发出 |
| `error` | `requestId?: string; code; message` | 协议错误，见第 3 节；`requestId` 回显出错的那条客户端消息的，无法解析时可缺 |

### 1.3 辅助类型（无消息 `type`）

| 类型 | 字段与规则 |
|---|---|
| `ContextFile` | `repo, path, content, sourceCommit`。`repo` 是稳定 id，不含 `/`；`path` 必须是规范相对路径：不以 `/` 开头、无反斜杠、无 NUL、无盘符前缀（`C:`），且没有 `""`、`.`、`..` 段（即拒绝 `./a`、`a//b`、`a/`、`a/../b`）。路径不做 URL 解码，`%2e%2e` 按字面处理。同一 `(repo, path)` 不得重复；不同 repo 下同名 path 合法（多仓库同名文件） |
| `ToolRequest` | `callId, toolName: string; input: unknown` |
| `Decision` | `{decision:"allow"}` 或 `{decision:"block"\|"confirm", reason}`，`reason` 非空 |
| `ConfirmRequest` | `confirmId, callId, toolName, reason: string; input: unknown` |
| `Confirmation` | `approved: boolean; by: string; reason?: string`。`by` 必填；`approved:false` 时 `reason` 必填且非空 |

`InterceptDecision`、`ConfirmResponse` 是对应完整消息类型；`ToolRequest`、`ConfirmRequest` 是去掉消息 `type` 后的载荷。

### 1.4 requestId 与配对规则

- `requestId` 只存在于 caller → runner 的消息（`start_task`、`intercept_decision`、`confirm_response`、`cancel`），是调用方给**这条消息**起的 id，在一个连接内唯一。
- runner 在 `accepted` 和任何针对该消息的 `error` 中回显它。例如迟到的决定得到 `stale_response`，其 `requestId` 就是那条迟到决定自己的 id。
- 决定与请求的配对用 `callId`；确认与请求的配对用 `confirmId`。`ProtocolError` 不另带 `callId`/`confirmId`。
- runner 回显 `requestId` 的真实行为由 T1-9A 实现并测试；本契约的 schema 测试只校验消息形状。

## 2. 行为约定

### 2.1 生命周期

一个 runner 进程对应一个客户端、一次成功启动的任务。状态：`idle → running → stopping → finished`。

- 第二个连接被拒绝。五道题各启动新 runner。
- 启动被接受后，runner 先发 `accepted`，再发事件。
- **第一事件规则**：`accepted` 之后的第一个事件是 `run.started` 或 `run.failed`。加载器或会话创建失败时只发布带原因的 `run.failed`（没有 `run.started`）；客户端不得假设第一个事件一定是 `run.started`。
- `running` 时再收到 `start_task`：返回 `already_running`（带该次启动自己的 `requestId`），不影响原任务。
- `finished` 后不复用：任何 `start_task` 返回 `run_finished` 并关闭连接。
- 有效启动前的拒绝（非法消息、`not_implemented`）保持 `idle`，客户端可修正后重试。
- `interceptMode: "policy"` 与 `resume` 在 T1 返回 `not_implemented`，且不创建会话、不执行工具。（Python 客户端 T2、策略直连 T3、恢复 T5 实现。）

### 2.2 拦截与确认

- `callback` 模式下，每个待执行工具先发 `intercept_request`，等待 `intercept_decision`，默认 30 秒。
- 决定为 `confirm` 时发 `confirm_request`，等待 `confirm_response`，**另计**默认 10 分钟（600 秒，等真人回复；与 Claude PreToolUse 钩子的默认上限一致；作者 2026-11-23 决定）。
- 两个超时都可在 runner 配置。出错或超时一律按 `block`。
- `Confirmation.by` 是调用方报告的测试身份，**不代表已完成 T4/T8 的鉴权**。
- 迟到、重复、与等待项不匹配的决定或确认返回 `stale_response`，不改变已完成的决定。
- 无法解析的请求回 `error`，可不带 `requestId`；正常任务继续。

### 2.3 取消与终止

- `cancel` 幂等；`idle` 时无操作。终止前的有效取消使任务进入 `stopping`；终止结果一旦选定就不被覆盖。唯一例外：会话创建完成前收到的取消，如果随后加载器或会话创建失败，结果改为带原因的 `run.failed`（第一事件规则，见 2.1；作者 2026-11-23 决定）。
- 清理过程中不再发布进度事件；最终只发布一种终止事件（`run.settled` / `run.failed` / `run.cancelled`，见 `agent-events.md`）。
- 错误完成与取消竞态时，取引擎串行观察到的第一个终止原因。内部清理失败改为 `run.failed`。
- 收到终止后，runner 关闭连接与监听并退出。
- 无客户端连接，或连接后一直未启动，默认 30 秒空闲超时退出。客户端断线触发取消和退出，不等待重连。

### 2.4 错误分层

协议校验错误用 `error` 消息；已接受任务的运行异常用 `run.failed` 事件。原始 pi 录制只写 runner 本地诊断文件，不进入协议。

## 3. 错误与状态语义

| 情况 | 返回 | 调用方应如何处理 |
|---|---|---|
| 消息非法 JSON、缺字段、类型/路径/决策不合法 | `error{code:"invalid_message"}`，`requestId` 可缺 | 修正后重发；未启动时仍为 `idle` |
| 运行中再次 `start_task` | `error{requestId: 第二次的, code:"already_running"}` | 用 `requestId` 与首次启动区分；原任务不受影响 |
| 任务结束后再启动 | `error{code:"run_finished"}` 并关闭 | 启动新 runner |
| `policy` 或 `resume` | `error{code:"not_implemented"}` | T1 不支持，改用 `callback` 且不带 `resume` |
| 迟到/重复/不匹配的决定或确认 | `error{code:"stale_response"}` | 忽略，已完成的决定不变 |
| runner 内部错误（非任务失败） | `error{code:"internal"}` | 视为不可恢复，重启 runner |
| 已接受任务的运行异常 | `run.failed{reason}` 事件 | 按终止事件处理 |

### 超时与默认值

| 项 | 默认 | 可配置 |
|---|---|---|
| 拦截等待 | 30 秒，超时按 block | 是（runner 配置） |
| 确认等待 | 10 分钟（600 秒），另计，超时按 block | 是 |
| 空闲/未启动连接 | 30 秒后退出 | 是 |
| 清理（取消或结束后） | 5 秒；超时或失败发带原因的 `run.failed`，runner 非零退出 | 否 |
| 模型请求重试 | 沿用 pi 默认：最多 3 次，退避 2/4/8 秒，用尽约 14 秒后 `run.failed` | 否（T1 不提供，需要时再加；作者 2026-11-23 决定） |

**连接来源**：runner 只监听 127.0.0.1，并在握手阶段拒绝带 `Origin` 头的连接（浏览器页面一定带，启动者的进程客户端不带），被拒绝的连接不占用唯一客户端位置。这只挡同机浏览器页面，调用方身份鉴权由 T4/T8 实现（作者 2026-11-23 决定）。

**进程退出**：runner 在终止事件发出且清理完成、空闲超时、客户端断线或收到 SIGTERM 后退出。退出码只反映清理结果：清理成功为 0，清理失败或超过清理时限为非零；任务本身失败（`run.failed` 来自模型或工具）不影响退出码（作者 2026-11-23 决定）。

清理卡在系统调用上时（例如诊断文件写入阻塞），runner 会先发出带原因的 `run.failed`，但进程可能无法自行退出（Node 退出时要回收卡住的线程池线程）。因此启动者必须设停止时限（默认 10 秒，不少于清理 5 秒 + 关闭连接 1 秒），到时强杀 runner 的整个进程组，并按非零退出处理（作者 2026-11-23 决定）。停止时限从启动者最早有理由认为 runner 该退出的时刻开始计时：发出取消或 SIGTERM、收到终止事件（`run.settled`/`run.failed`/`run.cancelled`）、或客户端连接关闭/断开，取其中最早者；runner 自己的空闲超时启动者不一定能感知，可不覆盖。计时用单调时钟（如 `performance.now()`），不用系统时间。停止时限必须明显长于 runner 内部收尾上限：引擎清理 5 秒 + 兜底 1 秒 + 等客户端关闭 1 秒 = 7 秒 < 10 秒，否则会把正常收尾中的 runner 强杀（作者 2026-11-24 决定）。

**工具进程**：pi 的 bash 工具以独立会话启动，不在 runner 的进程组里。正常结束、取消和清理失败时由 pi 的 abort/dispose 结束工具；runner 被强杀时正在运行的工具可能残留。这是 T1 的已知限制，由沙箱任务用容器或 cgroup 整体回收（作者 2026-11-23 决定）。

**激活工具**：runner 启动参数 `--tools <名字,名字>` 指定 pi 内置工具中激活哪些，只有它们会声明给模型，pi 系统提示中的工具清单与工具规则随之变化；未给时沿用 pi 默认（read/bash/edit/write）；名字为空或不是 pi 内置工具时，runner 不监听、非零退出。声明清单只是第一道防线：调用方拦截仍须拒绝清单之外的工具（作者 2026-11-24 决定）。

**外部程序与离线**：pi 的 grep 依赖 ripgrep，runner 要求 `rg` 在 PATH 上，由部署方安装。runner 进程设 `PI_OFFLINE=1`，pi 不得在运行时联网下载工具或包；缺 `rg` 时 grep 调用以错误结果返回，不静默下载（作者 2026-11-24 决定）。

**会话根目录**：runner 启动时必须配置 `sessionsRoot`（CLI `--sessions-root`），没有默认值。`start_task.sessionDir` 只能是它下面的相对路径；绝对路径、`..` 越界、经软链接跳出根目录时，任务以带原因的 `run.failed` 结束，不创建会话（作者 2026-11-23 决定）。

## 4. 示例

正常：
```json
{"type":"start_task","requestId":"A","sessionId":"s1","prompt":"fix","model":{"provider":"fake","id":"m"},"contextFiles":[{"repo":"r1","path":"AGENTS.md","content":"...","sourceCommit":"abc"},{"repo":"r2","path":"AGENTS.md","content":"...","sourceCommit":"def"}],"interceptMode":"callback"}
{"type":"accepted","requestId":"A","sessionId":"s1"}
{"type":"intercept_request","callId":"c1","toolName":"bash","input":{"command":"ls"}}
{"type":"intercept_decision","requestId":"D1","callId":"c1","decision":"allow"}
{"type":"cancel","requestId":"C1"}
```

错误：运行中第二次启动（requestId 为 B）
```json
// 先前 start_task A 仍在运行；调用方又发了 requestId 为 B 的 start_task
{"type":"error","requestId":"B","code":"already_running","message":"a task is already running"}
```

## 5. 0B 能力对照（pi 与 Claude Agent SDK）

来源：`docs/reviews/step01-pi-integration.md` 的 `#### 0B.1 能力 × pi × Claude Agent SDK`（含出处与探测编号，此处为压缩版）。pi 一列已在 1.5.1 上探测；**Claude 一列只对照了 `sdk.d.ts`（0.3.322）与官方文档，未实测，T1 不接 Claude。**

| 能力 | pi 1.5.1 | Claude Agent SDK 0.3.322 | 统一接口的边界 |
|---|---|---|---|
| 工具执行前放行 | 扩展 `tool_call` handler 返回 undefined | PreToolUse 钩子返回 `{}` / allow；`canUseTool` 返回 allow | 两边都能表达 `allow`。Claude 适配器应选 PreToolUse（canUseTool 会被 allow 规则绕过）。工具不存在/参数校验失败的 pi 调用不经过 `tool_call`，不发拦截请求 |
| 阻止并让模型看到原因 | 返回 `{block:true, reason}`；handler 抛错也阻止（fail closed） | PreToolUse `deny` + 原因；回调抛错默认放行（fail open），须设 `onFailure:"block"` | 两边都能表达 `block`+reason。出错默认行为相反，将来 Claude 适配器必须设 `onFailure:"block"` |
| 改写输入 | handler 中原地修改 `event.input`，修改后不再校验 | `updatedInput` | `Decision` 无改写字段，T1 不要求 |
| 异步等待决定 | handler 可 async，无超时，不因 abort 放弃等待 | 回调有 `signal` 与 timeout（PreToolUse 默认 600 秒） | 拦截 30 秒、确认 600 秒的超时，超时按 block，取消时释放等待，都由 runner 负责 |
| 确认 | 无内置“问用户”决定值；`ctx.ui.confirm` 无 UI 时返回 false | PreToolUse `ask` 转 canUseTool | 确认在拦截等待内部由 runner 完成（`confirm_request`/`confirm_response`），不用引擎原生 UI |
| 取消 | `session.abort()` 返回时 `agent_settled{aborted:true}` 已发；`dispose()` 不等待 | `abortController`；`Query.interrupt()`/`close()` | 两边都能表达 `cancel`；`run.cancelled` 由 runner 在清理完成后判定。Claude 取消后结果形态未核实 |
| 流式事件 | `session.subscribe`：`text_delta`、`message_end`、`tool_execution_start/end`、`agent_settled` | `stream_event`、`SDKAssistantMessage`、`tool_use`/tool_result、`SDKResultMessage` | 统一接口只要求 text.delta、message.completed、tool.started/finished 与唯一终止事件，终止事件由 runner 产生。Claude 的 `message.completed` 需按 message id 聚合 |
| 会话文件与恢复 | `SessionManager.create/open/inMemory`，用文件路径定位 | `resume: session-id`，目录由 CLI 决定 | `resume.sessionFileRef` 为引擎不透明引用（pi 路径 / Claude 会话 ID）；`sessionDir` 只对 pi 有对应。T1 中 resume 返回 `not_implemented`，runner 用 inMemory 会话 |

## 6. 变更记录

| 日期 | 变更 | 关联决策 | 受影响的调用方 |
|---|---|---|---|
| 2026-11-09 | 初版：全部消息、生命周期、错误码 | T1-4 | T1-9A、T1-9B、T2、T3、T5 |
| 2026-11-24 | 新增 runner 启动参数 `--tools`（激活工具清单） | 作者 2026-11-24（10B 0/5 后修流程缺陷：系统提示推 bash 而拦截拒绝 bash） | T1-10A4、T1-10B/10C、T3 |
| 2026-11-24 | runner 依赖 PATH 上的 `rg`，进程设 `PI_OFFLINE=1` 禁止运行时下载 | 作者 2026-11-24（10A4 发现 pi grep 缺 rg 时会从 GitHub 下载到工作区外） | T1-10A4、部署（含最终审查 Linux 镜像） |
