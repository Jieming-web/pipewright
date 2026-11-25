# T1 接入 pi 与本地模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 执行方式遵守 `docs/workflow.md` 和作者指示，不因本行自行启动多 agent 编排。

**Goal:** 调用方通过统一引擎接口驱动 pi 完成任务；引擎适配器转换事件；规则来自调用方读取的 git 基准引用；仓库 `.pi/` 资源不加载；Qwen API 与 Mac 本地小模型仅靠配置切换。

**Architecture:** TypeScript pnpm 工作区，三个包：`engine-protocol` 定义语言无关的消息与校验；`engine-runner` 在独立进程内使用 pi SDK，转换事件并通过 WebSocket 通信；`engine-client` 提供 TS 客户端及调用方的本地 git 规则读取功能。规则加载复用 pi 的 `resourceLoader`，显式关闭自动发现，只注入平台提供的资源。隔离目录只是辅助措施，具体 SDK 设置先经 Task 0 核实。

**Tech Stack:** Node.js ≥ 22.19、TypeScript strict、pnpm workspace、vitest、ws、zod、确切版本的 `@earendil-works/pi-coding-agent`、Ollama。

**Spec:**
- `docs/workflow.md`：2.4–2.5、3.2–3.4、3.7.4、4.3–4.6。
- `docs/specs/tasks.md`：T1，验收标准 1–11（第 11 条运行快照为 2026-11-21 按 `decisions/016-repair-loop-and-rsi-refinements.md` 新增，作者已同意修改本计划）；五题运行是验收，不算正式评测。
- `docs/specs/design.md`：第 1 节原则 1、4、5、7；第 2 节 pi、统一引擎接口、模型客户端；3.6、3.14、3.15.3；8.1–8.3。
- `docs/specs/proposal.md`：R1、R9、S3；第 5 节模型与硬件。
- `docs/specs/decisions/001-reuse-pi-as-harness.md`、`003-typescript-as-main-language.md`、`005-engine-interface-and-2x2-eval.md`、`008-policy-rules-memory-layers.md`、`014-pi-package-choice.md`、`015-model-selection.md`；002 仅作历史背景。
- 本任务产出的契约：`docs/specs/contracts/engine.md`、`docs/specs/contracts/agent-events.md`，使用 `docs/templates/contract.md`。

## Global Constraints

- pi 使用锁定的确切版本，不修改、不 fork、不打补丁；复用其工具、agent loop、重试、会话与资源加载机制。T1 不实现非 agent 模型客户端，T6 等任务按 ADR 014 使用 pi-ai。
- 单元与集成测试只用 Fake/Mock 模型；Task 0C 的开工探测、Task 10B/10C 的验收运行才调用真实模型。所有探测只用临时样例或公开测试仓库。
- 拦截决策来自调用方；运行器只转发、等待并执行决定，不含策略判断。拿不到决定即拒绝；产品策略服务由 T3 接入。
- 任务工作树中的规则文件不成为生效规则；调用方从明确的本地基准 git 引用读取 `AGENTS.md`，经启动参数交给运行器。T5 起改为平台从 Gitea 受保护分支读取。
- Task 0A–0C 全部通过才开始 Task 1。任何必要条件不成立或无法核实，停下来报告作者，不分阶段绕过关卡；标注未执行不等于通过。
- 实现时使用任务分支 `step-01-pi-integration` 和隔离工作区。每个小任务验证后本地提交，格式 `类型(step01): 说明`；推送、合并、tag、发布需作者同意。
- 文档中文，代码标识符英文。实现说明记录规范 commit；已记录的结论与运行结果只追加，不覆盖旧结果。
- 每个小任务重新读取全局、任务、前置上下文；接口与 SDK 核实结果不符时按 workflow 3.3 停下。除脚手架启动与资料核实外，功能先写测试、看到预期失败、再实现并验证；最多返修 3 轮。
- 本计划中的字段与行为是待落入契约的实现约定；验收标准只在 tasks.md 定义。所有复选框保持未完成，执行时记录日期、命令、结果和一行备注。

## Review Focus

1. 在文本流、工具运行、等待拦截或等待确认时取消/断线：等待项释放，工具停止，引擎清理，终止事件最多一次（Task 6、8B、9C）。
2. 错误消息、重复启动、迟到或重复确认：返回可关联的错误，不影响原任务，不执行已取消的工具（Task 4、6、9C）。
3. 模型服务错误、不可达、重试：遵守 pi 的重试，最终失败有原因；不在中间 `agent_end` 提前结束（Task 2B、3、8B）。
4. 同名多仓库规则、任务分支篡改、上级目录或用户目录的资源污染：只注入调用方指定的基准规则与平台资源（Task 5、7、8B）。
5. 假服务脚本耗尽、答案漏报/多报、诊断事件采集：测试不掩盖额外调用，五题有固定判定，原始事件不进入统一接口（Task 2A、2B、10A1、10A2、10B、10C）。

## 开工环境与 Task 0 关卡

2026-11-09 作者说明：API key 已放在项目根目录 `.env` 的 `DASHSCOPE_API_KEY`；Ollama 由作者安装。以下是执行时必须复核的清单，不把作者说明或旧检查快照写成已通过。

| 项 | 开工检查与通过证据 | 负责 |
|---|---|---|
| Node / pnpm | `node --version` 满足 ≥ 22.19；`pnpm --version` 可运行；记录实际版本 | 0A |
| Git / shell / 文件系统 | `git --version`、`bash --version`；临时仓库可 init/commit/show，临时目录可写；检查任务分支、工作区及提交身份 | 0A |
| 安装与资料访问 | 能下载指定 pi 版本及测试工具，能读取该版本 SDK 文档/声明与 Claude Agent SDK 官方文档 | 0A、0B |
| 本地通信与子进程 | 临时 HTTP/WebSocket 可绑定 loopback 随机端口；Node 能启动并清理子进程 | 0A |
| 执行与审查能力 | 核实所选执行方式及 writing-plans、using-git-worktrees、TDD、verification-before-completion、requesting-code-review 等所需技能/工具可用；缺失则报告，不默认为已具备 | 0A |
| pi SDK | 锁定 1.5.1（2026-11-10 作者决定由候选 1.5.0 改为 1.5.1，见实现说明 0A-R）；资源隔离、扩展、MCP、事件、取消与清理 API 有固定版本证据 | 0A、0B |
| API 凭证 | 从项目根目录 `.env` 注入 `DASHSCOPE_API_KEY`；只记录存在/缺失和调用成败，不打印值、不提交 `.env` | 0C |
| API 服务与模型 | 固定模型版本、服务地址、权限/额度及经 pi 的真实工具调用往返可用 | 0C |
| Ollama 与本地模型 | `ollama --version`、服务可达、选定模型已下载；记录模型标签与 digest、量化、推理配置，实际完成一次推理请求 | 0C |
| Mac 资源 | 16GB 约束下的小模型可加载；记录可用内存与磁盘，下载和安装等待另计 | 0C |
| 验收仓库 | Task 10A1 创建并版本化样例；Task 10B 前复核样例版本、答案集与运行目录可用 | 10A1、10B |
| Docker | T1 无容器依赖，不作为此关卡条件；T2 起另行检查 | — |

隔离工作区通常没有未跟踪的 `.env`。执行者显式指定原项目根目录 `.env` 的绝对路径，以 Node `--env-file=<绝对路径>` 加载到验收进程，再由它传递给 runner；不依赖当前目录碰巧存在 `.env`。模型配置仅引用变量名，日志与录制不含密钥。Task 0 探测在临时目录安装锁定依赖并运行，不要求产品脚手架预先存在；保存脱敏命令、版本与结果摘要到实现说明，失败即停下。

## 小任务、依赖与覆盖

按表顺序执行；“依赖”列是必须已有的前置产物。预计时间为主动工作时间，下载、模型等待、作者自测另计；超过一小时仍未形成独立可验证产物时报告并调整拆分。

| 小任务 | 预计 | 依赖 | T1 验收引用 |
|---|---|---|---|
| 0A 环境、资源隔离与 MCP 核实 | 60 分钟 | 无 | 6、8、9 |
| 0B 引擎公共能力核实 | 45 分钟 | 0A | 1、2、5 |
| 0C 模型资料与真实探测 | 60 分钟 | 0A、0B | 3 |
| 1 工作区与版本锁定 | 60 分钟 | 0A–0C 全部通过 | 6；其余测试基础 |
| 2A 假模型服务 | 45 分钟 | 1 | 测试支撑 |
| 2B 用真实 pi 录制测试样本 | 45 分钟 | 2A、0B | 2 |
| 3 事件转换与终止发布 | 60 分钟 | 2B | 1、2、5、11 |
| 4 引擎消息与契约 | 60 分钟 | 3、0B | 1 |
| 5 调用方读取基准规则 | 45 分钟 | 4 | 7、10 |
| 6 拦截与确认协调 | 60 分钟 | 4 | 1、5 |
| 7 受限资源加载器 | 60 分钟 | 5、6、2A | 7、8、10、11 |
| 8A 模型配置与会话创建 | 45 分钟 | 7、3 | 3、6、11 |
| 8B 引擎运行与取消 | 60 分钟 | 8A、6 | 1、2、5、7、10、11 |
| 9A runner 服务与进程入口 | 60 分钟 | 8B、4 | 1、5 |
| 9B TS 客户端 | 60 分钟 | 9A | 1 |
| 9C 跨进程异常与清理验证 | 60 分钟 | 9B | 1、5 |
| 10A1 五题样例与判定 | 60 分钟 | 9C | 4 |
| 10A2 只读验收运行脚本 | 60 分钟 | 10A1、5、9B | 3、4 |
| 10A3 真实运行刹车、运行条件与密钥检查（2026-11-24 作者要求） | 45 分钟 | 10A2 | 3、4 |
| 10A4 工具清单参数、grep 与提示词流程修正（2026-11-24 作者决定，10B 首跑 0/5 后） | 60 分钟 | 10A3 | 3、4 |
| 10A5 录制离线统计：请求数、中止数与用量（2026-11-24 作者决定） | 45 分钟 | 10A4 | 3、4 |
| 10A6 思考级别参数与思考开启时的判卷、截断、隐私检查（2026-11-24 作者决定） | 60 分钟 | 10A5 | 3、4 |
| 10B API 验收与录制 | 45 分钟 | 10A3；第 2 次前 10A4、10A5；第 3 次前 10A6 | 2、3、4 |
| 10C 本地验收与配置切换证据 | 45 分钟 | 10B | 2、3、4 |
| 11 收尾关卡 | 60 分钟 | 以上全部 | 1–11 逐条核对 |

---

### Task 0A：环境、资源隔离与 MCP 核实

**目标**：检查环境表中本项负责的能力，查明关闭资源发现和使用内置 MCP 的方法。没有产品代码前也能验证。

**Files:** Create `docs/reviews/step01-pi-integration.md`，按 `docs/templates/review.md`，先记录规范 commit 与开工核实。

**Interfaces:** 输出锁定 pi 版本、资源入口清单、SDK 配置组合、MCP 配置样例和可复现的脱敏探测命令，供 0B、0C、7 使用。

- [x] **Step 1：检查执行环境**，按环境表运行版本、临时 git 提交、端口与子进程探测；记录实际命令、退出码和结果，任一必要能力失败即停止。 — 2026-11-10：`node --version`、`pnpm --version`、`git --version`、临时仓库 init/commit/show、`node probe-net-proc.mjs` 等均退出 0（Node v24.15.0、pnpm 10.34.9、git 2.39.5、bash 3.2.57；loopback HTTP/WS 随机端口与子进程清理通过）；明细见 `docs/reviews/step01-pi-integration.md` 0A.2。
- [x] **Step 2：核实资源发现**，读取固定版本的 SDK、安全、扩展文档及类型声明。检查 `cwd`、`agentDir`、祖先目录、用户目录、环境变量和 settings 引用路径；确认自定义 `resourceLoader` 后工具工作目录仍正确。查明关闭上下文文件、配置、提示词、扩展、skill 自动发现的明确设置；空目录不作为充分证据。内联 `project_trust` 若可用，只作第二道保险。 — 2026-11-10：依据 tag v1.5.0（f9a2636）文档与 `.d.ts`；`node run-probe.mjs baseline|baseline-home|locked|locked-default-mcp` 均退出 0：基线加载全部敌意资源；推荐组合（`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` + `SettingsManager.inMemory(…, {projectTrusted:false})` + `agentsFilesOverride` + `appendSystemPrompt: []` + `reload({resolveProjectTrust})`）只出现平台资源，bash/read 工作目录正确；见实现说明 0A.3–0A.4。
- [x] **Step 3：核实 MCP**，以固定版本文档的章节、符号和示例路径记录内置 MCP 依赖、SDK 启用步骤、配置文件位置/格式及可信配置注入方式。`createMcpExtension`、`bindExtensions` 等名称均须以该版本为准；用临时本地 MCP 服务验证加载配置并列出工具。不自建替代客户端；能力不可用即报告。 — 2026-11-10：内置 `createMcpExtension`（依赖 `@earendil-works/pi-mcp@1.5.0`）+ `session.bindExtensions({})`；经 `loadConfig` 注入的临时 stdio 服务被加载、列出 `mcp__platform__echo/add` 并调用成功；发现默认配置读取进程级 `getAgentDir()`（不随 SDK `agentDir`）；见实现说明 0A.5。
- [x] **Step 4：记录并提交** `docs(step01): 核实执行环境与 pi 资源及 MCP 能力`。记录官方固定版本链接/commit，不引用浮动文档的行号。 — 2026-11-10：实现说明已创建（规范 commit 64d3422，pi tag v1.5.0 = f9a2636），本地提交见同名 commit。

### Task 0B：引擎公共能力核实

**目标**：在协议设计前确认 pi 与 Claude Agent SDK 的公共能力。

**Files:** Append `docs/reviews/step01-pi-integration.md` 的能力核实记录。

**Interfaces:** 输入 0A 的 pi 版本；输出“能力 × pi × Claude Agent SDK”表、pi 事件及清理生命周期证据，供 2B、3、4、8B 使用。

- [x] **Step 1：查阅双方官方文档与类型**，逐项核实工具执行前放行/阻止/改写、确认表达、取消、流式事件、会话文件与恢复；公共接口只要求两者可表达的能力，差异记录到表中，不在 T1 接通 Claude。 — 2026-11-10：pi 1.5.1（tag v1.5.1 = dd30101）的 `dist/` 与文档，Claude Agent SDK 0.3.322 的 `sdk.d.ts` 加官方文档 6 页；8 项能力两者都可表达，差异与边界见实现说明 0B.1；没有调用 Claude API。
- [x] **Step 2：核实 pi 生命周期**，记录扩展绑定方式、模型错误/重试与最终静止事件的关系、`prompt` 完成语义、abort/dispose 对运行工具及扩展等待的影响。确认 `agent_end` 与 `agent_settled` 的实际语义；无法支撑结束判定或清理约定时停下，不依据名称猜测。 — 2026-11-10：`node run-lifecycle.mjs <16 个场景>` 在 1.5.1 上全部退出 0，另有 5 个场景的 1.5.0 对照；结论：`agent_end` 不是最终信号，`agent_settled` 是唯一的最终静止信号，最终失败时 prompt 仍 resolve；abort 会杀掉 bash 进程组，但拦截 handler 不理会 signal 时 abort 不返回；#9126/#8635/#11879 有实测对照，#11599 只查了代码；没有阻塞项，见实现说明 0B.2–0B.4。
- [x] **Step 3：验证并提交**，检查每项能力有版本化出处、每个差异有处理边界；`docs(step01): 核实引擎公共能力与生命周期`。 — 2026-11-10：自查见实现说明 0B.5，本地提交见同名 commit。

### Task 0C：模型资料与真实调用探测

**目标**：完成模型开工核实，选定 T1 使用的一项 API 候选与本地小模型；不提前替 T2 作主模型选型。

**Files:** Append `docs/reviews/step01-pi-integration.md` 的模型表、环境证据与探测结果。

**Interfaces:** 输出 API 平台/区域/地址/固定模型 ID、密钥变量名、价格与许可证出处、训练截止日期；本地模型完整标签、digest、量化与配置。未公开信息明确写“未公开”，若必要条件无法核实则停下请作者决定。

- [x] **Step 1：核实公开资料**，查两个 Qwen 主模型候选的官方模型卡和 API 平台资料，记录 API 可用性、价格、许可证与训练截止日期；选本次可用的一个候选，另一候选的接通比较留给 T2。确认 Qwen 3.x 约 4B 指令模型在 16GB Mac 上的具体部署版本。不能用浮动 `latest` 代替版本锁定。 — 2026-11-10：Qwen3.6-35B-A3B 与 Qwen3-Coder-Next 都是 Apache-2.0，训练截止日期都未公开；百炼北京有 `qwen3.6-35b-a3b`（没有快照 ID，按作者决定记录 ID 和观察日期），原价每百万 token 输入 1.8 元、输出 10.8 元；本 key 调不到 Coder-Next，留给 T2；本地小模型为 `qwen3:4b-instruct-2507-q4_K_M`，T1 使用派生标签 `qwen3-4b-instruct-2507-ctx16k`；见实现说明 0C.0–0C.1。
- [x] **Step 2：检查凭证和本地服务**，按环境表从根目录 `.env` 注入 `DASHSCOPE_API_KEY`；核实 Ollama 安装、服务、模型下载及实际加载。缺失或不可调用即停，不跳到 Task 1。 — 2026-11-10：`DASHSCOPE_API_KEY` 存在，北京端点 `/models` 返回 200；Ollama 0.40.15 服务可达，两个标签已下载（digest 0edcdef3…、7f091551…，Q4_K_M，num_ctx 16384）；`ollama ps` 显示 3.9 GB、100% GPU；内存 16 GiB，磁盘可用 51 GiB；见实现说明 0C.2。
- [x] **Step 3：做最小 pi SDK 探测**，临时目录使用同一锁定 pi 版本和 0A 的隔离配置；API 模型实际请求一次只读工具，验证工具名/参数、执行结果回传、后续回答及结束。Ollama 至少完成经 pi 的推理请求，记录工具调用尝试及限制；小模型能力不足与服务/集成故障分开记录，后者不能当作“小模型做不对”放过。 — 2026-11-10：`node run-real.mjs qwen-api` 和 `node run-real.mjs ollama qwen3-4b-instruct-2507-ctx16k` 都退出 0，各 2 个请求、都返回 200，`read` 往返、工具结果回传、回答 `pelican`、`agent_settled` 都完成；没有服务或集成故障；API 花费约 0.0046 元；线上协议见实现说明 0C.3–0C.4。
- [x] **Step 4：关卡核对与提交**，0A–0C 必要检查全部有证据才允许 Task 1。`docs(step01): 记录模型版本与开工探测`。Task 0 的记录不替代五题验收。 — 2026-11-10：0A、0A-R、0B、0C 的必要项都有证据（实现说明 0C.5），Task 1 可以开始；本地提交见同名 commit。

### Task 1：工作区脚手架与版本锁定

**目标**：先让测试命令能运行，再测试版本锁定逻辑。

**Files:** Create root `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`vitest.config.ts`、`pnpm-lock.yaml`；三个包的 `package.json`、`tsconfig.json` 与入口；`scripts/check-pi-pinned.mjs`、`tests/unit/check-pi-pinned.test.ts`。Modify `.gitignore`。

**Interfaces:** `checkPiPinned(rootDir: string): { ok: boolean; problems: string[] }`；CLI 失败退出 1。root 提供 `test`、`typecheck`、`build`、`check:pi`。

- [x] **Step 1：建立最小脚手架并安装依赖**，此时不实现检查逻辑。protocol 自身依赖 zod；runner 依赖 protocol、确切版本 pi、ws；client 依赖 protocol、ws。跨包使用 `workspace:*`；每包声明自身实际导入依赖。配置 strict、Node 模块方式、包导出与构建顺序；root 开发依赖含 TypeScript、vitest、tsx、相关类型声明。忽略依赖、构建、临时目录和本地模型配置，保留 `.env` 忽略规则。 — 2026-11-10：`pnpm install` 完成；三个包 `@forgepilot/engine-{protocol,runner,client}`，runner 依赖 pi `1.5.1`（确切版本）；为解析锁文件，root 另加 devDependency `yaml`；pnpm 10 跳过了 @google/genai、esbuild、protobufjs 的构建脚本，没有执行 approve-builds，vitest 和 tsx 照常可用。
- [x] **Step 2：写失败测试**，覆盖非确切 semver、git/file/npm alias 替代源、pi 的 patch 配置、锁文件解析版本不符和合法工作区；运行 `pnpm vitest run tests/unit/check-pi-pinned.test.ts`，确认因缺失目标功能失败，而非测试工具未安装。 — 2026-11-10：`pnpm vitest run tests/unit/check-pi-pinned.test.ts` 失败，原因是 `Cannot find module '../../scripts/check-pi-pinned.mjs'`，vitest 3.2.7 已安装，说明失败来自目标功能缺失；返修第 1 轮新增的 5 个测试同样先失败（5 failed | 21 passed）。
- [x] **Step 3：实现检查**，检查根及各包 manifest、锁文件与补丁设置；已知 vendored pi 路径要报告，任意改名源码拷贝由收尾代码审查补充，脚本不声称独自证明 S3。 — 2026-11-10：检查根目录和各包 manifest、锁文件 importers（specifier 与解析版本）、patchedDependencies/overrides、改用其他键名的 npm 别名，以及已知的 vendored 路径；返修 1 轮，修复锁文件缺少 pi 条目时被跳过、别名换键名后漏检两个问题。；2026-11-10 作者审查后返修第 2 轮：检查范围扩大到所有 `@earendil-works/pi-*` 子包（作者决定），锁文件 `packages`/`snapshots` 中各 pi 包的版本也须是 1.5.1；工作区的包改为按 `pnpm-workspace.yaml` 的 `packages:` 列表查找，遇到不支持的写法直接报错
- [x] **Step 4：验证并提交**，`pnpm vitest run tests/unit/check-pi-pinned.test.ts && pnpm check:pi && pnpm typecheck && pnpm build` 全部成功；`feat(step01): 工作区与 pi 版本锁定`。 — 2026-11-10：控制会话复跑这四条命令，全部成功（26/26 通过，`pi 1.5.1 版本锁定检查通过`，`tsc -b` 无错误）；提交 56f0585 `feat(step01): 工作区与 pi 版本锁定`、03fc520 `fix(step01): 锁文件与别名的 pi 锁定检查`。；返修第 2 轮后控制会话复跑：39/39 通过，`check:pi` 通过，`pnpm test` 49/49 通过；提交 7bd2ea2 `fix(step01): pi 子包与工作区包路径的锁定检查`

### Task 2A：假的 OpenAI 兼容模型服务

**目标**：让真实 pi 的测试调用可编排的本地假模型，并能检查其请求。

**Files:** Create `tests/helpers/fake-openai-server.ts`、`tests/unit/fake-openai-server.test.ts`。

**Interfaces:** `ScriptedTurn` 支持文本及分块延迟、工具调用（名字/参数）、HTTP 错误；`startFakeOpenAIServer(turns: ScriptedTurn[]): Promise<{ baseUrl: string; requests: unknown[]; errors: string[]; close(): Promise<void> }>`；`fakeModelsJson(baseUrl: string): object` 生成 provider `fake`、model `fake-model` 的配置。

- [x] **Step 1：写失败测试**，覆盖文本分块重组、工具参数重组、HTTP 错误、请求顺序、断线清理；脚本耗尽时返回明确错误并写入 `errors`，绝不复用最后一条文本。测试结束要求 `errors` 无意外项。 — 2026-11-10：`tests/unit/fake-openai-server.test.ts` 覆盖文本分块重组、分段与一次给全两种工具调用、HTTP 429、请求顺序、脚本耗尽（返回 500、写入 errors、不复用）、断线清理、`fakeModelsJson`，以及一轮真实 pi 1.5.1 文本对话（控制会话追加）；每个测试结尾都断言 errors 里没有意外项。返修第 1 轮把断线测试改为在 close 之前检查写出次数和 inFlight，并新增意外请求写入 errors 的测试。
- [x] **Step 2：运行并确认预期失败**，`pnpm vitest run tests/unit/fake-openai-server.test.ts`。 — 2026-11-10：首次运行失败，原因是 `Cannot find module`，模块尚不存在；返修第 1 轮的测试同样先失败（2 failed | 8 passed）。控制会话做了变异检查：去掉断线判断后，断线测试失败（expected 52 to be less than 10），随后已还原。
- [x] **Step 3：实现服务**，按 0C 核实的 OpenAI 兼容协议发送流式文本/工具调用；本地随机端口，不访问外部模型。 — 2026-11-10：服务只绑定 127.0.0.1 的随机端口；分块格式与 0C.4 一致，由控制会话逐项核对；意外的方法或路径返回 404 并写入 errors；测试可读取 `stats {writes, inFlight}`；`fakeModelsJson` 把 compat 全部关闭，`reasoning: false`，apiKey 使用字面值 `fake-key`。
- [x] **Step 4：同命令通过后提交** `test(step01): 可编排的假模型服务`。 — 2026-11-10：控制会话复跑，该文件 10/10 通过，`pnpm typecheck` 无错误，`pnpm test` 36/36 通过；提交 f4c0fe9 `test(step01): 可编排的假模型服务`、a809bee `test(step01): 假模型服务断线与意外请求的检查`。；2026-11-10 作者审查后返修第 2 轮（作者决定）：根目录 devDependencies 加入 pi `1.5.1`，测试改用正常 import（RED：Cannot find package）；控制会话复跑：该文件 10/10，`check:pi` 通过（根目录 importer 为 1.5.1，锁文件中只有一份 pi），`pnpm test` 49/49 通过；锁文件里间接依赖 `@smithy/node-http-handler` 由 4.12.1 升到 4.14.2，是 pnpm 重新解析依赖的副作用；提交 a0c92d0

### Task 2B：通过真实 pi 录制事件样本

**目标**：先取得真实 SDK 事件，再写转换器；无需真实模型。

**Files:** Create `scripts/record-pi-fixtures.ts`、`tests/fixtures/pi-events/{text-only,tool-call-then-text,retry,retry-drop}.jsonl`、`tests/fixtures/pi-events/README.md`、`tests/integration/pi-recording.test.ts`。Modify `tests/helpers/fake-openai-server.ts`、`tests/unit/fake-openai-server.test.ts`：`ScriptedTurn` 新增一种脚本，发出指定的若干文本块后断开连接（2026-11-10 作者决定，用于录制“说到一半断开再重试”的真实样本，见 0B.2 第 330–332 行）。

**Interfaces:** `recordPiFixture(scenario: "text" | "tool" | "retry" | "retry-drop", output: string): Promise<void>`（`retry`：第一次请求返回可重试的 HTTP 错误，第二次成功；`retry-drop`：第一次请求发出部分文本后断开，第二次成功），使用真实 pi、2A 假服务与 0A 核实的隔离设置；CLI `pnpm tsx scripts/record-pi-fixtures.ts --scenario <场景> --output <路径>`。

- [x] **Step 1：写失败测试**，验证记录包含真实 SDK 的文本、工具开始/结束及最终结束事件；两个重试样本按 0B 查明的机制触发中间结束/重试，验证之后仍有事件；`retry-drop` 还要验证失败那次尝试已发出的文本增量保留在记录中。假服务新增的断开脚本同样先写失败测试。保存前脱敏，样本只含临时公开测试数据。 — 2026-11-10：`tests/integration/pi-recording.test.ts` 对每个场景都做两件事：用真实 pi 现场录制并断言，同时检查已提交的样本文件。断言覆盖文本、工具开始/结束、`agent_settled` 是最后一个事件且中间的 `agent_end` 带 `willRetry:true`，以及 retry-drop 保留了失败那次尝试已发出的 `partial-` 文本增量；假服务新增的断开脚本也补了单元测试。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/integration/pi-recording.test.ts`。 — 2026-11-10：录制测试先失败，原因是找不到模块；假服务的断开测试先失败，报 `expected '' to be 'partial-'`。
- [x] **Step 3：实现录制并运行四个场景**，README 写 pi 版本、生成命令、场景与脱敏规则。不能取得预期重试序列时停下核对 0B；不得手写事件冒充录制。额外手写边界样本须另标 synthetic。 — 2026-11-10：用 CLI 录完 4 个场景，全部是真实 pi 1.5.1 的输出，没有 synthetic 样本；README 写明了版本、生成命令、各场景说明和脱敏规则。控制会话复核：(1) 重新录制的 4 个样本与已提交的逐字节相同；(2) 变异检查，给 text 场景多加一条用不到的剧本后，录制报 `expected 2 requests, got 1`，且没有写出文件；(3) 重试的事件顺序与 0B.2 一致，实测比 0B.2 多出 `entry_appended`，`auto_retry_end` 出现在第二次尝试的 `message_end` 之后。
- [x] **Step 4：同命令通过并提交** `test(step01): 录制真实 pi 事件样本`。 — 2026-11-10：控制会话复跑，录制测试和假服务测试共 19/19 通过，`pnpm test` 58/58 通过，`typecheck` 和 `check:pi` 都通过；提交 e63333e `test(step01): 假服务新增中途断开脚本`、5755912 `test(step01): 录制真实 pi 事件样本`。；2026-11-10 作者审查后返修第 1 轮（作者决定）：根目录新增 `tsconfig.json`，`pnpm typecheck` 改为同时检查 `scripts/` 和 `tests/`（RED：故意写入 `maxRetries: "2"` 后，旧命令 exit 0，新命令报 TS2322）；断开测试改用 `vi.waitFor`；控制会话复跑 typecheck、check:pi、build 都通过，`pnpm test` 58/58 通过；提交 4790c85 `chore(step01): 脚本与测试纳入类型检查`

### Task 3：事件转换与唯一终止发布

**目标**：由引擎适配器转换原始事件；由一个发布器统一编号并保证终止唯一。

**Files:** Create `packages/engine-protocol/src/agent-events.ts`、`packages/engine-runner/src/pi-event-converter.ts`、`packages/engine-runner/src/run-events.ts`、`tests/unit/pi-event-converter.test.ts`、`tests/unit/run-events.test.ts`、`docs/specs/contracts/agent-events.md`。

**Interfaces:**
- `ProgressEvent`：`run.started {snapshot: RunSnapshot}`；`text.delta {text}`；`message.completed {role: "assistant", text}`；`tool.started {callId, toolName, input}`；`tool.finished {callId, toolName, isError, output}`。output 保留 JSON 可序列化的工具结果，不假定只有字符串。
- `TerminalEvent`：`run.settled`、`run.failed {reason}`、`run.cancelled`。`AgentEvent = ProgressEvent | TerminalEvent`；`SequencedEvent = AgentEvent & {sessionId: string; seq: number; at: string}`，at 为 ISO 时间。
- `RunSnapshot`：`{engine: {name: string; version: string}; model: {provider: string; id: string}; contextFiles: {repo: string; path: string; sourceCommit: string; sha256: string}[]}`。engine.name 用字符串（T12 起还有 Claude Code 适配器），pi 适配器填 `"pi"`，version 取运行器解析到的 pi 包版本；model 取 8A 实际注册并交给会话的模型（provider 与 id），不照抄 StartTask；contextFiles 来自 Task 7 加载器回读的实际加载内容，sha256 由运行器按实际加载的内容计算，不信任调用方传入的值（T1 验收 11）。
- `convertPiEvent(raw: unknown): ProgressEvent[]` 只转换进度，不产生终止；未知事件返回空数组。错误与最终静止由引擎按 0B 的语义处理。
- **重试残留的文字片段（2026-11-22 作者决定 ①）**：失败那次尝试已经发出的 `text_delta` 照常转换成 `text.delta`，不撤回、不加标记；契约写明“`text.delta` 可能含失败尝试的文字，最终文本以 `message.completed` 为准”。为保证这一点，`message.completed` 只由 `stopReason` 不是 `error`/`aborted` 的助手消息结束事件产生（失败尝试的半截消息不产生 `message.completed`）。转换只读事件中的 `delta` 与 `message_end` 的消息内容，不读会继续变化的 `partial` 字段（2B 样本 README）。
- `createRunEvents(sessionId: string, emit: (event: SequencedEvent) => void): { publish(event: ProgressEvent): void; finish(event: TerminalEvent): void }` 是唯一序号分配方；从 1 连续递增，finish 后忽略后续发布及重复 finish。

- [x] **Step 1：写失败测试**，重放 2B 样本验证文本、工具关联、未知事件、重试中间结束不产生终止；发布器验证 started/工具/文本/终止共享序号、只发一次终止且终止后无事件；protocol 校验 `run.started` 的 snapshot 字段（缺字段或 sha256 格式不对时拒绝）。 — 2026-11-22：新增 `tests/unit/pi-event-converter.test.ts`（8 项测试，用 2B 样本回放：文本、工具 callId 关联、未知或畸形事件返回 []、重试中途的 agent_end 不产生终止、retry-drop 的增量拼起来是 "partial-recovered"，而唯一的 message.completed 是 "recovered"）、`run-events.test.ts`（4 项）、`agent-events.test.ts`（10 项，按控制会话的决定新增：snapshot 缺字段或 sha256 不合格时拒绝）。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/unit/pi-event-converter.test.ts tests/unit/run-events.test.ts`。 — 2026-11-22：3 个文件都失败，原因是缺少模块或 schema，说明功能尚未实现。
- [x] **Step 3：实现并写契约**，记录每种事件字段、与原始 pi 事件的对应、会话内编号规则及宿主/存储负责的全局编号边界；settled/cancelled 只在清理成功后发布，failed 若因清理失败须明确原因并由进程退出兜底。不在服务层解析 pi 事件。 — 2026-11-22：新增 `docs/specs/contracts/agent-events.md`（字段、pi 事件对应表含刻意丢弃的事件、重试残留规则 ①、会话内序号与全局编号的边界、终止规则）。实现者另加了三处，均已写进契约：只有工具调用、没有文字的助手消息不产生 message.completed（待作者确认）；createRunEvents 可选的 now 参数；sha256 只接受小写 64 位十六进制。
- [x] **Step 4：同命令通过并提交** `feat(step01): 事件协议与统一终止发布`。 — 2026-11-22：控制会话复跑：3 个文件 22/22 通过，`pnpm test` 80/80 通过，typecheck、build、check:pi 都通过；审查结论 Approved（没有 Critical/Important 问题）；提交 02e716e `feat(step01): 事件协议与统一终止发布`。

### Task 4：引擎消息与跨进程契约

**目标**：落定与语言无关的 JSON over WebSocket 消息、状态和错误语义。

**Files:** Create `packages/engine-protocol/src/engine-messages.ts`、`packages/engine-protocol/src/index.ts`、`tests/unit/engine-messages.test.ts`、`docs/specs/contracts/engine.md`。

**Interfaces:** 以下消息均由 protocol 导出并校验，引用 Task 3 的事件类型。

| 消息/类型 | 字段 |
|---|---|
| `ContextFile` | `repo: string; path: string; content: string; sourceCommit: string` |
| `start_task` / `StartTask` | `requestId, sessionId, prompt: string; model: {provider: string; id: string}; contextFiles: ContextFile[]; interceptMode: "callback" \| "policy"; resume?: {sessionFileRef: string}; sessionDir?: string` |
| `ToolRequest` / `intercept_request` | `callId, toolName: string; input: unknown` |
| `Decision` | `{decision: "allow"}` 或 `{decision: "block" \| "confirm"; reason: string}` |
| `intercept_decision` | `requestId, callId: string` 加 `Decision` |
| `ConfirmRequest` / `confirm_request` | `confirmId, callId, toolName, reason: string; input: unknown` |
| `Confirmation` | `approved: boolean; by: string; reason?: string`；拒绝时 reason 必填 |
| `confirm_response` | `requestId, confirmId: string` 加 `Confirmation` |
| `cancel` | `requestId: string` |
| `accepted` | `requestId, sessionId: string`，仅用于启动确认 |
| `event` | `event: SequencedEvent` |
| `error` / `ProtocolError` | `requestId?: string; code: "invalid_message" \| "already_running" \| "run_finished" \| "not_implemented" \| "stale_response" \| "internal"; message: string` |

`ClientMessage`、`RunnerMessage` 是各方向消息联合；消息含同名 `type` 判别字段（辅助类型除外）。`InterceptDecision`、`ConfirmResponse` 分别是 intercept_decision、confirm_response 的完整消息类型；ToolRequest/ConfirmRequest 是去掉消息 type 后的载荷。`parseClientMessage(raw: string)` 与 `parseRunnerMessage(raw: string)` 返回 `{ok: true; message}` 或 `{ok: false; error: string}`，不抛解析异常。字段非空、上下文列表必传（可空），非法决策、重复 repo/path、越界相对路径拒绝。

- [x] **Step 1：写失败测试**，覆盖多仓库同名文件、缺字段、非法 JSON/类型/路径、拒绝无原因、确认无身份以及消息双向校验；`requestId` 能关联第二次启动的错误与首次启动。 — 2026-11-22：新建 `tests/unit/engine-messages.test.ts`，覆盖以下情况：多个仓库有同名文件、同一仓库内路径重复、缺字段、非法 JSON 或类型、越界路径（`..`、`./`、`//`、末尾 `/`、NUL、盘符）、block/confirm 没给原因、拒绝确认时没给原因或没给 by、两个方向的消息互相拒收、requestId 形状检查（真正的关联测试放到 T1-9A），以及 at 带时区偏移时拒收。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/unit/engine-messages.test.ts`。 — 2026-11-22：首轮 36 个失败（parseClientMessage 未实现）；返修第 1 轮 13 个失败，第 2 轮 1 个失败。
- [x] **Step 3：实现 schema 并写契约**，附 0B 能力对照表，固定以下行为： — 2026-11-22：`engine-messages.ts`（分消息 schema；按 type 分派解析；ClientMessage/RunnerMessage 由这些 schema 推导）；`agent-events.ts` 新增 SequencedEventSchema（控制会话决定），工具 input/output 键必须存在；`docs/specs/contracts/engine.md`（全部消息、生命周期、Step 3 的全部行为、1.4 节 requestId 语义：只出现在调用方发出的消息里，是每条消息的编号，runner 回显；决定和确认分别用 callId/confirmId 配对；未知字段忽略；at 用 UTC Z；0B 能力对照表）。返修 2 轮：requestId 语义改回计划原意并删掉 runner 请求上的 requestId；路径规范化；契约与 schema 对齐；转换器把缺失的 args/result 归一为 null，避免 undefined 经 JSON 传输后丢掉键（控制会话把它提升为 Important）。
  - 一个 runner 接受一个客户端、一条成功启动的任务；第二连接拒绝。`idle → running → stopping → finished`；启动接受后先回 accepted，再发事件。运行中再启动返回 already_running，不影响原任务；结束后不复用，返回 run_finished 并关闭。五题各启动新 runner。
  - `policy` 和 `resume` 在 T1 返回 not_implemented，且不创建会话/执行工具；有效启动前的拒绝保持 idle，可修正后重试。Python 客户端 T2、策略直连 T3、恢复 T5 实现。
  - callback 拦截等待默认 30 秒，确认另计默认 600 秒（10 分钟，作者 2026-11-23 决定），均可在 runner 配置；错误/超时按 block。确认身份是调用方报告的测试身份，不声称已完成 T4/T8 鉴权。
  - 迟到、重复、不匹配的决定/确认返回 stale_response，不改变已完成决定。无法解析请求时 error 不必有 requestId；正常任务继续。
  - cancel 幂等；idle 时无操作。终止前的有效取消进入 stopping；已选定终止结果后不覆盖。清理过程中不再发布进度；最终只发一种终止。错误完成和取消竞态按引擎串行观察到的第一个终止原因选择；内部清理失败改为 run.failed。
  - 收到终止后服务关闭连接/监听并退出；无客户端或未启动的连接默认 30 秒空闲超时退出。客户端断线触发取消和退出，不等待重新连接。
  - 协议校验错误与任务失败区分：前者 error，已接受任务的运行异常用 run.failed；原始 pi 录制只写运行器本地诊断文件，不加入协议。
  - accepted 之后的第一个事件是 `run.started` 或 `run.failed`：加载器或会话创建失败时只发布带原因的 `run.failed`（没有 run.started）；契约写明这一点，客户端不得假设第一个事件一定是 run.started。
- [x] **Step 4：同命令通过并提交** `feat(step01): 引擎消息与生命周期契约`。 — 2026-11-22：控制会话复跑，`pnpm test` 132/132，typecheck、build、check:pi 都通过；审查 Needs fixes，2 轮返修后复审全部 addressed；提交 6408626 `feat(step01): 引擎消息与生命周期契约`、8b4056b、d863ad6。

### Task 5：调用方从本地 git 基准引用读取规则

**目标**：补齐“读取基准规则 → 启动参数”链路，运行器不接触 git 规则读取。

**Files:** Create `packages/engine-client/src/git-context.ts`、`tests/unit/git-context.test.ts`；Modify client 导出入口。

**Interfaces:** `readGitContextFiles(sources: {repo: string; repoDir: string; baseRef: string; paths: string[]}[]): Promise<ContextFile[]>`。调用方明确指定基准引用，先解析为 commit 再读取对应 blob，`sourceCommit` 随文件传递；T1 约定本地 main 为测试基准，不声称本地 git 强制分支保护。

- [x] **Step 1：写失败测试**，临时仓库 main 含原规则，任务分支改成另一规则；读取仍返回 main 内容及其 commit。两仓库均有 AGENTS.md 时均保留；基准引用不存在、重复仓库标识/路径、路径不合法或 git 失败时报错。合法引用中缺少指定 AGENTS.md 时省略该文件，返回空列表也合法，不回退读取工作树。 — 2026-11-23：`tests/unit/git-context.test.ts` 19 个测试，覆盖 Step 1 全部情况；返修补上：规则文件是软链接或目录时报错，经过软链接目录的路径按缺失省略，基准引用为空白时报错，256 KiB 上限两侧边界，继承的 GIT_DIR 不影响读取，非 UTF-8 内容报错。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/unit/git-context.test.ts`。 — 2026-11-23：首轮全部失败（模块未实现）；返修第 1 轮 3 个失败（大小上限、GIT_DIR、UTF-8）。软链接、目录、空白引用这几条在旧代码上已通过，属于把已有行为固定下来；控制会话做了变异检查：去掉软链接检查、去掉 blob 检查、把上限比较改成 `>=`，都各有一个测试失败。
- [x] **Step 3：实现读取**，以参数调用 git，不把引用/路径拼成 shell 代码；不把 repoDir/baseRef 交给运行器。默认使用场景传 `paths: ["AGENTS.md"]`，不自动扩大扫描范围。 — 2026-11-23：`packages/engine-client/src/git-context.ts`，用 execFile 传参数数组，加 `--literal-pathspecs`；先 `rev-parse --verify --end-of-options <ref>^{commit}` 定下提交，再用 `ls-tree -z -l` 按这个提交查文件条目，最后 `cat-file blob` 读内容。作者决定（2026-11-23）：规则文件是软链接时报错拒绝；单个文件上限 256 KiB（`MAX_RULE_FILE_BYTES`，读内容之前就检查）。另外：调用 git 时去掉继承的 `GIT_*` 环境变量；内容严格按 UTF-8 解码；baseRef 注释建议写 `refs/heads/main` 这样的全称。。后续补丁（作者 2026-11-23 决定）：git 调用加 `--no-replace-objects`，防止 `refs/replace/*` 把基准规则换成别的对象（822e06a，新增 1 个测试，删掉这个参数后该测试失败）。
- [x] **Step 4：同命令通过并提交** `feat(step01): 调用方读取 git 基准规则`。 — 2026-11-23：控制会话复跑，`pnpm test` 151/151，typecheck、build、check:pi 都通过；审查（规格+质量）Approved 但有 Important（缺少软链接和目录的测试），ponytail-review 没有 Must；1 轮返修后复审 7 条全部 addressed；提交 d7639be、bc91882。

### Task 6：拦截与确认协调模块

**目标**：先独立实现决定等待，再由扩展和 WebSocket 复用，消除对后续 runner 的反向依赖。

**Files:** Create `packages/engine-runner/src/intercept-coordinator.ts`、`packages/engine-runner/src/intercept-extension.ts`、`tests/unit/intercept-coordinator.test.ts`。

**Interfaces:** `createInterceptCoordinator(opts: {send: (message: RunnerMessage) => void; interceptTimeoutMs: number; confirmTimeoutMs: number})` 返回 `decide(req: ToolRequest, signal: AbortSignal): Promise<{decision: "allow"} | {decision: "block"; reason: string}>`、`respond(message: InterceptDecision | ConfirmResponse): {ok: true} | {ok: false; code: "stale_response"}`、`cancelAll(reason: string): void`、只读 `pendingCount: number`。`createInterceptExtension(decide: ReturnType<typeof createInterceptCoordinator>["decide"], signal: AbortSignal): (pi: ExtensionAPI) => void` 将最终 allow/block 交给 pi。

- [x] **Step 1：写失败测试**，fake send 收集消息并送回决定；覆盖 allow/block、confirm 同意/拒绝及原因/身份、各自超时、send 抛错、abort、重复/错误 ID、迟到同意。超时用测试配置 200ms；结束后 pendingCount 为 0，迟到同意不会放行工具。 — 2026-11-23：`tests/unit/intercept-coordinator.test.ts` 共 22 个测试。Step 1 列出的每一项都有测试，另外还补了这些：信号在调用前已被取消、确认阶段发送失败、确认阶段被取消、同一个 callId 重复提交。清理方面用模拟时钟和 `getEventListeners` 断言：结束后没有残留的计时器，也没有残留的 abort 监听。还有一个测试证明确认超时从发出确认请求时重新计时，不和拦截共用截止时间。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/unit/intercept-coordinator.test.ts`。 — 2026-11-23：首轮失败原因是模块还不存在。返修第 1 轮新增 8 个测试，旧代码上 1 个失败（重复 callId）；另外 7 个补覆盖的测试，用变异检查证明它们有效。控制会话做的变异检查：删 clearTimeout 有 4 个测试失败，删 removeEventListener 有 2 个失败，把确认超时改成和拦截共用截止时间有 1 个失败。首轮另做了 4 个变异（cancelAll 改成空操作、去掉 pending.delete、忽略 approved、去掉调用前已取消的检查），每个都至少让 1 个测试失败。
- [x] **Step 3：实现模块与扩展**，按 0B 核实的钩子绑定；扩展只调用 decide 并返回阻止原因。cancelAll 必须结算所有等待并清理计时器，不能只等待 pi abort 自行处理。真实工具副作用测试留在 8B。 — 2026-11-23：`intercept-coordinator.ts` 用一个 Map 登记等待项，键是 `intercept:<callId>` 或 `confirm:<confirmId>`。不管以哪种方式结束（收到应答、超时、发送失败、被取消、调用 cancelAll），都会清掉计时器、摘掉 abort 监听、删掉自己的那一条。之后再到的应答返回 stale_response，同一个 callId 重复提交直接 block。决定为 confirm 时，在 decide 里发出 confirm_request（confirmId 用 randomUUID 生成），单独计时等待确认；拒绝时的原因写成 `rejected by <by>: <reason>`。`intercept-extension.ts` 用 pi 1.5.1 的 `pi.on("tool_call")` 绑定：放行返回 undefined，阻止返回 `{block:true, reason}`。 后续补丁（作者 2026-11-23 决定）：发送失败时的阻止原因固定写 `send failed`，不带内部报错，因为这段原因会被模型看到（52d542c）。
- [x] **Step 4：同命令通过并提交** `feat(step01): 拦截与确认协调`。 — 2026-11-23：控制会话复跑，`pnpm test` 173/173 通过，typecheck、build、check:pi 都通过。规格与质量审查要求返修（两条 Important：计时器和监听没有被清理却没有测试能发现；没有测试证明确认超时是单独计时的），ponytail-review 结论 Ship。返修 1 轮后复审 Approved。提交 57649e4、3c10fe6。

### Task 7：受限资源加载器

**目标**：只注入调用方规则和显式平台扩展；验证所有禁止的资源入口。

**Files:** Create `packages/engine-runner/src/restricted-resource-loader.ts`、`tests/fixtures/hostile-repo/`、`tests/integration/restricted-loader.test.ts`。

**Interfaces:** `createRestrictedResourceLoader(opts: {scratchDir: string; contextFiles: ContextFile[]; extensionFactories: ((pi: ExtensionAPI) => void)[]}): Promise<{loader: ResourceLoader; settingsManager: SettingsManager; loadedContextFiles(): RunSnapshot["contextFiles"]}>`。返回的 `settingsManager` 就是加载器内部使用的那一份（内存设置、`projectTrusted: false`、`cacheWarming: "off"`），会话必须用同一份；pi 的 `createAgentSession` 只读自己拿到的 settingsManager，不传就回退到默认的 `SettingsManager.create`，而它默认信任项目（作者 2026-11-23 决定）。`loadedContextFiles` 从 pi 加载器回读实际加载的规则文件（不照抄 opts），按内容计算 sha256，并映射回 repo、path、sourceCommit。使用 0A 确认的关闭设置，pi 接收的路径映射为 `/<repo>/<path>`；repo 为无斜杠的稳定标识；来源 commit 来自 ContextFile.sourceCommit，由 `loadedContextFiles()` 映射回运行快照。scratchDir 每次新建，清理责任归会话。

- [x] **Step 1：写失败测试**，用 2A 假模型和真实 SDK 检查首个请求及资源加载结果：调用方规则出现，任务工作树/祖先/模拟用户目录中的 AGENTS.md、CLAUDE.md 不出现；多个仓库同名规则都有来源标签；`loadedContextFiles()` 的 sha256 与假服务首个请求中实际出现的规则内容一致，且不包含任何被禁止来源的文件（T1 验收 11）。 — 2026-11-23：`tests/integration/restricted-loader.test.ts` 共 12 个测试，用 2A 假服务和真实 pi 1.5.1 SDK。已覆盖：调用方规则出现在首个请求里；多个仓库的同名规则都带 `/<repo>/<path>` 来源标签；`loadedContextFiles()` 从 `loader.getAgentsFiles()` 回读，sha256 与首个请求里的规则内容一致，sourceCommit 正确；pi 持有的标签映射不回输入文件时报错；输入标签重复时报错；pi 默认的系统提示仍然保留。
- [x] **Step 2：补资源污染用例并运行**，`pnpm vitest run tests/integration/restricted-loader.test.ts` 应因缺失加载器失败。样本含 `.pi/extensions/marker.ts` 的加载副作用、`.pi/settings.json` 引用外部 sentinel 扩展/提示词/skill、`.pi/APPEND_SYSTEM.md`、该版本支持的系统提示词覆盖入口、`.pi/skills/evil/SKILL.md`、`.agents/skills/evil/SKILL.md`；对上级与用户目录重复验证。断言 marker 不产生、提示词/skill 标记不注入、发现列表不含这些资源、settings 指定的可观察行为不生效。 — 2026-11-23：首轮失败原因是模块还不存在。敌意资源放在 6 个场景：任务工作树（进程 cwd 也切到那里）、祖先目录、用户目录（HOME 和 PI_CODING_AGENT_DIR）、加载器自己的 cwd、加载器自己的 agentDir、加载器上面一层的 git 根目录。每个场景都断言：没有产生 marker，扩展、提示词和 skill 列表为空，没有系统提示或追加提示的来源，请求里没有 `HOSTILE_`。设置测试不传 tools，断言不信任项目、defaultTools 未生效、shell 前缀未生效、cacheWarming 为 off。对照测试：pi 默认加载能检出全部敌意资源。返修第 1 轮之前，测试只证明了“空目录是空的”，7 个变异只抓到 1 个；返修后，单独把 noExtensions、noPromptTemplates、noSkills、appendSystemPrompt、systemPrompt、cacheWarming 中任何一个改坏都会让测试失败，会话改用默认设置也会失败。noContextFiles、projectTrusted、cwd、agentDir 是等价变异：别的防线已经挡住同一件事，所以改坏它们测试照样通过；代码里注明这几项是纵深防御。
- [x] **Step 3：实现并复核**，调用真实 SDK 创建会话触发加载，验证仓库工具 cwd 仍正确、显式平台扩展仍可运行。不能只检查返回对象；正确设置后仍加载仓库资源则停止报告。 — 2026-11-23：`packages/engine-runner/src/restricted-resource-loader.ts` 采用 0A.4 的组合，cwd 和 agentDir 都设成新建的 scratchDir，并且**补了 `systemPrompt: ""`**：按 0A 的组合，agentDir 下的 SYSTEM.md 不需要信任就会被加载，0A 当时没发现，是因为探测用的平台目录是空的。`""` 只跳过 SYSTEM.md 的发现，保留 pi 默认系统提示；如果改成 `" "`，默认提示会被替换掉，已用测试确认。按作者决定，接口同时返回 settingsManager。真实 SDK 会话测试显示 bash 和 read 在会话 cwd 中执行，显式平台扩展能运行，也能拦截 tool_call。没有出现正确设置下仍加载仓库资源的情况。
- [x] **Step 4：同命令通过并提交** `feat(step01): 限制 pi 资源来源`。 — 2026-11-23：控制会话复跑，`pnpm test` 186/186，typecheck、build、check:pi 都通过。规格与质量审查 Needs fixes，有 2 条 Important：测试只证明了空目录是空的；设置没有交到会话手里。ponytail-review 的结论是先修再交。返修 2 轮后复审 Approved。提交 c19651b、887e9bb（计划）、7e17369、1960e20。

### Task 8A：模型配置与会话创建

**目标**：封装 pi 原有模型配置和会话管理，所有会话从创建时就使用正式隔离配置及拦截扩展。

**Files:** Create `packages/engine-runner/src/model-config.ts`、`packages/engine-runner/src/pi-session.ts`、`config/models.example.json`、`tests/integration/pi-session.test.ts`。

**Interfaces:** `loadModelRuntime(modelsPath: string, stateDir: string): Promise<ModelRuntime>` 使用 0A 确认的 pi 类型；pi 的 auth.json 与 models-store.json 写在 stateDir（createPiSession 传入自己的 scratchDir），不写在 models.json 所在目录，配置目录只读（作者 2026-11-23 决定）；`createPiSession(opts: {task: StartTask; modelsPath: string; workDir: string; scratchDir: string; sessionsRoot: string; decide: ReturnType<typeof createInterceptCoordinator>["decide"]; signal: AbortSignal}): Promise<{session: AgentSession; snapshot: RunSnapshot}>`。`task.sessionDir` 只能是 `sessionsRoot`（runner 配置的会话根目录）下的相对路径：绝对路径、`..` 越界、经软链接跳出根目录一律报错，不创建会话（作者 2026-11-23 决定，安全）。内部只创建一个 Task 7 受限加载器，会话使用的就是这个加载器，以及这个加载器返回的 `settingsManager`。`createAgentSession` 的 settingsManager 必须显式传入，不允许回退到 pi 默认设置，项目设置信任必须显式关闭（作者 2026-11-23 决定）；snapshot 由同一加载器的 `loadedContextFiles()` 与实际注册的模型组成，保证快照描述的正是会话所用的资源。SDK 类型名与 0A 不符时先修订计划再实现，不以 unknown 掩盖。

- [x] **Step 1：写失败测试**，两份 fake provider 配置命中不同假服务，工作目录只影响工具；返回的 snapshot 中 model 等于实际注册的模型，contextFiles 的 sha256 与会话首个请求中实际出现的规则内容一致；API key 仅从环境引用获得。缺少模型/密钥报明确错误；端到端测试：仓库里放恶意 `.pi/settings.json`（例如 `defaultTools`、`shellCommandPrefix`），确认会话的工具列表和 bash 的 shell 前缀都没有被改，且 `isProjectTrusted()` 为 false（作者 2026-11-23 要求）；默认内存会话，指定 sessionDir 使用 pi 持久化并在清理后保留文件；sessionDir 为绝对路径、含 `..` 越界、经软链接跳出 sessionsRoot 时报错，且根目录之外没有写入任何文件。不自行重写会话格式。 — 2026-11-23：`tests/integration/pi-session.test.ts`，16 个测试，用假模型服务和真实 pi 1.5.1。Step 1 列出的每一项都有测试覆盖：两个 provider 各自命中自己的假服务；工作目录只影响工具（bash 执行 `pwd` 验证）；snapshot.model 和规则的 sha256 都与首个请求一致；密钥只从 `$ENV` 引用取得；缺少模型、缺少密钥时报出明确错误；默认使用内存会话；指定 sessionDir 时由 pi 持久化，清理后文件仍然保留。另外按作者要求覆盖了这些情况：仓库里放恶意 `.pi/settings.json` 的端到端测试（项目不受信任，工具没有被改成 ls，没有恶意 shell 前缀）；sessionDir 是绝对路径（根目录内外都算）、用 `..` 越界、经软链接跳出根目录时都报错，并且根目录外没有写入任何文件；`..foo` 这样的合法目录名可以通过；百炼配置的 compat 从示例文件读取，请求体里带 `enable_thinking:false`；会话一创建，bash 调用就要经过 decide；加载示例配置后，配置目录里没有新增文件。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/integration/pi-session.test.ts`。 — 2026-11-23：首轮失败原因是模块还不存在。返修第 1 轮新增的测试里，状态文件测试和 `..foo` 测试在旧代码上失败；“根目录内的绝对路径”这一项用变异检查验证：去掉 isAbsolute 检查后它会失败。控制会话还做了这些变异，每一项都有测试失败：不传 settingsManager（端到端测试失败）；分别去掉软链接检查、thinkingLevel off、提前 getAuth、拦截扩展；把状态文件改回写到配置目录（1 个测试失败）。
- [x] **Step 3：实现配置与工厂**，模型注册、鉴权、settings、SessionManager 都复用核实后的 SDK API；不读取用户个人 auth/settings 文件，不存在暂时默认 allow 的阶段。示例包含 fake、qwen-api（百炼）、ollama，真实 ID 和版本采用 0C 结果。 — 2026-11-23：`model-config.ts` 提供 `loadModelRuntime(modelsPath, stateDir)`，authPath 和 modelsStorePath 都放在 stateDir，这样既不读用户的 ~/.pi，也不往配置目录里写（作者决定）。`pi-session.ts` 的顺序是：校验 sessionDir → 加载模型并提前检查密钥 → 创建带拦截扩展的受限加载器 → 调用 `createAgentSession`。创建会话时 settingsManager 用加载器返回的那一份，`thinkingLevel` 设为 "off"，SessionManager 按需用内存版或持久化版；snapshot 从同一个加载器回读。去掉了多余的 `bindExtensions`，因为 pi 在构造会话时就已经装好了 tool_call 钩子。`config/models.example.json` 包含三个 provider：fake；qwen-api（百炼 compat，`reasoning: true`，密钥写 `$DASHSCOPE_API_KEY`）；ollama（`qwen3-4b-instruct-2507-ctx16k`）。
- [x] **Step 4：同命令通过并提交** `feat(step01): 模型配置与受限 pi 会话`。 — 2026-11-23：控制会话复跑：`pnpm test` 202/202，跑完后 git status 干净；typecheck、build、check:pi 都通过。规格与质量审查结论是 Needs fixes，有 2 条 Important：误提交了 config/auth.json 和 models-store.json；根目录内的绝对路径没有测试。ponytail-review 的结论也是先修再交。返修 1 轮后复审 Approved。提交：576b391（计划）、fb945bc、4faa1c4（计划）、cb9b94e。

### Task 8B：引擎运行、唯一结束与取消

**目标**：接通事件转换、拦截和会话清理，并对终止负责。

**Files:** Create `packages/engine-runner/src/pi-engine.ts`、`packages/engine-runner/src/raw-event-recorder.ts`、`tests/integration/pi-engine.test.ts`。

**Interfaces:** `PiEngine` 构造参数 `{modelsPath: string; workDir: string; sessionsRoot: string; coordinator: ReturnType<typeof createInterceptCoordinator>; emit: (event: SequencedEvent) => void; recordPiEventsPath?: string}`；`run(task: StartTask): Promise<void>`、幂等 `cancel(): Promise<void>`、只读 `disposed: boolean`。`sessionsRoot` 为必填，原样传给 createPiSession，不提供缺省值（作者 2026-11-23 决定）；每次 run 新建自己的 scratchDir 并在清理时删除。记录器 `createRawEventRecorder(path: string): {record(raw: unknown): void; close(): Promise<void>}` 只由运行器调用，关闭完成才认为录制完整。

- [x] **Step 1：写失败测试**，覆盖纯文本、工具后继续回答、重试后最终结束、重试耗尽、不可达、初始化失败（分两条路径：加载器失败与会话创建失败，两者都只有 run.failed、没有 run.started）；使用 0B 允许的测试重试配置，给每个错误用例明确总时限。事件必须有唯一最后终止、序号连续。真实 bash 在临时目录产生 marker 验证 allow；block、确认拒绝、超时均无 marker，模型收到原因。 — 2026-11-23：`tests/integration/pi-engine.test.ts`，假模型服务加真实 pi 1.5.1。纯文本、工具后继续回答（allow 时有 marker）、block/确认拒绝/超时均无 marker 且模型收到原因、重试后最终结束、重试耗尽、不可达、初始化失败两条路径（只有 run.failed）都有测试；快速重试配置通过 spy `SettingsManager.inMemory` 注入（不改 pi）。RED：模块不存在，换成空桩后 20 个全部失败。
- [x] **Step 2：补取消与来源测试并运行**，`pnpm vitest run tests/integration/pi-engine.test.ts`：慢流、等待决定、等待确认、正在运行的延迟 marker 工具均可取消；重复 cancel 和结束竞态；disposed=true、pendingCount=0、工具停止且观察到原定 marker 时间后仍无副作用。调用 Task 5 读取规则，修改任务分支后启动两次独立引擎，验证规则不变，且两次 `run.started` 的 snapshot.contextFiles 哈希相同，并等于基准引用中的文件内容哈希（T1 验收 11）。 — 2026-11-23：慢流、等待决定、等待确认、延迟 marker 工具均可取消；重复 cancel、结束竞态、disposed、pendingCount=0、过原定时间无 marker 都有断言。修改任务分支后两次独立引擎的 snapshot 哈希相同且等于基准引用内容（T1 验收 11）。在 message.completed 处取消的竞态只断言恰好一个终止。
- [x] **Step 3：实现运行及清理**，先调用 8A 的 createPiSession（创建受限加载器、回读并创建会话），成功后发布带 snapshot 的 run.started，再开始 prompt；加载器或会话创建失败时只发布带原因的 run.failed，不发布 run.started（与 Task 4 契约一致）；正常结束仅在 0B 确认的最终静止且无未完成工作时选择 settled，不能把每个模型错误事件直接作为最终失败而跳过 pi 重试。停止时先取消协调等待、abort 工具/模型、dispose 会话、关闭录制并清理临时目录，再由 Task 3 发布一次终止。清理限时 5 秒；超时/失败仍由同一发布器发送一次带清理原因的 run.failed，然后让 run/cancel 拒绝以供 runner 非零退出，不假报 disposed=true。 — 2026-11-23：`packages/engine-runner/src/pi-engine.ts`、`raw-event-recorder.ts`。每次 run 新建 scratchDir；结果只在 agent_settled 时选择；清理按 cancelAll → abort 信号 → session.abort → dispose → 关闭录制 → 删除 scratchDir 的顺序逐步尽力执行（返修第 1 轮：某步失败也继续，抛出第一个错误；清理失败时 run.failed 保留原失败原因）；限时 5 秒；第二次 run 返回被拒绝的 promise。返修第 2 轮：清理一开始，run 就不再等 pi 的 prompt()，改为跟随清理结果，prompt 永不返回时 run/cancel 也在时限内结束（作者 2026-11-23 同意修）。
- [x] **Step 4：同命令通过并提交** `feat(step01): pi 引擎运行与取消清理`。验证诊断文件来自 SDK 原始订阅，且不会经 emit 泄漏原始事件或密钥。 — 2026-11-23：提交 ee41f1c、1d275d9、09d4165（返修第 2 轮）。`pnpm vitest run tests/integration/pi-engine.test.ts` 25/25；`pnpm test` 227/227（控制方复跑），typecheck/build/check:pi 通过，测试后 git status 干净。诊断文件 raw.jsonl 来自 `session.subscribe` 原始事件，测试断言其中与 emit 均不含密钥。控制方变异检查：去掉 session.abort、改在 agent_end 定结果、不删 scratchDir、run.started 提前到创建会话之前都被测试抓到；去掉 cancelAll 未被抓到（等待监听的是同一个 abort 信号，属于等价变异）。

### Task 9A：runner 服务与进程入口

**目标**：把进程内能力包装成协议服务，管理连接与进程退出。

**Files:** Create `packages/engine-runner/src/runner-server.ts`、`packages/engine-runner/src/main.ts`、`tests/integration/runner-server.test.ts`。

**Interfaces:** `startRunnerServer(opts: {port: number; modelsPath: string; workDir: string; sessionsRoot: string; interceptTimeoutMs?: number; confirmTimeoutMs?: number; recordPiEventsPath?: string; idleTimeoutMs?: number}): Promise<{port: number; close(): Promise<void>; done: Promise<{ok: boolean}>}>`。`done` 在服务因终止、空闲超时、断线或外部 `close()` 结束后 resolve，永不 reject；引擎清理失败或超过清理时限都记为 `ok: false`，因此 `done` 一定会 resolve。CLI 等 `done` 后以 `ok ? 0 : 1` 退出，SIGTERM 走「调 close、等 done、再退出」；退出码只反映清理结果，不反映任务成败（作者 2026-11-23 决定）。`idleTimeoutMs` 默认 30000，对应契约「空闲可配置」。CLI 提供对应 `--port`、`--models`、`--workdir`、`--sessions-root`、`--intercept-timeout-ms`、`--confirm-timeout-ms`、`--idle-timeout-ms`、`--record-pi-events`；`sessionsRoot`/`--sessions-root` 必填，原样传给 PiEngine（作者 2026-11-23 决定）；stdout 仅打印一行 `RUNNER_LISTENING <port>`，诊断到 stderr。

- [x] **Step 1：写失败测试**，用原生 ws 客户端（不依赖 Task 9B）验证 accepted/事件流、决定/确认往返、unsupported 不执行、重复连接/启动及格式错误；正常终止或断线后 close 可完成。 — 2026-11-23：新建 `tests/integration/runner-server.test.ts`，测试客户端用 Node 22 内置 WebSocket（根 package 无 ws 依赖）；覆盖 accepted/事件流、决定/确认往返、policy/resume 不执行、第二连接/第二次启动（requestId 关联）、格式错误、正常终止/断线/close 后 done、清理失败 ok:false、引擎不返回时兜底、空闲退出、CLI 缺参与 SIGTERM；返修补：关闭中迟到的 start_task、客户端不回 close 帧、端口占用、非法整数参数。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/integration/runner-server.test.ts`。 — 2026-11-23：RED 为 runner-server 模块不存在；返修第 1 轮 RED：客户端不回 close 帧时 done 用时 30001 ms（期望 <3000）。
- [x] **Step 3：实现服务与入口**，T1 绑定 loopback，握手时拒绝带 `Origin` 头的连接且不占用客户端位置（作者 2026-11-23 决定，2026-11-23 追加）；空闲退出、终止及断线按 Task 4。SIGTERM 同样进入清理。引擎清理失败时只转发 8B 已发布的 run.failed，不另造终止事件；记录失败并让独立进程非零退出。启动者以独立进程组管理 runner 及其工具，在非零退出或停止超时后清理整个组；9C 测试与 10A2 脚本落实这一责任。（2026-11-23 修订，作者决定：pi 的 bash 工具在独立会话里，不在 runner 组内；启动者只能强杀 runner 组，工具由 pi 的 abort/dispose 结束，runner 被强杀时工具可能残留，记为 T1 已知限制；停止时限默认 10 秒，见 engine.md 进程退出。）正常终止只在清理成功后发出，再关闭连接，不另增 disposed 协议消息。 — 2026-11-23：`runner-server.ts` 单一收尾 finish()（终止/取消/断线/空闲/close/SIGTERM 共用），send 不抛错，引擎兜底 CLEANUP_LIMIT_MS+1s，等客户端关闭最多 1 s 后强制断开；`main.ts` 等 done 后按 ok 退出 0/1。接口按作者决定增加 done 与 idleTimeoutMs（5bd5aaa）。审查：SDD 与 ponytail-review 共 1 轮返修，复审 Approved。
- [x] **Step 4：同命令通过并提交** `feat(step01): runner 服务与进程入口`。 — 2026-11-23：控制会话复跑 `pnpm test` 248/248，typecheck、build、check:pi 通过，测试后 git 干净；控制会话 7 项变异全部被测试抓到。提交 a2dd552、3d1699e。作者追加 Origin 检查（返修第 2 轮，144183a）：带 Origin 头的握手回 403、不占客户端位置；复跑 `pnpm test` 249/249，typecheck、build、check:pi 通过；去掉检查的变异被抓到。

### Task 9B：TypeScript 客户端

**目标**：封装启动确认、事件、拦截、确认和错误传播，调用方只认本项目协议。

**Files:** Create `packages/engine-client/src/engine-client.ts`、`tests/integration/engine-client.test.ts`；Modify `packages/engine-client/src/index.ts`。

**Interfaces:** `EngineClient.connect(url: string): Promise<EngineClient>`；`start(task: Omit<StartTask, "type" | "requestId">): Promise<void>` 在 accepted 后 resolve，启动拒绝时 reject；`onEvent(cb)` 接收 SequencedEvent；`onError(cb)` 接收 ProtocolError；`onIntercept(cb: (req: ToolRequest) => Promise<Decision>)`；`onConfirm(cb: (req: ConfirmRequest) => Promise<Confirmation>)`；`cancel(): void`；`waitForEnd(): Promise<SequencedEvent>`；`close(): Promise<void>`。

- [x] **Step 1：写失败测试**，验证启动拒绝不挂起、文本/终止、拒绝原因透传、确认人的 by 与理由透传；accepted 后第一个事件就是 run.failed（没有 run.started）时，waitForEnd 正常返回该终止事件。初次启动拒绝时 waitForEnd 同样 reject；运行中第二次 start 被拒绝不破坏原有等待。终止前断线 reject（不是伪造 run.cancelled），终止后正常关闭不覆盖结果；重复 waitForEnd 得到缓存结果。callback 抛错或没有 handler 时发送带原因的拒绝。 — 2026-11-23：新建 `tests/integration/engine-client.test.ts`（进程内 runner + 假模型服务，异常服务端用 ws 桩）：启动拒绝不挂起、文本/终止、拒绝原因透传、确认人 by 与理由透传、首事件 run.failed、初次拒绝时 waitForEnd reject、运行中第二次 start 被拒不影响原等待、终止前断线 reject、终止后关闭不覆盖、重复 waitForEnd、callback 抛错/无 handler/返回非法应答时发带原因的拒绝（确认 by:"engine-client"，控制会话裁决）；返修补：两个 start 同时挂起不丢终止结果、抛出无 toString 的值。
- [x] **Step 2：运行并确认失败**，`pnpm vitest run tests/integration/engine-client.test.ts`。 — 2026-11-23：RED 19 个失败（EngineClient 不存在）；返修第 1 轮 RED：并发 start 时 waitForEnd 拿到 not_implemented；Object.create(null) 导致 10 秒超时与未处理 rejection。
- [x] **Step 3：实现客户端**，使用双向校验及 requestId 关联。非致命错误仅通知对应调用或 onError，非法服务端消息使连接失败并结算等待；close 释放 listener/等待项。onEvent/onError 回调抛错由客户端捕获并写 stderr，不让进程崩溃；处理器缺失或抛错时自动拒绝确认的 `by` 为 `"engine-client"`（作者 2026-11-23 决定）。start 前注册回调，避免漏掉开始后的即时请求。 — 2026-11-23：`engine-client.ts`：收发都经 protocol 校验；requestId 关联启动拒绝；非法服务端消息使连接失败并结算等待；首个结果为准；拦截/确认 fail closed。审查：SDD 与 ponytail-review 均通过，按作者规则 1 轮返修（合并拒绝路径、并发 start、reasonOf 不抛错、去掉固定等待），复审 Approved。
- [x] **Step 4：同命令通过并提交** `feat(step01): TS 引擎客户端与错误传播`。 — 2026-11-23：控制会话复跑 `pnpm test` 271/271，typecheck、build、check:pi 通过，测试后 git 干净；控制会话 8 项变异全部被抓到。提交 41db693、fcf7a93。作者追加回调异常捕获（返修第 2 轮，cb312bd）：onEvent/onError 同步抛错写 stderr、后续消息照常处理；复跑 `pnpm test` 272/272，typecheck、build、check:pi 通过；去掉捕获的变异被抓到。

### Task 9C：跨进程异常与清理验证

**目标**：在真实子进程边界验证 Task 4 行为和验收 5，补足进程内测试看不到的泄漏。

**Files:** Create `tests/integration/runner-process.test.ts`；必要时修复 9A/9B 文件并记录偏差。

**Interfaces:** 通过 9A CLI 启动、9B 客户端调用；清理证据使用子进程退出码、监听端口关闭、工具子进程结束、延迟 marker 不出现，不增加产品诊断消息。

- [x] **Step 1：补充测试并先运行**，`pnpm vitest run tests/integration/runner-process.test.ts`；覆盖慢流/工具/等待决定/等待确认时取消和断线、重复取消、迟到批准、错误 JSON、第二次启动、正常结束关闭、无客户端空闲退出。新测试可能已通过；发现缺陷时保留失败证据再修复，不为制造红灯改坏代码。 — 2026-11-23：新建 `tests/integration/runner-process.test.ts`（9A CLI 子进程 + 9B 客户端，runner 以独立进程组启动，finally 强杀组并删临时目录）：慢流/工具/等待决定/等待确认 × 取消与断线、重复取消、迟到批准、错误 JSON、第二次启动、正常结束关闭、无客户端与已连接未启动的空闲退出、清理失败与清理卡死。首轮 16 项全部直接通过，未发现 9A/9B 缺陷，未改产品代码；新检查用变异确认有效（断线不收尾 → 4 项失败；去掉 abort+dispose → 失败；退出码强制 0 → 失败）。
- [x] **Step 2：验证退出边界**，正常任务终止后不再有事件、进程在 5 秒内退出；清理超时用故障注入验证带原因的 run.failed、非零退出或卡死时启动者在停止时限后强杀 runner 进程组；工具子进程由 pi 在卡住之前结束，测试须如实归因，不把它算作启动者兜底的效果（2026-11-23 修订，作者决定，见 engine.md 进程退出与工具进程）。测试失败也在 finally 清理所有创建的资源。 — 2026-11-23：正常结束 5 秒内退出、关闭码 1000、之后无事件；断线到退出 <2.5 秒；清理卡死用「诊断文件指向无读端 FIFO」注入（不加产品开关）：先发带原因的 run.failed，runner 卡在系统调用无法自行退出，启动者 10 秒停止时限后强杀 runner 组；工具在卡住前已由 pi 结束，测试如实归因。由此作者修订契约（启动者强杀）与计划（工具进程不在 runner 组内，记为已知限制），4d02ea5。
- [x] **Step 3：必要修复后运行** `pnpm test && pnpm typecheck && pnpm build && pnpm check:pi`；全部通过后提交 `test(step01): 跨进程取消与异常验证`。 — 2026-11-23：控制会话复跑 `pnpm test` 289/289（约 44 秒），typecheck、build、check:pi 通过，git 干净，无残留 runner 进程。审查：SDD Needs fixes（归因与断线时限）、ponytail Ship，1 轮返修（只改测试，共享 TOOL helper），复审 Approved。提交 9e3ad6c、03c7a87。

### Task 10A1：五题样例与判定

**目标**：形成固定答案集与独立可验证的判定，不把五题扩大为正式评测框架。

**Files:** Create `tests/fixtures/sample-repo/`、`tests/fixtures/sample-repo-questions.json`、`tests/fixtures/sample-repo/README.md`、`scripts/t1-grade.ts`、`tests/unit/sample-repo-answers.test.ts`、`tests/unit/t1-grade.test.ts`。

**Interfaces:** 每题记录目标定义位置、问题及完整答案集合 `{path: string; line: number}[]`；`gradeAnswer(answer: unknown, expected: {path: string; line: number}[]): {passed: boolean; missing: string[]; extra: string[]; error?: string}`。样例与题集各以内容哈希标版本；临时 git commit 仅作规则来源证据，不要求每次临时初始化产生相同 commit。

- [x] **Step 1：建立小型 Python 样例及答案**，6–8 个模块、5 个目标函数、各 1–3 个调用点，含跨模块调用、导入别名及同名干扰。只使用显式函数调用与导入，无动态分派；人工通读全部模块核对完整调用点，核对记录放在样例仓库之外，仓库 README 不含答案。 — 2026-11-24：`tests/fixtures/sample-repo/` 8 个模块、5 个目标（调用点 3/2/1/1/2），含跨模块调用、函数别名 `compute_total as total_of`、模块别名 `import config as cfg`，同名干扰在 legacy.py（同名函数、同名方法、注释、字符串）；人工核对记录 `tests/fixtures/sample-repo-audit.md` 在仓库外；审查者独立通读全部模块，答案集无漏无多。
- [x] **Step 2：写失败测试并运行**，`pnpm vitest run tests/unit/sample-repo-answers.test.ts tests/unit/t1-grade.test.ts`。校验答案路径/行号确有对应调用，并结合人工完整性核对记录验证答案集；不能仅凭行上存在函数名宣称完整。判分覆盖漏报、多报、同名误报、格式错误、重复项和顺序变化。 — 2026-11-24：首轮 RED 不合规：实现者先写了判分代码，事后挪走才跑出 RED（t1-grade 加载失败、哈希未记录），已报作者；返修第 1 轮按先测后改：题面写明定义模块、哈希排除 __pycache__（EISDIR）、别名调用机械检索均先见失败。
- [x] **Step 3：实现判定**，要求最终回答为 JSON 数组，路径为仓库相对 POSIX 路径、行号从 1 开始；允许去重和排序，不模糊匹配，不自动重问“直到答对”。格式不合法判错。（2026-11-24 作者确认严格格式：不剥代码块标记；答案前后的空白允许并有测试固定；格式错误信息要具体，被代码块包裹时明确写出。）标准答案集合变动须重新完整核对并更新题集版本。 — 2026-11-24：`scripts/t1-grade.ts` 严格格式（trim 后 JSON.parse，不剥代码块标记；仓库相对 POSIX 路径、行号为 ≥1 的整数；去重、忽略顺序；多余字段忽略）；样例与题集各有内容哈希，过期即测试失败；`.gitattributes` 固定 fixtures 为 LF。审查 SDD Needs fixes（题面歧义）、ponytail Ship，1 轮返修，复审 Approved。
- [x] **Step 4：同命令通过并提交** `test(step01): 五题样例与固定判定`。 — 2026-11-24：控制会话复跑 `pnpm test` 353/353，typecheck、build、check:pi 通过，git 干净；变异：删一个答案 → 2 项失败，样例里加一处别名调用 → 3 项失败。提交 e9fab4a、d803f19。作者 2026-11-24：接受首轮 TDD 违规，条件是补变异检查——去重、剥代码块、行号 0/小数、`..`、绝对路径、顺序相关 6 类变异均被抓到（只删 `startsWith("/")` 为等价变异）；返修第 2 轮（1f63fde）：代码块包裹给出明确原因、固定空白容忍，复审 Approved；复跑 `pnpm test` 357/357，typecheck、build、check:pi 通过。

### Task 10A2：只读验收运行脚本

**目标**：组装调用方规则读取、客户端、逐题判分及运行器诊断录制。

**Files:** Create `scripts/t1-real-run.ts`、`tests/integration/t1-real-run.test.ts`。

**Interfaces:** 消费 10A1 的题集与 `gradeAnswer`、Task 5 的 `readGitContextFiles`、9A CLI 与 9B 客户端。CLI：`pnpm tsx scripts/t1-real-run.ts --models <配置> --model <provider/id> --record-dir <目录> --output <报告>`；env 在外层 Node 进程注入。

- [x] **Step 1：写失败测试并运行**，`pnpm vitest run tests/integration/t1-real-run.test.ts`。假模型验证五题各启动新 runner/内存会话和临时 git 仓库副本，从指定 main 引用加载规则；标准答案、完整性核对记录与其他题回答均未提供给引擎。所有源码、脚本和题集的版本证据可从报告核对。
- [x] **Step 2：实现只读运行与判分**，调用方只放行 0B 核实的 pi 内置只读工具（read/grep/find/ls 中实际存在者），拒绝 bash/edit/write 和所有未知工具；测试拒绝后无副作用。（2026-11-24 作者决定：会话未指定工具时 pi 只激活 read/bash/edit/write，T1 只放行 read，不改 8A 去激活 grep/find/ls；read 只放行解析软链接后落在本题临时副本内的路径，其余拒绝并记入工具拒绝，测试覆盖副本外绝对路径、`../` 跳出、副本内软链接指向副本外、前缀相似目录（如 copy-1 与 copy-10）四种拒绝和副本内正常文件放行；拒绝理由写明可用工具，例如「此任务不提供 bash，请使用 read 读取文件」。启动 runner 与强杀进程组的启动者代码只保留一份，脚本与 9C 测试共用。）提示词同时提供样例文件路径清单，使只有 read 时也能遍历样例，清单不含答案，且从本题临时副本自动生成，不手写。提示词明确要求「只输出 JSON 数组，不要用代码块包裹，不要加任何解释文字」，并附一个正确格式的示例（示例不含真实答案）（2026-11-24 作者决定）。每题总时限默认 120 秒，超时取消并记失败；启动者按 9A 管理独立进程组，停止时限默认 10 秒，按 engine.md 进程退出的规则从最早的退出信号（取消/SIGTERM、终止事件、连接关闭）起用单调时钟计时，到时强杀整个组，正常/异常退出均清理资源（2026-11-23 补充，2026-11-24 补计时起点）。
- [x] **Step 3：实现记录并验证**，每题由 runner `--record-pi-events` 写独立原始事件文件，脚本不解析 pi 原始事件；报告保存回答、判分差异（格式错误与内容答错 missing/extra 分开列出，格式错误带具体原因；2026-11-24 作者决定）、工具拒绝、模型配置版本、样例/题集哈希、源码与脚本哈希、临时基准 commit、耗时及退出情况。脚本全部答对退出 0，否则非零；服务故障与答案错误分别记录。
- [x] **Step 4：同命令通过并提交** `test(step01): 只读验收运行与诊断采集`。 — 2026-11-24：`d9f3dca` 首版（RED：脚本模块不存在）；返修 1 轮 `c9b44ef`：read 限于临时副本（解析软链接，不存在即拒，5 种情况单元测试）、文件清单由副本 `git ls-files` 生成、拒绝理由写明用 read、启动者代码共用 `packages/engine-client/src/runner-launcher.ts`（10 秒停止计时在其中）、非零退出与脚本崩溃（退出码 3）补测。命令 `pnpm test` 382/382、`pnpm typecheck`/`build`/`check:pi` 通过，控制者在 c9b44ef 重跑一致，无残留进程与临时目录。审查：SDD 与 ponytail-review 共 1 轮返修，复审全部 ADDRESSED。 2026-11-24 返修第 2 轮（作者决定在 10B 前修）`48255dd`：启动者监听 spawn 的 error，启动失败时 exit 立即落定、listening/connect 报错、stop() 不强杀并立即返回、pid 类型可为空；脚本记为本题服务故障并继续。`pnpm test` 383/383，控制者重跑一致；复审 ADDRESSED。

### Task 10A3：真实运行刹车、运行条件与密钥检查

**目标**：跑真实 API 前补齐刹车、可复现条件和密钥泄露的自动检查（2026-11-24 作者要求）。

**Files:** Modify `scripts/t1-real-run.ts`、`tests/integration/t1-real-run.test.ts`、`tests/unit/t1-real-run.test.ts`；Create `scripts/check-secrets.ts`、`tests/unit/check-secrets.test.ts`。

**Interfaces:** 10A2 CLI 增加 `--max-tool-calls`（默认 30）；`check-secrets` CLI：`node --env-file=<.env> --import tsx scripts/check-secrets.ts --env <变量名>... <路径>...`。

- [x] **Step 1：每题刹车**，先写失败测试。调用方拦截回调按题计数工具调用（放行与拒绝都计），超过上限即取消本题，记为失败并写明原因；报告中单列为"超出上限"，不混入服务故障，也不混入格式错误或答错。假模型脚本反复调用被拒的 bash 时，测试断言本题在上限处停止、假服务请求数不超过上限加 1。（2026-11-24 作者决定修订，见 Task 10A4：此上限只对已声明工具成立；未声明工具见 10A4。）每题 120 秒总时限保留。
- [x] **Step 2：运行条件**，报告记录开始时间（ISO）、源码 git commit 与工作区是否有未提交改动、所选模型在模型配置中的条目（不含 key，配置只引用环境变量名）、温度等采样参数的实际情况（未设置时写明未设置、由服务端默认）。测试用假服务核对请求里实际发送的采样参数与报告一致。
- [x] **Step 3：密钥检查**，`check-secrets` 从指定环境变量取值，在给定文件和目录（递归）中查找原文，命中即列出文件并非零退出，输出不打印 key；同时用 `git check-ignore` 确认 `.env` 已被忽略，否则非零退出。单元测试用假 key 覆盖命中、未命中、目录递归、变量未设置（非零退出并说明）、`.env` 未被忽略。
- [x] **Step 4：同命令通过并提交** `test(step01): 真实运行刹车、运行条件与密钥检查`。 — 2026-11-24：`61a4eea` 首版（每题按工具调用计数刹车，默认 30，越限先取消再拒绝，单列 limitExceeded；报告记 startedAt、commit+dirty、模型条目（脱敏）、实际采样参数；`scripts/check-secrets.ts`）；返修 1 轮 `d4311a5`：`.gitignore` 加 `.tmp/`、模型级字段脱敏、check-secrets 目录内软链接/读不了的文件/git 出错均非零并分别报告、samplingParams 记入报告（按思考级别的采样参数或 modelOverrides 退出 3）。`pnpm test` 403/403、typecheck/build/check:pi 通过，控制者重跑一致。审查：SDD 与 ponytail-review 共 1 轮返修，复审 Approved。

### Task 10A4：工具清单参数、grep 与提示词流程修正

**目标**：修掉 10B 首跑（0/5）暴露的三个流程缺陷后再重跑：read 不给行号；提示词把"只输出 JSON"写成本轮要求，没有限定为最终回答，模型不读就答；pi 系统提示推模型用 bash，而拦截拒绝 bash（2026-11-24 作者决定）。

**Files:** Modify `docs/specs/contracts/engine.md`（已在本任务计划提交中更新：`--tools`）、`packages/engine-runner/src/pi-session.ts`、`packages/engine-runner/src/main.ts` 及相关传参、`scripts/t1-real-run.ts`、`tests/fixtures/pi-events/README.md` 与对应测试。

**Interfaces:** runner CLI 新增 `--tools <名字,名字>`（engine.md 激活工具）；脚本以 `--tools read,grep` 启动 runner。

- [x] **Step 1：工具清单参数**，先写失败测试。runner `--tools` 传入 pi 会话的激活工具；未给时行为不变；空或未知名字时不监听、非零退出。用假模型断言请求中的工具定义只有清单内的工具，系统提示中不再出现 bash 相关规则。T3 的"不声明多余工具"在 T1 提前做，原因是指令冲突属于流程缺陷。
- [x] **Step 2：grep 接入与路径限制**，脚本只声明并放行 read 和 grep，拦截仍拒绝其余所有工具（保留 bash/write 被拒测试）。grep 的搜索路径与 read 同一规则：解析软链接后须在本题临时副本内；测试覆盖副本外绝对路径、`../` 跳出、副本内软链接指向副本外、前缀相似目录四种拒绝和副本内正常路径放行。确认 grep 不跟随软链接、搜索不到 `.git` 中的内容（pi 的 grep 用 ripgrep 且带 `--hidden`，因此临时副本的工作目录内不得有可被搜到的 git 元数据，基准 commit 与规则读取仍按 Task 5 从 git 引用取得），均写成测试。拒绝理由由实际工具清单生成，写明可用 read 和 grep。
- [x] **Step 3：提示词改为先读后答**，提示词只讲步骤不讲方法：先用工具查看需要的文件，确认后再作答；格式要求只针对最终回答（「只输出 JSON 数组，不要用代码块包裹，不要加任何解释文字」与示例保留）。不得写针对题目的解题方法（如先 grep 函数名再排除注释）。"可用工具"一句由实际工具清单自动生成，不手写；测试断言提示词中的工具名与请求中的工具定义一致。
- [x] **Step 4：录制说明**，`tests/fixtures/pi-events/README.md` 写明 10B 样本保留临时副本路径的原因（路径被拆在流式增量中，替换会破坏增量与最终参数的一致；不含用户名，目录已删除），并把规则写准确：必须去掉家目录、仓库/工作树路径和用户名；无法一致替换的随机临时目录可保留并注明。
- （2026-11-24 作者决定，10A4 首次派发因环境与前提不符停下后补充）**rg 与离线**：runner 依赖 PATH 上的 `rg`（本机 ripgrep 16.0.0，`/opt/homebrew/bin/rg`，已在 runner 同样的子进程环境中确认可找到），runner 进程设 `PI_OFFLINE=1`（engine.md 外部程序与离线）；报告的运行条件记录 rg 版本。`--tools` 名字由 runner 自带的内置工具名单校验（pi 对未知名静默忽略、未导出名单），并有测试与 pi 内部名单比对。**未声明工具**：pi 对未声明工具直接回 `Tool X not found`，不经过调用方拦截；bash/write 集成测试改为断言模型收到 not found、无副作用、计入刹车，拦截拒绝的端到端证据改用越界 read/grep；报告把"未声明工具调用"与"拦截拒绝"分两栏。**刹车计数**：`tool.started` 事件与拦截共用一个计数器，按 callId 去重；拦截做决定时计数必须已更新。测试证明一次已声明的 read 只计一次、超过上限后的那次 read 被拒（不因事件晚到而放行）、反复调用 bash 记为超出上限而非服务故障。**git 元数据**：基准仓库建在本题根目录下单独位置并提交（基准 commit 与规则从其 `refs/heads/main` 读取），runner 工作目录用 `git checkout-index` 导出的纯文件，不含 `.git` 目录或文件。**开场白**：pi 固定前言"Help users inspect files, run commands, and modify code ... Additional tools may be available."接受，写进实现说明；10B 重跑后在录制里统计未声明工具的调用次数，若仍频繁，在 T3 评估用 customPrompt 替换系统提示。
- （2026-11-24 作者决定，10A4 审查后）**刹车上限的数字**：已声明工具（read/grep）越限的那次调用由拦截在取消后同步拒绝，模型请求数 ≤ 上限 + 1。未声明工具由 pi 直接回 `Tool X not found`、不经拦截，刹车只能按 `tool.started` 计数：发出取消时 pi 可能已发出下一次模型请求，该请求随后被中止，故模型请求数 ≤ 上限 + 2，其中至多 1 次被中止；前提是取消在一次模型响应返回之前生效（本机连接毫秒级，模型响应远慢于此）。测试必须确定：假服务把越限后的那次请求挂住不回应，直到被取消中止，断言越限后没有任何工具被执行、本题记为超出上限、请求数恰为上限 + 2 且最后一次被中止；不得用依赖时序的范围断言。报告逐题记录模型请求数，其中被中止的请求单列，费用统计包含被中止的请求（拿不到用量时如实注明）。T3 将刹车移到 runner 内部（自行计数或用扩展在下一次模型请求前拦截），对未声明工具也恢复 ≤ 上限 + 1。**"事件晚到"测试**：pi 总是先发 `tool.started` 再走拦截，集成测试无法构造拦截先到的顺序；计数逻辑须可单独测试，单元测试确定地覆盖两种到达顺序，删去拦截侧计数的变异必须失败。**拿不准就拒绝**：grep/read 的输入不是对象时拒绝；grep 不带 path 按 "." 处理并有测试；报告中的 rg 版本在与 runner 相同的环境中探测。
- [x] **Step 5：同命令通过并提交** `fix(step01): 工具清单参数、grep 与先读后答提示词`。 — 2026-11-24：首次派发因缺 rg 与未声明工具不经拦截停下，作者决定后补计划（`d990ab1`、`50091c1`）；`8d1d57f` 实现（runner `--tools` 自校验、`PI_OFFLINE=1`、只声明 read/grep、grep 路径同 read、工作目录用 checkout-index 无 .git、先读后答提示词由工具清单生成、刹车事件与拦截共用计数）；返修 1 轮 `9e1687d`（假服务挂住越限后请求使请求数断言确定：已声明恰为上限+1、未声明恰为上限+2 且最后一次被中止；createBrake 单测两种到达顺序；非对象输入拒绝；rg 在 runner 环境探测；逐题模型请求数与用量在统一事件中拿不到，报告写 null 并注明）。`pnpm test` 444/444、typecheck/build/check:pi 通过，控制者重跑一致，~/.pi 不存在。审查：SDD 与 ponytail-review，1 轮返修，复审 Approved。

### Task 10A5：录制离线统计（请求数、中止数与用量）

**目标**：统一事件不带模型请求边界、结束原因与用量，运行脚本报告中这些字段为 null（10A4）。T1 用独立的离线统计脚本读取 runner 录下的 pi 原始事件文件，统计逐题模型请求数、被中止的请求数与用量，供 10B/10C 记录费用；原始事件只用于诊断，不进入统一接口，运行脚本仍不解析原始事件。在事件契约中增加"模型请求结束"事件（带结束原因与用量）推迟到 T2 评测框架（2026-11-24 作者决定）。

**Files:** Create `scripts/t1-usage.ts`、`tests/unit/t1-usage.test.ts`。

**Interfaces:** `pnpm tsx scripts/t1-usage.ts --record-dir <目录> [--output <json>]`；按文件（每题一个）输出 `{ id, requests, aborted, errored, usage: { input, output, cacheRead, cacheWrite, reasoning, total } }` 及合计；不读取 key、不联网。

- [x] **Step 1：写失败测试**，用 `tests/fixtures/pi-events/` 中已有录制（含 10B 的 real-qwen-api 样本、retry 样本）与构造的小样本覆盖：正常结束、工具调用多轮、重试（每次失败尝试各算一次请求）、被中止（stopReason aborted 计入 aborted，有用量则计入，无则如实标注）、错误结束。请求的判定口径（以哪类事件为一次模型请求的结束）先核对 pi 1.5.1 的事件语义并写进脚本注释与测试名；同一请求的增量更新不得重复计数。
- [x] **Step 2：实现**，只读给定目录下的录制文件；文件损坏或某行无法解析时报告该文件与行号并非零退出，不静默跳过；输出不含提示词与回答正文。
- [x] **Step 3：验证并提交** `test(step01): 录制离线统计请求数与用量`；用 10B 首跑的 `.tmp/t1-api` 实际运行一次，与实现说明中手算的输入 28,644、输出 900 token 核对，差异如实记录（不提交 `.tmp`）。 — 2026-11-24：`57cde6c`（一次请求 = role=assistant 的 message_end；重试每次失败尝试各计一次并计 errored；aborted 另计；缺用量计 usageMissing）；返修 1 轮 `cfe6e0d`（非对象行、目录无 .jsonl 均报错退出 2）。对 10B 首跑 `.tmp/t1-api` 实跑：13 请求、输入 28,644、输出 900，与手算一致。`pnpm test` 453/453、typecheck/build/check:pi 通过，控制者重跑一致。审查：SDD Approved（确认响应开始前被取消的请求仍发出 aborted 的 message_end）、ponytail Ship，1 轮返修，复审 ADDRESSED。

### Task 10A6：思考级别参数与思考开启时的判卷、截断、隐私检查

**目标**：10B 第 3 次运行开启思考（2026-11-24 作者决定，推翻 0C"T1 API 模型关闭思考"）。原因：第 2 次运行（`f184198`）已证明三个流程缺陷都修好——不再先试 bash、grep 行号全对、每题先读后答；剩下的主要是格式失败，表现正是模型把推理写进了最终回答（去掉说明文字后 3 题内容正确）。开启思考前先保证：思考不挤掉回答、截断可识别、判卷只读最终回答、思考内容也过隐私检查。

**Files:** Modify `docs/specs/contracts/engine.md`（已在本任务计划提交中更新：思考级别）、`packages/engine-runner/src/pi-session.ts` 及传参、`packages/engine-runner/src/main.ts`、`scripts/t1-real-run.ts`、`scripts/t1-usage.ts`、`scripts/check-secrets.ts`、`tests/helpers/fake-openai-server.ts` 与对应测试。

**Interfaces:** runner `--thinking <级别>`（默认 off）；`t1-real-run.ts --thinking <级别>` 透传给 runner；`t1-usage` 输出增加按结束原因的计数（含长度截断）与每题最后一次请求的结束原因；`check-secrets` 增加本机路径检查选项。

- [x] **Step 1：思考级别参数**，先写失败测试。runner `--thinking` 透传为 pi 会话思考级别，取值按 pi 的级别名由 runner 校验，非法值不监听、非零退出；未给时为 off，现有行为不变。报告运行条件记录思考级别。
- [x] **Step 2：输出上限与截断**，核对 pi 1.5.1 在 compat `thinkingFormat: "qwen"` 下开启思考时实际发送的字段（如 enable_thinking、思考预算）以及思考 token 是否计入最大输出 token；确认上限足以容纳"思考 + 回答"，必要时按 pi 支持的方式设置思考预算，做法写进实现说明。被截断的回答（结束原因为长度用完）必须能识别：统一事件不带结束原因（事件契约增加该字段推迟到 T2），由 `t1-usage` 统计各结束原因（含长度截断）和每题最后一次请求的结束原因；10B 记录时据此把截断与普通格式错误分开。
- [x] **Step 3：判卷只读最终回答**，假服务支持按 qwen 兼容格式流式发送思考内容（以 pi 实际解析的字段为准）。测试证明：开启思考时，交给判卷程序的回答文本只有最终回答，不含思考内容；转换器的 `message.completed` 不含思考内容。
- [x] **Step 4：隐私检查覆盖思考内容**，`check-secrets` 增加本机路径检查（家目录、仓库/工作树绝对路径、用户名），命中只报文件与位置，不打印命中内容；单元测试覆盖含思考内容的录制行。10B 提交录制样本前对样本运行 key 检查与本机路径检查，均须通过（`.tmp` 下的原始录制因系统提示含本机路径，只做 key 检查）。
- [x] **Step 5：同命令通过并提交** `feat(step01): 思考级别参数与思考开启时的判卷、截断、隐私检查`。 — 2026-11-24：`43a269a`（runner `--thinking` 自校验、默认 off；假服务按 qwen 流式发 reasoning_content，端到端证明判卷只拿最终回答（把思考拼进 message.completed 的变异使 3 条测试失败）；t1-usage 统计结束原因与 lastStopReason；check-secrets `--local-paths`；models.example.json compat 加 `thinkingTokenBudgetField: "thinking_budget"`，low 预算 2048、max_completion_tokens 8192）；返修 1 轮 `f5b6682`（实现说明追加做法与截断归类规则；用户名按路径段匹配；仓库路径在家目录内不重复报）。`pnpm test` 481/481、typecheck/build/check:pi 通过，控制者重跑一致，~/.pi 不存在。审查：SDD 逐行核实 pi 1.5.1 发送字段、ponytail Ship after fixes，1 轮返修，复审全部 ADDRESSED。10B 前须给 git 忽略的 config/models.local.json 加同一 compat 字段。

### Task 10B：API 五题验收与录制

**目标**：使用 0C 锁定的 API 候选完成验收，追加真实模型录制。

**Files:** Append `docs/reviews/step01-pi-integration.md`；Create 脱敏后的 `tests/fixtures/pi-events/real-qwen-api-*.jsonl`；Modify 录制 README 和转换器测试以覆盖新样本。本地 `config/models.local.json` 不提交。

**Interfaces:** 使用 10A2 CLI；配置只引用 `DASHSCOPE_API_KEY`，不嵌入 key。

- [x] **Step 1：复核环境与固定版本**，确认采用 0C 模型、10A1 固定的样例/题集版本，并记录当前源码 commit；读取根目录 `.env`，只将公开样例送 API。先跑 10A2 假模型测试，防止脚本错误混入结果。
- [x] **Step 2：实际运行**，`node --env-file=<项目根目录/.env绝对路径> --import tsx scripts/t1-real-run.ts --models config/models.local.json --model qwen-api/<锁定ID> --record-dir .tmp/t1-api --output .tmp/t1-api-result.json`；预期报告 5/5 且退出 0。未达标按 workflow 3.3 分析并报告，不更换题目、改答案或忽略失败；所有尝试追加记录。（2026-11-24 作者要求：未全对时先按报告分类看是格式错误、missing、extra、超出上限还是服务故障；题面或流程问题可以修，但不针对某道题调整提示词去凑对；确需改提示词，在账本和实现说明里记清改了什么、为什么。）
- （2026-11-24 作者决定，第 3 次运行条件）**第 3 次运行**：`--thinking low`（pi 发 `enable_thinking: true`、`thinking_budget: 2048`、`max_completion_tokens: 8192`，回答至少留 6144 token；本地 `config/models.local.json` 的 qwen-api compat 须带 `thinkingTokenBudgetField: "thinking_budget"`）；每题时限保持 120 秒，作为对比基准：第 2 次运行（思考关闭）每题实际耗时 normalize_name 8.5 s、compute_total 5.5 s、send_notice 5.5 s、load_config 5.2 s、audit_event 6.3 s，最长 8.5 s，若第 3 次超时据此估算开启思考的放慢倍数再定放宽多少；运行时设 `TMPDIR=/tmp/fp-t1`（运行前创建），使临时副本不建在 macOS 每用户固定的 `/private/var/folders/<标识>/` 下，新录制不出现该标识，运行条件中记录此设置（不改代码）。已提交的前两次样本保留该标识，README 如实写明"这是 macOS 每个用户固定的临时目录标识，不含用户名"。只跑一次；检查顺序：check-secrets（新样本另加 `--local-paths`）→ 结果分类（按 `t1-usage` 的 `lastStopReason` 把截断与格式错误分开）→ 拒绝与未声明工具次数 → 从录制核对思考确实开启并统计推理 token → 费用。即使 5/5，也只说明这一次通过。
- [x] **Step 3：补充录制与验证**，从 runner 生成文件中选取脱敏样本，保留生成元数据；`pnpm vitest run tests/unit/pi-event-converter.test.ts` 通过，记录五题逐项结果与实际调用花费。（2026-11-24 作者要求：提交前对 `.tmp/t1-api`、结果报告和新 fixtures 运行 `check-secrets --env DASHSCOPE_API_KEY`，必须通过；以录制为准核对思考模式确实关闭——返回内容无思考段，并在转换器测试中对新 API 样本断言无思考内容；查看工具拒绝记录，副本外读取或 bash 尝试如实记入实现说明；记录运行条件（模型、采样参数、时间、commit），说明一次全对只代表这一次。注意 pi 系统提示含本机绝对路径（可能含用户名），会随请求发往 API 提供方，“只将公开样例送 API”严格说不完全准确，实现说明中注明。）
- [x] **Step 4：提交** `test(step01): API 五题验收与事件录制`。这不是正式评测，不创建 evals 报告。 — 2026-11-24：共 3 次真实运行，均追加记录。第 1 次 `2a01872` 0/5（暴露三个流程缺陷，由 10A4 修正）；第 2 次 `f184198` 1/5（流程缺陷已修好，格式失败为推理写进最终回答）；第 3 次 `281e216`（`--thinking low`、`TMPDIR=/tmp/fp-t1`）**5/5、退出 0**，无截断、无未声明工具调用与拒绝，推理 4,315 token，最长 14.1 s，约 ¥0.118（三次合计约 ¥0.283，原价估算，控制台待核对）；只说明这一次通过，稳定性待 T2 评测。返修 2 轮 `e367524`、`4c7dd80`（思考泄漏检查改为整段切片对全部转换结果字段、README 精简）。check-secrets（key 与本机路径）通过，`pnpm test` 481/481。审查：SDD Approved（三次）、ponytail，复审全部 ADDRESSED。

### Task 10C：本地五题验收与配置切换

**目标**：用同一脚本与题集运行已就绪的本地小模型，如实记录，并证明切换无需改代码。

**Files:** Append `docs/reviews/step01-pi-integration.md`；按需追加 `tests/fixtures/pi-events/real-ollama-*.jsonl` 及录制 README。

**Interfaces:** 仍使用 10A2 CLI；仅 model 选择与模型配置改变；运行结果路径变化不影响任务内容。

- （2026-11-24 作者提醒，10C 开工前）**先测再定，一次只改一个条件**：先用与 10B 第 3 次相同的流程（`--tools read,grep`、`TMPDIR=/tmp/fp-t1`）跑一次。本地模型是非思考的 instruct 版本，10B 已证明格式问题靠开思考才解决，10C 很可能再出现"推理写进最终回答"，结果不好也如实记录，逐题分清格式错误、内容错误（missing/extra）、截断与超出上下文。**16k 上下文**：系统提示、题目、文件清单与 grep/read 返回累计可能接近 16k；开工前确认超出上下文时报告或离线统计能看出来（如结束原因、Ollama 的截断表现），不得被记成答错，看不出来则先停下报告。确因工具不够用而失败，再评估是否开放更多搜索工具；时限先看每题实际耗时再决定是否放宽。
- （2026-11-24 作者决定，10C 首次正式运行 `177fb39` 后）**运行认可与补充**：认可这次运行（每次请求上下文最多 1,918 token，约为窗口 12%，溢出不可能发生），实现说明追加预检 (b) 的偏差：多条消息合计超出 16k 时 Ollama 静默丢弃最早的消息，报告与 `t1-usage` 当时看不出，按作者规则本应停下。**离线溢出检测**：`t1-usage` 逐题识别上下文溢出——主判据为同一题内后一次请求的输入总量（input + cacheRead）比前一次下降，辅助判据为 cacheRead 相对上一次请求的输入总量骤降；HTTP 400 "exceeds the available context size" 单独归类为超出上下文（不混入一般错误）；输出越过窗口（input + cacheRead + output 超过给定的上下文窗口）也标出；三种情形都要有测试。**Ollama 输出上限**：ollama 条目加 `compat.maxTokensField: "max_tokens"`（Ollama 0.40.15 只认 max_tokens，忽略 max_completion_tokens），不为此重跑，实现说明注明。
- （2026-11-24 作者决定，10C 审查后修订离线溢出检测）**输入总量** = input + cacheRead + cacheWrite（修订此前的 input + cacheRead）。**主判据**仍为同一题内输入总量下降；用量全为 0（服务端未回报）的请求跳过，不算下降。**辅助判据**改为 cacheRead < 上一次输入总量 − 16，只在服务端回报缓存时检查；依赖按 token 缓存前缀的服务，换成按块缓存的服务或缓存被清掉（如模型重新加载）时可能误报，届时按服务调整容差。两个判据须一起用：10C 预检 (b) 真实发生的静默丢弃被新增的工具结果盖住，主判据没有触发。**被中止或缺用量的请求**：给定 `--context-window` 时，按上一次输入总量 + 上一次输出 + 其后追加的工具结果字符数 / 3 估算，超过窗口则单列为"可能溢出，无法核实"，不算答错，不与已确认的溢出混在一起；"3 个字符约 1 个 token"偏向英文与代码，中文会低估。测试：真实数字（上一次输入 1,391 → cacheRead 1,250、输入总量 12,770）能抓到；正常序列（1408→1410、1467→1509）不误报；cacheWrite 不为 0 的构造数据；用量全为 0 不误报；预检 (b) 被中止请求标为可能溢出。注释写明盲区（统计干净不等于没有溢出）。长期根本办法在 T3：发送前估算长度，快超出窗口就主动停止。
- [ ] **Step 1：检查本地环境未漂移**，核对 Ollama 服务、0C 模型标签/digest/量化和推理配置；缺环境则停止，不能按模型能力不足处理。
- [ ] **Step 2：运行**，`pnpm tsx scripts/t1-real-run.ts --models config/models.local.json --model ollama/<锁定ID> --record-dir .tmp/t1-local --output .tmp/t1-local-result.json`。记录每题回答、得分、工具调用限制和超时；小模型未全部答对可记录后继续，但服务/脚本/引擎故障须先查明。脚本对未全对返回非零，不为本地模型改变判分。
- [ ] **Step 3：核对配置切换证据**，比较两次报告中的产品源码与脚本内容哈希、题集/样例版本，要求完全一致；Task 10B 的记录/样本提交不算产品改动。若必须修代码，修复后重跑两组，保留旧结果。补充真实录制后运行 `pnpm vitest run tests/unit/pi-event-converter.test.ts`。
- [ ] **Step 4：提交** `test(step01): 本地模型验收与配置切换证据`。

### Task 11：按顺序通过任务收尾关卡

**目标**：依 workflow 3.4 正式收尾；作者明确同意前不标 T1 完成。

**Files:** Append `docs/reviews/step01-pi-integration.md`；实施 T1 时更新 `docs/specs/tasks.md` 的路径/状态/日期/备注。本次仅修订计划时不执行这些修改。

**Interfaces:** 输入全部小任务证据；输出整体审查结果、逐项验收表、实现说明和讲解自测结果。

- [ ] **Step 1：全部检查与整体代码审查**，运行 `pnpm test && pnpm typecheck && pnpm build && pnpm check:pi`，实际读输出；请求整体代码审查。审查修复先补复现测试，验证修复并更新受影响记录；若改动影响真实验收结果，重跑对应验收。最终检查须针对修复后的代码，不能沿用过期证据。
- [ ] **Step 2：逐条核对 T1 验收 1–11**，使用下表定位产物；每条记录测试名、命令结果、契约/说明位置及代码版本。额外检查锁文件、依赖来源、patch 和源码复用情况，不能只凭 check:pi。未执行项明确标注且不通过本关卡。
- [ ] **Step 3：确认评测关卡适用性**，引用 tasks.md 的 T1 说明：五题仅为验收，本任务不适用 workflow 3.4 第 3 项，不增加正式评测。
- [ ] **Step 4：完成实现说明**，追加做了什么、设计意图、代码地图、计划偏差、验证与限制、3–5 道讲解自测题；删除执行账本前将裁决、修复及复现测试转存到实现说明。保留早期核实和失败尝试，不覆写历史记录。
- [ ] **Step 5：收尾一致性检查**，核对 CLAUDE.md 索引、文档链接、契约/代码、任务路径和状态；T1 尚未获作者同意时保持 `[~]`。提交 `docs(step01): 实现说明与验收核对`。
- [ ] **Step 5b：生成阶段学习总结**，用 project-logger skill 写 `docs/project-log/step01-pi-integration.md`（2026-11-22 作者新增的收尾步骤，见 workflow 3.4 第 6 项）；先给作者读、回答作者的问题，作者认可后本地提交 `docs(step01): 阶段学习总结`。
- [ ] **Step 6：严格讲解自测**，AI 提问，作者不看代码回答；未通过则记录问题并讲解，弄懂后重测，不跳过。
- [ ] **Step 7：作者明确同意后**，记录自测结果和同意，更新 T1 为 `[x]`、完成日期和备注，本地提交 `docs(step01): 记录 T1 收尾结果`。不自动继续 T2，不推送、合并、打 tag 或发布。

## 验收覆盖索引

此表只引用 tasks.md 编号，不另设验收标准；Task 2A 是测试支撑，Task 11 是所有验收的最终证据关卡。

| T1 验收 | 主要产物与证据 |
|---|---|
| 1 | 0B 能力对照；3/4 契约；6、8B、9A–9C 接口、拦截、确认、结束判定 |
| 2 | 2B SDK 录制；3 转换测试与契约；10B/10C 真实模型录制回归 |
| 3 | 0C 模型资料/真实工具调用探测；8A 配置；10B/10C API 与本地运行及配置切换 |
| 4 | 10A1 固定题库与判定；10A2 运行脚本；10B/10C 逐题结果 |
| 5 | 6 等待清理；8B 引擎取消；9C 跨进程与工具清理 |
| 6 | 0A 版本来源；1 依赖锁定；11 整体代码与依赖检查 |
| 7 | 5 基准引用读取；7 禁止自动发现；8B 分支篡改端到端验证 |
| 8 | 0A 开关核实；7 配置、提示词、扩展、skill 与父级/用户目录负向验证 |
| 9 | 0A 内置 MCP 配置和工具发现探测记录 |
| 10 | 4 上下文协议；5 调用方读取；7 多仓库注入；8B 完整链路与分支篡改测试 |
| 11 | 3 `run.started` snapshot 契约；4 首个事件规则；7 加载器回读与哈希；8A 快照与会话使用同一加载器；8B 分支篡改后 snapshot 不变且等于基准内容；9B 客户端处理“先失败”的事件流 |
