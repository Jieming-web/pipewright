# pi 原始事件样本

这里的 `.jsonl` 全部是**真实 pi 输出**，由 `scripts/record-pi-fixtures.ts` 经 SDK 录制，没有手写事件。目前没有 synthetic 样本；以后若补手写的边界样本，文件名须带 `synthetic`，并在本文件单列说明。

- pi 版本：`@earendil-works/pi-coding-agent` **1.5.1**（未修改）
- 模型：Task 2A 的假 OpenAI 兼容服务（`tests/helpers/fake-openai-server.ts`），provider `fake`、model `fake-model`，不用真实模型
- 格式：每行一个事件，即 `session.subscribe` 回调收到的原始对象，按收到顺序，**收到时立即** `JSON.stringify`
- 校验：`tests/integration/pi-recording.test.ts` 对现场录制和本目录文件跑同一组断言

## 录制环境

- 隔离设置按 `docs/reviews/step01-pi-integration.md` 0A.4：`DefaultResourceLoader` 打开 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`，`appendSystemPrompt: []`，`reload({ resolveProjectTrust: async () => false })`；`SettingsManager.inMemory(…, { projectTrusted: false })`；`SessionManager.inMemory`。
- `agentDir`、`cwd` 都在每次新建的临时目录下，录完删除；`cwd` 里只有一个公开测试文件 `hello.txt`（内容 `hello from fixture\n`）。
- 设置：`retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 }`（0B.2 的快速配置），`cacheWarming: "off"`（避免 settled 后的额外请求）。
- 工具：所有场景都是 `createAgentSession({ tools: ["read"] })`，即 pi 内置的只读 `read` 工具。
- 录制函数在假服务 `errors` 非空、或请求数不等于脚本轮数时抛错，不写文件。

## 场景与生成命令

在仓库根目录执行：

| 文件 | 命令 | 假服务脚本 | 提示词 |
|---|---|---|---|
| `text-only.jsonl` | `pnpm tsx scripts/record-pi-fixtures.ts --scenario text --output tests/fixtures/pi-events/text-only.jsonl` | 1 轮文本 `Hello` `, ` `world` | `say hello` |
| `tool-call-then-text.jsonl` | `pnpm tsx scripts/record-pi-fixtures.ts --scenario tool --output tests/fixtures/pi-events/tool-call-then-text.jsonl` | 第 1 轮 `read({path:"hello.txt"})`（id `call_fixture_1`，分段参数），第 2 轮文本 `The file ` `says hello.` | `read hello.txt` |
| `retry.jsonl` | `pnpm tsx scripts/record-pi-fixtures.ts --scenario retry --output tests/fixtures/pi-events/retry.jsonl` | 第 1 轮 HTTP 500，第 2 轮文本 `recov` `ered` | `say hello` |
| `retry-drop.jsonl` | `pnpm tsx scripts/record-pi-fixtures.ts --scenario retry-drop --output tests/fixtures/pi-events/retry-drop.jsonl` | 第 1 轮发出 `par` `tial-` 后销毁连接（`drop`），第 2 轮文本 `recov` `ered` | `say hello` |

录到的关键序列（与 0B.2 一致）：
- `retry`：`message_end{stopReason:error, "500: …"}` → `agent_end{willRetry:true}` → `auto_retry_start{attempt:1, delayMs:20}` → `entry_appended` → `agent_start` → 文本增量 → `auto_retry_end{success:true}` → `agent_end{willRetry:false}` → `agent_settled{aborted:false}`
- `retry-drop`：文本增量 `par` `tial-` → `message_end{stopReason:error, "terminated: other side closed (UND_ERR_SOCKET)"}` → `agent_end{willRetry:true}` → `auto_retry_start` → … → 文本增量 `recov` `ered` → `auto_retry_end{success:true}` → `agent_end{willRetry:false}` → `agent_settled{aborted:false}`。失败尝试已发出的增量**不撤回**，最后一个 `agent_end.messages` 中只有 `recovered`。

## 读样本时要知道的

- `message_update` 的 `assistantMessageEvent.partial` 和 `message` 是 pi 内部会继续变化的共享对象。事件是在流已经读得更远之后才分发的，所以序列化下来的 `partial` 可能比本条 `delta` 超前（例如 `text_start` 时已是完整文本）。这是真实行为，转换器应以 `delta` 和 `message_end` 为准，不要依赖 `partial` 的中间状态。
- 本机连续录制多次结果逐字节相同，但上面这一点取决于时序，测试不比对整文件。

## 脱敏规则（保存前执行，只改值，不改事件的结构和顺序）

| 原值 | 替换为 | 说明 |
|---|---|---|
| 字段 `timestamp`、`durationMs` 的数字 | `0` | 时间戳和耗时，去掉不确定性 |
| 字段 `timestamp` 的字符串（会话条目的 ISO 时间） | `1970-01-01T00:00:00.000Z` | 同上，保留字符串类型 |
| 字段 `id`、`parentId`、`targetId` 中的 8 位十六进制随机 id（会话条目） | `<entry-N>`，按首次出现编号 | 同值同号，保留引用关系；`call_fixture_1`、`chatcmpl-fake-N` 本身确定，不替换 |
| pi 安装目录（`pi.getPackageDir()`，出现在系统提示 docs 段） | `<pi-package>` | 含本机用户名和家目录 |
| 本次临时根目录（含 realpath 形式） | `<tmp>` | 如系统提示中的 `<tmp>/work` |
| 家目录 | `<home>` | 兜底 |

替换按上表从上到下进行（路径先长后短）。替换后若仍含临时根目录、系统临时目录或家目录，录制函数抛错，不写文件。
