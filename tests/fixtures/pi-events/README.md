# pi 原始事件样本

这里的 `.jsonl` 全部是**真实 pi 输出**，没有手写事件。目前没有 synthetic 样本；以后若补手写的边界样本，文件名须带 `synthetic`，并在本文件单列说明。两类来源：
- 假模型样本（下文到“脱敏规则”为止）：由 `scripts/record-pi-fixtures.ts` 经 SDK 录制。
- 真实 API 样本 `real-qwen-api-*.jsonl`：从 Task 10B 一次真实运行中 runner 录下的原始事件选取、脱敏，见文末“真实 API 样本”。

以下到“脱敏规则”为止只说假模型样本：

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

## 真实 API 样本（Task 10B，2026-11-24）

| 文件 | 来源题目 | 内容 |
|---|---|---|
| `real-qwen-api-send-notice.jsonl` | `send_notice` | 第 1 轮调用 `bash` 被调用方拦截拒绝（`此任务不提供 bash，请使用 read 读取文件`）→ 改用 `read notify.py` → 一轮并行 7 个 `read` → 再读 `orders.py` → 文本 `[{"path":"orders.py","line":7}]`（行号判错，见实现说明 10B） |

生成元数据：
- 命令（仓库根目录）：`node --env-file=<项目根目录>/.env --import tsx scripts/t1-real-run.ts --models config/models.local.json --model qwen-api/qwen3.6-35b-a3b --record-dir .tmp/t1-api --output .tmp/t1-api-result.json`；本目录文件取自 `.tmp/t1-api/<题目>.jsonl`，即 runner `--record-pi-events` 的原始输出（`raw-event-recorder.ts`，收到即序列化）。
- 时间 `2026-11-24T07:51:25.755Z`（报告 `conditions.startedAt`）；源码 commit `d83ee30c62f3f63894eb97bb94c82760d4c53786`，工作区干净。
- pi `@earendil-works/pi-coding-agent` 1.5.1（未修改）。模型 provider `qwen-api`、id `qwen3.6-35b-a3b`（百炼北京端点 OpenAI 兼容接口，`compat.thinkingFormat: "qwen"`、`reasoning: true`、`maxTokens: 8192`），会话 `thinkingLevel: "off"`，请求中为 `enable_thinking: false`；没有设置 temperature/top_p（服务端默认）。
- 会话：runner 的受限资源加载器、内存会话、调用方拦截只放行副本内的 `read`（`scripts/t1-real-run.ts`）。每题一个临时 git 副本，题面列出文件清单。
- 录制环境与假模型样本不同：这里有 `system` 角色的 `message_end`（pi 系统提示，含工具说明与 docs 段），工具集是 pi 默认的 `read/bash/edit/write`。

脱敏（只改值，不改事件结构和顺序；脚本未入库，规则如下）：

| 原值 | 替换为 |
|---|---|
| 字段 `timestamp`、`durationMs` 的数字 / 字符串 | `0` / `1970-01-01T00:00:00.000Z`（同上文） |
| 字段 `id`、`parentId`、`targetId` 中的 8 位十六进制随机 id | `<entry-N>`（这两个样本中没有出现） |
| pi 安装目录（工作树 `node_modules/.pnpm/…/pi-coding-agent` 的 realpath，系统提示 docs 段） | `<pi-package>` |
| 工作树根目录 | `<repo>` |
| 家目录 | `<home>` |

替换后检查：样本中都不再含家目录、工作树路径和用户名（`grep` 无结果），`check-secrets --env DASHSCOPE_API_KEY` 通过。

规则：家目录、仓库/工作树路径和用户名必须去掉；随机临时目录若无法一致替换（如被拆在流式增量里），可以保留，并在下面注明原因。

**没有替换**的值：
- 每题临时副本路径 `/private/var/folders/<标识>/T/fp-t1-<随机>/repo`。它出现在系统提示的工作目录中，`send-notice` 里模型生成的 `bash` 命令也带着它，而这条命令是按流式增量（`toolcall_delta`）和逐步增长的 `partial`/`message` 参数录下的，路径被拆在多个片段里；只替换完整路径会让增量拼接与最终参数对不上。`/private/var/folders/<标识>/T/` 是 macOS 为每个用户分配的**固定**临时目录，`<标识>` 不含用户名，但对同一账户长期不变；`fp-t1-<随机>` 每题随机，运行结束即删除。前两次运行的样本保留了该标识；第 3 次运行用 `TMPDIR=/tmp/fp-t1` 避开了它（见 `docs/reviews/step01-pi-integration.md` 的“Task 10B 第 3 次运行”一节）。
- 百炼返回的 `responseId`、工具调用 id（`call_…`）：服务端生成，不含本机或账号信息。
- 用量字段 `usage.cost` 为 0，因为模型条目没有写 `cost`；实际花费按 token 数估算，见实现说明 10B。

读样本时：`partial` 超前的问题同上文；转换器测试（`tests/unit/pi-event-converter.test.ts`）断言思考关闭的样本没有思考内容（无 `thinking*` 流事件、助手消息只含 `text`/`toolCall`、`usage.reasoning` 为 0、`thinkingLevel` 为 `off`）。

### 第 2 次运行样本（Task 10B 第 2 次运行，2026-11-24）

| 文件 | 来源题目 | 内容 |
|---|---|---|
| `real-qwen-api-run2-normalize-name.jsonl` | `normalize_name` | 先 `grep`（结果带 `文件:行号:` 前缀）→ 并行 2 个 `read` → 两轮“文本 + `read`”同在一条助手消息 → 最终文本：一段说明加 JSON 数组（格式错误、漏了 text_utils.py:6，见实现说明 10B 第 2 次运行） |

生成元数据与上面不同的地方：
- 命令中 `--record-dir .tmp/t1-api-run2 --output .tmp/t1-api-run2-result.json`，取自 `.tmp/t1-api-run2/normalize_name.jsonl`；
- 时间 `2026-11-24T11:33:42.836Z`；源码 commit `e5253d7fbe8908c3e4789c48195fb7aa68f66132`，工作区干净；
- runner `--tools read,grep`：系统提示只声明 `read`、`grep`，rules 段没有 bash 规则；`rg` 为 ripgrep 16.0.0，runner 设 `PI_OFFLINE=1`；
- 提示词为“先用工具查看需要的文件，确认后再作答”。

脱敏规则与检查同上：家目录、工作树路径和用户名都已去掉，`check-secrets` 通过。临时副本路径照旧保留：模型这次给 `grep`/`read` 传的是副本内的绝对路径，它被拆在流式增量里。

### 第 3 次运行样本（Task 10B 第 3 次运行，思考开启，2026-11-24）

| 文件 | 来源题目 | 内容 |
|---|---|---|
| `real-qwen-api-run3-thinking-send-notice.jsonl` | `send_notice` | 每次请求都先有 thinking（`thinking_start/delta/end`）：thinking + `read notify.py` 与 `grep` 并行 → thinking + 并行 `read orders.py`、`read legacy.py` → thinking + 最终文本 `[{"path": "orders.py", "line": 8}]`（正确） |

取自 `.tmp/t1-api-run3/send_notice.jsonl`。运行条件（命令、时间、commit、思考级别与请求字段、`TMPDIR=/tmp/fp-t1`）见 `docs/reviews/step01-pi-integration.md` 的“Task 10B 第 3 次运行”一节。

脱敏规则同上；替换后搜索家目录、工作树路径和用户名都没有结果，`check-secrets --env DASHSCOPE_API_KEY --local-paths` 通过，且不含 `var/folders`。临时副本路径为 `/private/tmp/fp-t1/fp-t1-<随机>/repo`（`/tmp` 的 realpath），不含用户名或账户标识，照旧保留（同样被拆在流式增量里）。转换器测试断言：思考原文的任何片段都不出现在转换结果的任何事件、任何字段中（与工具结果等非思考内容重合的片段除外），每次请求的 `usage.reasoning` 都大于 0。
