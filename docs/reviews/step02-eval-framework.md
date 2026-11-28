# 实现说明：T2 评测框架 v1 与基线

- **任务**：tasks.md T2
- **计划**：plans/2026-11-25-T2-eval-framework.md
- **代码版本**：分支 step-02-eval，基于 commit 67e9d8d（T2-0 只写本文档，无代码改动）
- **依据的规范版本**：commit 67e9d8d

> 记录"实际发生了什么"。完成后不修改正文，后续变化只在开头追加说明。本文目前只有「0. 开工核实」，其余章节在后续任务收尾时补写。

> 更正（追加）：0.8 及之后依据规范 c815ffc（ADR 017）。

## 0. 开工核实（2026-11-25，T2-0）

`<S>` = `/private/tmp/claude-501/-Users-chenjieming-Desktop-coding-agent/6d9b209b-b45a-4fac-b58e-ee4f74986389/scratchpad/t2-0`。只在 scratch 中实验，没有改动任何受控文件。密钥只通过 `node --env-file=<绝对路径>/.env` 注入探测进程，没有打印或写入；每次探测末尾扫描输出目录，均为 `clean`。

### 0.1 留出集（Step 1）

| 来源 | 结果 |
|---|---|
| 控制者 2026-11-25 经 HF datasets-server 查询 | SWE-bench-Live `full` 共 1888 行，`created_at ≥ 2025-09-01` 为 3 行，`≥ 2025-10-01` 为 0 行；`nebius/SWE-rebench-leaderboard` 月度划分到 `2026_03` 止（2026_01: 48、2026_02: 57、2026_03: 110） |
| 本机 `huggingface.co` 主站 | `curl -m 15 https://huggingface.co` 返回 000（连不上）；控制者的 python urllib 也是 UNEXPECTED_EOF。主站不可达，但 `datasets` 库能加载数据（见下），所以没能用主站页面交叉核对，只用了 `datasets` 这条路径 |
| `datasets` 5.2.0 直接加载 SWE-bench-Live `full` | `rows 1888`，最大 `created_at` 为 `2025-09-02 09:55:04`，`≥2025-09-01: 3`，`≥2025-10-01: 0`。与 datasets-server 一致 |
| `datasets.get_dataset_split_names("nebius/SWE-rebench-leaderboard")` | 共 16 个划分，末尾 `2025_10 … 2026_03`；`2026_01: 48`、`2026_02: 57`、`2026_03: 110`，与 datasets-server 一致 |

结论：没有变化。2026-06 之后没有划分，所以没有 ≥ 30 条的较新 Python 留出题；与计划的「留出集暂缓」决定一致，没有触发停下条件。

### 0.2 Python 与 swebench（Step 2）

- `/usr/local/bin/python3.13 -m venv <S>/venv`，`pip install swebench datasets`：**swebench 5.0.2**、datasets 5.2.0、docker 7.2.0。
- 实际导入路径（后续 Task 以此为准，和计划里的猜测有出入）：

| 名称 | 实测导入路径 |
|---|---|
| `make_test_spec` | `swebench.harness.utils`（**没有** `swebench.harness.test_spec` 模块） |
| `get_eval_report` | `swebench.harness.grading`，签名 `(test_spec, prediction, test_log_path, include_tests_status) -> dict` |
| `GIT_APPLY_CMDS` | `swebench.harness.run_evaluation`（**不在** `constants`），值 `['git apply --verbose', 'git apply --verbose --3way', 'git apply --verbose --reject', 'patch --batch --forward --fuzz=5 -p1 -i']` |
| `exec_run_with_timeout` | `swebench.harness.docker_utils`（**没有** `docker_build` 模块），签名 `(container, cmd, timeout=60)` |
| `TestSpec` | `swebench.types`；字段含 `instance_id, repo, version, image, eval_script, eval_script_list, log_parser, eval_type, FAIL_TO_PASS, PASS_TO_PASS, image_assets` |

- `SWE-bench/SWE-bench_Verified`（`test` 划分）：**500 条**；revision sha `78f471bf655a3137b2e8a75af1501690ec009ec3`（`HfApi().dataset_info(...).sha`）。列：`base_commit, created_at, difficulty, environment_setup_commit, eval_type, image, instance_id, log_parser, repo, version, patch, test_patch, eval_script, problem_statement, hints_text, FAIL_TO_PASS, PASS_TO_PASS`。已确认带 `image`、`eval_script`、`log_parser`、`eval_type`。
- 仓库分布：django 231、sympy 75、sphinx 44、matplotlib 34、scikit-learn 32、astropy 22、xarray 22、pytest 19、pylint 10、requests 8、seaborn 2、flask 1。
- 数据集里的 `image` 字段是 x86_64 名称，如 `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest`，`eval_type=pass_and_fail`，`log_parser=parse_log_astropy`。

### 0.3 镜像（Step 3）

选定 3 个实例：`psf__requests-2317`、`astropy__astropy-12907`、`django__django-11099`（同一天核实）。

| 项 | 结果 |
|---|---|
| 命名规则 | `<namespace>/sweb.eval.<arch>.<org>_1776_<repo>-<num>:latest`；实例 id 里的 `__` 换成 `_1776_`。x86 为 `swebench/sweb.eval.x86_64.…` |
| x86 能否解析 | `docker manifest inspect swebench/sweb.eval.x86_64.django_1776_django-11099:latest` 成功，是 OCI index，含 amd64 加一个 unknown/unknown 条目 |
| arm64（`swebench` 命名空间） | `swebench/sweb.eval.arm64.psf_1776_requests-2317` 和 `…astropy_1776_astropy-12907` 能解析并拉取；**`…arm64.django_1776_django-11099` 返回 denied（不存在）**。所以不是每个实例都有 `swebench` 的 arm64 镜像 |
| arm64（Epoch AI） | `ghcr.io/epoch-research/swe-bench.eval.arm64.django__django-11099:latest` 可拉取。Epoch 命名用 `swe-bench.eval.<arch>.<instance_id>`（保留 `__`，不用 `_1776_`） |
| 已拉取镜像（保留，后续任务复用） | `swebench/sweb.eval.arm64.psf_1776_requests-2317:latest` 2.9GB；`swebench/sweb.eval.arm64.astropy_1776_astropy-12907:latest` 3.44GB；`ghcr.io/epoch-research/swe-bench.eval.arm64.django__django-11099:latest` 3.05GB。另有 `node:24-slim` 352MB、`curlimages/curl:latest` 38.1MB（辅助）。拉取前可用空间 41GiB，拉取后 26GiB（高于 20GB 下限） |
| `Env` | 三个镜像的 `PATH=/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`，`TZ=Etc/UTC`（Epoch 另有 `PIP_NO_CACHE_DIR=0`）。`WorkingDir=/testbed`，`Cmd=["/bin/bash"]`，`Entrypoint=null`，用户 root（uid 0） |
| testbed 激活方式 | `PATH` 里只有 base 环境，`which python` 在不激活时是 `/opt/miniconda3/bin/python`。`/root/.bashrc` 末尾有 `source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed`，只对交互式 bash 生效；非交互的 `bash -c` 要自己执行 `source /opt/miniconda3/bin/activate && conda activate testbed`。`/opt/miniconda3/envs` 下只有 `testbed`（requests 的是 Python 3.9.21） |
| `/testbed` git：swebench 镜像 | HEAD 是一个额外提交 `SWE-bench`（2025-04-19，requests 为 `213dc320`，astropy 为 `b07e92416e`），reflog：`commit: SWE-bench` ← `reset: moving to <base_commit>` ← `clone`；分支只有 `main`；stash 为空；工作区干净。**标签：requests 154、astropy 168**。 |
| `/testbed` git：Epoch django | HEAD 就是 base commit `d26b242443`（2019-03-20，无额外提交）；reflog：`reset: moving to d26b…` ← `clone`；分支只有 `main`；stash 为空；标签 422 |
| 未来提交泄漏风险 | 仓库不是浅克隆，包含 base commit 之后的历史和标签：requests `git rev-list --all` 6299 条，而 `HEAD` 祖先只有 3690 条；`v2.9.0 … v2.9.2` 等较新标签在库里（`git tag --contains HEAD` 为 0，标签不指向 HEAD 的后代链上但仍可 `git log --all` 看到）；astropy 45556 对 32967；django 48985 对 26747。agent 若执行 `git log --all` 或 `git show <tag>` 可能读到修复提交。**后续任务需要决定是否在跑之前清理（例如删除标签并 `gc`），或在工具策略里禁用**，这属于计划要处理的问题，在此只记录事实 |

### 0.4 运行包可行性（Step 4）

- 在 scratch 复制（`git archive HEAD`，随后 `git init` 以复现 `.gitignore` 生效的环境）里 `pnpm install --frozen-lockfile && pnpm -r build`，再执行 `pnpm --filter @forgepilot/engine-runner deploy --legacy --prod <S>/out2-engine-runner` 和 engine-client 的同样命令。
- **两个包的 `dist/` 都在**：runner 24 个文件（含 `main.js`），client 8 个文件；`node_modules/@forgepilot/engine-protocol` 是符号链接，其 `dist/` 6 个文件。即使根 `.gitignore` 有 `dist/`（`git check-ignore` 确认命中），`pnpm deploy` 仍带上了 `dist/`，**不需要给包加 `files` 字段**。前提是先构建过（`pnpm -r build`）；deploy 本身不会构建。runner 目录 159MB，client 5.3MB。
- 官方发行包：node v24.15.0 `node-v24.15.0-linux-arm64.tar.xz`（sha256 `f3d5a797…dda0`，与 `SHASUMS256.txt` 一致）、ripgrep 16.0.0 `aarch64-unknown-linux-gnu`（sha256 `0b0bddcf…4740`）、fd v10.5.2 `aarch64-unknown-linux-gnu`（sha256 `4b144f38…dba6`）。ripgrep、fd 的校验值是下载后计算的，没有和发布页的校验文件比对。
- 在 `swebench/sweb.eval.arm64.psf_1776_requests-2317:latest` 里只读挂载 `<S>/bundle:/fp:ro`，PATH 为 `/fp/node/bin:/fp/bin:/opt/miniconda3/bin:…`，`bash -c 'source /opt/miniconda3/bin/activate && conda activate testbed; …'`：

```
python=/opt/miniconda3/envs/testbed/bin/python
v24.15.0
ripgrep 16.0.0 (rev 669cb4c755)
fd 10.5.2
runner: --models is required
exit=2
```

通过。注意：激活 conda 后 `PATH` 前面会多出 conda 环境目录，node/rg/fd 仍由 `/fp` 提供，因为 conda 环境里没有这三个。

### 0.5 网络（Step 5）

`docker network create --internal fp-probe`（`Internal=true`）。`curlimages/curl` 容器只接 `fp-probe`：

| 访问 | 结果 |
|---|---|
| `https://github.com` | curl exit 6（解析不了主机名）→ 失败，符合要求 |
| `http://host.docker.internal:80` | curl exit 6（解析不了）→ 失败，符合要求（作者补 2）。对照：默认 bridge 网络里能解析（exit 非 6，只是端口没服务） |
| `http://1.1.1.1` | curl exit 7（连不上），说明裸 IP 也出不去 |
| `https://dashscope.aliyuncs.com` | curl exit 6 → 失败 |
| 双网络容器（`fp-b`，`node:24-slim`，同时接 `fp-probe` 与另一个普通 bridge 网络）→ `https://dashscope.aliyuncs.com` | fetch 得到 HTTP 404（根路径无内容，说明已连通） |
| internal 网络里的容器 → `http://fp-b:8080` | 返回 `hello-from-fp-b`，curl exit 0（按容器名访问成功） |

探测容器、`fp-b` 和两个网络都已删除（`docker ps -a` 为空）。

### 0.6 模型（Step 6）

密钥：`DASHSCOPE_API_KEY` present；`MOONSHOT_API_KEY` **absent**。

百炼模型列表（北京端点，免费 GET）：状态 200，191 个模型。含 `qwen3.6-35b-a3b`、`qwen3.6-27b`、`qwen3.6-flash`、`qwen3.6-plus`、`kimi-k2.6`、`kimi/kimi-k2.6`、`kimi-k2.5`、`kimi-k2.7-code`、`kimi-k3`、`kimi-k3.1-pro`、`qwen3-coder-flash`；**没有 `qwen3-coder-next`**。

探测：每个模型一个短请求（pi 1.5.1，读一个文件的 `read` 工具调用，加最终回答），经记录代理；脚本见附录 A。

| 模型 | 结果 |
|---|---|
| `qwen3.6-35b-a3b`，`thinkingLevel: low` | 2 个请求都 200，最终回答 `Pelican`。pi 发出 `enable_thinking: true`、`thinking_budget: 2048`、`max_completion_tokens: 8192`，不发 temperature 等采样参数（服务端默认；百炼页面没有列出这个模型的默认采样值，未核实） |
| 同上，加 `enable_search: true`（代理注入） | 2 个请求都 200，回答 `pelican`，无错误：**该参数被接受**（只证明不报错，没有核实是否真的触发联网搜索） |
| `qwen3-coder-next`，`off` | 404 `{"message":"Model not exist.","code":"model_not_found"}`。**本 key 在百炼北京端点上不可用**，与 T1 0C 的结论一致，仍然不可用 |
| `kimi-k2.6`（经百炼，不是 Moonshot 官方端点），`low` | 2 个请求都 200，回答 `pelican`。**补充信息，不替代 Moonshot 官方端点的核实** |
| Moonshot 官方端点的 `kimi-k2.6` | **未执行（缺 key）** |

用量口径（pi 报告值）：

| 模型 | 请求 | input | output | reasoning | cacheRead | totalTokens | 平台原始 `prompt_tokens`/`total_tokens` |
|---|---|---|---|---|---|---|---|
| qwen3.6-35b-a3b | 1 | 1233 | 57 | 28 | 0 | 1290 | 1233 / 1290 |
| qwen3.6-35b-a3b | 2 | 1319 | 33 | 27 | 0 | 1352 | 1319 / 1352 |
| kimi-k2.6（百炼） | 1 | 896 | 100 | 83 | 0 | 996 | 896 / 996 |
| kimi-k2.6（百炼） | 2 | 259 | 37 | 35 | 768 | 1064 | 1027（其中 cached 768）/ 1064 |

结论：`reasoning ≤ output` 在 4 个请求中都成立；无缓存命中时 `totalTokens == input + output`。**有缓存命中时 pi 的 `input` 是 `prompt_tokens − cached_tokens`，`totalTokens = input + cacheRead + output`**（kimi 第 2 个请求：259 + 768 + 37 = 1064）。所以计划中「`totalTokens` 是否等于 `input + output`」只在无缓存命中时成立。计 token 数时应使用 `input + cacheRead + output`（或直接用 `totalTokens`），不能只加 `input + output`。这个差异来自 Qwen3.6 请求没有命中缓存（百炼页面对 qwen3.6-35b-a3b 标注不支持上下文缓存），而 Kimi 命中了；两者的平台原始口径一致（`total = prompt + completion`，`reasoning` 含在 `completion` 里），不是 Kimi 与百炼的口径冲突。Moonshot 官方端点的口径没有测，仍是未知。

模型资料与价格（元/百万 token）：

| 项 | Qwen3.6-35B-A3B | Qwen3-Coder-Next | Kimi K2.6 |
|---|---|---|---|
| 模型 ID | 百炼 `qwen3.6-35b-a3b` | 百炼 `qwen3-coder-next` 文档里有这个 ID，但本 key 返回 404 | Moonshot 官方 `kimi-k2.6`；百炼 `kimi-k2.6`、`kimi/kimi-k2.6` |
| 价格（北京，输入 / 输出 / 缓存命中） | 1.8 / 10.8 / 不支持缓存（<https://help.aliyun.com/zh/model-studio/qwen3-6-35b-a3b>，与 `model-pricing` 页一致） | 未核实（`model-pricing` 页只找到 qwen3-coder-flash；第三方报价不一致，不采用） | 百炼 6.5 / 27 / 缓存价未列（<https://help.aliyun.com/zh/model-studio/model-pricing>）；Moonshot 官方价格表页面是空的，未核实 |
| 可用 | 可用 | 不可用（见上） | 经百炼可用；官方端点未测 |
| 思考级别 | pi 的 `off/low/…` 经 `enable_thinking` 加 `thinking_budget`（`low` 为 2048）；已测 `low` 和 T1 已测的 `off` | 官方模型卡为只有非思考模式（T1 记录） | 百炼：`enable_thinking`，默认 `false`；已测 `low`（开启思考） |
| 默认采样参数 | 未核实（页面未列） | 未核实 | 百炼页面：`top_p` 0.95，`temperature` 思考 1.0、非思考 0.6，`presence_penalty` 0.0 |
| 发布日期 | T1 记录模型卡引用年月 2026-04 | 未核实 | 未核实 |
| `enable_search` | 被接受（见上） | 未测（模型不可用） | 未测 |

Moonshot 官方文档（<https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart>、<https://platform.kimi.com/docs/pricing/chat-k26>）的信息：`kimi-k2.6` 已标注停用，**2026-10-31 起 K2 系列不再对新注册用户开放，预计 2026 年 12 月底全部下线**；页面没有给出 base URL、价格、发布日期（均「未核实」）。推荐迁移到 `kimi-k3.1-pro`、`kimi-k3`。这对 Kimi 作为基线模型有风险（见 0.7）。

### 0.7 关卡（Step 7）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 留出集：`datasets` 重新确认 SWE-bench-Live | 通过 | 1888 行，≥2025-10-01 为 0（0.1） |
| 2 | 留出集：rebench 划分到 2026_03 | 通过 | 16 个划分，末尾 2026_03（0.1） |
| 3 | HF 主站交叉核对 | 未执行 | 主站 curl 000；只用 `datasets` 路径，不算关卡失败 |
| 4 | venv + swebench 5.x | 通过 | swebench 5.0.2 |
| 5 | 四个符号的导入路径 | 通过 | 0.2 表（与计划猜测不同，后续任务以实测为准） |
| 6 | Verified 数据集与字段 | 通过 | 500 条、sha `78f471bf…`、含四个字段 |
| 7 | x86 镜像名可解析 | 通过 | `docker manifest inspect` 成功 |
| 8 | arm64 镜像可拉取 | 通过（有缺口） | 3 个实例都拉到，但 `django` 在 `swebench` 命名空间没有 arm64，只能用 Epoch |
| 9 | `/testbed` git 状态、Env、激活方式 | 通过 | 0.3；发现未来提交与标签仍在库里 |
| 10 | `pnpm deploy` 两个包的 `dist/` 都在 | 通过 | 不需要 `files` 字段（0.4） |
| 11 | 挂载运行包，conda 激活后 `--models is required` 非零退出，`which python` 指向 `envs/testbed` | 通过 | exit=2（0.4） |
| 12 | internal 网络：github、host.docker.internal 失败 | 通过 | curl exit 6 |
| 13 | 双网络容器访问 dashscope；internal 容器按容器名访问它 | 通过 | HTTP 404 可达；返回 `hello-from-fp-b` |
| 14 | Qwen key 存在 | 通过 | present |
| 15 | Qwen3.6-35B-A3B 工具调用探测与用量口径 | 通过 | 0.6 |
| 16 | `enable_search` 是否被接受 | 通过 | 200，无错误 |
| 17 | **Qwen3-Coder-Next 可用** | **不通过** | 模型列表没有，请求 404 `model_not_found` |
| 18 | Kimi K2.6（Moonshot 官方端点）探测与用量口径 | 未执行（缺 key） | `MOONSHOT_API_KEY` absent |
| 19 | Kimi K2.6 经百炼探测与用量口径 | 通过（补充） | 回答正确，`reasoning ≤ output`，口径见 0.6 |
| 20 | 价格与发布日期 | 部分未核实 | Qwen3.6、Kimi（百炼）价格有来源；Qwen3-Coder-Next、Kimi 官方价格和各发布日期未核实 |

**汇总：通过 15、不通过 1、未执行 2、未核实项见第 20 行。** 有不通过项，按 Step 7 不提交，向作者报告。

需要作者决定：
1. Qwen3-Coder-Next 在百炼上用本 key 调不通。选择：(a) 换到百炼上能用的编码模型（`qwen3-coder-flash`、`qwen3.6-plus` 等），(b) 用其他渠道（第三方网关或自部署），(c) 先去掉这个模型，只测 Qwen3.6 与 Kimi。建议 (c) 或 (a)，因为计划里 D7 对 Qwen3-Coder-Next 的设置（非思考、`off`）依赖它可用。
2. Kimi K2.6 已被 Moonshot 标注停用（K2 系列 2026 年 12 月底下线）。选择：(a) 经百炼调用 `kimi-k2.6`（本 key 可用，价格 6.5/27），(b) 换成 `kimi-k3.1-pro`/`kimi-k3`，(c) 补 `MOONSHOT_API_KEY` 并测官方端点（但新注册已关）。建议 (a) 或 (b)。
3. 镜像里保留了未来提交和标签（0.3），需要在后续任务里决定怎么处理。

### 0.8 作者决定（2026-11-25，追加）

依据 `docs/specs/decisions/017-main-model-without-selection.md`（规范提交 c815ffc），作者对 0.7 的两个阻塞作出决定：

1. T2 不做主模型选型：主模型直接用 Qwen3.6-35B-A3B，去掉 Qwen3-Coder-Next。tasks.md T2 验收 10 已改写。
2. Kimi K2.6 经百炼调用（`kimi-k2.6`，使用 `DASHSCOPE_API_KEY`）；T2 不使用 Moonshot 官方端点，不需要 `MOONSHOT_API_KEY`。

对 0.7 关卡表的补充说明（原表各行不改）：

- 第 17 项（Qwen3-Coder-Next 可用）：不适用（ADR 017，作者决定不做选型）。
- 第 18 项（Moonshot 官方端点 Kimi 探测）：不适用（ADR 017，经百炼调用，第 19 项百炼 `kimi-k2.6` 探测已通过）。
- 第 3 项（HF 主站交叉核对）：未执行（主站不可达），不阻塞（计划已接受 datasets-server 结果并写明索引可能滞后）。
- 第 20 项中 Qwen3-Coder-Next 与 Moonshot 官方价格：随上两项不适用；Kimi 价格采用百炼的 6.5 / 27 元。

**更新后的关卡结论：关卡通过（含 2 项不适用、1 项未执行但不阻塞）。**

### 0.8a 更正与重新判定（追加，T2-0 审查返修）

1. **结论以 0.8 为准**：0.8 的「关卡通过」取代 0.7 汇总行（通过 15 / 不通过 1 / 未执行 2）。0.7 表实际有 20 行，准确计数为：通过 16（第 1、2、4 至 16、19 项；汇总行的「15」没有把补充项第 19 项算进去）、不通过 1（第 17 项）、未执行 2（第 3、18 项）、部分未核实 1（第 20 项）。按 ADR 017，第 17、18 项不适用，第 3 项不阻塞。
2. **第 20 项重新判定**：价格与发布日期。价格：Qwen3.6 与百炼 Kimi 都有来源；Qwen3-Coder-Next 与 Moonshot 官方价格随 ADR 017 不适用。发布日期按「未核实」接受，不阻塞（留出集已暂缓，发布日期目前只用于以后重新启用留出集的条件）。
3. **更正 0.3「未来提交泄漏风险」一行**：该行中关于 `git tag --contains HEAD` 的句子自相矛盾，不作为证据。准确的证据是 `git rev-list --all | wc -l` 大于 `git rev-list HEAD | wc -l`，即有些提交从 HEAD 不可达，但仍可从其他引用（分支、标签、远端引用）到达：requests 6299 对 3690，astropy 45556 对 32967，django（Epoch）48985 对 26747。各实例的其他细节分开看：requests 与 astropy（swebench 镜像）HEAD 是额外提交 `SWE-bench`，标签 154 / 168；django（Epoch）HEAD 就是 base commit，标签 422。

### 0.9 交接给后续任务的事实

- arm64 镜像命名与回退：先试 `swebench/sweb.eval.arm64.<instance_id 中 __ 换成 _1776_>:latest`，不存在（denied）则回退到 `ghcr.io/epoch-research/swe-bench.eval.arm64.<instance_id>:latest`（保留 `__`）；`django__django-11099` 只在 Epoch 有。
- 数据集 `image` 字段只给 x86 名称（`swebench/sweb.eval.x86_64.…`），arm64 名称要自己推导。
- 本机已拉取的 3 个实例（requests-2317、astropy-12907、django-11099）是 smoke-v1 候选。
- 用量口径：有缓存命中时 `totalTokens = input + cacheRead + output`（`input` 已扣除缓存），无命中时等于 `input + output`；`reasoning` 含在 `output` 内（0.6）。
- swebench 5.0.2 的导入路径以 0.2 表为准，不要照计划里的猜测。
- Kimi 经百炼：`kimi-k2.6`，价格 6.5 / 27 元（输入 / 输出）。
- 已被取代：0.6 的 Qwen3-Coder-Next 列、Moonshot 官方各行、0.7 的「需要作者决定 1、2」已被 ADR 017 取代，下游只看 Qwen3.6 与百炼 Kimi；T2 不使用 `MOONSHOT_API_KEY`。

## 附录 A：Step 6 探测脚本全文（均在 `<S>/probe/` 下运行；`node_modules` 指向 runner 的依赖，pi 1.5.1）

`list-models.mjs`（最终版的匹配表达式改过两次，正文列出的 ID 来自两次不同的过滤）：

```js
// T2-0 Step 6: list models visible to DASHSCOPE_API_KEY (free GET). Prints status and matching ids only.
const key = process.env.DASHSCOPE_API_KEY;
if (!key) { console.log("DASHSCOPE_API_KEY missing"); process.exit(2); }
const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
const j = await r.json();
const ids = (j.data ?? []).map((m) => m.id);
console.log("status", r.status, "count", ids.length);
console.log("match:", ids.filter((i) => /next|coder|qwen3-/i.test(i)).join(", "));
```

`probe-model.mjs`：

```js
// T2-0 Step 6: one short pi request (one read tool call) against a Bailian-compatible model, via a logging proxy.
// usage: node --env-file=<abs .env> probe-model.mjs <modelId> <reasoning:true|false> <thinkingLevel> <outDir> [extraJson]
// extraJson (optional) = extra top-level request fields to inject at the proxy (e.g. {"enable_search":true}).
// Never prints header values or key; leak check at the end.
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

const [modelId, reasoningArg, level, outDir, extraJson] = process.argv.slice(2);
const reasoning = reasoningArg === "true";
const extra = extraJson ? JSON.parse(extraJson) : {};
mkdirSync(outDir, { recursive: true });
const UP = { origin: "https://dashscope.aliyuncs.com", basePath: "/compatible-mode/v1" };
const work = mkdtempSync(join(tmpdir(), "t20-"));
const repo = join(work, "repo"); mkdirSync(repo);
writeFileSync(join(repo, "hello.txt"), "ForgePilot probe sample file. The magic word is: pelican.\n");
const agentDir = join(work, "agent"); mkdirSync(agentDir);

const wire = [];
const DROP = new Set(["host", "connection", "content-length", "accept-encoding"]);
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", async () => {
    let bodyText = Buffer.concat(chunks).toString("utf8");
    const entry = { i: wire.length, path: req.url };
    try { const b = JSON.parse(bodyText); Object.assign(b, extra); bodyText = JSON.stringify(b); entry.requestBody = { ...b, messages: `[${b.messages?.length} msgs]`, tools: `[${b.tools?.length} tools]` }; } catch {}
    wire.push(entry);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
    try {
      const up = await fetch(UP.origin + req.url, { method: req.method, headers, body: bodyText });
      entry.status = up.status;
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
      let raw = ""; const dec = new TextDecoder();
      for await (const part of up.body) { raw += dec.decode(part, { stream: true }); res.write(part); }
      entry.responseRaw = raw.slice(-1500) + (raw.length > 1500 ? "" : "");
      entry.errorBody = up.status >= 400 ? raw.slice(0, 600) : undefined;
      res.end();
    } catch (e) { entry.proxyError = e.message; res.writeHead(502); res.end("{}"); }
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${proxy.address().port}${UP.basePath}`;

const models = { providers: { "qwen-api": { baseUrl: base, api: "openai-completions", apiKey: "$DASHSCOPE_API_KEY",
  compat: { thinkingFormat: "qwen", supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, thinkingTokenBudgetField: "thinking_budget" },
  models: [{ id: modelId, reasoning, input: ["text"], contextWindow: 262144, maxTokens: 8192 }] } } };
const modelsPath = join(agentDir, "models.json");
writeFileSync(modelsPath, JSON.stringify(models));
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
const model = modelRuntime.getModel("qwen-api", modelId);
if (!model) throw new Error("model not resolved");
const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }, { projectTrusted: false });
const loader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPrompt: [], extensionFactories: [] });
await loader.reload({ resolveProjectTrust: async () => false });
const { session } = await createAgentSession({ cwd: repo, agentDir, model, thinkingLevel: level, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(repo), tools: ["read"] });
await session.bindExtensions({});
const msgs = [];
session.subscribe((ev) => { if (ev.type === "message_end" && ev.message.role === "assistant") { const m = ev.message; msgs.push({ stopReason: m.stopReason, errorMessage: m.errorMessage, usage: m.usage, parts: (m.content ?? []).map((c) => c.type === "toolCall" ? { type: "toolCall", name: c.name } : c.type === "thinking" ? { type: "thinking", chars: (c.thinking ?? "").length } : { type: c.type }) }); } });
let outcome = "resolved";
try { await session.prompt("Use the read tool to read the file hello.txt in the current directory. Then reply with only the magic word it contains."); } catch (e) { outcome = `rejected: ${e.message}`; }
await new Promise((r) => setTimeout(r, 1000));
const result = { version: VERSION, modelId, reasoning, level, extra, outcome, finalText: session.getLastAssistantText(), msgs, wire };
session.dispose(); proxy.close();
const tag = `${modelId.replace(/[^\w.-]/g, "_")}-${level}${Object.keys(extra).length ? "-extra" : ""}`;
writeFileSync(join(outDir, `result-${tag}.json`), JSON.stringify(result, null, 2));
const key = process.env.DASHSCOPE_API_KEY ?? "";
let leak = false;
for (const f of readdirSync(outDir)) { const s = readFileSync(join(outDir, f), "utf8"); if ((key && s.includes(key)) || /Bearer\s+\S/.test(s)) leak = true; }
const u = msgs.map((m) => m.usage);
console.log(JSON.stringify({ modelId, level, outcome, statuses: wire.map((w) => w.status), finalText: result.finalText, stop: msgs.map((m) => m.stopReason), err: msgs.map((m) => m.errorMessage).filter(Boolean), errBody: wire.map((w) => w.errorBody).filter(Boolean), usage: u, reqKeys: Object.keys(wire[0]?.requestBody ?? {}), leakCheck: leak ? "LEAK" : "clean" }, null, 1));
process.exit(leak ? 3 : 0);
```

运行命令：

```
node --env-file=<abs>/.env probe-model.mjs qwen3.6-35b-a3b true low out
node --env-file=<abs>/.env probe-model.mjs qwen3.6-35b-a3b true off out '{"enable_search":true}'
node --env-file=<abs>/.env probe-model.mjs qwen3-coder-next false off out
node --env-file=<abs>/.env probe-model.mjs kimi-k2.6 true low out
```

## 附录 B：Step 1 至 5 探测命令与脚本

`probe_holdout.py`（`venv/bin/python -I`）：

```python
import datasets, sys
try:
    ds = datasets.load_dataset("SWE-bench-Live/SWE-bench-Live", split="full")
    ca = sorted(str(x) for x in ds["created_at"])
    print("rows", len(ds), "max created_at", ca[-1])
    print(">=2025-09-01:", sum(c>="2025-09-01" for c in ca), ">=2025-10-01:", sum(c>="2025-10-01" for c in ca))
except Exception as e:
    print("LOAD FAIL", type(e).__name__, str(e)[:300])
```

`probe_rebench.py`：

```python
import datasets
b = datasets.get_dataset_split_names("nebius/SWE-rebench-leaderboard")
print("splits tail:", b[-6:], "n", len(b))
for s in b[-3:]:
    d = datasets.load_dataset("nebius/SWE-rebench-leaderboard", split=s)
    print(s, len(d), "cols", [c for c in d.column_names if "date" in c or "created" in c])
```

`probe_swebench.py`：

```python
import importlib, collections, json
import swebench
print("swebench", getattr(swebench,"__version__",None))
for n in ["make_test_spec","get_eval_report","GIT_APPLY_CMDS","exec_run_with_timeout"]:
    found=[]
    for m in ["swebench.harness.test_spec.test_spec","swebench.harness.grading","swebench.harness.constants","swebench.harness.docker_build","swebench.harness.docker_utils","swebench.harness.run_evaluation","swebench.harness.utils","swebench.harness.test_spec"]:
        try:
            mod=importlib.import_module(m)
            if hasattr(mod,n): found.append(m)
        except Exception as e: found.append(f"{m}!{type(e).__name__}")
    print(n, found)
import datasets
ds = datasets.load_dataset("SWE-bench/SWE-bench_Verified", split="test")
print("rows", len(ds), "cols", ds.column_names)
print("revision", ds.info.download_checksums and "" or "", getattr(ds._info,"version",None))
c=collections.Counter(r.split("/")[0]+"/"+r.split("/")[1] if "/" in r else r for r in ds["repo"])
print(dict(c.most_common()))
r=ds[0]
print({k:(type(r[k]).__name__, (str(r[k])[:60])) for k in ["image","eval_script","log_parser","eval_type","instance_id"] if k in r})
```

镜像、运行包与网络（命令摘要）：

```bash
docker manifest inspect swebench/sweb.eval.x86_64.django_1776_django-11099:latest
docker manifest inspect swebench/sweb.eval.arm64.django_1776_django-11099:latest      # denied
docker pull swebench/sweb.eval.arm64.psf_1776_requests-2317:latest
docker pull swebench/sweb.eval.arm64.astropy_1776_astropy-12907:latest
docker pull ghcr.io/epoch-research/swe-bench.eval.arm64.django__django-11099:latest
docker run --rm $I bash -c 'cd /testbed && git log -1 && git tag | wc -l && git reflog | head -5 && git branch -a && git stash list && git rev-list --all | wc -l && git rev-list HEAD | wc -l'

# scratch 里的 repo 副本：git archive HEAD | tar -x; git init; pnpm install --frozen-lockfile; pnpm -r build
pnpm --filter @forgepilot/engine-runner deploy --legacy --prod <S>/out2-engine-runner
pnpm --filter @forgepilot/engine-client deploy --legacy --prod <S>/out2-engine-client
docker run --rm -v <S>/bundle:/fp:ro -e PATH=/fp/node/bin:/fp/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin $I \
  bash -c 'source /opt/miniconda3/bin/activate && conda activate testbed; which python; node --version; rg --version|head -1; fd --version; node /fp/runner/dist/main.js; echo exit=$?'

docker network create --internal fp-probe; docker network create fp-probe-out
docker run --rm --network fp-probe curlimages/curl -sS -m 8 -o /dev/null -w '%{http_code}' <url>      # github / host.docker.internal / 1.1.1.1 / dashscope
docker run -d --name fp-b --network fp-probe-out node:24-slim node -e "require('http').createServer((q,r)=>r.end('hello-from-fp-b')).listen(8080)"
docker network connect fp-probe fp-b
docker exec fp-b node -e "fetch('https://dashscope.aliyuncs.com').then(r=>console.log('status',r.status))"
docker run --rm --network fp-probe curlimages/curl -sS -m 8 http://fp-b:8080
docker rm -f fp-b; docker network rm fp-probe fp-probe-out
```

## 附录补注（追加）

- 附录 A `probe-model.mjs` 中 `entry.responseRaw = raw.slice(-1500) + (raw.length > 1500 ? "" : "");` 的三元表达式是空操作，且没有任何结论读取 `responseRaw` 之外的内容；脚本原文不改，它是实际运行内容的证据。
- 运行包的组装命令（把 node、rg、fd 解压到 `/fp`）没有保留；Task 6 会写进 `build-eval-bundle.sh`。

## 4. 与计划的偏差（追加，逐任务补写）

| 偏差 | 原因 | 谁决定的 | 影响 |
|---|---|---|---|
| T2-1：pi-engine「启动失败后清理也失败」不用计划写的 EPIPE 注入，改为在测试里 `vi.spyOn(coordinator, "cancelAll")` 抛 `CANCEL_BOOM`（`tests/integration/pi-engine.test.ts`「启动失败后清理也失败：reason 同时保留清理原因与原失败原因」，提交 4c0ba73）；只在测试里替换，没有加产品开关 | 启动失败时没有任何录制写入，EPIPE 与写满都造不出清理失败 | 作者（2026-11-25），附带条件：两个失败原因都断言、scratchDir 仍被删除、做变异检查、写进本节 | 被测的仍是同一条清理路径（`pi-engine.ts` 清理步骤逐个尽力执行、reason 拼接原失败原因）。条件核对（2026-11-25，新会话）：断言为 `^cleanup failed: CANCEL_BOOM; run failed: model not found: fake/nope$`，并断言 `scratchLeft()` 为空；变异检查三项均变红、恢复后变绿——去掉 cancelAll 抛错（promise resolved instead of rejecting）、reason 不拼接原失败原因（实际为 `cleanup failed: CANCEL_BOOM`）、清理遇第一个失败即停（残留 `fp-run-*` 目录） |

- 关闭竞态的同类写法已排查（2026-11-25，T2-1 修 raw-event-recorder close() 之后），发现 2 处，均延后到 Task 17：`packages/engine-client/src/engine-client.ts:50-51` 丢弃 ws `error` 事件的原因、只报随后的 `runner connection closed (code 1006)`——已复现（真实 ws 收非法帧：先 `Invalid WebSocket frame: RSV2 and RSV3 must be clear`，后 close 1006），Task 17 按此复现先写测试再修；`packages/engine-client/src/runner-launcher.ts:56-57` 在 `exit` 事件后即读 stderr（Node 文档称此时 stdio 可能未关）——未复现（macOS、Node 24.15，≤64 KB 各 300 次完整），Task 17 与 T2-4 延后的「退出时只等 stdout 不等 stderr」合并处理，并在 Linux 上再试。runner-server、stdio-bridge、t1 脚本无同类写法。

### WSL 下集成测试偶发超时（2026-11-25，追加）

**现象**：在 WSL2 Ubuntu 上跑 `tests/integration/runner-process.test.ts` 与 `t1-real-run.test.ts`，偶发失败。失败用例不固定，报的都是 vitest 的 `Test timed out in 20000ms`（t1-real-run 为 60000ms）；一次失败后，后面几条用例常常接着失败，报 `model not found: fake/fake-model`。

**诊断结论与证据要点**
- 根因是 WSL2 虚拟机整体卡顿，不是产品竞态。dmesg 有 `watchdog: BUG: soft lockup - CPU#0 stuck for 29s! [khugepaged:122]`，journal 里 systemd-resolved 的 `Clock change detected` 与卡顿时间吻合（虚拟机恢复后宿主同步时钟）。
- 原始失败全部是用例超时；`forced:true`、退出码、事件序列这类断言从没单独失败过。
- 连带失败的机制：vitest 判定超时后，超时用例的函数仍在后台运行，继续使用文件级共享变量（`root`、`groups`、`exits`、`p()` 等）。这时下一条用例的 beforeEach 已经把这些变量换成新目录，残留代码的 `launch()` 于是把自己的 models.json 写进新用例的 root，并把自己的 runner 记进新用例的进程列表，导致下一条用例 `model not found`。一次卡顿就这样连成一串失败。

**作者决定**：采用 A（调高用例超时）和 B（用例状态隔离）；未选 C（调大「启动被拒」用例的 `stopTimeoutMs=3000`）和 D（改 `.wslconfig`）。

**改了什么**（只改测试，不改产品代码、契约和断言里的时间值）
- `tests/integration/runner-process.test.ts`
  - 超时：普通用例改为 `T = 60_000`，原为 20s；`--thinking low` 和缺 rg 两条原为 30s，也按普通用例改为 60s。FIFO 类三条（无读端 FIFO、等待打开时取消、清理超时且 runner 卡在退出）改为 `T_FIFO = 90_000`，原为 30s。`stopTimeoutMs`、`DISCONNECT_EXIT_MS`、`exit.at - …` 等断言与产品时限不变。
  - 隔离：删除文件级的 `root/servers/clients/groups/exits/p` 和 `beforeEach/afterEach`，改为 `setup()` 工厂，每条用例开头调用一次（`const { p, launch, ... } = setup();`）。工厂内创建本用例的临时目录和进程列表；`launch/connect/scratchLeft/neverRan/toolRunning/toolGone` 通过闭包使用本用例的这一份；清理用 `onTestFinished` 注册，和原 afterEach 一样，先杀进程组、等 runner 退出，再关客户端和服务、删目录。另加一个守卫：用例结束后，残留代码再调 `launch()` 会关掉刚起的假服务并抛错，不再起 runner。用例数（28 个定义、展开后 42 条）、名字和断言行都没变：`git diff` 中删除的 `expect` 行只有移进 `setup()` 的辅助函数，它们重新缩进后原样出现。
- `tests/integration/t1-real-run.test.ts`：五条 60s 用例改为 120s，其余不变。

**隔离有效性检查**（在 `.tmp/iso/` 下做，不进仓库）：分别取重构前（`git show HEAD:`）和重构后的文件副本，各追加两条用例。ghost 的超时设为 300ms，函数在超时后继续运行，1 秒后调用 `launch()`；紧接着的 victim 等 2.5 秒，再断言自己 root 下没有 `model/models.json`、`groups` 为空。重构前：ghost 超时，victim 失败（`expected true to be false`，models.json 出现在 victim 的目录里），复现了连带失败。重构后：ghost 超时，victim 通过，且没有遗留 runner 进程。

**验证结果**（2026-11-25 22:21–22:51，WSL2 Ubuntu）
- `pnpm vitest run tests/integration/runner-process.test.ts` 连跑 5 次：第 1、2、4 次 42/42 通过；第 3、5 次各失败 1 条，都没有连带失败（41/42）。
  - 第 3 次：`--tools "-bash"` 超时（63.4s，平时约 1.4s）。journal 在 22:28:29 和 22:28:39 有 `Clock change detected`，与这条用例的时间吻合，判断为又一次虚拟机卡顿。
  - 第 5 次：「启动被拒…stop() 不强杀」得到 `forced: true, code: null`，用时 25.0s，其他 13 次都在 5.7–6.1s。这正是下面的残余风险；这一段 journal 和 dmesg 没有记录，无法直接证明是卡顿。
- `pnpm test` 全量连跑 3 次：第 2、3 次 540/540 通过；第 1 次失败 1 条（539/540）：「清理超时且 runner 卡在退出」的 `expect(stopped.at - t0).toBeLessThan(10_000 + 1000)` 实测 13667ms，单跑时这条用例总用时 11.6–11.8s。属于时间断言在全量并行负载或卡顿下超限，不是用例超时，也没有连带；这段时间同样没有 journal 或 dmesg 记录。
- 「负载 + 并发」2 轮（后台全量 `pnpm test`，同时串行跑 2 次 runner-process）：4 次 runner-process 均为 42/42，2 次全量均为 540/540。
- `pnpm typecheck`：通过（rc=0）。
- 本轮 dmesg 没有新的 soft lockup，最近一条在 21:56:58。

**残余风险**
- 「启动被拒」那条的 `stopTimeoutMs=3000` 没有调（作者未选 C），卡顿超过约 3 秒时仍可能得到 `forced:true`，本轮复现了 1 次。
- 断言里的时间界限（如上面的 `stopped.at - t0 < 11000`）在长卡顿或重负载下仍可能超限。调高用例超时对这类失败无效；按约定不放宽断言。
- 卡顿超过 60s（FIFO 类超过 90s、t1 超过 120s）时仍会超时，但隔离后只影响这一条用例。

### 与计划的偏差（续，按 workflow 3.3 新格式，2026-11-25 追加）

T2-6 至 T2-9 由协作者在 Windows + WSL2 x86 上完成并直接推送；以下偏差在 2026-11-25 补审时整理。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| T2-6：fd 没有官方校验文件，改用 GitHub release API 附件的 `digest` 字段 | 协作者 | 计划要求官方校验文件，fd 项目未发布 | 审查员 2026-11-25 核对脚本值与 API digest 逐位一致；计划原写「aarch64 值与 T2-0 自算值一致」不成立（T2-0 缩写 `4b144f38…dba6` 与脚本 `…efba6dd` 尾部不符），已在计划更正 | 作者 2026-11-25 确认（本会话，条件：记录写明协作者提议、审查员核对、作者确认） |
| T2-9：`git fsck` 加 `--connectivity-only` | 协作者 | 加快自检 | 审查员 2026-11-25 实测仍会列出不可达 blob，不削弱泄漏检测 | 作者 2026-11-25 确认（本会话） |
| T2-9：`truncate_history` 增加 `probe_blobs` 参数，截断后一并自检 | 协作者 | 调用方不必再单独调 `verify_truncated` | 计划接口没有该参数；默认空时不传也不报错，Task 12 可能漏传 | 作者 2026-11-25 确认（本会话），条件：改为必填或补测试；计划 Task 9 接口与 Task 12 流程已同步为必填 |
| T2-8：代理镜像固定为 `node:24-slim@sha256:873f586f…b6b34530` | 协作者 | 计划写「Task 0 记录的 digest」，但 Task 0 没记录 | 见下方 T2-0 补记 | **待作者确认** |
| P1：Task 6 起改在 WSL2 x86 上开发，用 uv 取得 Python 3.13 | 协作者 | 协作者用 Windows；WSL 无 sudo | 计划「平台变更 P1」；与 D9「不装 uv」、tasks.md 验收 9「Mac 上能跑少量冒烟任务」字面不一致 | **待作者确认**（作者要求单独讨论） |

### T2-0 补记：代理镜像 digest（2026-11-25 追加）

T2-0 的网络探测（0.5）用的是不带 digest 的 `node:24-slim`，当时没有记录 digest。2026-11-25 用 `docker buildx imagetools inspect` 核对 T2-8 固定的 `sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530`：它是 Docker Hub 官方 `docker.io/library/node:24-slim` 的多架构索引（OCI image index），含 `linux/amd64` 与 `linux/arm64/v8`；核对时 `node:24-slim` 标签当前也指向这个 digest。

- 更正（追加）：上表 P1 一行与代理镜像 digest 一行的确认结果——P1 作者 2026-11-25 修订后确认：D9 改为两边统一 Python 3.13.18（Mac 升级 `/usr/local/bin/python3.13`，WSL 无 sudo 时用 uv 取得解释器，报告记录实际版本）；验收 9 不变，Mac 仍为必需环境、WSL2 x86 为第二个开发环境；协作者机器上用作者单独创建、带额度上限、可吊销的 key。代理镜像 digest 已核对（见 T2-0 补记），仍待作者确认。
- 更正（追加）：代理镜像 `node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530` 作者 2026-11-25 确认（本会话）。
- 更正（追加）：D9 由「两边统一 3.13.18」改为「Python 3.13，补丁版本不限，评测报告记录实际版本」——作者 2026-11-25 确认（本会话）。理由：3.13.18 起 python.org 只提供源码包、没有 macOS 安装包；评测框架只用标准库与锁定版本的 pytest，agent 在 SWE-bench 镜像内运行，补丁版本差异不影响评测结果。现状：Mac 3.13.1，WSL 3.13.18。

### 与计划的偏差（续，2026-11-26 追加：T2-6~T2-9 返修第 1 轮）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| T2-8：普通 docker 命令默认时限 600 秒 → 60 秒；`cleanup_run` 批量删除另用 300 秒，删容器失败仍继续删网络 | 返修实现者（60 秒）；控制会话（`cleanup_run` 单独放宽） | docker 卡住时更快发现；批量删除在高负载下可能超过 60 秒 | 复审（t2-6to9-rereview-1）：受影响的是 ps、network、cp、代理启动、logs/inspect、`cleanup_run`；`docker exec`、run（1800 秒）、create（600 秒）不受影响 | 作者 2026-11-26 确认（本会话） |
| T2-8：新增计划接口外的 `ensure_egress_network(run)`、`Sandbox.name` 与三个超时常量 | 返修实现者 | 实现代理专用出网网络（计划 Task 8 已改）所需 | 复审判定只影响写法：RUN、READY 两个常量与原值相同，RM 是清单第 5 项要求的短时限 | **待作者确认** |
| 计划 Task 13 第 7 步：任何结束方式都在 `finally` 里清理，启动时清扫遗留资源 | 复审员发现、作者给出要求 | 原文只在 Ctrl-C 与异常时清理，正常结束会残留代理容器与网络 | 复审 t2-6to9-rereview-1 | 作者 2026-11-26（本会话，原话已写入计划） |
- 更正（追加）：上表「新增计划接口外的 `ensure_egress_network(run)`、`Sandbox.name` 与三个超时常量」一行，作者 2026-11-26 确认（本会话，原话「认可」）。

### 与计划的偏差（续，2026-11-26 追加：T2-10）

对照基准：swebench 5.0.2 的 `run_instance`。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 评分容器不加 `SYS_ADMIN`（官方会加） | 实现者 | 评分容器运行 agent 写的代码，加了会放宽隔离；Verified 用不到 | 审查员对照 5.0.2 源码；条件：定版任务集的每个实例金标准运行（不加 `SYS_ADMIN`）FAIL_TO_PASS 必须全部通过，结果在 Task 11/15 预检后追加到本表 | 作者 2026-11-26（本会话，附条件） |
| 不还原 `image_assets` | 实现者 | 只有 Multimodal 数据集用到，T2 只用 Verified | 条件：实例的 `image_assets` 不为空时直接报错，不静默跳过（返修实现） | 作者 2026-11-26（本会话，附条件） |
| 按架构换镜像由调用方负责，`grade` 直接用传入实例的 `image` | 实现者 | 数据集 `image` 为 x86 名，Mac 冒烟要换 arm64 | 条件：`grade` 结果记录镜像名、digest、架构；正式评测拒绝非 amd64 的结果，arm64 只用于冒烟（计划 Task 10/12/13 已写入） | 作者 2026-11-26（本会话，附条件） |
| `grade` 增加必填参数 `run`，返回 `GradeResult` | 审查员（Important：缺省标签 `fp-run=grade` 使 `cleanup_run` 清不到） | 保证所有容器带本次运行名标签 | task-10-review.md | 作者 2026-11-26（本会话） |
| swebench infra_failure 与 docker/容器出错归为 `infra_error`（官方留在分母） | 审查员提出、控制会话建议 | 断网或容器坏掉不应算模型失败、悄悄拉低成功率 | task-10-review.md；报告需注明与官方算法不同 | 作者 2026-11-26（本会话） |
- 更正（追加）：T2-6 至 T2-10 返修后的 WSL x86 复验取消——作者 2026-11-26 确认（本会话，原话「在我这跑通就可以了」）。现状：Mac arm64 上 Python 全量 127 passed（T2-10 后）、TS 541/541（T2-6~9 返修后）；`linux-x64` 运行包的 GNU tar 解压写法与 x86 镜像用例在返修后未执行，首次验证在 Task 15 Step 2。

### 冷烟候选镜像 digest（2026-11-26 追加，T2-11 前）

按 design 3.11「每个平台只用一个来源、按 digest 锁定」（作者 2026-11-26）。2026-11-26 用 `docker buildx imagetools inspect` 取得：

| 实例 | Mac arm64（Epoch `ghcr.io/epoch-research/swe-bench.eval.arm64.<id>`） | x86（官方 `swebench/sweb.eval.x86_64.<id 中 __→_1776_>`） |
|---|---|---|
| `psf__requests-2317` | `sha256:dacf1300f00c585d18f5cbcd331777825b5437f682c1a846b2fd90606e1b570b`（压缩后约 0.7 GB） | `sha256:c6b5c8846507b5e48e307decca28dbdfa4f5ef17070c1087aacde765e8c4b178` |
| `astropy__astropy-12907` | `sha256:fbbd240e3fee2881c98d74895bd614e5252e714bd6ab741c1c440c048304f750`（约 0.9 GB） | `sha256:e082963099ed7d5a5f75a0be46e338be36faae33b2cba5289a9ddbd505997f1f` |
| `django__django-11099` | `sha256:9312a779b863a5c97cf7c473987bab8293bc702dbe44e637e983604d21f82717`（约 0.96 GB） | `sha256:cca302934edd881cc4f1e4647a389a25cdaa3c02bfa33667a4204934a09c4fb1` |

官方 arm64 缺 `django__django-11099`（denied），所以 Mac 统一用 Epoch。T2-0 用过的官方 arm64 镜像（requests、astropy）不再用于冷烟。

### 与计划的偏差（续，2026-11-26 追加：T2-11）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| smoke-v1 由 2 个实例改为 1 个（astropy-12907） | 作者 | 3 个候选只有 astropy 通过入选标准 | Epoch arm64 预检（种子 20261126）：astropy 四项通过、金标准 62 秒；django-11099 空补丁时 F2P 的 `test_help_text (…UserAttributeSimilarityValidatorTest)` 通过，不满足标准 (2)；requests-2317 金标准 F2P 7/8、空补丁 6/8，测试连 httpbin.org 等外部服务（SSL 证书错误、连接断开）——详见 task-11-report | 作者 2026-11-26（本会话） |
| Mac 镜像来源由 Epoch 改为官方 arm64 | 控制会话发现、作者决定 | Epoch astropy 镜像启动时 `pyproject.toml` 有未提交改动；官方 arm64 把它提交在 HEAD 的「SWE-bench」提交里，工作区干净 | 控制会话 2026-11-26 两镜像 `git status --porcelain` 对比；官方 arm64 astropy digest `sha256:6373496b634a2e95077bfa3407ea8d334fd3520439832f003a0d631ab8a0d348` | 作者 2026-11-26（本会话） |
| 容器启动时工作区不干净就报错（`resolve_effective_base`） | 实现者发现风险、作者决定 | 镜像原有未提交改动会混进 agent 补丁，评分时可能打不上 | task-11-report | 作者 2026-11-26（本会话） |
| Step 4b 的 x86 预检实例由 requests-2317 改为冷烟集里最小的实例 | 实现者建议、作者决定 | requests 依赖外网且已不在冷烟集 | 同上 | 作者 2026-11-26（本会话） |
| 新增计划接口外的 `image_refs`、`local_platform`、`_ensure_image`、`_node_version`；`precheck` 的 `max_gold_s`；任务集 `images` 字段与 `selection` 两个字段 | 实现者 | 实现按平台选镜像、digest 锁定与 10 分钟上限 | task-11-report | 作者 2026-11-26（本会话，原话「认可」） |
| 修 T2-9 `gold_probe_blobs` 两个 bug：`repo` 与数据集字段撞名改读 `repo_path`；以打补丁前的工作区为基准取探针 | 实现者 | 规范正确、实现有误（workflow 3.3 可自行修，先写复现测试） | e2e965c 中的复现测试 | 不需确认（workflow 3.3） |

### smoke-v1 预检结果（2026-11-26 追加，T2-11）

平台 Mac arm64（Docker Desktop），运行包 `bundle-linux-arm64`（node 24.15.0），种子 20261126。生成命令为 `build_taskset("smoke", 1, [astropy 行], 1, 20261126, bundle, eval/tasksets/smoke-v1.json)`，用时 113 秒，只尝试 1 次，没有 infra_error。任务集文件 sha256 为 `7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`。

| 项 | `astropy__astropy-12907` |
|---|---|
| Mac 评分镜像 | `swebench/sweb.eval.arm64.astropy_1776_astropy-12907@sha256:6373496b634a2e95077bfa3407ea8d334fd3520439832f003a0d631ab8a0d348`（arm64；`grade` 回读的 digest 相同） |
| x86 镜像（写入任务集，未在本机运行） | `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:e082963099ed7d5a5f75a0be46e338be36faae33b2cba5289a9ddbd505997f1f` |
| (1) 金标准补丁 → `resolved` | 通过：F2P 2/2、P2P 13/13 |
| (2) 空补丁时 F2P 每一条都失败 | 通过：F2P 0/2 通过（2 条都失败），P2P 13/13，结果 `unresolved` |
| (3) 挂载运行包后 `node --version` | 通过：`v24.15.0` |
| (4) 金标准评分墙钟 ≤ 600 秒 | 通过：49.0 秒（测试 48.2 秒）；空补丁评分的测试 51.2 秒 |
| 容器启动时工作区干净 | 通过：`git status --porcelain` 为空 |
| 金标准探针 | `45bea360859c6851034d413fa5e6d96057fefe60`（`astropy/modeling/separable.py` 修复后的 blob） |

对照 swebench 5.0.2：打补丁沿用 `GIT_APPLY_CMDS` 回退链，判定用 5.0.2 的 `get_eval_report`（`include_tests_status=True`）。有意差异见 T2-10 偏差表：评分容器不加 `SYS_ADMIN`，`infra_failure` 与 docker 出错归为 `infra_error`。在不加 `SYS_ADMIN` 的情况下，金标准运行 FAIL_TO_PASS 全部通过（2/2），满足 T2-10 偏差表「不加 SYS_ADMIN」一行附的条件。两次评分的 swebench 报告中 `infra_failure` 都为 false。日志在 `eval/runs/precheck-82872ebe/`（不进 git）。

### 与计划的偏差（续，2026-11-26 追加：T2-11 审查后）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| `build_taskset` 候选数改为 `min(ceil(n×1.5), 可选条数)` | 实现者（未先请示） | smoke-v1 只有 1 行、n=1 时原写法要 2 个候选而报错 | 审查员核实 dev-v1（500 行取 60）行为不变 | 作者 2026-11-26（本会话，「认可」） |
| 开发集只记录 x86 镜像，冷烟集记录两个平台 | 审查员发现缺口、控制会话建议 | 官方 arm64 缺部分实例，dev-v1 定版会因解析 arm64 中止；正式评测只认 amd64 | task-11-review.md I2 | 作者 2026-11-26（本会话） |
| 预检里 BaseMismatch 直接排除、不重试；便宜的镜像检查放在评分之前 | 审查员 | 镜像的确定性性质，重试只浪费评分时间并把真实原因记成「无法测量」 | task-11-review.md M1 | 作者 2026-11-26（本会话） |

- 更正（追加）：上一节表中「`_node_version`」已在实现中改为 `_image_checks`（工作区、有效基准与 node 检查合在一个 Sandbox 里），作用相同（审查 M7）。
- 补注（追加）：smoke-v1.json 的 `selection.method` 写作 "stratified by repo"，但输入 rows 是作者指定的 1 个实例（astropy-12907），只凭种子复现不出候选范围；复现时以本节与上节记录为准（审查 M8）。
- 清理（追加）：作者 2026-11-26 同意删除不再用于冷烟的 Epoch arm64 requests-2317 与 astropy-12907 镜像，以及两个中止的预检目录 `eval/runs/precheck-4e89f7ed`、`precheck-1e3bd0ee`（已删）；Epoch arm64 django-11099 保留（T2-9 真实镜像测试用）。其余 `eval/runs/precheck-*` 保留作证据。
- 更正（追加）：偏差表「认可」一行中的 `_ensure_image` 已在 T2-11 返修第 1 轮（5414a5e）删除——检查顺序前移后，镜像检查启动容器时已拉好镜像，它成了多余（实现者顺带删除，属写法细节）。

### 与计划的偏差（续，2026-11-26 追加：MVP 里程碑）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 在 Task 12 前插入 MVP 里程碑：T2-12、T2-13 先做精简版，再做 T2-14 冷烟；并发、续跑、完整预算、置信区间、代理对账、Kimi、x86 服务器、dev-v1、基线报告等挪到 MVP 之后再定；tasks.md 验收标准不变 | 作者（「设计层面比较重」「先做一个最小化的 MVP」），控制会话整理范围 | 先端到端跑通、看到真实结果，再决定哪些防护与统计真的需要 | 计划「MVP 里程碑」一节 | 作者 2026-11-26（本会话） |

### 与计划的偏差（续，2026-11-26 追加：T2-12）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 采样参数由模型代理注入：T2-7 代理路由加可选 `params: {temperature, top_p}`，转发时覆盖请求体（MVP「已建部分不改」的唯一例外） | T2-12 实现者 | pi 1.5.1 发 OpenAI 格式请求时不发 `top_p`、只在调用参数带 `temperature` 时才发；runner 命令行与契约没有采样参数；D7 要求不依赖服务端默认值 | task-12-report（读了 pi 1.5.1 的 OpenAI 请求代码）；实现说明 0.6 也记录过 pi 不发采样参数 | 作者 2026-11-26（本会话） |
| Qwen3.6 采样参数取 temperature=1.0、top_p=0.95 | T2-12 实现者 | D7：模型卡里 SWE 类评测所用的值优先 | Hugging Face 模型卡 https://huggingface.co/Qwen/Qwen3.6-35B-A3B「Benchmark Results > Language」脚注：SWE-bench 系列用 temp=1.0、top_p=0.95；与百炼思考模式默认值恰好相同，出处以模型卡为准 | D7 规则内，不需另行确认 |
| `run_instance` 去掉 `budget` 参数、不评分（评分字段由 T2-13 填） | T2-12 实现者 | MVP 把 Budget 挪后；计划的 6 步流程本就不含评分 | task-12-report | 作者 2026-11-26（本会话，「认可」） |
| T2-12：`usage_complete` 只在成功返回却无用量时为 false；出错请求不算用量未知 | 审查员（M4） | 出错请求按契约用量为 null 且不计费，原口径会让碰到过限流的运行都标成用量不完整 | task-12-review.md | 作者 2026-11-26（本会话） |
| T2-12：除 `infra_error` 外都取补丁（实现曾只在正常结束时取，按计划改回） | 审查员（I1） | 失败运行的半成品补丁留作诊断；对 D10 计分无影响 | task-12-review.md | 作者 2026-11-26（本会话，按计划） |
| T2-12：配置 `model.compat`、`model.pi` 改为必填 | 审查员（M1）、控制会话裁定 | 缺失时静默为空，`thinking` 可能悄悄失效；与 D7「显式写出」同一原则 | task-12-review.md | 控制会话裁定（规范正确、实现补校验，workflow 3.3） |
| T2-13（MVP）：`rate_limited` 也按 D10 重试并先退避 60 秒；确定性基础设施错误不重试；开跑前检查运行包有 `bin/fp-entry` | 审查员（⚠️、M6），控制会话建议 | 对齐 D10；确定性错误重试只是白跑；路径写错时尽早失败 | task-12-review.md | 作者 2026-11-26（本会话） |
- 补注（追加）：上表「除 `infra_error` 外都取补丁」一行——待评分（`none`）的运行取补丁失败时记 `infra_error`：没有补丁就无从评分，保留 `none` 会污染 D10 计分（复审 t2-12 rereview-1）。
- 更正（追加）：上表 `usage_complete` 一行补充——被中止（aborted）的请求无用量时算用量未知（上游可能已部分计费），只有出错返回（如 429）不算；作者 2026-11-26 确认（本会话）。pi 会话文件不落盘，轨迹以 `events.jsonl` 与 `raw.jsonl` 为准；作者 2026-11-26 确认不另存。

### 与计划的偏差（续，2026-11-26 追加：T2-13）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 修 T2-6 遗留 bug：`fp-env.sh` 不带参数 source conda activate，runner 参数被当成 activate 参数、桥退出 3（每次真实运行都会 infra_error）；改为显式传 `base` | T2-13 实现者 | 规范正确、实现有误（workflow 3.3，先写复现测试） | 86eb4d1；复现用例在带 conda 的官方镜像上，旧代码失败；审查员用 bash `source` 语义模拟验证。T2-12 用无 conda 的合成镜像、T2-6 只测无参调用，所以没抓到。T2-14 前须重建运行包 | 不需确认（workflow 3.3） |
| 命令行新增 `--env-file`（默认仓库根 `.env`） | T2-13 实现者 | 工作区里没有 `.env`；符合「key 只从 .env 读取」 | task-13-review.md | 作者 2026-11-26（本会话） |
| 命令须带 `PYTHONPATH=eval` | 审查员核实 | 计划原命令在仓库根找不到模块；只改命令文本，不加打包配置 | task-13-review.md | 控制会话裁定（写法） |
| 清理前把代理日志存到 `<out>/proxy.jsonl` | 审查员（计划缺口） | 清理删除代理容器后无法核对采样参数 | task-13-review.md | 作者 2026-11-26（本会话） |
| 评分阶段 `infra_error` 只重新评分、不重跑 agent | 审查员（Minor） | 省模型花费，补丁不变 | task-13-review.md | 作者 2026-11-26（本会话） |
| 异常结束时也做 check-secrets 扫描 | 审查员（Minor）、控制会话裁定 | Global Constraints：每次真实运行后扫描输出目录 | task-13-review.md | 控制会话裁定（安全） |

### T2-14：Mac 冒烟（2026-11-26 追加，MVP 最后一步）

命令（工作区根，作者看过报价 3.02 元后同意）：`PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run --config eval/configs/qwen3.6.yaml --taskset eval/tasksets/smoke-v1.json --out eval/runs/smoke-2026-11-26 --env-file <主仓库>/.env`，退出 0。

| 核对项 | 结果 | 证据 |
|---|---|---|
| 结果 | complete；astropy-12907 resolved，成功率 100%（1/1），无法测量 0 | `summary.md`；补丁一行：`_cstack` 中 `= 1` 改为 `= right` |
| token / 轮数 / 耗时 | 输入 194578、输出 6439（含 reasoning 2384）、缓存 0；18 次请求、18 次工具调用；agent 65.6 秒 | `record.json` |
| 实际花费 | 0.4198 元（报价 3.02 元），手算 0.3502 + 0.0695 一致；`usage_unknown_runs` 0 | `summary.json` |
| 四个文件 | `events.jsonl`、`raw.jsonl`、`patch.diff`、`record.json` 齐全（另有 `models.json`、`grade/`） | 运行目录 |
| snapshot | engine pi 1.5.1；model qwen-api / qwen3.6-35b-a3b | `record.json` |
| `verify_truncated`（含金标准 blob 探针，验收 8） | 通过：`truncate_history` 在运行容器里截断后自检，不通过会抛 HistoryLeak、记为无法测量；本次正常进入 agent 阶段 | `repo_prep.truncate_history`；`failure_type: none` |
| agent 的 python 指向 testbed | 是：agent 跑 pytest 的表头为 `/opt/miniconda3/envs/testbed/bin/python` | `events.jsonl` |
| 采样参数 | 代理日志 18 条请求全部 200，均为 temperature=1、top_p=0.95（另 enable_thinking=true、thinking_budget=2048、max_completion_tokens=8192） | `<out>/proxy.jsonl` |
| check-secrets | ok（无 key、无本机路径） | 运行输出 |
| 残留 | `fp-run` 标签的容器 0、网络 0 | `docker ps -a` / `docker network ls` |
| 容器内 `curl` 外网与 `host.docker.internal` 失败 | 本次未在运行中核对（容器已清理）；真实 docker 用例 `test_no_internet_no_host` 覆盖同一网络配置 | 见下方待定 |
| `docker top` 能看到 agent 命令（验收 3） | 本次未核对 | 见下方待定 |

- 待定（追加）：上表最后两项需要在运行中的容器里核对，跑完已无法补；交接说明列的核对项比计划 Step 2 少，开跑前未发现。是否补核、怎么补，等作者决定。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| Step 3 校准不取 p90，取单次实测 ×2：`assumed_tokens_per_run` 写 400000 输入 + 13000 输出（单次报价约 0.86 元） | 控制会话 | 只有 1 个样本，p90 即其本身；smoke 这道题是一行修复、18 轮，正式任务集会更长，照单样本报价偏低 | 本节上表 | 作者 2026-11-26（本会话，「按你的建议，×2 写入」） |
| 只改 `qwen3.6.yaml`（计划写「两个配置文件」） | 控制会话 | `kimi-k2.6.yaml` 未建，Kimi 组在 MVP 挪后清单 | `eval/configs/` 只有一个文件 | 作者 2026-11-26（本会话，「只改 qwen3.6.yaml」） |

#### T2-14 补跑（2026-11-26 追加：补核上表两项待定）

作者同意补跑一次（报价 0.86 元，已用校准后的值）。命令同上，`--out eval/runs/smoke-2026-11-26b`，退出 0。运行时另开监控脚本：等任务容器里出现 `fp-entry` 后，在容器里跑 curl，并每秒采样一次 `docker top` 与宿主机 `ps`，直到容器结束。监控脚本放在会话临时目录，不进仓库。

| 核对项 | 结果 | 证据 |
|---|---|---|
| 结果 | complete；resolved 1/1；补丁与第一次相同（`= 1` 改为 `= right`） | `summary.md`、`patch.diff` |
| token / 轮数 / 耗时 | 输入 378239、输出 7721（含 reasoning 3309）、缓存 0；18 次请求、18 次工具调用；agent 82.8 秒 | `record.json` |
| 实际花费 | 0.7642 元（报价 0.86 元）；`usage_unknown_runs` 0 | `summary.json` |
| 容器内 curl（验收 3 网络部分） | `https://github.com` 退出 6（解析不了）；`http://host.docker.internal` 退出 6；`http://1.1.1.1` 退出 7（连不上） | 监控输出，容器 `fp-task-smoke-2026-11-26b-e7d5d9e6` |
| `docker top` 能看到 agent 命令（验收 3） | 76 次采样都有 runner（`/fp/node/bin/node /fp/app/runner/dist/main.js …`）与桥（`stdio-bridge.js`）；还抓到 agent 的工具命令，如 `/bin/bash -c cd /testbed && python -m pytest astropy/modeling/tests/test_separable.py -v …`、`python -c from astropy.modeling …` | 监控输出 |
| 宿主机上没有对应进程 | 76 次采样里，宿主机 `ps` 中匹配 `testbed\|pytest\|separable\|fp-entry\|runner` 的进程为 0（已排除宿主机上的 docker CLI 客户端 `docker exec -i … /fp/bin/fp-entry`，它只是转发 stdio 的客户端） | 监控输出 |
| 采样参数 | 18 条请求全部 200，均为 temperature=1、top_p=0.95 | `<out>/proxy.jsonl` |
| 四个文件、snapshot | 齐全；pi 1.5.1，qwen-api / qwen3.6-35b-a3b | 运行目录、`record.json` |
| check-secrets / 残留 | ok；`fp-run` 标签的容器 0、网络 0 | 运行输出、docker |

- 观察（追加）：两次运行轮数相同（18），输入 token 却差近一倍（194578 和 378239）；第二次已占校准值 400000 的 95%。两个样本还不足以重新校准，留到 MVP 之后的减重讨论再定。

### 与计划的偏差（续，2026-11-27 追加：MVP 之后的减重）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 方案 B：开发集 30 个（候选 45），Qwen 与 Kimi 都每题 2 次，共 120 次（原 40 个，Qwen 3 次、Kimi 2 次，共 200 次）；D5 改 | 控制会话 | 40 题时按题抽样误差约 ±8 个百分点，从 2 次加到 3 次压不下；花费约 250 元降到约 150 元（按 smoke 单题推算，正式题会更贵），串行约 5–9 小时；tasks.md 验收 1、2 仍满足 | 计划「MVP 之后的减重」一节 | 作者 2026-11-27（本会话，「按你的建议，方案 B」） |
| 不做：`--workers` 并发；运行中预算累计与取消（`budget_cancelled`、「未运行」「未完成」，D10 改）；`reconcile_proxy` 与 `proxy-fields.json`；启动时清扫遗留资源；GitHub Actions x86 预检；删除 `probe_blobs` | 控制会话 | 串行即可跑完；花费靠报价、按组运行与人工对账控制；采样参数核对已有 `proxy.jsonl`；`finally` 已清理；预检改在服务器上直接跑 | 同上 | 作者 2026-11-27（本会话，「没问题，按这个改计划」） |
| 新增 Task 14b：`--repeats`、均值与样本标准差、按题 bootstrap、极简续跑（`run.json` 核对 + `done.json` 跳过）、`kimi-k2.6.yaml` 与 Mac 上 Kimi 冒烟 | 控制会话 | 验收 2 需要重复与波动；手动补跑要合并两个输出目录、更易出错，极简续跑约十几行；Kimi 有下线风险，尽早确认可用 | 同上 | 作者 2026-11-27（本会话） |
| Task 15 服务器规格降为 8 vCPU / 32 GB / 300 GB（原 16 / 64 / 500） | 控制会话 | 不并发；45 个镜像各 3–4 GB | 同上 | 作者 2026-11-27（本会话） |

### 与计划的偏差（续，2026-11-27 追加：T2-14b）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| `--resume` 且 `--out` 不存在时按新跑处理；`--out` 存在但没有 `run.json` 时拒绝续跑 | T2-14b 实现者 | 前者无可续之物；后者无法核对配置一致性 | task-14b-report.md；参数化用例 | 作者 2026-11-27（本会话，「偏差都确认」） |
| Kimi K2.6 采样取 temperature=1.0、top_p=1.0（不是「Model Usage」推荐的 top_p 0.95，也不同于百炼默认） | T2-14b 实现者 | D7：模型卡里 SWE 类评测所用的值优先 | https://huggingface.co/moonshotai/Kimi-K2.6「Evaluation Results」脚注 1："Unless otherwise specified, all Kimi K2.6 experiments were conducted with temperature = 1.0, top-p = 1.0"；脚注 4 SWE-Bench 部分未另给；审查员抓取核对属实 | D7 规则内；作者 2026-11-27 知悉并确认 |
| 写法细节：`aggregate` 第一个参数改为按重复分组（唯一调用方已同步）；开跑前也检查运行包有 `VERSION`；summary.md「共 X 次运行（题 × 重复）」；Kimi 配置 provider 沿用探测时的 `qwen-api`、route 取名 `kimi` | T2-14b 实现者 | 实现 `run.json` 与重复所需；标签不影响行为 | task-14b-report.md | 作者 2026-11-27（本会话，「偏差都确认」） |
| 修 b60f0cf 遗留：校准花费后 `test_estimate_cost`、`test_estimate_printed_and_declined` 失败（控制会话当时只跑了 `-k config`），改为当前校准值 | T2-14b 实现者 | 规范正确、测试未跟进（workflow 3.3） | task-14b-report.md | 不需确认（workflow 3.3） |

### T2-14b Step 5：Kimi 冒烟（2026-11-27 追加）

作者同意报价 2.95 元后，Mac 上运行 `PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run --config eval/configs/kimi-k2.6.yaml --taskset eval/tasksets/smoke-v1.json --out eval/runs/kimi-smoke-2026-11-27 --env-file <主仓库>/.env`，退出 0。

| 核对项 | 结果 | 证据 |
|---|---|---|
| 百炼 `kimi-k2.6` 可用 | 14 次请求全部 200，路由 `kimi` | `proxy.jsonl` |
| 结果 | complete；resolved 1/1；补丁同样改 `= right`，另加了一个回归测试 | `summary.md`、`patch.diff` |
| token / 轮数 / 耗时 | 输入 15465 + cacheRead 126208、输出 5026（含 reasoning 3428）；14 次请求、13 次工具调用；agent 107.4 秒 | `record.json` |
| 实际花费 | 1.0566 元（报价 2.95 元）；手算 (15465+126208)×6.5 + 5026×27，除以 100 万，一致；`usage_unknown_runs` 0 | `summary.json` |
| 采样参数 | 14 条均为 temperature=1、top_p=1，与配置一致 | `proxy.jsonl` |
| snapshot | pi 1.5.1；qwen-api / kimi-k2.6 | `record.json` |
| 新目录结构 | `run.json`、`rep-1/<实例>/done.json` 都在 | 运行目录 |
| check-secrets / 残留 | ok；`fp-run` 容器 0、网络 0 | 运行输出、docker |

- 校准（追加）：按 Step 5「实测 ×2」，`assumed_tokens_per_run` 写 290000 输入（含 cacheRead）+ 11000 输出，单次报价约 2.18 元。
- 观察（追加）：Kimi 输入有 89% 是缓存命中。现行口径按输入价计，如果百炼对缓存打折，实际账单会低于 `actual_cost`。Task 16 Step 2 对账时一并核对。

### 与计划的偏差（续，2026-11-27 追加：只跑 Qwen、香港服务器）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| T2 基线只跑 Qwen，Kimi K2.6 组推迟（tasks.md T2 验收 6 同步改） | 控制会话提议推迟，作者决定 | Kimi 约占剩余跑题时间六成、花费七成；面试结论只需要主模型基线 | `scripts/process-cost.py` 测量与本会话估算 | 作者 2026-11-27（本会话，「那就只跑 Qwen」） |
| 服务器改为阿里云香港按量付费，8 vCPU / 16 GB / 300 GB（原 32 GB）；代码用 git bundle 传 | 控制会话 | 内地访问 Docker Hub 与 Hugging Face 不稳定；串行运行估计内存峰值不超过 6 GB（未实测，预检时记录）；不推送 | Mac 实测 Docker 磁盘只剩 16 GiB，放不下约 52–78 GB 镜像，所以不走 Mac | 作者 2026-11-27（本会话，「租香港的服务器」） |

### T2-15：香港 x86 服务器准备与冒烟（2026-11-27 追加）

服务器：阿里云香港按量 `ecs.e-c1m2.2xlarge`（8 vCPU / 16 GiB / 300 GB ESSD），Ubuntu 24.04.5，1.92 元/时；安全组 22 端口只放行作者出口 IP；root + 密钥登录，密码登录关闭。环境：docker 29.10.1（amd64）、node 24.15.0（sha256 与运行包脚本一致）、pnpm 10.34.9、Python 3.12.3 venv（swebench 5.0.2）。代码用 `git bundle` 传 `46a383c`，未推送；x64 运行包 VERSION `46a383c`。`.env` 只传 `DASHSCOPE_API_KEY` 一行（600）。

| 核对项 | 结果 |
|---|---|
| 机器验收 | `pytest eval/tests` 209 passed（含 x86 假模型端到端）；`pnpm test` 538/542，3 个因主机缺 rg（装 ripgrep 后重跑通过），1 个 check-secrets「读不了的文件」因 root 不受 `chmod 0` 限制（环境所致，Mac 通过） |
| x86 冒烟 `smoke-x86-2026-11-27`（验收 9） | complete；resolved；评分 `grade_arch` amd64，镜像 `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:e0829630…`（与 smoke-v1 记录一致）；补丁同 Mac |
| token / 花费 | 输入 392538、输出 6169；29 次请求、28 次工具调用；实际 0.7732 元（报价 0.86） |
| 用时（`process-cost.py phases`） | 准备 3.7 秒、agent 79.4 秒、评分 58.9 秒，合计 142 秒 |
| 采样 / 安全 / 残留 | 29 条均 temperature=1、top_p=0.95；check-secrets ok；`fp-run` 容器 0、网络 0 |

### 与计划的偏差（续，2026-11-27 追加：整体审查后、基线前的修复）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 运行目录布局：只把尝试目录下的子目录 `fp-out/` 挂成容器的 `/fp-out`，`patch.diff`、`record.json`、`grade/` 等宿主机写入的文件留在挂载之外 | 整体审查 I2 | 原来整个尝试目录可写地挂进容器，agent 可放符号链接让宿主机（服务器上是 root）写任意路径；控制会话核实 `sandbox.py:133` 属实 | final-review.md | 作者 2026-11-27（本会话，「三件都同意」） |
| 模型服务出错（上游 5xx、代理 502、连接不上）算 `infra_error`，按 D10 重试后排除；先改 design 3.11 | 整体审查 I1 提问，控制会话建议 | design 3.11 定义「不是由 agent 或补丁引起的失败」，规范未写这一情形 | final-review.md | 作者 2026-11-27（本会话） |
| 每道题开跑前检查代理容器仍在运行，不在就中止（可修好后续跑） | 整体审查 I1 | 代理中途挂掉时后续运行会快速失败、留在分母、写 done.json 后续跑也跳过 | final-review.md | 作者 2026-11-27（本会话） |
| 限流判断正则改为只匹配独立的 429（原 `429\|rate.?limit` 会匹配 264292 之类数字，把真实失败改记 rate_limited 后排除，抬高成功率） | 整体审查 M2 | 规范正确、实现有误（workflow 3.3）；控制会话实测误匹配 | final-review.md | 不需确认（workflow 3.3），作者同意基线前修 |
| 这批修复的流程：一个实现者一次修完 → 全部机器验收 → 一次限定范围的复审，不单独做 ponytail-review | 控制会话 | 试用精简流程 | 本会话 | 作者 2026-11-27（本会话） |

### dev-v1 定版（2026-11-27 追加，T2-15 Step 3，验收 1）

在香港 x86 服务器上执行 `build_taskset("dev", 1, <Verified 500 行>, 30, 20261125, bundle-linux-x64, eval/tasksets/dev-v1.json)`（代码 `46a383c`）。第一次因 Docker Hub 匿名拉取限流（429），17 个候选无法测量、只有 27 个通过而中止；作者在服务器上 `docker login`（个人只读 token，作者亲手输入）后同种子重跑，用时 2989 秒。

| 项 | 结果 |
|---|---|
| 开发集规模 | **30 题**（验收 1 的 30–50 之内），候选 45 |
| 预检 | 44 通过；排除 `psf__requests-1921`（金标准补丁打上后仍 unresolved） |
| 仓库分布 | django 8；astropy、xarray、pytest、sympy 各 3；matplotlib、seaborn、scikit-learn、sphinx 各 2；flask、pylint 各 1（共 11 个仓库） |
| 镜像 | 30 题都记录 x86 `name@digest` |
| 文件 sha256 | `e9c3137d9918687ebc6553b9efbf576ed19198f9ea2393443c959b040c63e002` |
| 截断检查（整体审查 I3） | 30 个镜像各跑一遍 `resolve_effective_base` + `truncate_history`（含自检与金标准探针），全部通过，每题 1–7 秒 |

### 基线首次开跑 403（2026-11-28 追加）

02:12 在服务器开跑 dev-v1 基线（代码 `c1bf105`）后，百炼对每个请求返回 `403 AllocationQuota.FreeTierOnly`（账号开着「仅使用免费额度」且免费额度已用完）。每题第一个请求即失败、记为 `run_failed` 留在分母；控制会话发现后 SIGTERM 停止（退出 143，清理与 check-secrets 正常，无残留），已完成 9 题、模型花费 0。输出目录改名 `dev-v1-qwen-aborted-403` 留作证据。Mac 上三次 Qwen 冒烟与 x86 冒烟的花费可能由免费额度抵扣，对账时核实。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 模型服务 401/403 时立即中止整次评测、非零退出、不写该题 done.json，可修好后续跑（design 3.11 已加一句） | 控制会话 | 账号级错误每题都会失败，原逻辑会把它记成 agent 失败、悄悄产出 0% 基线 | 本节 | 作者 2026-11-28（本会话，「改吧，先修 403 再开跑」） |

### 基线第二次开跑与方案 C（2026-11-28 追加）

02:33 在服务器重新开跑（代码 `9907ab6`，工具上限 100）。首题 `astropy__astropy-13579` 用了 93 次请求、90 次工具调用、714 秒，输入 7034357 + 输出 78061 token，13.50 元，resolved。按首题推算 60 次运行约 300–700 元、10–20 小时，远超报价 51.62 元的 2 倍与服务器时限；控制会话在首题写完 `done.json` 后 SIGTERM 停止（退出 143，清理与 check-secrets 正常）。原因：qwen3.6-35b-a3b 在百炼不支持缓存，pi 每轮重发整段历史，输入随轮数近似平方增长；冒烟题只有 18–29 轮，按它校准的报价严重偏低。首题累计输入：第 20 次 58 万、第 30 次 109 万、第 40 次 170 万、第 50 次 244 万。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 方案 C：工具调用上限 100 → 40（D7；`qwen3.6.yaml`、`kimi-k2.6.yaml`）；`assumed_tokens_per_run` 改为首题前 40 次请求累计（170 万输入 + 3.4 万输出，约 3.44 元/次，作单题上界），前 5 题后按实测重估 | 控制会话 | 把单题成本封顶到约四分之一；30 × 2 结构与验收 2 不变 | 本节 | 作者 2026-11-28（本会话，「那就选 C 吧」） |
| 上限 100 下跑出的首题结果不并入基线：配置变了，`run.json` 的 config_hash 不同，续跑会被拒；目录改名 `dev-v1-qwen-cap100-aborted` 留作证据，基线用新目录 | 控制会话 | 口径必须一致 | 本节 | 随方案 C（作者 2026-11-28） |
| 两个测试（`test_estimate_cost`、`test_estimate_printed_and_declined`）写死了正式配置的估算值，配置一改就失败（第二次出现），本次同步期望值 | 控制会话 | 规范正确、测试写法脆弱；提议之后改为用测试自己的配置 | 本节 | 待作者（提议） |


## T2 收尾（2026-11-28 追加，收尾方案 C：先做不依赖基线的项）

作者 2026-11-28 决定：先做不依赖基线的收尾项；撤回「工具上限 40」；整体审查剩下的两项推迟。基线跑完后再补验收 2、5、6 的证据、讲解自测，并请作者同意标 `[x]`。

### 偏差（续）

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| 撤回方案 C（工具上限 40），恢复 100；`assumed_tokens_per_run` 回到 400000 + 13000 | 控制会话 | 方案 C 按 dev-v1 唯一的「1-4 hours」题推算，其余 29 题较短（按难度分布预测 30 × 1 约 11–141 元）；100 次上限已封顶单题约 11–16 元；40 会截断难题 | `scripts/context-replay.py --predict`；本节一致性检查 | 作者 2026-11-28（本会话，「同意撤回」） |
| 13579 与三次冒烟的轨迹作为固定用例入库 `eval/traces/`（偏离「运行产物不进 git」） | 控制会话 | 让成本诊断与重放能只凭 git 复跑；工作区与服务器都不是持久存储 | `eval/traces/README.md`、各 `MANIFEST.md`（sha256）；check-secrets 干净 | 作者 2026-11-28（本会话，「同意，冒烟也一起收录」） |
| 整体审查留下的两项（`engine-client.ts:50-51` 丢弃 ws 错误原因、`runner-launcher.ts:56-57` 在 exit 后读 stderr）推迟到 T2 之后 | 整体审查要求合并前修或经作者推迟 | 不影响评测结果 | `final-review.md` | 作者 2026-11-28（本会话，「第 5 步推迟」） |
| proposal S8 注明 T2 的 Kimi 对照推迟（与 tasks.md 验收 6 一致） | 控制会话（一致性检查） | 上游需求与任务不一致 | 本节一致性检查 | 随作者 2026-11-27「只跑 Qwen」 |

### 验收 1–10 核对（2026-11-28）

| # | 状态 | 证据 |
|---|---|---|
| 1 | 满足 | `eval/tasksets/dev-v1.json`（30 题、11 个仓库、版本 1、sha256 e9c3137d…）；规模与预检见本文「dev-v1 定版」；留出集按规定推迟 |
| 2 | **部分满足** | 一条命令 `python -m forgepilot_eval run …` 输出 summary（成功率均值、样本标准差、bootstrap 区间、token、轮数、耗时、失败类型）与每题完整轨迹；记录含运行快照、config_hash、任务集 sha、运行包 VERSION。**缺**：在 dev-v1 上实跑出的结果 |
| 3 | 满足 | 「T2-14 补跑」：docker top 看到 agent 命令、宿主机 76 次采样无对应进程；容器内 curl 外网与宿主机失败；每题独立容器与仓库副本 |
| 4 | 满足 | 配置 `danger_patterns`（D8）；`policy.py` 与测试；评测框架经 callback 做拦截决策 |
| 5 | **部分满足** | 每次运行先打印预计花费；summary 记 `cost.actual_yuan`；冒烟与首题手算一致。**缺**：基线实际花费与百炼账单对账 |
| 6 | **未满足** | 基线报告未写：dev-v1 上的 Qwen 基线两次开跑均中止（见「基线首次开跑 403」「基线第二次开跑与方案 C」） |
| 7 | 满足 | `engine_client.py` 只经 stdio 桥协议；运行包只读挂载到任务容器 `/fp` |
| 8 | 满足 | 每次运行 `truncate_history` + `verify_truncated`（含金标准 blob 探针）；dev-v1 30 个镜像截断检查全部通过 |
| 9 | 满足 | `smoke-x86-2026-11-27`（香港 x86，amd64 评分，同一条命令）；Mac 冒烟 3 次 |
| 10 | 满足 | `eval/configs/qwen3.6.yaml`；ADR 017 |

### 收尾一致性检查（workflow 4.6，2026-11-28）

| 层 | 核对项 | 结果 |
|---|---|---|
| 需求 → 任务 | proposal S8「T2 做 Kimi 对照」与 tasks.md 验收 6（Kimi 推迟） | 不一致，已在 S8 注明推迟 |
| 设计 → 实现 | design 3.11 新增两句（模型服务出错算 infra_error；401/403 中止整次评测） | 一致：`run_task.py` 分类与 `ProviderAccessError`，有测试（9907ab6） |
| 设计 → 实现 | 镜像按平台固定来源并锁定 digest | 一致：dev-v1 只记 x86 `name@digest` |
| 设计 → 实际 | 远程运行（`.env` 600、tmux、rsync 拉回） | 一致；代码用 git bundle 而非 clone（未推送，偏差表已记） |
| 计划 → 实现 | 「运行产物不进 git」 | 例外：`eval/traces/` 固定用例，已记偏差 |
| 计划 → 实现 | D7 工具上限、`assumed_tokens_per_run` | 一致：配置与测试已还原为 100 与 400000 + 13000 |
| 任务 → 验证 | 验收 2、5、6 | 待基线；跑 1 次还是 2 次（D5 写 2 次）待作者定 |
| 契约 | `engine.md`、`agent-events.md` 自 T2-4 后未改 | 一致（基线前修复只动评测框架 Python 代码） |

### 附录：执行账本转存（2026-11-28）

执行账本（`.superpowers/`，不进 git）在收尾后会删除，按 workflow 3.4 把裁决、返修轮次与推迟的 minor 原样转存。整体审查对这些 minor 的分拣见 `final-review.md` 的结论：除已推迟的两项 TS 问题外，其余可保留；其中三项已在后续修复（代理跟随重定向、excluded 缺重复序号、续跑时代理容器重名）。

**裁决（Ruling）**

- Ruling: T2-12 实际依赖 T2-11（任务集 probe_blobs）——按表顺序执行本来就在 11 之后，不改计划文本——若错，只是依赖表少写一项，无执行影响。
- Ruling: 不删 run3「input+cacheRead+output===totalTokens、reasoning≤output」断言 —— 作者第二轮意见（3）明确要求以 T1 第 3 次录制证明推理 token 已含在 output 内，它检验的是 pi/百炼计数口径而非转换器逻辑，正是其目的；加一行注释说明 —— 若错，代价只是多一条不覆盖转换器的断言。
- Ruling: Minor 1（「监听前退出」用例桥不存在也通过）按审查准则「测试不断言任何东西」升为 Important 进返修 —— 准则明文 —— 若错只是多改两行断言。
- Ruling: Minor 2（运行中 stdin EOF → 取消、工具不执行）进返修 —— brief 要求「stdin EOF 后以 runner 退出码退出」的测试，现有覆盖只是 idle 时顺带测到，而这是 Python 侧到期叫停依赖的语义 —— 若错只是多一条测试。
- Ruling: Minor 3（换行路径 finish 调两次、退出码靠回调先后）进返修 —— 隐式竞态影响退出码正确性 —— 若错只是加一个只执行一次的标志。
- Ruling: `rm -rf "/"` 必须拦 —— D8（b9983f8）正文已把它列为引号内容照样参与匹配的例子，属实现未达规范 —— 若错只是测试里的规则多允许一对引号。已 resume 实现者改 rm 规则。
- Ruling: Nice 1（删元测试 every_d8_rule_has_a_hit_and_a_miss）、Nice 4（删重复 returncode 断言）不做 —— 二者直接服务作者的硬要求（双向测试、每条路径检查 returncode）—— 若错只是多几行测试。Nice 2/3/5 不做 —— 收益小、Nice 5 缩短 grace 可能引入时序抖动 —— 若错只是测试慢约 4 秒。Nice 6（shortcut 注释）进返修。
- Ruling: Minor-1（缺 callId/confirmId 抛 KeyError）、Minor-2（异常路径无测试）、Minor-3（calls==2 时序依赖）随 Important-1 进返修 —— 1 与 brief 的协议错误处理一致、2 是作者「任何路径」要求、3 去掉隐性抖动 —— 若错只是多几行。
- Ruling: ponytail 建议中 T7 32 MiB 上限保留（信任边界的输入限制）、T8 image_digest 不改 {{.Id}}（续跑核对要跨机器可比）、T9 update-ref 层保留并按 --no-deref 修、ORIG_HEAD/FETCH_HEAD 删除行保留并补测试 —— 均属安全/正确性 —— 若错只是多几行代码。采纳：删 T6 重复 ro 测试、T8 未用 stop()/ready_timeout_s/重复测试/抄写式断言。
- Ruling: ponytail Nice 2（删 git apply --check --reverse）不做 —— 审查员确认与 swebench 5.0.2 官方一致 —— 若错只是多 4 行。Nice 1、3 采纳。Minor：SDK 客户端关闭、utf-8、异常路径清理测试采纳；CLI/SDK 守护进程不一致、swebench 标记跳过逻辑延后。
- Ruling: urllib3.exceptions.HTTPError 归 infra_error（不放宽到 OSError）—— 计划已写「docker/容器本身出错归 infra_error」，exec_run_with_timeout 读原始流时守护进程重置抛的就是未包装的 urllib3 异常，属实现漏项（workflow 3.3 可自行修）—— 若错只是多一条异常类型。返修第 2 轮（resume）。
- Ruling: Task 13 非 amd64 检查放在 D10 排除之后、infra_error 且 arch 为空不参与 —— 与作者规则一致的澄清 —— 若错只是 Task 13 一条用例。计划已追加。
- Ruling: I1、M2、M3、M5、M6 进返修 —— 规范正确、实现有误或安全加固（workflow 3.3）—— 若错只是多几行。M4 与 ponytail Should 1 一并处理（删死代码与依赖 Epoch 的测试）。M7、M8 由控制会话在实现说明追加。ponytail Should 2、Nice 3、5 采纳，Nice 4 不做。
- Ruling: M1 进返修（compat/pi 改必填）—— D7「显式写出、不依赖默认」同一原则，防止思考级别静默失效 —— 若错只是配置多两个必填键。ponytail Should 1、2，Nice 3（先实测）、4 采纳；Nice 5 不做。
- Ruling: 第 2 轮的复审由控制会话直接核对 diff 代替派审查员 —— 改动只有一行条件与注释，与作者决定逐字一致，用例覆盖 aborted 与 error 两种 —— 若错只是少一次独立复审，T2 整体审查（Task 17）仍会覆盖。
- Ruling: ponytail Should 1（删清理失败特殊处理）不做 —— 与作者 Task 13 第 7 步「原始异常时清理错误只附加不覆盖」冲突 —— 若错只是多 10 行。Nice 4（去中位数）不做 —— 计划原文要求均值与中位数。Nice 6（无本机平台镜像预检）保留 —— 否则跑完 agent 才在评分时出错，白花模型钱。Should 3（3 条重复测试）、Nice 5（RUN_NAME 正则）采纳。
- Ruling: 异常结束时也扫描输出目录（check-secrets）进返修 —— 安全，Global Constraints「每次真实运行后扫描」—— 若错只是多一次扫描。资源警告用 -rw 定位并消除（测试输出应干净）。PYTHONPATH=eval 只改计划与 T2-14 命令文本。
- Ruling: ponytail #1（删 rmtree 前的路径防护）不采纳 — 删除操作的安全防护不砍 — 若错只多 2 行。
- Ruling: ponytail #11 撤回——恢复 summary.md 三项断言，run.json 全量比对也保留 — 两者都是 brief 要求的行为，省 2 行不值得丢覆盖 — 若错只多 2 行测试。
- Ruling: 代理存活检查扩到每次重试前与写 done.json 前（代理不在就中止、不写 done.json）—— I1 的目的就是防中途挂掉后续跑救不回，brief 只写「开跑前」是我写漏 —— 若错只多几次 docker inspect。
- Ruling: 流中途断开、请求超时仍记 run_failed —— design 3.11 只列 5xx/502/连接不上 —— 若错，少量运行留在分母、成功率略偏低，报告注明。

**返修轮次**

- T2-0：fix round 1/5（5 addressed, 0 open；commits 16cd8d6..5299cb2）。复审裁定 0.7 表为 20 项、通过 16（实现者对，前审查员误数）。
- Task 2: fix round 1/5 (2 addressed, 1 open — Unicode 空白仍是字面字符，报告误称已转义；commits 403b595..78e6af3)。控制会话用 python ascii() 核实属实。
- Task 2: fix round 2/5 (1 addressed, 0 open — Unicode 转义；commits 78e6af3..eafcea9)。复审（haiku）原样跑正则得 True 是其复制时字符范围被展宽，按码点检查为空；控制会话原样跑为 False。
- Task 3: fix round 1/5 (4 addressed, 0 open — 映射表、StopReasonSchema 单一来源、测试去重；commits 9a0c26e..aefecb1)。控制会话复核 pnpm build + unit 通过。
- Task 4: fix round 1/5 (6 addressed, 0 open — 137 范围、监听前退出精确断言、运行中 EOF、finish 一次、删无效断言、合并测试；commits eebbc26..4511531)。
- Task 5: fix round 1/5 (5 addressed, 0 open — EOF 后不退出记 failure、缺 callId/confirmId 按协议错误、decide 异常测试、calls>=2、shortcut 注释；commits c24da09..efd5f33)。控制会话复跑 81 passed、无残留进程、pip freeze 与 requirements 一致。
- T2-6~9 fix round 1/5（11 addressed, 0 open；commits 2e13ea3..10f7012）。复审（opus）：无新 Critical/Important；新增接口只影响写法；默认时限 600→60 秒为行为改变，需作者确认（cleanup_run 批量删除高负载时可能抛 DockerError 并跳过删网络）；Task 13 第 7 步只在 Ctrl-C/异常时 cleanup_run，正常结束会残留代理容器与网络——计划缺口，需作者确认；计划 Task 8 勾选记录已追加更正。
- T2-6~9 fix round 2/5（1 addressed, 0 open — cleanup_run 300 秒且删容器失败仍删网络；commits 6ed4bdc..68ffd89）。复审（sonnet）无新 Critical/Important。
- T2-10 fix round 1/5（6 addressed, 0 open；commits febcecb..8e64bd6）。复审（sonnet）无新 Critical/Important。
- T2-10 fix round 2/5（1 addressed, 0 open — urllib3 HTTPError 归 infra_error；commits 8e64bd6..f71ff3b）。复审（sonnet）无新问题。
- T2-11 fix round 1/5（10 addressed, 0 open；commits ea0717b..5414a5e）。复审（opus）无新 Critical/Important；workflow SHA 用 git ls-remote 核对与 tag 一致；_ensure_image 删除不影响行为（docker run 自动拉取、失败按 infra 重试）。
- T2-12 fix round 1/5（6 addressed, 0 open；commits e98d2c1..a404d76）。复审（sonnet）无新 Critical/Important；建议 aborted 算用量未知（可能部分计费）——待作者；none 状态取补丁失败记 infra_error 合理，偏差表补半句。
- T2-12 fix round 2/5（1 addressed, 0 open；commits f58f06d..45b985a）。
- T2-13 fix round 1/5（6 addressed, 0 open；commits 3a3570a..2ef360f）。复审（sonnet）无新问题。运行包已重建（2ef360f，含 fp-env 修复）。控制会话在跑全量 -rw 作证据；T2-14 报价：单次 3.02 元（未校准假设 150 万输入 + 3 万输出），重试最坏约 9.07 元。
- Task 14b: fix round 1/5 (4 addressed, 1 open — ponytail #11 删掉 summary.md 断言后「summary.md 加这三项」无用例; commits 2f7ac67..c712a3c)
- Task 14b: fix round 2/5 (1 addressed, 0 open; commits c712a3c..2561fef)，复审 clean。控制会话全量 209 passed（6m38s）无警告，fp-run 无残留。
- Task 14b: fix round 3/5 (2 addressed, 0 open — 续跑前 cleanup_run、excluded 带 repeat；commits 08c6412..b5d8c89)，复审 clean。

**推迟的 minor**

- Task 0: minor (deferred): 附录 A 另一次模型过滤表达式未附、0.6 缓存措辞偏推断。
- Task 0: minor (deferred): 附录补注措辞绕口（"没有任何结论读取 responseRaw 之外的内容"）；0.9「reasoning 含在 output 内」略强于 0.6 的证据（T1 录制 totalTokens=input+output 另有支持）。
- Task 1: minor (deferred): pi-engine.ts:133-134 注释「没打开成功」不准（打开刚成功即被取消时 fd 留到进程退出，行为无误）。
- Task 1: minor (deferred): tests/helpers/fifo.ts:31-43、t1-real-run.test.ts:681-684 失败路径漏 fd（只影响已失败的测试）。
- Task 1: minor (deferred): writerOpened 默认 8 s 超时，重负载下冷启动可能偶发超时，可放宽到约 20 s。
- Task 1: minor (deferred): 契约措辞更正与 fix 提交 4c0ba73 合在一起（只改措辞），实现说明中注明。
- Task 1: minor (deferred): 「打开成功后、会话创建前收到取消」无专门测试（走 §2.3 既有逻辑）。
- Task 2: minor (deferred): 每个用例重复 realpathSync+动态 import，可提到 describe 外。
- Task 2: minor (deferred): 写死 packages/engine-runner/node_modules 路径（失败会红，只是维护注意）。
- Task 2: minor (deferred): Unicode 空格用例写成字面字符，建议改为   等转义，防编辑器/格式化悄悄替换使用例失效。
- Task 2: minor (deferred): 测试注释补一句为何对照 resolveToCwd 而不是 resolveReadPath；@、Unicode 空格、file:// 分支没有各自的变异证据。
- Task 2: minor (deferred): 普通空格 "a b.py" 由 "my file.py" 覆盖；三个 Unicode 用例合并为多字符串，失败时无法单独定位是哪种空白。
- Task 3: minor (deferred): agent-events.md:60「任何 stopReason」应为五值之一、未知值丢弃。
- Task 3: minor (deferred): engine.md:77 没有该事件的情况除强杀外还有清理超时后晚到的 aborted。
- Task 3: minor (deferred): 「清理阶段丢弃其他进度事件」无测试锁住（建议慢流取消测试断言 text.delta 恰 1 条）。
- Task 3: minor (deferred): pi-engine.test.ts:244-245 断言顺序颠倒（报错信息不直观）。
- Task 4: minor (deferred): 退出码 2 有歧义（runner 参数错、桥 usage 错、帧含换行都是 2）。
- Task 4: minor (deferred): 退出时只等 stdout 不等 stderr，macOS 上 stderr 理论可能截断。
- Task 4: minor (deferred): readline 把裸 \r 当行尾，含裸 CR 的非 JSON 行会被拆帧（合法 JSON 不受影响）。
- Task 4: minor (deferred): 契约「终止 runner 并以 2 退出」实为断开连接；可补「桥不转发信号，桥退出等同断线」。
- Task 4: minor (deferred): ws.send 前 readyState 守卫可删（凭记忆，未核实 ws 行为）。
- Task 4: minor (deferred): 参数解析 indexOf("--runner") 多余。
- Task 4: minor (deferred): 监听前退出分支用永不 resolve 的 Promise 与 `as never` 绕类型，可让 quit 返回 never。
- Task 4: minor (deferred): launch 返回的 err 无人使用。
- Task 4: minor (deferred): 契约段含实现细节（spawnRunner、不带 Origin、非实时流），变更记录重复退出码约定。
- Task 4: minor (deferred): 137 测试依赖 pgrep（node:24-slim 无 procps 会失败），可在测试注释写明。
- Task 5: minor (deferred): 桥被 SIGKILL 后 runner 孙进程最多残留约 10 秒（test_engine_client.py:534-543，靠 idle-timeout 退出）。
- Task 5: minor (deferred): fake-openai-cli --host 0.0.0.0 打印的 baseUrl 容器不可用（Task 8 处理）。
- Task 6: minor (deferred): 篡改测试只改 node；conda 失败退出 3 无测试；pnpm build 静默；接口清单缺 bin/fp-env；「未执行」只在勾选记录。
- Task 7: minor (deferred): 上游跨源重定向会被跟随（建议 fetch 加 redirect: "manual"）。
- Task 8: minor (deferred): 「默认网络连不到代理」测试缺测试内正向对照；就绪等待最后一次调用可能只是报错文字不同。
- Task 8: minor (deferred): network rm 仍 check=False，容器未删导致网络删不掉时不单独报错（计划未要求）。
- Task 10: minor (deferred): CLI 与 SDK 可能连到不同 Docker 守护进程；swebench 标记无跳过逻辑。
- Task 10: minor (deferred): 超时后 client.close() 使读流线程报错（线程内吞掉，无副作用）；out_dir 传 str 会 AttributeError（Task 12 传 Path）。
- Task 11: minor (deferred): test_taskset.py 多一空行；git 本身出错时抛 RuntimeError 会中止 build_taskset（修复前已存在）。
- Task 14b: minor (deferred): bootstrap 百分位下标不对称（250/9749），报告说法不符
- Task 14b: minor (deferred): excluded 条目无 repeat 序号，多次重复时定位不到 rep 目录
- Task 14b: minor (deferred): done.json 非原子写入
- Task 14b: minor (deferred): 续跑时 estimate 只算剩余、actual 算全部，并列易误读
- Task 14b: minor (deferred): 强杀后续跑会因 fp-proxy-<run> 重名起不来（需先按标签清理）
- Task 14b: minor (deferred): run.json 不覆盖评测框架 Python 代码改动
- Task 14b: minor (deferred): test_report.py:365-367 key=None（缺 run.json）时断言 stderr 含 "config_hash"，语义不清
- Task 14b: minor (deferred): 续跑时 cleanup_run 在 try 之外，docker 报错直接抛出

- 更正（追加）：收尾核对（阶段学习总结起草时）发现两处记录疏漏——计划 Task 14 Step 4 已提交（b60f0cf、fcf03d3）但漏勾，已补勾；Task 15 Step 2 要求的 smoke-v1 x86 金标准预检没有单独执行（x86 冒烟只证明命令可用），已在计划中更正，记为遗漏、未补跑。
- 验证记录（追加）：收尾时机器验收 `pnpm test` 551 passed、typecheck/build 退出 0、check:pi 通过；全量 `pytest eval/tests -q -rw` 首跑 1 failed（`test_run_task.py:202` 起假模型容器的 `docker run` 失败），当时另一组带 Docker 的测试正在同时运行（`fp-run` 标签下 `t12-…` 容器「Up 2 seconds」）；单独重跑 244 passed、无残留。结论：两组 Docker 测试并发争用所致，非代码问题。

| 偏差 | 提议人 | 理由 | 证据 | 确认人 |
|---|---|---|---|---|
| T2 收尾关卡第 7 步「讲解自测」本次免做（workflow 3.4） | 作者 | 作者决定 | 本会话 | 作者 2026-11-28（本会话，「这次免做」） |
| T2 暂不标 `[x]`：验收 6 未满足、2 与 5 部分满足；先推送分支 | 作者 | 作者选择直接推送，不就验收 6 做例外或拆分 | 本会话 | 作者 2026-11-28（本会话，「直接推送」） |
