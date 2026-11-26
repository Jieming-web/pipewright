# T2 评测框架 v1 与基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 执行方式遵守 `docs/workflow.md` 和作者指示，不因本行自行启动多 agent 编排。

**Goal:** 一条命令在 Docker 中跑完一个版本化的 SWE-bench 任务集：Python 评测框架经统一引擎接口驱动容器内的 pi runner，在新容器中评分，输出成功率（均值、波动与置信区间）、token、轮数、耗时、失败类型、花费和完整轨迹；产出 Qwen3.6-35B-A3B 与 Kimi K2.6 的开发集基线报告。

**Architecture:** 每个任务、每次重复一个容器，镜像用 SWE-bench 官方实例镜像（Mac 冒烟用 arm64 镜像）。runner、Linux 版 node、rg、fd 和启动脚本打成运行包，只读挂载到容器 `/fp`。评测框架用 `docker exec -i` 运行启动脚本：脚本先激活 testbed 的 conda 环境，再启动 stdio 桥；桥启动 runner，并把 WebSocket 帧与 stdin/stdout 的 JSON 行互转，所以 runner 仍只监听容器内 127.0.0.1。任务容器只接 Docker internal 网络，模型请求经旁路的模型代理转发，API key 只在代理容器里。token 与轮数来自新增的「模型请求结束」协议事件。agent 结束后取出补丁，用 swebench 5.x 在新容器里评分。正式评测在 x86 服务器上克隆本仓库后运行同一条命令。

**Tech Stack:** TypeScript（runner、stdio 桥、模型代理，沿用 T1 的 pnpm 工作区与 vitest）；Python 3.13 venv（`eval/`：pytest、swebench 5.x、PyYAML）；Docker（本机 Docker Desktop 29.3 arm64；x86 云服务器正式评测）；Qwen3.6-35B-A3B 与 Kimi K2.6，都经百炼 API 调用（ADR 017）。T2 不跑本地模型（作者 2026-11-25 决定，见 tasks.md T2 验收 6）。

**Spec:**
- `docs/workflow.md`：3.2–3.6、4.1–4.6。
- `docs/specs/tasks.md`：T2，验收 1–10（验收 1 含留出集暂缓与重新启用条件，验收 6 含不跑本地模型，均为作者 2026-11-25 决定）；T2「T1 遗留」M3、M5。
- `docs/specs/design.md`：3.11 评测（全节，含 2026-11-25 追加的远程运行与网络两段）、5.1、5.2；第 2 节统一引擎接口。
- `docs/specs/proposal.md`：R2、R4、S1、S8；第 5 节模型与硬件。
- `docs/specs/decisions/005`、`011`、`015`、`016`（运行快照）、`017`（主模型直接用 Qwen3.6-35B-A3B，不做选型；Kimi 经百炼调用）。
- 契约：`docs/specs/contracts/engine.md`（本任务修改：M3 打开时限、取消竞速、stdio 桥传输、停止阶段的模型请求结束事件）、`docs/specs/contracts/agent-events.md`（本任务新增 `model.request.finished`）。
- 前置代码：`packages/engine-runner`（`pi-engine.ts`、`pi-event-converter.ts`、`runner-server.ts` 的 `STOP_BACKSTOP_MS`）、`packages/engine-client`（`spawnRunner`、`STOP_TIMEOUT_MS`）、`scripts/check-secrets.ts`、`tests/helpers/fake-openai-server.ts`；T1 实现说明「推迟到 T2：M3」及其更正，以及收尾节中推迟到 T2 的「模型请求结束」事件（2205、2448、2456 行附近）。
- 计划审查：2026-11-25 子 agent 审查（资深 agent 工程师视角）的"必须改"与"建议改"全部采纳，作者另补 8 条（下文标「作者补」）；同日作者第二轮意见（预算取消、续跑一致性、推理 token、复用选型记录、Kimi 2 次等）经复核后采纳（下文标「作者补 2」）。

## 开工决定（作者 2026-11-25 已确认）

| # | 决定 |
|---|---|
| D1 | 任务容器不能上网，也访问不到宿主机：只接 Docker `--internal` 网络。模型请求发给旁路的模型代理容器，代理只放行 `POST /<route>/chat/completions`，把 `model` 改写为该路由固定的模型 ID，删除联网搜索类参数（`enable_search`、`search_options`、`web_search`、`tools` 里 `type` 不是 `function` 的条目），并由代理加 API key。评分容器不运行 agent，使用默认网络。已写进 design 3.11。 |
| D2 | Python 经 stdio 桥连 runner：`docker exec -i <容器> /fp/bin/fp-entry <runner 参数>`，一行一条协议消息，消息本身不变。关停不依赖 stdin EOF：Python 侧设硬截止，最终兜底是删除容器。 |
| D3 | 新增契约事件 `model.request.finished`：每次模型请求结束都发，包括失败和被中止的请求，停止阶段也发（在终止事件之前）；用量缺失或全为 0 时为 `null`，报告中显示「未知」。用量带 `reasoning`，它是 `output` 的子集（T1 第 3 次录制：无缓存时 `totalTokens = input + output`；T2-0 实测：有缓存命中时 `totalTokens = input + cacheRead + output`；两次都是 `reasoning ≤ output`），只用于单列展示；花费只按 `output` 计，不再加 `reasoning`。T1 的原始录制只作诊断，不再用来统计。 |
| D4 | 用 swebench 5.x 与 `SWE-bench/SWE-bench_Verified` 数据集（自带 `image`、`eval_script` 等字段）。评分在新建的同镜像容器里进行：沿用 swebench 的补丁回退链，打补丁后跑测试，设测试超时。不信任 agent 容器里的任何结果。 |
| D5 | 开发集 40 个。Qwen3.6-35B-A3B 每题重复 3 次；Kimi K2.6 重复 2 次（作者补 2：它只是对照；n=2 的样本标准差参考价值低，Kimi 的波动以按题 bootstrap 区间为准，报告注明两组重复次数不同）。成功率报告每次重复的均值与样本标准差（ddof=1），再加一个按题 bootstrap 的 95% 置信区间。不做主模型选型（ADR 017）；配对比较与「能分辨的最小差距」暂不实现。 |
| D6 | 留出集暂缓（tasks.md T2 验收 1），T2 不建、不跑；本计划只在 Task 0 记录核实结果。 |
| D7 | 提示词只含 `problem_statement`；工具 `read,bash,edit,write,grep,find,ls`（运行包里带 rg 与 fd）；思考级别写在各模型的配置里，Qwen3.6-35B-A3B 与 Kimi K2.6 都为 `low`；采样参数 `temperature`、`top_p` 在两个模型的配置里显式写出，取各自模型卡里做 SWE 类评测所用的值（模型卡没给 SWE 专用值时，取模型卡对所用模式的推荐值，并注明），出处写在配置注释里，不依赖服务端默认值（作者 2026-11-25）；单任务 30 分钟墙钟上限、100 次工具调用上限。 |
| D8 | 临时危险命令清单只匹配命令位置（行首，或 `;`、`&&`、`||`、`|`、`&`、`$(`、反引号之后；引号里的分隔符不算命令位置：单引号里全部不算，双引号里 `;`、`|`、`&` 等不算、`$(` 与反引号本身仍算命令位置；只是不把分隔符当命令位置，引号里的内容照样参与匹配，如 `rm -rf "/"`；已知不拦：`sudo`/`env`/`time`/`nohup`/`xargs` 等前缀命令、`bash -c '…'`、子 shell `( … )`、命令组 `{ …; }`、绝对路径（`/usr/bin/curl`）、双引号里 `$(…)` 内部分隔符之后的命令（如 `"$(true; curl x)"`）——任务容器只接 internal 网络，清单只是临时的、T3 起被替换，多一条规则就多一分误拦，作者 2026-11-25）：`rm -r…f /`、`git push`、`curl`、`wget`、`nc`、`ssh`、`scp`、`shutdown`、`reboot`、`mkfs`、`dd`、fork 炸弹。命中就拒绝；其余激活的工具放行；未激活的工具拒绝。清单写在评测配置里，T3 起由策略服务替换。 |
| D9 | 本机用 Python 3.13（补丁版本不限）建 venv：Mac 用 `/usr/local/bin/python3.13`；没有 sudo 的 Linux/WSL 可以用 uv 取得 3.13 解释器，uv 只用于取得解释器，venv 和 `requirements.txt` 的用法不变；评测报告记录实际的 Python 版本（作者 2026-11-25，P1 修订；同日作者改为补丁版本不限——3.13.18 起 python.org 不再提供 macOS 安装包，且补丁版本差异不影响评测结果；原文「`/usr/local/bin/python3.13 -m venv eval/.venv`，不装 uv」）；服务器上用系统自带的 Python（≥3.10 即可）；依赖锁定确切版本，写在 `eval/requirements.txt`。 |
| D10（作者补 5） | 计分口径写进配置，开跑前固定：`patch_apply_failed`、`empty_patch`、`run_failed`、`timeout`、`tool_budget` 都算失败，留在分母里；`infra_error`（定义见 design 3.11：不是由 agent 或补丁引起的失败，含任何阶段的 Docker/守护进程/容器故障；测试超时不算）与 `rate_limited`（429）最多重试 2 次，仍失败的记为「无法测量」，从分母中排除并逐条列出（T2 基线仍用本条；配对比较按 design 3.11「一格无法测量即不确定」，作者 2026-11-26）；排除的运行超过 5% 时，整次评测判为**无效**，命令以非零退出。预算触发时，被取消的运行记为 `budget_cancelled`，尚未开始的记为「未运行」，两者都从分母中排除并逐条列出，整次评测标为**未完成**（作者补 2）：命令同样以非零退出，但可以提高 `--budget` 后用 `--resume` 续跑；未完成与无效分开报告。 |

### 平台变更 P1（2026-11-25 追加；协作者提议，作者 2026-11-25 修订后确认）：Task 6 起增加 Windows + WSL2 Ubuntu（x86_64）开发环境，Mac 仍为必需环境

协作者从 Task 6 起在 Windows 机器的 WSL2 Ubuntu 26.04（x86_64，Docker Desktop 29.9.3 WSL 后端）上继续；Windows 原生下 T1 的 POSIX 依赖（FIFO、进程组、软链接）使 17 个测试失败，不做 Windows 原生兼容。WSL 内已核实：`pnpm test` 531/531、`typecheck`、`build`、`check:pi` 通过，`eval/.venv/bin/pytest eval/tests -q` 81 passed，与 Task 5 记录一致。对后续小任务的影响：

| 原文 | 改为 |
|---|---|
| D9 `/usr/local/bin/python3.13 -m venv`，不装 uv | 见 D9 新文：两边都用 3.13（补丁版本不限）；Mac 用 `/usr/local/bin/python3.13`，WSL 无 sudo 时用 uv 取得解释器（如 `~/.local/bin/python3.13`） |
| Task 6 Step 1「Task 0 拉到的那个 arm64 实例镜像」，`bundle-<本机架构>` | 两个架构都要能构建并通过测试：Mac 用 arm64 实例镜像、`bundle-linux-arm64`；WSL 用同一实例的 x86_64 官方镜像、`bundle-linux-x64`；测试按本机架构选（作者 2026-11-25：Mac 仍为必需环境） |
| Task 11 Step 4「从验证过 arm64 镜像的实例里选，在 Mac 上真实预检」 | 原文不变（Mac 上真实预检）；WSL x86 上可另从 x86 镜像可用的实例里预检 |
| Task 14「Mac 冒烟」 | 原文不变（Mac 冒烟，验收 9）；WSL x86 冒烟可选。协作者机器上用作者在百炼控制台单独创建的 key（带额度上限、可随时吊销），不用作者的主 key（作者 2026-11-25） |
| Task 1 Step 5「macOS 上连跑 5 次」等已完成记录 | 不改，属历史记录 |

验收 9「Mac 上能跑少量冒烟任务」不变：Mac 仍是必需环境，WSL2 x86 是第二个开发环境，两边都要能跑全量测试（作者 2026-11-25；原提议「Mac 不再作为必需环境」未采纳）。2026-11-26 作者补充：验收以 Mac 跑通为准，WSL x86 不再要求复验；x86 的首次验证落在 Task 15 Step 2（服务器上构建 `linux-x64` 运行包并先跑 smoke-v1 的 x86 版本）。

**需要作者准备**：x86 服务器到 Task 15 才租，租之前先报价。两个模型都用 `.env` 里的 `DASHSCOPE_API_KEY`，T2 不使用 `MOONSHOT_API_KEY`（ADR 017）。

## Global Constraints

- pi 锁定 1.5.1，不修改、不 fork；runner 的产品行为只按契约改，先改契约再改代码。T2 由评测框架担任拦截决策方（`interceptMode: "callback"`）。
- 评测框架用 Python，只经跨进程协议与 runner 通信，不导入、不调用任何 TS 代码（验收 7：T12 接入 Claude Code 时评测框架不需要改）。
- agent 的命令只在任务容器内执行；每个任务的每次重复都新建容器，结束后删除；本次评测创建的容器与网络都打上标签 `fp-run=<运行名>`，崩溃后可以按标签清理。
- 单元与集成测试只用假模型；真实模型只在 Task 0、14、15、16 调用，每次调用前输出预计花费。
- API key 只从 `.env` 读取，用 `docker run -e 变量名`（值从子进程环境继承）只传给代理容器，不进入命令行参数、日志、轨迹或报告；每次真实运行后用 `scripts/check-secrets.ts` 扫描输出目录，只传本次实际用到的变量。
- 运行产物写到 `eval/runs/<运行名>/`，不进 git；评测报告 `docs/evals/` 只追加、不改正文；不引用第三方排行榜的分数；报告注明开发集分数可能偏高，并写明 T2 没有留出集数字。
- 任务分支 `step-02-eval`，隔离工作区；每个小任务验证后本地提交，格式 `类型(step02): 说明`；推送、合并、tag、租服务器需作者同意。
- 文档中文，代码标识符英文；先写测试并看到失败，再实现；同一任务最多返修 3 轮；每做完一个小任务就停下等作者审查（规格与质量审查之后，另做一次 ponytail-review）。

## Review Focus

1. **agent 卡住或模型服务不可用**：runner 一直不发终止事件 → 到墙钟上限后发取消；再过 15 秒仍未结束，就杀掉桥进程并删除容器，记为 `timeout`，其他任务照常继续（Task 5、12）。
2. **补丁不完整或打不上**：agent 新建了文件或改了二进制文件 → 补丁用 `git add -A` 后 `git diff --cached --binary <有效基准>` 取出（有效基准见 Task 9）（被 `.gitignore` 忽略的构建产物不进补丁，这是有意的）；评分时回退链都打不上就记为 `patch_apply_failed`，算失败（Task 10、12）。
3. **历史截断漏网或误报**：标签、reflog、packed-refs、stash、notes、远程引用或不可达对象里仍有基准之后的提交 → 截断后自检，自检不通过就不运行这个任务，记为 `infra_error`；反过来，swebench 镜像的 HEAD 是 `base_commit` 之上的一个额外提交（提交信息 `SWE-bench`，含环境设置），不能被当成泄露或被退掉（实现说明 0.8a），所以截断、自检、取补丁都以有效基准为准（Task 9，作者 2026-11-25 指出）。
4. **评测进程崩溃或中途 Ctrl-C**：容器按标签清理；用 `--resume` 续跑，已有 `record.json` 的运行会跳过；不带 `--resume` 时，输出目录已存在就拒绝运行（Task 13）。
5. **花费失控或限流**：累计实际花费达到 `--budget` 时，取消所有进行中的运行（`budget_cancelled`），不再开始新的（「未运行」），整次评测标为未完成；429 单独归类，不和模型能力混在一起（Task 12、13）。

---

## 小任务、依赖与覆盖

| 小任务 | 预计 | 依赖 | T2 验收引用 |
|---|---|---|---|
| 0 开工核实 | 120 分钟 | 无 | 1、3、7、9、10 |
| 1 M3：诊断文件打开时限 | 75 分钟 | 0 | T1 遗留 |
| 2 M5：路径规则防漂移测试 | 30 分钟 | 0 | T1 遗留 |
| 3 模型请求结束事件 | 60 分钟 | 1 | 2、5 |
| 4 stdio 桥 | 60 分钟 | 3 | 7 |
| 5 Python 客户端与拦截策略 | 75 分钟 | 4 | 4、7 |
| 6 运行包与启动脚本 | 75 分钟 | 4 | 3、7 |
| 7 模型代理 | 45 分钟 | 0 | 3 |
| 8 容器沙箱与网络 | 60 分钟 | 6、7 | 3 |
| 9 仓库历史截断 | 60 分钟 | 8 | 8 |
| 10 评分 | 60 分钟 | 8 | 2 |
| 11 任务集与金标准预检 | 75 分钟 | 10 | 1 |
| 12 单任务运行 | 75 分钟 | 5、9、10 | 2、3、4 |
| 13 汇总、花费、并发与一条命令 | 90 分钟 | 11、12 | 2、5 |
| 14 Mac 冒烟与花费校准 | 60 分钟 | 13 | 3、7、8、9 |
| 15 远程 x86 与任务集定版 | 90 分钟＋运行 | 14、作者同意租用 | 1、9 |
| 16 开发集基线与报告 | 60 分钟＋运行 | 15 | 6 |
| 17 收尾关卡 | 60 分钟 | 以上全部 | 1–10 逐条核对 |

---

### Task 0：开工核实

**目标**：确认本计划依赖的每个外部条件都成立，任何一项不成立就停下来报告，不绕过。结果写进 `docs/reviews/step02-eval-framework.md`「0. 开工核实」（模版 `docs/templates/review.md`），探测脚本全文附在附录。

- [x] **Step 1：留出集核实记录**。把 2026-11-25 的核实结果写进实现说明：datasets-server 查到 SWE-bench-Live full 划分 `created_at ≥ 2025-10-01` 为 0 题，SWE-rebench-leaderboard 按月划分只到 `2026_03`；`huggingface.co` 主站当时连不上，没能交叉核对，datasets-server 的索引可能滞后。用 `datasets` 直接加载再确认一次；结论如果变了，停下报告作者。 — 2026-11-25：留出集结论复核未变（datasets 直接加载 + datasets-server），HF 主站不可达，未交叉核对。
- [x] **Step 2：Python 与 swebench**。`/usr/local/bin/python3.13 -m venv` 建 scratch venv，安装 swebench 5.x 最新版；记录确切版本，以及 `make_test_spec`、`get_eval_report`、`GIT_APPLY_CMDS`、`exec_run_with_timeout` 的实际导入路径（后续 Task 以实测为准）。加载 `SWE-bench/SWE-bench_Verified`，记录 revision sha、条数、仓库分布，并确认实例带 `image`、`eval_script`、`log_parser`、`eval_type` 字段。 — 2026-11-25：swebench 5.0.2；导入路径与计划猜测不同，以实现说明 0.2 为准。
- [x] **Step 3：镜像**。挑 3 个实例：x86 镜像名能否解析（`docker manifest inspect`）；Mac 上能否拉取 arm64 镜像（先查 `swebench` 命名空间下的 arm64 仓库，再查 Epoch AI），并在容器内查看 `cd /testbed && git log -1`。记录镜像命名规则、单个镜像大小，`/testbed` 的 git 状态（`git tag | wc -l`、`git reflog | head`、`git branch -a`、`git stash list`），以及镜像 `Env` 里的 PATH 和 testbed 环境的激活方式。 — 2026-11-25：3 个实例镜像已拉取（2 个 swebench arm64、django-11099 来自 Epoch）；/testbed 留有基准之后的提交与标签。
- [x] **Step 4：运行包可行性**。执行 `pnpm --filter @forgepilot/engine-runner deploy --legacy --prod <scratch>/runner`，以及 engine-client 的同样命令，确认两者的 `dist/` 都在（根目录 `.gitignore` 里有 `dist/`，需要时给包加 `files` 字段）。把 Linux arm64 版 node 24、rg、fd 的官方发行包放进去，挂载进 Step 3 的 arm64 实例镜像（不用 `ubuntu:22.04`）。在 `source /opt/miniconda3/bin/activate && conda activate testbed` 之后运行 `node runner/dist/main.js`，应以「--models is required」非零退出；同时确认 `which python` 指向 `envs/testbed`。 — 2026-11-25：先 pnpm -r build 后 deploy 即带 dist，无需 files；容器内以 2 退出且 which python 指向 envs/testbed。
- [x] **Step 5：网络**。`docker network create --internal fp-probe`。internal 网络里的容器：`curl https://github.com` 必须失败，访问 `host.docker.internal` 必须失败（作者补 2）。同时接两个网络的 `node:24-slim` 容器能访问 `https://dashscope.aliyuncs.com`；internal 网络里的容器能按容器名访问它。 — 2026-11-25：internal 网络连不上外网与 host.docker.internal；双网络容器可达百炼。
- [x] **Step 6：模型**。从 `.env` 加载 key，只记录是否存在。Qwen3.6-35B-A3B、Qwen3-Coder-Next、Kimi K2.6 各发一次只含一个工具调用的请求（形状同 T1 0C 的探测脚本），记录：模型 ID、价格（元/百万 token，输入/输出/缓存）、是否可用、支持哪些思考级别、默认采样参数，以及 `enable_search` 一类参数是否被接受。开了思考的模型（Qwen3.6、Kimi K2.6）各核对一次 pi 报的用量口径：`totalTokens` 是否等于 `input + output`、`reasoning` 是否不超过 `output`。Kimi 的口径与百炼不同时停下报告，不自行改计费。 — 2026-11-25：Qwen3.6 可用；qwen3-coder-next 404；Kimi 经百炼可用（Moonshot 官方停用）→ 作者决定 ADR 017。
- [x] **Step 7：关卡**。在实现说明里逐项写「通过 / 不通过 / 未执行」，有不通过就停下报告作者；全部通过后提交 `docs(step02): 开工核实`。 — 2026-11-25：关卡通过（2 项不适用、1 项未执行不阻塞，见实现说明 0.8–0.8a）。

### Task 1：M3 诊断文件打开时限

**目标**：诊断文件打不开或打开卡住，都属于启动失败，在创建 pi 会话、执行任何工具之前报出。方案按 T1 实现说明「推迟到 T2：M3」的 A2+3。

**Files:** Modify `docs/specs/contracts/engine.md`、`packages/engine-runner/src/raw-event-recorder.ts`、`packages/engine-runner/src/pi-engine.ts`；迁移 `git grep -n "no-such-dir\|mkfifo" -- tests/integration` 列出的 8 条测试。

**Interfaces:** `createRawEventRecorder(path)` 新增 `opened: Promise<void>`；新常量 `RECORDER_OPEN_LIMIT_MS = 5_000`。

- [x] **Step 1：改契约**。engine.md 第一事件规则删掉「尚未实现」，改写为：等文件打开结果，最多 5 秒，期间收到取消就立即结束等待、按 `run.cancelled` 收尾；打开失败或超时，只发带原因的 `run.failed`，不执行工具；打开卡住导致进程无法自行退出时，由启动者到停止时限强杀。超时表加一行「诊断文件打开，5 秒，不可配置」。在「进程退出」一段写明：打开等待与取消竞速，不与清理时限叠加，所以「7 s < 10 s」的算术不变。变更记录加一行。提交 `docs(step02): 契约补诊断文件打开时限`。 — 2026-11-25：41c2af1；措辞「打开尚未完成」的更正随 4c0ba73（作者同意）。
- [x] **Step 2：写失败测试**（`runner-process.test.ts`）。 — 2026-11-25：三条新测试，另加录制关闭竞态的复现测试（a8b808d，作者同意）。
  - `it("诊断文件目录不存在：只发 run.failed，工具不执行，以 0 退出")`：事件类型序列为 `["run.failed"]`，`reason` 匹配 `/ENOENT.*no-such-dir/`，退出码 0，`ran.marker` 不出现。
  - `it("诊断文件是无读端 FIFO：约 5 秒后发 run.failed（原因含 timed out），工具不执行")`：事件序列为 `["run.failed"]`，marker 不出现；进程不能自行退出时，启动者强杀（`forced: true`）也算通过。
  - `it("等待打开时收到取消：立即以 run.cancelled 结束，工具不执行")`。
- [x] **Step 3：运行确认失败**：`pnpm vitest run tests/integration/runner-process.test.ts`。预期现象：第一条得到 `run.failed: cleanup failed: ENOENT…`，退出码 1，marker 出现；第二条的工具照常执行（marker 出现），到清理超时才发 `run.failed: cleanup failed`；第三条要等创建结束才处理取消。现象和这里写的不一样，就停下报告。 — 2026-11-25：RED 现象与本步描述一致。
- [x] **Step 4：实现**：`pi-engine.ts` 在 `mkdtemp`/`createPiSession` 之前，让 `recorder.opened`、5 秒超时和取消信号三者竞速；打开失败或超时，就置空 recorder、`#outcome = run.failed`、`return stop()`；取消先到，就按取消收尾。 — 2026-11-25：打开、5 秒计时、取消三者竞速，先到者决定结果。
- [x] **Step 5：迁移旧的故障注入测试**：原来用「目录不存在」注入**清理失败**的，改为打开 FIFO 读端后立即关闭，让写入得到 EPIPE；原来用「无读端 FIFO」注入**清理超时**的，改为打开读端但不读，写满管道缓冲区。两种注入在 macOS 上各连跑 5 次，再在 `node:24` Linux 容器里跑一次（`pnpm install --frozen-lockfile` 在容器内执行，node_modules 不和宿主机共用）。任何一处不稳定，就停下报告作者。 — 2026-11-25：8 条迁移完成；macOS 5×12 全过，Linux node:24 103/103；「启动失败后清理也失败」改用 cancelAll 抛错注入（作者同意的偏差）。
- [x] **Step 6：全量验证并提交**：`pnpm test && pnpm typecheck && pnpm build && pnpm check:pi`；提交 `fix(step02): 诊断文件打不开属于启动失败`。 — 2026-11-25：pnpm test 501/501（两次）、typecheck、build、check:pi 通过；4c0ba73；任务审查 Approved、ponytail Ship。

### Task 2：M5 路径规则防漂移测试

**Files:** 新建 `tests/unit/pi-resolve-drift.test.ts`；`scripts/t1-real-run.ts` 导出 `piResolve`。

- [x] **Step 1：写测试**：对一组输入（`a.py`、`./a.py`、`/abs/a.py`、`~/a.py`、`@a.py`、含普通空格和 Unicode 空格的路径、`../x`），断言 `piResolve(input, cwd)` 与 pi 1.5.1 的 `core/tools/path-utils.js` 中 `resolveToCwd(input, cwd)`（工具实际使用的那个，带去掉 `@` 前缀和统一 Unicode 空白）结果相同；按文件路径导入，做法同 `pi-session.test.ts` 的工具名单比对。 — 2026-11-25：对照 resolveToCwd，输入分两组注明用途（分支覆盖 / pi 可能单独变化的路径形状，作者决定不删用例），Unicode 空白用转义；共用 tests/helpers/pi-internal.ts。
- [x] **Step 2：运行**：`pnpm vitest run tests/unit/pi-resolve-drift.test.ts`，预期直接通过。不通过时，先把差异记进实现说明，再停下问作者：是修 `piResolve`，还是改对照对象。用变异确认测试有效：删掉 `piResolve` 对 `~` 的处理，测试必须失败，确认后恢复。 — 2026-11-25：首跑 18/18 通过；删 ~ 处理 3 例失败、去掉 Unicode 空白替换 4 例失败，均已恢复。
- [x] **Step 3：提交** `test(step02): piResolve 与 pi 路径规则的防漂移测试`。 — 2026-11-25：403b595、78e6af3、eafcea9；任务审查 Approved，ponytail 返修 2 轮后复审通过；全量 520 通过（第 1 轮后）。

### Task 3：模型请求结束事件（D3）

**目标**：每次模型请求结束，调用方都能拿到结束原因和用量，包括失败、重试中的失败尝试和被中止的请求。T1 推迟到 T2 的事项在这里完成。

**Files:** Modify `docs/specs/contracts/agent-events.md`、`docs/specs/contracts/engine.md`（2.3 清理阶段的例外）、`packages/engine-protocol/src/agent-events.ts`、`packages/engine-runner/src/pi-event-converter.ts`、`packages/engine-runner/src/pi-engine.ts`（停止阶段放行这类事件）、`scripts/t1-usage.ts`（只改 shortcut 注释，指向新事件）；Test `tests/unit/pi-event-converter.test.ts`、`tests/unit/agent-events.test.ts`、`tests/integration/pi-engine.test.ts`。

**Interfaces:** 事件 `model.request.finished`（进度类）：`stopReason: "stop" | "toolUse" | "length" | "error" | "aborted"`；`usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null`（pi 没给用量或全部为 0 时为 `null`，表示未知；`reasoning` 是 `output` 的子集，pi 没给时为 0）；`errorMessage?: string`（只在 `stopReason` 为 `error` 时出现，原样截断到 500 字符）。来源是 pi 的每条 `role=assistant` 的 `message_end`。

- [x] **Step 1：改契约**：agent-events.md 的事件表和 pi 映射表各加一行，并加一条例子；engine.md 2.3 写明：清理过程中不再发布进度事件，唯一的例外是 `model.request.finished`，它在终止事件之前发出；runner 被强杀时，正在进行的请求不会有这个事件。提交 `docs(step02): 契约新增模型请求结束事件`。 — 2026-11-25：249c50b；映射表矛盾行在 aefecb1 拆分更正。
- [x] **Step 2：写失败测试**：转换器用现有样本 `retry.jsonl`、`retry-drop.jsonl`（失败尝试 `stopReason: "error"`，各一条）、`tool-call-then-text.jsonl`（`toolUse` 和 `stop` 各一条，用量与样本一致）；用量全为 0 → `usage: null`。用 T1 第 3 次真实录制 `real-qwen-api-run3-thinking-send-notice.jsonl` 断言：每条有用量的事件 `reasoning > 0` 且 `reasoning ≤ output`，`input + output` 等于录制中的 `totalTokens`（证明推理 token 已含在 `output` 里，花费不能再加 `reasoning`）。schema 拒绝未知的 `stopReason`。集成测试：慢流中途取消，事件序列里有一条 `stopReason: "aborted"` 的 `model.request.finished`，并且排在 `run.cancelled` 之前。 — 2026-11-25：实现前 7 个失败；run3 断言按缓存口径写为 input+cacheRead+output===totalTokens（控制会话据 T2-0 推广），并保留为作者要求的计费口径证据。
- [x] **Step 3：运行确认失败**；**Step 4：实现**；**Step 5：全量验证并提交** `feat(step02): 模型请求结束事件`。 — 2026-11-25：(Step 3–5) 9a0c26e、aefecb1；StopReasonSchema 单一来源；全量 526 通过、typecheck/build/check:pi 通过；任务审查 + ponytail 返修 1 轮后复审通过。

### Task 4：stdio 桥（D2）

**Files:** Create `packages/engine-client/src/stdio-bridge.ts`、`tests/integration/stdio-bridge.test.ts`；Modify `docs/specs/contracts/engine.md`（新增「传输：stdio 桥」与变更记录）。

**Interfaces:**
- 命令行：`node stdio-bridge.js --runner <runner main.js> -- <runner 参数…>`。
- stdin 每行原样作为一个 WebSocket 文本帧发出；每个收到的帧原样写成一行到 stdout。帧里有换行时，写 stderr 并以 2 退出。
- stdin EOF 时关闭 WebSocket（runner 按断线取消）。WebSocket 关闭后，`spawnRunner().stop()` 等 runner 退出；桥的退出码等于 runner 的退出码，runner 被强杀时为 137。runner 的 stderr 原样转到桥的 stderr。桥不校验、不改写消息。

- [x] **Step 1：写契约**，提交。 — 2026-11-25：305e23c（传输：stdio 桥）。
- [x] **Step 2：写失败测试**（假模型服务 + 真实 runner 子进程）：`start_task → accepted → 事件 → run.settled`，每条消息各占一行；callback 拦截一来一回之后工具执行；stdin EOF 后桥以 runner 的退出码退出；非法 JSON 行原样转发，stdout 收到 `invalid_message`。 — 2026-11-25：5 个用例：完整一轮含拦截往返、非法 JSON 透传、监听前退出（退出码 2）、运行中 stdin EOF 即取消、非 KILL 信号终止退出 137。
- [x] **Step 3：运行确认失败**；**Step 4：实现**（用 `spawnRunner` 的 `listening` 拿端口，再用 `ws` 直连）；**Step 5：全量验证并提交** `feat(step02): runner 的 stdio 桥`。 — 2026-11-25：(Step 3–5) eebbc26、4511531；stderr 在 runner 退出后一次写出（未改 spawnRunner）；全量 531 通过；任务审查 + ponytail 返修 1 轮后复审通过。

### Task 5：Python 客户端与拦截策略

**Files:** Create `eval/pyproject.toml`、`eval/requirements.txt`、`eval/forgepilot_eval/{__init__,engine_client,policy}.py`、`eval/tests/{test_policy,test_engine_client}.py`、`tests/helpers/fake-openai-cli.ts`；Modify `.gitignore`（加 `eval/runs/`、`eval/.cache/`）。

**Interfaces:**
- `run_task(cmd: list[str], start: dict, decide: Callable[[dict], dict], on_event: Callable[[dict], None], timeout_s: float, kill: Callable[[], None], grace_s: float = 15, should_cancel: Callable[[], bool] | None = None) -> RunResult`；`RunResult(terminal: dict | None, failure: str | None, timed_out: bool)`。
  - 同步实现：读线程把 stdout 的行放进队列，主循环带超时取出。到 `timeout_s` 时写 `cancel`；`should_cancel` 返回 True 时同样写 `cancel` 并走同一条收尾路径，但 `timed_out` 为 False（作者 2026-11-25：工具调用超限后由此取消，否则只能拖到墙钟超时）；之后 `grace_s` 秒内仍没有终止事件和进程退出，就调用 `kill()`（由调用方删除容器），并杀掉桥子进程。
  - `confirm_request` 一律回 `approved: false, by: "eval", reason: "eval does not confirm"`。
  - 出现非 JSON、缺 `type`、事件缺 `type`/`seq` 的行，记 `failure="protocol: …"`，按超时同样的路径收尾。终止事件之前 stdout 就 EOF，记 `failure="bridge exited: code N"`。
- `Policy(cfg: PolicyConfig)`，`PolicyConfig(tools, danger_patterns, max_tool_calls)`；`decide(req) -> Decision`；`exhausted: bool`（计数超限后返回 `block` 并置为 True，调用方经 `run_task` 的 `should_cancel` 取消任务）。
- `fake-openai-cli.ts <turns.json> [--host 0.0.0.0]`：stdout 打印 `FAKE_LISTENING <baseUrl>`。

- [x] **Step 1：建 venv**：`/usr/local/bin/python3.13 -m venv eval/.venv && eval/.venv/bin/pip install -r eval/requirements.txt`。 — 2026-11-25：`eval/.venv/bin/python --version` → Python 3.13.1；`pip freeze` 与 requirements.txt 逐行一致（只锁 pytest 及其依赖）。
- [x] **Step 2：写失败测试**。
  - `test_policy.py`：D8 每条规则各一个命中样例和一个不该命中的样例，例如 `grep -rn "curl" .`、`echo git pushd`、`ls; curl x`（命中）；`powershell` 被拒；第 101 次调用被拒，且 `exhausted` 为 True。
  - `test_engine_client.py`：本机用 node 跑桥 + runner + 假模型，不用 Docker。正常结束拿到 `run.settled`，`seq` 从 1 开始连续；拦截被拒时工具不执行；`timeout_s=1` 配慢流，得到 `timed_out=True` 和 `run.cancelled`；假桥（一个忽略 stdin、永不输出的 Python 脚本）在 `timeout_s + grace_s + 2` 秒内返回，且 `kill` 被调用过；桥进程被杀时得到 `failure`，不挂起。
- [x] **Step 3：运行确认失败**：`eval/.venv/bin/pytest eval/tests -q`；**Step 4：实现**；**Step 5：通过后提交** `feat(step02): Python 引擎客户端与评测拦截策略`。 — 2026-11-25：80f1959、5dc3a93（作者决定：should_cancel、D8 补 & 与引号规则，计划 b9983f8）、c24da09（rm 规则带引号）、efd5f33（审查返修：EOF 后不退出也记 failure、缺配对字段按协议错误）；D8 已知不拦补全见 443996d。`eval/.venv/bin/pytest eval/tests -q` → 81 passed（控制会话复跑，无残留进程）；`pnpm test` 531 通过（80f1959 时，之后未改 TS）。

### Task 6：运行包与启动脚本

**Files:** Create `scripts/build-eval-bundle.sh`、`eval/runtime/fp-entry.sh`、`eval/tests/test_bundle.py`。

**Interfaces:**
- `scripts/build-eval-bundle.sh <linux-x64|linux-arm64>` 生成 `eval/.cache/bundle-<arch>/`，包含：
  - `node/`：node 24 官方 Linux 发行包；
  - `bin/rg`、`bin/fd`：官方发行包；
  - 三者的 sha256 先与官方发布的校验文件比对（node 的 `SHASUMS256.txt`，rg、fd 的 GitHub release 中官方发布的校验文件），一致后再写死进脚本，脚本注释写明校验文件的 URL（作者 2026-11-25：T2-0 是下载后自己算的，只能证明文件以后没被改过，证明不了下载到的就是官方那份）。某个项目没有发布官方校验文件时，停下报告作者，不用自己算的值代替；
  - fd 没有发布官方校验文件（2026-11-25 核实 v10.5.2 的 release 附件与说明）：改用 GitHub release API 中附件的 `digest` 字段（GitHub 在项目 CI `github-actions[bot]` 上传时计算），脚本注释写明 API URL——协作者提议（P1 之后追加），审查员 2026-11-25 核对脚本值与 API digest 逐位一致，作者 2026-11-25 确认；原写「aarch64 值与 T2-0 自算值一致」不成立：T2-0 只记了缩写 `4b144f38…dba6`，与脚本值 `4b144f38…efba6dd` 尾部不符、又无完整值，无法核对，以 API digest 为准（2026-11-25 更正）；
  - `bin/fp-entry`：即 `fp-entry.sh`；
  - `app/runner/`、`app/client/`：先 `pnpm -r build`，再两次 `pnpm deploy --legacy --prod` 的产物（T2-0 实测：先构建时不需要 `files` 字段，`dist/` 会被带上）；
  - `VERSION`：内容为 `<git commit> pi@1.5.1 node@<版本>`。
  - 下载缓存放在 `eval/.cache/downloads/`；sha256 不符时脚本失败退出。
- `fp-entry.sh`：存在 `/opt/miniconda3/bin/activate` 时，先执行它并 `conda activate testbed`（失败就退出 3）；然后 `export PATH=/fp/bin:/fp/node/bin:$PATH`，最后 `exec node /fp/app/client/dist/stdio-bridge.js --runner /fp/app/runner/dist/main.js -- "$@"`。pi 的子 shell 会继承这些环境变量。

- [x] **Step 1：写失败测试**（标记 `docker`，镜像用 Task 0 拉到的那个 arm64 实例镜像）：只读挂载 `bundle-<本机架构>`，用 `docker exec` 运行 `bash -c '/fp/bin/fp-entry'`，断言 stderr 含 `--models is required`；在同一环境里，`bash -c` 子 shell 中 `which python` 包含 `envs/testbed`，`rg --version`、`fd --version` 都成功，`node --version` 以 `v24.` 开头。 — 2026-11-25（WSL x86，P1）：镜像 `swebench/sweb.eval.x86_64.psf_1776_requests-2317`；6 个用例：布局与 VERSION、fp-entry 报 `--models is required`、同一环境的工具与 testbed、`/fp` 只读、下载缓存被篡改时 sha256 不符失败且不产出、未知架构拒绝。写法偏差：环境设置拆为 `bin/fp-env`（fp-entry source 它，测试也 source 它，以检查"同一环境"），fp-entry 行为不变。
- [x] **Step 2：运行确认失败**：`eval/.venv/bin/pytest eval/tests/test_bundle.py -q`；**Step 3：实现**；**Step 4：通过后提交** `build(step02): 评测运行包与启动脚本`。 — 2026-11-25：RED 1 failed、4 errors（脚本不存在）；实现后 6 passed（55 s，含首次构建）；版本 node 24.15.0、rg 16.0.0、fd 10.5.2（gnu 版，同 T2-0），node 与 rg 的值与官方校验文件一致，fd 用 GitHub API digest（作者决定），两个 arm64 值与 T2-0 自算值一致；运行包 368 MB，无指向包外的绝对软链接，pi-tui 带各平台预编译 `.node`（x86 主机也能打 arm64 包，arm64 包本机未执行）；变异：rg 校验值改一位 → 退出 1、不产出；无 conda 的 `node:24-slim` 中 fp-env 不激活、工具可用。全量：`pytest eval/tests` 87 passed、`pnpm test` 531/531、typecheck、check:pi 通过。c2a1560。未做：计划要求的 ponytail-review（本会话无此 skill），待作者决定是否另做。

### Task 7：模型代理（D1，作者补 1）

**Files:** Create `eval/runtime/model-proxy.mjs`、`tests/unit/model-proxy.test.ts`。

**Interfaces:**
- 用法：`node model-proxy.mjs`，监听 8080。环境变量 `FP_PROXY_ROUTES` 为 JSON：`{"<route>": {"base": "https://…/v1", "keyEnv": "DASHSCOPE_API_KEY", "model": "<固定模型 ID>"}}`。
- 路由可选 `params: {temperature, top_p}`：转发时覆盖请求体里的这两个字段（作者 2026-11-26，T2-12 发现 pi 1.5.1 不发 `top_p`、只在调用参数带 `temperature` 时才发，runner 与契约也没有采样参数；由代理注入只对评测生效、不改契约，对任何引擎通用）。代理日志的 `sampling` 记录覆盖后的值。
- 只放行 `POST /<route>/chat/completions`，其余一律 404。请求体的 `model` 改写为路由固定的值，删除 D1 列出的联网搜索类参数；丢弃客户端带来的 `authorization`，改用 `Bearer <env[keyEnv]>`。响应体按流原样回传，SSE 不缓冲。
- 每个请求往 stdout 写一行 JSON 日志：`{route, status, fields: [请求体顶层字段名，已排序], sampling: {temperature, top_p, max_tokens, enable_thinking, …实际出现的}}`。日志里不写请求体内容，也不写 key。

- [x] **Step 1：写失败测试**：转发路径和请求体正确；`model` 被改写；`enable_search: true`、`search_options`、`{type: "web_search"}` 都被删除，`type: "function"` 的工具保留；替换 `authorization`；其他路径和 GET 请求返回 404；上游 429 原样回传；SSE 分块按到达顺序回传；日志里没有 key。 — 2026-11-25：9 个用例（代理作子进程、上游为测试内假服务）。计划之外另加：工具全被删时去掉 `tools`、客户端断开时中止上游（取消后不再计费）、上游连不上 502、请求体非 JSON 对象 400、缺 key 或配置非法启动即退出 2；日志同时断言不含提示词与客户端 token。写法细节：`FP_PROXY_PORT`（默认 8080，0 为随机，测试用）、启动行 `model-proxy listening on <port>` 写 stderr（stdout 只放请求日志）、请求体上限 32 MiB（413）、非已知路由的日志 `route: null`。
- [x] **Step 2：运行确认失败**：`pnpm vitest run tests/unit/model-proxy.test.ts`；**Step 3：实现**；**Step 4：提交** `feat(step02): 评测模型代理`。 — 2026-11-25：RED 9 failed（代理不存在）；实现后 9 passed；变异 4 项均被抓住（不中止上游、不删搜索参数、缓冲整个响应、转发客户端 authorization）；全量 `pnpm test` 540/540、typecheck、check:pi、`pytest eval/tests` 87 passed。9c1bf88。未做：ponytail-review（同 T2-6）。

### Task 8：容器沙箱与网络（作者补 2）

**Files:** Create `eval/forgepilot_eval/sandbox.py`、`eval/tests/test_sandbox.py`。

**Interfaces:**
- `ensure_network(run: str) -> str`：创建 `fp-eval-<run>`（`--internal`，带 `fp-run` 标签），已存在就复用。
- `start_proxy(run: str, routes: dict, env: dict) -> ProxyHandle`：容器名 `fp-proxy-<run>`，镜像 `node:24-slim@<Task 0 记录的 digest>`，用 `docker cp` 把 `model-proxy.mjs` 放进去；接 internal 网络（别名 `fp-model-proxy`）和本次运行专用的出网网络 `fp-egress-<run>`（普通 bridge，带 `fp-run` 标签，`cleanup_run` 一并删除），不接 Docker 默认网络：评分容器（Task 10）在默认网络上运行 agent 的补丁与测试，不得能连到代理（作者 2026-11-25，T2-7 审查发现；测试须证明默认网络上的容器连不到代理）；key 用 `-e 变量名` 传入。`ProxyHandle.logs() -> list[dict]` 返回代理的日志行。
- `class Sandbox`（上下文管理器）：`Sandbox(run, image, bundle: Path, out_dir: Path)`。
  - `__enter__`：`docker run -d --label fp-run=<run> --network fp-eval-<run> -v bundle:/fp:ro -v out_dir:/fp-out <image> sleep infinity`；
  - `exec(cmd, timeout_s) -> (code, out)`；
  - `entry_cmd(runner_args) -> list[str]`：返回 `["docker","exec","-i",<id>,"/fp/bin/fp-entry",*runner_args]`；
  - `kill()`、`__exit__`：一律 `docker rm -f`；
  - `image_digest() -> str`。
- `cleanup_run(run: str) -> None`：按标签删除容器和网络。普通 docker 命令默认时限 60 秒，`cleanup_run` 的批量删除用 300 秒；删容器失败时仍继续删网络，最后再报错（作者 2026-11-26，返修第 1 轮把默认时限由 600 秒降到 60 秒时确认）。

- [x] **Step 1–4**（2026-11-25，WSL x86）：11 个用例：internal 网络带标签且复用；github、host.docker.internal、1.1.1.1 都不通；经 `fp-model-proxy:8080` 拿到假服务回复且代理日志记 200；任务容器环境无 key、key 只在代理容器环境里；docker 命令行参数（spy 每次调用）不含 key；`/fp` 只读、`/fp-out` 可写、`entry_cmd` 形状、`image_digest`；`exec` 超时返回 124；`with` 内异常后容器已删；`kill`；模拟崩溃后 `cleanup_run` 按标签删光容器与网络；代理镜像固定 digest。RED：模块不存在。变异 3 项被抓住（去掉 `--internal`、key 改为 `-e K=V`、`__exit__` 不删容器）；第一次「key 进参数」没被抓住（`docker inspect` 看不到 CLI 参数），测试改为 spy argv 后抓住。写法细节：`node:24-slim` 的 digest 由 Task 8 固定（Task 0 未记录）；假服务辅助容器只接默认 bridge，代理按其 bridge IP 转发（默认 bridge 无容器名解析）；共用 fixture 移到 `eval/tests/conftest.py`。全量：`pytest eval/tests` 98 passed，`pnpm test` 两次 540/540（此前一次在 docker 测试刚结束时出现 22 个失败，重跑 3 次未复现，记为负载下的偶发，未定位）。未做：ponytail-review。
  - 更正（2026-11-26，返修第 1 轮 bad2712）：代理改接 `fp-egress-<run>`、不接默认网络，假上游改在 egress 网络上按容器名访问、不再依赖宿主机 node_modules；新增「默认网络上的容器连不到代理」用例。上面关于假服务「只接默认 bridge、按 IP 转发」的描述已过时。
- 原步骤：**Step 1：写失败测试**（`docker`）：容器里 `curl -sS --max-time 5 https://github.com` 失败；`curl --max-time 5 http://host.docker.internal` 失败；`http://fp-model-proxy:8080/fake/chat/completions` 能拿到假模型服务的回复（假服务以 `--host 0.0.0.0` 跑在一个也接入默认网络的辅助容器里，因为 internal 网络访问不到宿主机）；任务容器的环境变量里没有 `DASHSCOPE_API_KEY`；`with Sandbox(...)` 内抛出异常后容器已删除；`cleanup_run` 之后按标签查不到任何容器和网络。
- [ ] **Step 2：运行确认失败**；**Step 3：实现**；**Step 4：提交** `feat(step02): 评测容器沙箱与网络`。

### Task 9：仓库历史截断（验收 8）

**Files:** Create `eval/forgepilot_eval/repo_prep.py`、`eval/tests/test_repo_prep.py`。

**Interfaces:**
- **有效基准**（作者 2026-11-25 决定）：容器启动时 `/testbed` 的 HEAD。swebench 镜像的 HEAD 是 `base_commit` 之上的额外提交 `SWE-bench`（环境设置），Epoch 镜像的 HEAD 就是 `base_commit`（实现说明 0.8a）。评分容器也是在这个 HEAD 上打补丁，所以截断、自检、取补丁、金标准 blob 都以有效基准为准，不用数据集的 `base_commit`。
- `resolve_effective_base(sb: Sandbox, repo: str, base_commit: str) -> str`：先检查容器启动时的工作区，`git status --porcelain` 不为空就报错（作者 2026-11-26：否则镜像里原有的未提交改动会混进 agent 补丁；预检把这类实例排除）；返回 `git rev-parse HEAD`；`git merge-base --is-ancestor <base_commit> HEAD` 不成立（`base_commit` 既不是 HEAD 也不是它的祖先）时抛 `BaseMismatch`，这一次运行记为 `infra_error`。
- `truncate_history(sb: Sandbox, repo: str, eff_base: str, probe_blobs: list[str]) -> None`（`probe_blobs` 必填，传任务集里的金标准 blob，截断后一并自检；T2-9 偏差，协作者提议、作者 2026-11-25 确认）：
  1. `git checkout -B fp-base <eff_base>`（工作区内容不变）；
  2. 删除其他所有分支、标签、远程、stash、notes，以及 `refs/original`、`refs/replace`；
  3. `git reflog expire --expire=now --all && git gc --prune=now --quiet`；
  4. 自检，不通过就抛 `HistoryLeak`。
- `verify_truncated(sb, repo, eff_base, probe_blobs: list[str]) -> list[str]`：返回所有仍存在的问题，空列表表示通过。检查项：
  - `git rev-list --all --not <eff_base>` 非空；
  - `git for-each-ref` 中除 `refs/heads/fp-base` 外还有别的引用；
  - `git fsck --unreachable --no-reflogs --connectivity-only` 有输出（T2-9 偏差：加 `--connectivity-only`，审查员实测仍会列出不可达 blob；协作者提议、作者 2026-11-25 确认）；
  - `probe_blobs` 中任何一个 `git cat-file -e` 成功。
- `extract_patch(sb, repo, eff_base) -> str`：`git add -A && git diff --cached --binary <eff_base>`（Task 12 调用）。
- `gold_probe_blobs(inst) -> list[str]`：在一个临时容器里把金标准补丁打到有效基准（容器启动时的 HEAD）上，取补丁改动的每个文件的新 blob hash。这些 blob 只存在于修复之后，不受 `environment_setup_commit` 影响。只在预检时调用一次，结果存进任务集（Task 11），运行时直接读取，不再每次起临时容器（作者补 2）。

- [x] **Step 1：写失败测试**（标记 `docker`）。 — 2026-11-25（WSL x86，P1）：`eval/tests/test_repo_prep.py` 11 个用例。合成仓库（`buildpack-deps:jammy-scm` 里建好后 `docker commit` 成临时镜像，每个用例新起容器；fix 提交含修改、新建、新建空文件、删除各一；fix 由分支、轻量与附注标签、远程引用、`refs/original` 指向，另有 notes、stash、经过 fix 的 HEAD reflog，引用已 `pack-refs`）9 个：有效基准为环境提交（base_commit 等于 HEAD 时返回 HEAD）；`BaseMismatch`（后代提交、库里没有的提交）；截断前自检报出 8 类引用、fix 提交与两个探针 blob；截断后自检为空、`log --all` 只剩环境提交与 base、HEAD 为 `fp-base`、无远程与 reflog、索引与工作区不变、fix 对象已删；只删引用不 gc 时只有 fsck 报出不可达对象；截断后探针仍在时抛 `HistoryLeak`；for-each-ref 看不到的坏引用（全零的 `refs/remotes/origin/HEAD`）自检报出、截断删掉；`extract_patch` 含修改、删除、新建、二进制文件，不含 `.gitignore` 忽略的 `build/`，在新容器里 `git apply --check` 成功；`gold_probe_blobs` 恰为 fix 中修改与新建文件的 blob（不含删除与空 blob）。swebench 镜像（`swebench/sweb.eval.x86_64.psf_1776_requests-2317`，base_commit `091991be…`）与 Epoch 镜像（`ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099`，x86 存在且已拉取，base_commit `d26b2424…`）各 1 个，内容同计划。base_commit 经 datasets-server 查 SWE-bench_Verified 核对（venv 无 swebench/datasets，未新增依赖）。
  - 合成仓库（镜像 `buildpack-deps:jammy-scm`）：base、base 之上的环境提交（作为 HEAD，模拟 swebench 镜像）、之后的 fix 提交、指向 fix 的标签、一个 stash、一个远程分支引用和一条 notes。`resolve_effective_base` 返回环境提交；截断后 `verify_truncated(..., [fix 中新文件的 blob])` 为空；`git log --all --oneline` 只剩环境提交、base 及其祖先，环境提交仍在。截断前就自检，断言能报出问题。`base_commit` 不是 HEAD 的祖先时抛 `BaseMismatch`。
  - **swebench 镜像**（Task 0 拉到的 `psf__requests-2317` arm64 镜像）：`resolve_effective_base` 返回的 HEAD 不等于 `base_commit`，`base_commit` 是它的父提交；截断后自检为空（不误报 `SWE-bench` 提交）；HEAD 的提交信息仍是 `SWE-bench`；改一个文件后 `extract_patch` 只含这个文件；在同一镜像的新容器里 `git apply --check` 该补丁成功。
  - **Epoch 镜像**（Task 0 拉到的 `django__django-11099`）：`resolve_effective_base` 返回的 HEAD 等于 `base_commit`；截断后自检为空；`extract_patch` 只含被改的文件，在同一镜像的新容器里 `git apply --check` 成功。
- [x] **Step 2：运行确认失败**；**Step 3：实现**；**Step 4：提交** `feat(step02): 有效基准、历史截断与自检`。 — 2026-11-25：RED：收集时 `ModuleNotFoundError: forgepilot_eval.repo_prep`。首版实现后 swebench 用例失败，暴露两处与 0.3 记录不同的镜像事实：①完整 `git fsck` 在 requests x86 镜像上以 6 退出（历史里有 badTimezone 的老提交，不是泄露），自检改为 `git fsck --connectivity-only --unreachable --no-reflogs`；②镜像里有 for-each-ref 看不到的坏引用 `refs/remotes/origin/HEAD`（全零），截断增加直接删 `.git/refs` 下除 fp-base 外的文件、重写 `packed-refs` 只留 fp-base，并补合成仓库复现用例。另：requests x86 镜像标签 87 个（0.3 记录的 arm64 为 154），无 remote，其余结构（HEAD 为 `SWE-bench`、父提交为 base_commit、只有 main、stash 空）与 0.3 一致；Epoch x86 与 0.3 一致（HEAD=base、标签 422）。之后 11 passed（约 30 s，django 截断约 7 s）。变异 11 项全被抓住：不 expire reflog（3 失败）、不 gc（5）、自检漏 fsck（1）、`extract_patch` 不 `add -A`（3）、坏引用不删（1）、不查祖先（1）、自检漏探针（2）、gold 不排除删除（1，补「删除文件」后）、gold 不排除空 blob（1）、三处删引用都放过标签（5）；只在 update-ref 一处放过标签时未失败——属于纵深防御（随后的删文件与重写 packed-refs 仍删掉标签），不是漏测。全量：`pytest eval/tests` 109 passed；`pnpm test` 三次：3 失败 / 540 全过 / 1 失败（`runner-process` 的 FIFO 时限用例 43 s，偶发；本任务未改 TS，同 T2-8 记录的负载下偶发，未定位）；typecheck 通过；无 `fp-run` 残留容器、临时镜像已删。写法细节与偏差：`truncate_history` 增加可选参数 `probe_blobs`（默认空，自检一并检查，Task 12 可直接传任务集的 blob）；截断另删 `ORIG_HEAD`、`FETCH_HEAD` 等伪引用文件、删除所有 remote 配置，最后核对 fp-base 仍指向有效基准；`extract_patch` 经 base64 取出（stderr 不混入，非 UTF-8 字节以 surrogateescape 保留）；`gold_probe_blobs(inst)` 的 `inst` 为 dict（`image`、`patch`、`repo` 默认 `/testbed`、可选 `run` 标签），临时容器 `--network none`，先 `git apply` 失败再 `patch --batch --fuzz=5 -p1`，排除空 blob 与有效基准历史里已有的 blob，真实数据留给 Task 11。202ee41。未做：ponytail-review。

### Task 10：评分（D4）

**Files:** Create `eval/forgepilot_eval/grade.py`、`eval/tests/test_grade.py`。

**Interfaces:** `grade(inst: dict, patch: str, out_dir: Path, run: str, timeout_s: int = 1800) -> GradeResult`；`GradeResult(status: str, image: str, image_digest: str, arch: str)`，`status` 为 `resolved` / `unresolved` / `patch_apply_failed` / `infra_error`。（作者 2026-11-26，T2-10 审查后）原接口为 `grade(inst, patch, out_dir, timeout_s) -> str`，三种结果：
  - `run` 必填，评分容器打 `fp-run=<run>` 标签，`cleanup_run(run)` 能清到；
  - swebench 报告标出 infra_failure，或 docker/容器本身出错（含打补丁阶段容器坏掉）时返回 `infra_error`，按 D10 重试与排除；这与 swebench 官方把它留在分母里的算法不同，报告注明；
  - 结果记录评分用的镜像名、digest 与架构；
  - 与 swebench 5.0.2 的有意差异：评分容器不加 `SYS_ADMIN`；不还原 `image_assets`，实例的 `image_assets` 不为空时直接报错，不静默跳过；按架构换镜像由调用方负责（Task 11、12）。
- 新建容器：同一镜像、默认网络、不挂运行包，带 `fp-run` 标签。
- 打补丁沿用 swebench 的 `GIT_APPLY_CMDS` 回退链，全部失败返回 `patch_apply_failed`。
- 用 swebench 的带超时执行跑 `make_test_spec(inst).eval_script`，再用 `get_eval_report` 判定；超时记为 `unresolved`，并在日志中注明。
- 日志写入 `grade.log`；无论结果如何，容器都删除。

- [x] **Step 1：写失败测试**（标记 `docker`、`swebench`，用 Task 0 拉到的一个实例）：金标准补丁得到 `resolved`；空补丁得到 `unresolved`；乱码补丁得到 `patch_apply_failed`；`timeout_s=1` 得到 `unresolved` 且日志里有超时说明；（返修追加）评分容器带 `fp-run=<run>`；`image_assets` 不为空时报错；容器坏掉或 docker 出错时得到 `infra_error`；返回值含镜像名、digest、架构。
- [x] **Step 2：运行确认失败**；**Step 3：实现**；**Step 4：提交** `feat(step02): swebench 评分`。 — 2026-11-26（Mac arm64）：5033e23（实现）、8e64bd6（返修 1：`run` 必填、`GradeResult`、`infra_error`、拒绝 `image_assets`）、f71ff3b（返修 2：urllib3 异常归 `infra_error`）；偏差均经作者确认（实现说明偏差表）。RED：`ModuleNotFoundError: forgepilot_eval.grade`；返修 1 另做 6 个变异均被抓。控制会话复跑 `eval/.venv/bin/pytest eval/tests -q` → 127 passed，`fp-run` 标签无残留容器与网络。未执行：WSL x86 上的 `test_grade` 与 `pip install -r`，待协作者复验。

### Task 11：任务集与金标准预检（验收 1，作者补 8）

**Files:** Create `eval/forgepilot_eval/taskset.py`、`eval/tests/test_taskset.py`、`eval/tasksets/smoke-v1.json`。开发集在 Task 15 定版。

**Interfaces:**
- `stratified_sample(rows: list[dict], n: int, seed: int) -> list[str]`：按 `repo` 分层，每个仓库至少 1 个（`n` 小于仓库数时，按种子随机选 `n` 个仓库、每个仓库 1 个，作者 2026-11-26）；其余名额按仓库条数比例分配，余数按种子随机分；仓库内按种子随机抽；结果按 `instance_id` 排序。`n` 大于可选条数时抛错。
- `precheck(inst, bundle) -> PrecheckResult(ok: bool, reasons: list[str], probe_blobs: list[str])`：三项检查，分别是金标准补丁 → `resolved`、空补丁 → `unresolved`、在该镜像里挂载运行包后 `/fp/node/bin/node --version` 成功；调用 `grade` 时传入按本机架构选好的镜像；金标准评分与正式评分一样不加 `SYS_ADMIN`，定版任务集的每个实例金标准运行 FAIL_TO_PASS 必须全部通过，结果写进实现说明的偏差表，注明对照的是 swebench 5.0.2；因金标准失败被排除的候选逐条列出原因（作者 2026-11-26，T2-10 审查后）；同时调用 `gold_probe_blobs` 记下探针。
- **镜像来源**（作者 2026-11-26）：每个平台只用一个来源，不逐个实例回退。Mac arm64 起初统一用 Epoch 的 `ghcr.io/epoch-research/swe-bench.eval.arm64.<instance_id>`（官方 arm64 没有 `django__django-11099`，Epoch 覆盖全部 3 个候选）；预检后冷烟集只剩 astropy-12907，而它的 Epoch 镜像工作区不干净（`pyproject.toml` 有未提交改动），作者 2026-11-26 决定 Mac 改用官方 arm64 `swebench/sweb.eval.arm64.<id 中 __→_1776_>`（astropy-12907 为 `sha256:6373496b634a2e95077bfa3407ea8d334fd3520439832f003a0d631ab8a0d348`，工作区干净），仍是一个平台一个来源；x86 用数据集里的镜像名。所有镜像按 digest 锁定，任务集文件记录两个平台的 `name@digest`，并记入实现说明（规则同 node 镜像）。2026-11-26 控制会话查到的候选 digest：Epoch arm64 requests-2317 `sha256:dacf1300f00c585d18f5cbcd331777825b5437f682c1a846b2fd90606e1b570b`、astropy-12907 `sha256:fbbd240e3fee2881c98d74895bd614e5252e714bd6ab741c1c440c048304f750`、django-11099 `sha256:9312a779b863a5c97cf7c473987bab8293bc702dbe44e637e983604d21f82717`；官方 x86 requests-2317 `sha256:c6b5c8846507b5e48e307decca28dbdfa4f5ef17070c1087aacde765e8c4b178`、astropy-12907 `sha256:e082963099ed7d5a5f75a0be46e338be36faae33b2cba5289a9ddbd505997f1f`、django-11099 `sha256:cca302934edd881cc4f1e4647a389a25cdaa3c02bfa33667a4204934a09c4fb1`。
- **入选标准**（作者 2026-11-26，预检之前写定）：(1) 金标准补丁 → `resolved`；(2) 空补丁时 FAIL_TO_PASS 的**每一条**测试都失败（不只是整体 `unresolved`；用于证明评分器真在区分对错，这一条最重要）——`grade` 需把 swebench 的报告（含各测试状态）写到 `out_dir/report.json` 供预检读取；(3) 挂载运行包后 `/fp/node/bin/node --version` 成功；(4) 冷烟集额外要求：本平台金标准评分墙钟不超过 10 分钟（开发集不套用）。金标准超时视为不通过，排除该实例（不算 `infra_error`）。T2-10 的另外两条条件仍然适用：`image_assets` 不为空时报错（Task 10）；评分结果记录镜像名、digest、架构，正式评测拒绝非 amd64（Task 10、12、13）。
- **预检检查顺序与 BaseMismatch**（作者 2026-11-26）：先做便宜的镜像检查（工作区是否干净、有效基准、`node --version`），再跑金标准与空补丁评分，失败得早；`base_commit` 与镜像对不上（BaseMismatch）是镜像的确定性性质，预检里像工作区不干净一样直接排除并注明原因，不重试；正式运行（Task 12）里仍按 Task 9 当 `infra_error`。
- **任务集记录哪些平台的镜像**（作者 2026-11-26）：冷烟集（`smoke-*`）记录 arm64 与 x86 两个平台的 `name@digest`；开发集只记录 x86（正式评测只认 amd64，开发集不在 Mac 上跑），不解析 arm64。
- **预检中的 `infra_error`**（作者 2026-11-26）：同样配置自动重试最多 2 次，仍失败的记为「无法测量」，从候选中排除（在 `excluded` 里注明原因）；通过预检的候选不足 `n` 个、或全部候选都无法测量时，报错停下，不生成任务集。
- `build_taskset(name, version, rows, n, seed, bundle, out) -> None`：先抽 `min(ceil(n × 1.5), 可选条数)` 个候选（作者 2026-11-26 追认：smoke-v1 只有 1 行，原写法会要 2 个候选而报错；dev-v1 从 500 行取 60 个，不变），逐个预检，再用同一种子从通过预检的候选里分层抽 `n` 个。写出的任务集文件包含：`{name, version, dataset, revision, seed, created, selection, precheck: {passed, excluded: [{id, reasons}]}, instance_ids, probe_blobs: {<instance_id>: [blob…]}}`。`taskset_sha256(path) -> str` 对文件内容做 sha256，记录与续跑核对都用它。任务集一旦提交就不再修改，有变更就发新版本。

- [x] **Step 1：写失败测试**：用 3 个仓库、条数 10/5/1 的假数据：`n=8` 时覆盖全部 3 个仓库；同一种子结果相同，不同种子结果不同；`n` 过大时抛错。`build_taskset` 中预检用假函数，让 2 个候选不通过：它们出现在 `excluded` 里，不出现在 `instance_ids` 里；每个入选实例在 `probe_blobs` 里都有非空列表。
- [x] **Step 2：运行确认失败**；**Step 3：实现**。
- [x] **Step 4：生成 `smoke-v1`**：**1 个实例** `astropy__astropy-12907`（作者 2026-11-26：原定 2 个，3 个候选在 Epoch arm64 上预检后 django-11099 空补丁有一条 FAIL_TO_PASS 通过、requests-2317 测试依赖外网，均被排除），用官方 arm64 镜像按 digest 在 Mac 上重跑四项预检后定版。
- [ ] **Step 4b：x86 预检**（作者 2026-11-26，不找协作者）：在 GitHub Actions 的 ubuntu 运行器上，对冷烟集里最小的实例跑金标准与空补丁预检（作者 2026-11-26：原定 requests-2317 已被排除，改为冷烟集里镜像最小的实例，现为 astropy-12907；workflow 以实例 id 为输入）（手动触发的 workflow，用 x86 镜像 digest，不需要任何密钥）；运行器跑不了的实例在 Task 15 的 x86 服务器上补跑，不通过就发 smoke-v2。结果追加到实现说明。
- [x] **Step 5：提交** `feat(step02): 任务集抽样与金标准预检`。 — 2026-11-26（Mac arm64）：e2e965c、f0acbb3（实现与 smoke-v1.json，sha256 `7462bbd3…6ecd`）、51ca08f（预检结果）、5414a5e（审查返修 1）；workflow 23e9674（未推送、未运行，Step 4b 待作者同意后执行）。偏差均经作者确认（实现说明偏差表）。`eval/.venv/bin/pytest eval/tests -q` → 155 passed，`fp-run` 无残留。返修后按新检查顺序在官方 arm64 astropy 上真实预检（`eval/runs/precheck-68453747/`）：镜像检查 1.4 s → 金标准 52.3 s（F2P 2/2、P2P 13/13）→ 空补丁 53.3 s（F2P 0/2）→ 探针 `45bea360…`，与 smoke-v1 一致。

### MVP 里程碑（作者 2026-11-26 插入）

作者认为设计层面偏重，决定先做一个最小可跑的 MVP，作为 T2 的中间里程碑；tasks.md 的验收标准不变。MVP 跑通后，再按实际结果决定下面「挪后清单」里哪些要做、哪些删掉。

**MVP 的定义**：一条命令在 Mac 上跑完 smoke-v1——每个实例起容器 → 截断历史 → agent 经代理调用 Qwen → 取补丁 → 评分 → 输出成功率、token、轮数、耗时、失败类型、实际花费，并保存每个任务的轨迹。

**已建好的部分全部复用，不改**（T1、T2-1 至 T2-11）；唯一例外：T2-7 代理路由加可选 `params` 注入采样参数（作者 2026-11-26，见 Task 7）。`truncate_history` 的 `probe_blobs` 直接取 smoke-v1 里已算好的值。

**MVP 要做的**：
- **T2-12 精简版**：Task 12 的配置加载（含 `sampling` 必填、危险命令清单、30 分钟与 100 次工具调用上限、价格）与 `run_instance` 的 6 步运行流程照做；`TaskRecord` 只写最少字段：`instance_id`、`failure_type`、`failure_reason`、`usage`、`requests`、`tool_calls`、`wall_s`、`snapshot`、`patch.diff`、评分结果（`GradeResult` 四项）、`config_hash`、`taskset_sha256`。不做 `proxy-fields.json`。
- **T2-13 精简版**：命令 `run --config --taskset --out`：先打印预计花费并等确认（`--yes` 跳过）；`--out` 已存在就拒绝；按顺序逐个实例跑、跑完即评分；`infra_error` 按 D10 重试 2 次，仍失败的记为无法测量、排除并逐条列出；写 `summary.json`、`summary.md`（成功率、token、轮数、耗时、失败类型计数、实际花费、排除清单）；结束时用 `scripts/check-secrets.ts` 扫描输出目录；无论怎样结束都在 `finally` 里调用 `cleanup_run`。
- **T2-14**：Mac 上用真实 Qwen 跑一次 smoke-v1（1 个实例），跑前报价。

**挪后清单**（MVP 之后再定）：`--workers` 并发；`--resume` 与续跑一致性核对；`Budget` 的运行中累计、超限取消进行中的运行与 `budget_cancelled`/未完成状态；重复次数（`--repeats`）、样本标准差与 bootstrap 置信区间；`reconcile_proxy` 与 `proxy-fields.json`；Task 13 第 7 步中「启动时清扫遗留资源」；Kimi 组；Task 15 x86 服务器、dev-v1 定版；Task 16 基线报告；Task 11 Step 4b 的 GitHub Actions x86 预检；删除 `probe_blobs`（减重候选，作者未定）。

### Task 12：单任务运行（验收 2、3、4，作者补 6、7）

**Files:** Create `eval/forgepilot_eval/{run_task,config}.py`、`eval/configs/{qwen3.6,kimi-k2.6}.yaml`（两者的 `base` 都是百炼端点、`keyEnv` 都是 `DASHSCOPE_API_KEY`）、`eval/prompts/swe-v1.txt`、`eval/tests/test_run_task.py`。

**Interfaces:**
- `EvalConfig`（从 YAML 读取）字段：
  - 模型：`model: {provider, id, route, base, keyEnv}`、`thinking`、`sampling`（必须显式含 `temperature` 与 `top_p`，值与出处见 D7；缺任一项时加载配置报错）；
  - 拦截与限额：`tools`、`danger_patterns`、`max_tool_calls`、`task_timeout_s`、`grade_timeout_s`；
  - 提示词与花费：`prompt_file`、`price: {input_per_m, output_per_m}`、`assumed_tokens_per_run: {input, output, source}`；
  - 计分：`scoring`（D10 的口径与 5% 阈值）。
- `config_hash(cfg) -> str`：对规范化 YAML、提示词文件内容和 `sampling` 一起做 sha256。
- `run_instance(inst, cfg, run: str, out_dir: Path, attempt: int) -> TaskRecord`（MVP：去掉 `budget` 参数，Budget 挪后；`run_instance` 不评分，`TaskRecord` 的评分字段默认为 null，由 T2-13 跑完后调用 `grade` 填上——作者 2026-11-26 认可），写出 `out_dir/<instance_id>/<attempt>/` 下的四个文件：
  - `events.jsonl`：全部协议事件；
  - `raw.jsonl`：诊断用；
  - `patch.diff`；
  - `record.json`。
- `TaskRecord` 字段：
  - 标识与版本：`instance_id`、`attempt`、`taskset_version`、`taskset_sha256`、`config_hash`、`bundle_version`、`image_digest`、`effective_base`；评分的 `grade_image`、`grade_image_digest`、`grade_arch`（来自 `GradeResult`）（作者 2026-11-26，T2-10 审查后）；
  - 运行快照：`snapshot`，取自 `run.started`，没有就为 null；
  - 结果：`terminal_type`、`failure_type`、`failure_reason`；
  - 统计：`tool_calls`、`wall_s`；`requests`（`model.request.finished` 的条数）；`usage`（累加，含单列的 `reasoning`；任一请求的用量为 null 时，标 `usage_complete: false`）；`rate_limit_errors`（`errorMessage` 匹配 `/429|rate.?limit/i` 的请求数）；`patch_bytes`。
- `failure_type` 在运行阶段的取值：`none`（待评分）、`empty_patch`、`run_failed`、`rate_limited`（以 `run.failed` 结束，且最后一次请求的错误是 429）、`timeout`、`tool_budget`、`budget_cancelled`（因预算超限被取消）、`infra_error`（容器、桥、截断自检、协议错误等）。
- `Budget`：线程安全的累计实际花费，每收到一条 `model.request.finished` 就按 `input + cacheRead + cacheWrite` 与 `output` 累加（不加 `reasoning`）；达到上限时把 `exceeded` 置为 True，`run_instance` 随即取消自己，记为 `budget_cancelled`。
- 运行流程：
  1. 创建 `Sandbox`；
  2. `eff = resolve_effective_base(sb, "/testbed", inst["base_commit"])`，再 `truncate_history(sb, "/testbed", eff, probe_blobs)`，`probe_blobs` 取任务集里的 `probe_blobs[instance_id]`，为必填参数（T2-9 偏差，作者 2026-11-25 确认）；
  3. 写 `/fp-out/models.json`：baseUrl 为 `http://fp-model-proxy:8080/<route>`，apiKey 为字面占位串 `unused`；
  4. 调用 `run_task(sb.entry_cmd([... --workdir /testbed --sessions-root /fp-out/sessions --record-pi-events /fp-out/raw.jsonl --tools … --thinking …]), kill=sb.kill)`；
  5. `extract_patch(sb, "/testbed", eff)` 取出补丁；
  6. 删除容器。
  - 任何异常都先写 `record.json`（`infra_error` 加原因），再交给上层。

- [ ] **Step 1：写失败测试**（`docker`、假模型；「实例」用 `buildpack-deps:jammy-scm` 里预置的一个小仓库）：
  - 配置缺 `sampling.temperature` 或 `sampling.top_p` 时加载报错；假服务收到的请求体里 `temperature`、`top_p` 等于配置值；
  - 假模型执行 `bash: echo fix > new_file.py` 后结束：`patch.diff` 含 `new_file.py`；`failure_type=none`；`snapshot.engine.name=="pi"`；`requests==2`，`usage` 与假服务返回的一致；`record.json` 含 `config_hash`、`taskset_version`、`image_digest`、`bundle_version`。
  - 改了提示词文件内容后，`config_hash` 跟着变。
  - `bash: curl x` 被拒（对应的 `tool.finished` 是错误结果）。
  - `task_timeout_s=2` 配慢流，得到 `timeout`。
  - 假服务连续返回 429，直到 pi 重试用尽，得到 `rate_limited`。
  - 预算设为 0.000001 元，得到 `budget_cancelled`，且 `Budget.exceeded` 为 True。
  - 运行包路径故意写错，得到 `infra_error`，`docker ps -a` 里查不到容器。
- [ ] **Step 2：运行确认失败**；**Step 3：实现**；**Step 4：提交** `feat(step02): 单任务运行与轨迹记录`。

### Task 13：汇总、花费、并发与一条命令（验收 2、5，作者补 3、4、5）

**Files:** Create `eval/forgepilot_eval/{report,__main__}.py`、`eval/tests/test_report.py`。

**Interfaces:**
- `estimate_cost(cfg, n_runs) -> float`（元）：按 `assumed_tokens_per_run` 计算，并在输出中注明这个假设的来源（`source` 字段）。
- `actual_cost(records, cfg) -> float`：`input + cacheRead + cacheWrite` 按输入价计，不算缓存折扣，报告里注明；`output` 按输出价计，`reasoning` 已含在其中，不重复计；只要有用量未知的运行，就单独列出条数。
- `aggregate(records, cfg) -> Summary`：
  - 先按 D10 处理排除；任务集不是 `smoke-*` 时，出现 `grade_arch` 不是 amd64 的记录就判为 `invalid` 并以非零退出（这项检查在 D10 排除之后做；评分为 `infra_error` 且 `grade_arch` 为空的记录已按 D10 处理，不参与这项检查——控制会话 2026-11-26 按作者规则澄清，Task 13 用一条用例固定）——正式评测只认 amd64，arm64 只用于冒烟（作者 2026-11-26，T2-10 审查后）；
  - 成功率：每次重复各算一个值，给出均值与样本标准差（ddof=1）；
  - 按题 bootstrap 95% 置信区间：先算每题在各次重复中的平均成功，再对题目重抽样 10000 次，种子固定；
  - 每次运行的 token、轮数、耗时：均值与中位数；
  - `failure_type` 计数（含 `rate_limited`、`budget_cancelled`）、排除清单、「未运行」清单；状态为 `complete` / `incomplete`（有 `budget_cancelled` 或未运行）/ `invalid`（D10 的 5% 阈值），未完成与无效分开报告。
- `reconcile_proxy(records, proxy_logs) -> dict`：代理记下的请求总数与 `model.request.finished` 总数对账（按整次评测），差值写进 summary；被强杀的运行没有事件，差值不为 0 时列出这些运行。
- 命令：`eval/.venv/bin/python -m forgepilot_eval run --config <yaml> --taskset <json> --repeats N --out eval/runs/<名字> --budget <元> [--workers K] [--resume] [--yes]`。
  1. 先打印预计花费和预算，等确认（`--yes` 跳过）；
  2. 输出目录已存在且没有 `--resume` 时拒绝运行；带 `--resume` 时，先核对已有记录的 `config_hash`、`taskset_version`、`taskset_sha256`、`bundle_version` 与当前一致，任何一项不一致就拒绝并列出（作者补 2），一致才跳过已有 `record.json` 的运行；`--budget` 不参与核对，续跑时可以提高；
  3. 用 K 个线程并发执行「运行 → 评分」；`infra_error` 与 `rate_limited` 按 D10 重试，`rate_limited` 先退避 60 秒；
  4. 预算超限时停止派发新运行，并取消进行中的运行；
  5. 结束时写 `summary.json`、`summary.md`（含 `reconcile_proxy` 的结果）、`proxy-fields.json`（代理日志里实际发出的字段和采样参数去重后的结果，与配置的 `sampling` 不一致就在 summary 中标红）；
  6. 用 `scripts/check-secrets.ts` 扫描输出目录，发现密钥、评测无效或未完成时，以非零退出；
  7. 无论正常结束、Ctrl-C、SIGTERM 还是异常，都在 `finally` 里按标签调用 `cleanup_run`（为 SIGTERM 注册处理函数）。评测结果先落盘再清理。有原始异常时，清理错误只附加、不覆盖；没有原始异常但清理失败时，报错并标记为「评测完成、清理失败」。另外，每次启动时按标签清扫之前运行遗留的资源，标签带 run_id，只清扫所属进程已结束的运行（作者 2026-11-26；原文「Ctrl-C 与异常时，按标签调用 `cleanup_run`」，T2-6~9 复审发现正常结束不清理）。

- [ ] **Step 1：写失败测试**：
  - 3 次重复的成功率为 [0.5, 0.25, 0.75] 时，均值 0.5，样本标准差 0.25；
  - bootstrap：全对时区间为 [1, 1]；同一种子结果相同；
  - D10：`patch_apply_failed` 在分母里；3 个 `infra_error` 排除后，排除比例超过 5% 时状态为 `invalid`；有 `budget_cancelled` 或未运行时状态为 `incomplete`，二者都不进分母并被列出；
  - `actual_cost`：用量 `{output: 100, reasoning: 80}` 只按 100 计输出；
  - `reconcile_proxy`：代理 5 次、事件 4 次时差值为 1；
  - `estimate_cost` 与 `actual_cost` 的数值样例；
  - `--out` 已存在且不带 `--resume` 时以非零退出；`--resume` 跳过已有记录（用假的 `run_instance` 计调用次数）；已有记录的 `config_hash`、`taskset_sha256` 或 `bundle_version` 任一与当前不一致时，`--resume` 拒绝运行；
  - 预算超限后不再派发新运行。
- [ ] **Step 2：运行确认失败**；**Step 3：实现**；**Step 4：提交** `feat(step02): 汇总、花费、并发与评测命令`。

### Task 14：Mac 冒烟与花费校准（真实模型）

- [ ] **Step 1**：`python -m forgepilot_eval run --config eval/configs/qwen3.6.yaml --taskset eval/tasksets/smoke-v1.json --repeats 1 --out eval/runs/smoke-<日期> --budget 5`；先看预计花费。
- [ ] **Step 2：核对并记录**到实现说明：
  - 每次运行的四个文件齐全；`snapshot` 的引擎和模型字段正确；
  - `verify_truncated` 通过；运行中的容器里 `git cat-file -e <金标准 blob>` 失败（验收 8）；
  - agent 工具里 `which python` 指向 `envs/testbed`（看 events 中的 bash 输出，提示词不为此改动）；
  - 容器内 `curl` 外网和访问 `host.docker.internal` 都失败；
  - `docker top` 里能看到 agent 的命令，而宿主机上没有对应的进程（验收 3；Docker Desktop 下命令跑在虚拟机里）；
  - `proxy-fields.json` 与配置一致，其中每个请求的 `temperature`、`top_p` 都等于配置里显式写的值（证明确实发出去了，而不是用了服务端默认值）；`check-secrets` 干净。
- [ ] **Step 3：校准**：用这次的每次运行 token（取 p90）更新两个配置文件的 `assumed_tokens_per_run`，`source` 写为 `smoke-<日期> p90`（作者补 4）。
- [ ] **Step 4：提交** `docs(step02): Mac 冒烟与花费校准`。

### Task 15：远程 x86 与任务集定版（验收 1、9）

- [ ] **Step 1：报价**：写给作者以下内容，**作者同意后才租**：
  - 金标准预检的时长：60 个候选；
  - 开发集基线共 **200 次运行**（Qwen 40 题 × 3 次 = 120，Kimi 40 题 × 2 次 = 80）：token 花费按两组各自校准后的 p90 × 运行次数计；
  - 预计时长 = 200 × 冒烟实测的单次平均时长（agent + 截断 + 评分）÷ `--workers`，另加 60 个候选的金标准预检时长；
  - 服务器规格与价格：只需 CPU，建议 16 vCPU / 64 GB / 500 GB 盘；按小时价格乘上面的预计时长；
  - 每次运行的 `--budget`。
- [ ] **Step 2：服务器准备**（作者决定）：
  - 克隆本仓库的 `step-02-eval` 分支（推送到 GitHub 需作者同意；也可以用 `git bundle` 经 scp 传过去）；
  - 安装 docker、node 24、pnpm；运行 `scripts/build-eval-bundle.sh linux-x64`；建 Python venv；
  - `.env` 经 scp 传上去，并 `chmod 600`；
  - 所有评测在 tmux 里运行；结果用 `rsync -a` 拉回本机 `eval/runs/`；
  - 先跑 `smoke-v1` 的 x86 版本，确认同一条命令可用（验收 9）；开始正式评测之前，冷烟集的所有实例必须在 x86 上通过预检（Task 11 入选标准），Task 11 Step 4b 没覆盖的实例在这里补跑，不通过就发 smoke-v2（作者 2026-11-26）。
- [ ] **Step 3：任务集定版**：在服务器上执行 `build_taskset`，生成 `dev-v1`（40 个，种子 20261125，候选 60）。预检结果和金标准 blob 在这一步一起写进任务集文件（x86 上算出），不拆开。文件拉回本机提交；开发集规模写进实现说明（验收 1）。

### Task 16：开发集基线与报告（验收 6，作者补 4）

- [ ] **Step 1：Qwen 组**：报价经作者同意后，在服务器上跑 `dev-v1` 40 题 × 3 次（`eval/configs/qwen3.6.yaml`，设 `--budget`）。
- [ ] **Step 2：对账**（作者补 2，必须在 Kimi 组之前）：作者在百炼控制台查 Qwen 组期间的实际账单，与 `actual_cost` 对比，差异与原因（缓存折扣、推理 token 计价等）写进报告；差异超过 10% 时先修正计费口径，再给 Kimi 组报价。
- [ ] **Step 3：Kimi 组**：报价经作者同意后，跑 `dev-v1` 40 题 × 2 次（`eval/configs/kimi-k2.6.yaml`，设 `--budget`），跑完同样对账。
- [ ] **Step 4：写报告** `docs/evals/<日期>-T2-baseline.md`（模版 `docs/templates/eval.md`），内容包括：
  - 两组的成功率（均值、样本标准差、bootstrap 区间）、token、轮数、耗时、失败类型（含 `rate_limited`）、排除清单、评测状态（完整 / 未完成 / 无效）、花费与对账结果；
  - 工具调用出错率：只计调用层面的错误，即参数校验失败、未知工具、edit 找不到原文；bash 非零退出和策略拦截各自单列；
  - 注明：主模型按 ADR 017 直接选定，没有经过选型；Kimi K2.6 经百炼托管调用，与 Moonshot 官方端点是否完全一致未核实；Kimi 只跑 2 次，两组重复次数不同；开发集分数可能偏高；T2 没有留出集数字，留出集重新启用后要重跑本基线（tasks.md T2 验收 1）；本地模型基线在 T13；
  - 写明任务集版本、配置 hash、运行包版本、镜像 digest 与运行快照的核对结果。
- [ ] **Step 5：提交** `docs(step02): 开发集基线报告`。

### Task 17：收尾关卡

按 `docs/workflow.md` 3.4 依次通过：整体代码审查；验收 1–10 逐条核对，核对表写进实现说明；实现说明的「验证记录」与「与计划的偏差」；收尾一致性检查（4.6）；project-logger 生成 `docs/project-log/step02-eval-framework.md`，作者先读；讲解自测；作者同意后，才在 tasks.md 标 `[x]`。合并回 main 需作者同意。
