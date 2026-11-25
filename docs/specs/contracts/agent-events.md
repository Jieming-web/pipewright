# 契约：Agent 事件协议（agent-events）

> 职责：模块间的接口、输入输出结构、行为约定、错误与状态语义。不写内部实现。

- **提供方**：`packages/engine-protocol`（类型与 zod schema）、`packages/engine-runner`（`convertPiEvent`、`createRunEvents`）
- **调用方**：引擎适配器（Task 8B）、运行器（Task 9A）、宿主/存储、客户端
- **相关设计**：design.md（事件流与终止语义相关章节）；pi 事件语义见 `docs/reviews/step01-pi-integration.md` 0B.1、0B.2

## 1. 接口

### 1.1 事件

所有事件有 `type`。字段如下，schema 在 `agent-events.ts`（`AgentEventSchema` 等）。

| type | 类别 | 字段 |
|---|---|---|
| `run.started` | 进度 | `snapshot: RunSnapshot` |
| `text.delta` | 进度 | `text: string` |
| `message.completed` | 进度 | `role: "assistant"`, `text: string` |
| `tool.started` | 进度 | `callId: string`, `toolName: string`, `input: unknown` |
| `tool.finished` | 进度 | `callId: string`, `toolName: string`, `isError: boolean`, `output: unknown` |
| `run.settled` | 终止 | 无 |
| `run.failed` | 终止 | `reason: string` |
| `run.cancelled` | 终止 | 无 |

`input`、`output` 保留 JSON 可序列化的原始结构（例如 pi 的 `read` 结果是 `{content:[{type:"text",text}], …}`），不假定为字符串。

`RunSnapshot`：

```ts
{
  engine: { name: string; version: string };           // pi 适配器：name="pi"，version 为运行器解析到的 pi 包版本
  model: { provider: string; id: string };             // 8A 实际注册并交给会话的模型，不照抄 StartTask
  contextFiles: { repo: string; path: string; sourceCommit: string; sha256: string }[];
}
```

`sha256` 必须匹配 `^[0-9a-f]{64}$`（小写十六进制）。它由运行器按实际加载的内容计算，不信任调用方传入的值。

### 1.2 带序号的事件

`SequencedEvent = AgentEvent & { sessionId: string; seq: number; at: string }`，`at` 为以 `Z` 结尾的 UTC ISO 8601 时间（与 `engine.md` 一致，schema 为 `z.string().datetime()`）。`tool.started.input` 与 `tool.finished.output` 键始终存在，`null` 表示 pi 没有给出值。

### 1.3 函数

- `convertPiEvent(raw: unknown): ProgressEvent[]`：只转换进度，永不产生终止事件；未知或畸形输入返回 `[]`，不抛错。
- `createRunEvents(sessionId, emit, now?)`：返回 `{ publish(ProgressEvent), finish(TerminalEvent) }`。可选第三参数 `now: () => Date` 仅为测试注入时钟，默认 `() => new Date()`。

## 2. 行为约定

### 2.1 pi 事件到本协议的对应

| pi 原始事件 | 产生的事件 | 说明 |
|---|---|---|
| `message_update` 且 `assistantMessageEvent.type === "text_delta"` | `text.delta{text: assistantMessageEvent.delta}` | 只读 `delta`，不读 `partial`（共享可变对象，可能比 `delta` 超前） |
| `message_end`，`message.role === "assistant"` 且 `stopReason` 不是 `error`/`aborted` | `message.completed{role:"assistant", text}` | `text` 为 `message.content` 中所有 `type:"text"` 片段拼接；拼接后为空（例如只含工具调用的消息）则不产生 |
| `message_end`，role 为 user/system/toolResult，或助手消息 `stopReason` 为 `error`/`aborted` | 无 | 失败尝试的半截消息不产生 `message.completed` |
| `tool_execution_start{toolCallId, toolName, args}` | `tool.started{callId, toolName, input: args}` | |
| `tool_execution_end{toolCallId, toolName, result, isError}` | `tool.finished{callId, toolName, isError, output: result}` | `callId` 与 `tool.started` 对应 |
| `agent_start`、`agent_end`、`turn_start`、`turn_end` | 无 | `agent_end` 不是最终信号（重试时带 `willRetry:true`） |
| `auto_retry_start`、`auto_retry_end` | 无 | 重试是引擎内部过程 |
| `agent_settled` | 无 | 这是 pi 的最终静止信号，但终止事件的选择属于引擎（Task 8B），转换器不产生 |
| `entry_appended`、`message_start`、`text_start`、`text_end`、`toolcall_*`、`thinking_*` 及其他未知事件 | 无 | 刻意丢弃 |

`run.started` 不来自 pi 事件，由运行器在会话建立后用实际加载的信息构造并发布。

### 2.2 重试残留规则（作者决定 ①，2026-11-22）

失败尝试已经发出的 `text_delta` 照常转换成 `text.delta`，不撤回、不加标记。因此 `text.delta` 的拼接结果可能包含失败尝试的文字（样本 `retry-drop`：拼接为 `partial-recovered`）；**最终文本以 `message.completed` 为准**（该样本只有一个 `message.completed`，文本为 `recovered`）。

### 2.3 序号

- `seq` 是**会话内**序号：由 `createRunEvents` 唯一分配，从 1 开始连续递增，`run.started`、文本、工具与终止事件共用同一个序列。
- 宿主/存储负责跨会话的全局编号（如存储游标），不在本协议内；本协议的 `seq` 不用作全局顺序。
- 序号分配方只有一个；其他模块不得自行编号或补发事件。

### 2.4 终止

- 一次运行恰好有一个终止事件：`finish` 第一次调用发布，之后的 `finish` 与 `publish` 一律被忽略（不抛错）。
- 终止事件的选择由引擎（Task 8B）根据 pi 的 `agent_settled`、取消请求、清理结果决定；转换器不参与。
- `run.settled`、`run.cancelled` 只在清理成功后发布。
- `run.failed` 用于运行失败；若因清理失败而无法正常收尾，`reason` 须写明原因，并由进程退出兜底。
- 服务层不解析 pi 事件，只处理本协议事件。

## 3. 错误与状态语义

| 情况 | 返回或抛出什么 | 调用方应如何处理 |
|---|---|---|
| 输入不是对象、字段缺失或类型不对 | `convertPiEvent` 返回 `[]` | 无需处理 |
| 未知 pi 事件类型 | `[]` | 无需处理 |
| 终止后继续 `publish` / 重复 `finish` | 静默忽略 | 无需处理；不会再收到事件 |
| snapshot 缺字段或 `sha256` 格式不对 | `AgentEventSchema.safeParse` 失败 | 在边界（接收方）拒绝该事件 |

## 4. 示例

正常（`text-only` 样本）：

```json
{"type":"run.started","snapshot":{"engine":{"name":"pi","version":"1.5.1"},"model":{"provider":"fake","id":"fake-model"},"contextFiles":[]},"sessionId":"s1","seq":1,"at":"2026-01-01T00:00:00.000Z"}
{"type":"text.delta","text":"Hello","sessionId":"s1","seq":2,"at":"2026-01-01T00:00:00.001Z"}
{"type":"message.completed","role":"assistant","text":"Hello, world","sessionId":"s1","seq":5,"at":"2026-01-01T00:00:00.003Z"}
{"type":"run.settled","sessionId":"s1","seq":6,"at":"2026-01-01T00:00:00.004Z"}
```

错误：`{"type":"run.started","snapshot":{…,"contextFiles":[{"repo":"r","path":"p","sourceCommit":"c","sha256":"abc"}]}}` 被 schema 拒绝（sha256 非 64 位小写十六进制）。

## 5. 变更记录

| 日期 | 变更 | 关联决策 | 受影响的调用方 |
|---|---|---|---|
| 2026-11-22 | 初版：事件定义、pi 映射、重试残留规则、序号与终止规则 | 作者决定 ①（重试残留文字） | Task 4、8B、9A |
