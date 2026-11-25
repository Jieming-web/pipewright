# 实现说明：T2 评测框架 v1 与基线

- **任务**：tasks.md T2
- **计划**：plans/2026-11-25-T2-eval-framework.md
- **代码版本**：分支 step-02-eval，基于 commit 67e9d8d（T2-0 只写本文档，无代码改动）
- **依据的规范版本**：commit 67e9d8d

> 记录"实际发生了什么"。完成后不修改正文，后续变化只在开头追加说明。本文目前只有「0. 开工核实」，其余章节在后续任务收尾时补写。

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
