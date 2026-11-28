# T2 评测框架 v1 与基线：一条命令在断网的 Docker 容器里驱动 pi 做 SWE-bench 题，在新容器里评分并汇总；框架与冒烟已通，dev-v1 基线未跑完

> 范围：`docs/plans/2026-11-25-T2-eval-framework.md`。已完成的小任务：T2-0 至 T2-15，以及 T2-14b（T2-12、T2-13 按「MVP 里程碑」只做了精简版；T2-15 的 Step 1–3 已勾选，其中 Step 2 要求的 smoke-v1 x86 金标准预检没有单独跑，已在计划里更正为遗漏）。T2-17 收尾关卡已做的部分：整体审查、验收 1–10 核对表、收尾一致性检查都已写进实现说明「T2 收尾（2026-11-28 追加）」。本文是收尾关卡里的 project-log 一项。
> 未完成：T2-16 的 Step 1–5 都没完成。Qwen 组两次开跑都中止了，对账和基线报告都没做；Kimi 组按作者 2026-11-27 的决定推迟，T2 不跑。T2-17 还剩讲解自测和作者同意后标 `[x]`。T2-11 Step 4b 的 GitHub Actions x86 预检被方案 B 取消。整体审查留下的两项 TS 问题推迟到 T2 之后。验收 2、5 只部分满足，验收 6 未满足，见实现说明「验收 1–10 核对」。
> 提交：`15b3f77..90e410c`，共 112 个提交（截至本文提交前）（`git log 15b3f77..HEAD --oneline`）。按类型（统计截至 dbf55d6）：docs 62、fix 25、feat 13、test 5、chore 3、ci 2、build 1。`git diff --stat` 为 119 个文件，+32053/−202，其中 `eval/traces/` 占 47 个文件、+24080 行，是收录的轨迹固定用例。今天收尾写的文档改动（计划、实现说明、proposal）已在 `90e410c` 提交，本文已读。
> 当场复跑（HEAD `dbf55d6`，macOS arm64，Docker 29.3.1）：
> - `pnpm test` → 26 个文件 551/551 通过（89.06 s）；
> - `pnpm typecheck` → 退出 0；
> - `eval/.venv/bin/pytest eval/tests -q -m "not docker"` → 193 passed、51 deselected（168 s）；
> - `pnpm vitest run tests/integration/pi-request-capture.test.ts` → 9/9；
> - `eval/.venv/bin/pytest eval/tests/test_report.py -k end_to_end -q` → 1 passed（59.5 s），跑完后带 `fp-run` 标签的容器和网络都是 0；
> - 第 3 节的离线分析脚本也都跑过，结果与实现说明、执行账本一致。
>
> 未复跑：
> - Docker 全量 `pytest eval/tests` → 引用自执行账本「401/403 中止修复 9907ab6」一行（244 passed，无警告）。9907ab6 之后 `eval/forgepilot_eval`、`eval/tests`、`eval/configs`、`packages` 都没有改动（`git diff --stat 9907ab6..HEAD -- …` 为空）。
> - 所有真实模型运行 → 引用自实现说明「T2-14」「T2-14 补跑」「T2-14b Step 5」「T2-15」「dev-v1 定版」「基线首次开跑 403」「基线第二次开跑与方案 C」各节。
> - 主命令接真实模型的那次运行要 key、要花钱，没有复跑。

本文的证据来源：
- 计划全文；
- `tasks.md` T2 的验收 1–10；
- ADR 005、011、016、017；
- design 3.11；
- 实现说明 `docs/reviews/step02-eval-framework.md`：0 节、各偏差表、T2-14 至「T2 收尾」各节，附录 A/B 没有细读；
- 执行账本 `.superpowers/sdd/2026-11-25-T2-eval-framework/progress.md` 全文，以及同目录的 `request-capture-report.md`、`final-review.md`、`prebaseline-rereview.md`。`external-comparison.md` 只读了开头，作背景用，本文不引用其中任何分数；
- 主入口代码：`eval/forgepilot_eval/{__main__,run_task,sandbox,repo_prep,grade,report,policy,engine_client}.py`、`eval/runtime/*`、`eval/configs/qwen3.6.yaml`。

---

## 1. 这一阶段是怎么完成的

**分工。**
- **作者**：规范、计划、所有取舍决定，以及每个小任务做完后的代码审查。计划里标「作者补」「作者补 2」、偏差表「确认人」一栏写作者的，都是作者的决定。
- **AI（Claude）**：控制会话按计划派子 agent 写代码。每个小任务都经过同一套流程：实现者 → 规格+质量审查 → ponytail 反过度设计审查 → 返修与复审 → 勾选 → 停下等作者。控制会话的裁决记作「Ruling」，在实现说明附录「执行账本转存」里。
- **协作者**：T2-6 至 T2-9 是协作者在 Windows + WSL2 x86 上做完后直接推送的，提交用的是作者本人的 git 身份，也没有实现者报告（执行账本 2026-11-25「远端多出 11 个提交」一行）。作者因此要求补审：并行派 4 名任务审查员和 1 名 ponytail 审查员，控制会话在 Mac 上重跑全量测试。

**推进流程。**

1. **规范 → 计划。**
   - 计划先经过一次子 agent 审查，审查员从资深 agent 工程师的视角看，提出的「必须改」和「建议改」全部采纳。
   - 作者另补了 8 条（作者补 1–8），第二轮又补了预算、续跑一致性、推理 token 等意见（作者补 2）。
   - 动手前定下 D1–D10 十条开工决定：
     - D1 任务容器断网，key 只放在旁路代理里；
     - D2 用 stdio 桥连 runner；
     - D3 新增「模型请求结束」事件；
     - D4 用 swebench 5.x 在新容器里评分；
     - D5 规模与重复次数；
     - D6 留出集暂缓；
     - D7 提示词、工具、采样参数和上限；
     - D8 临时危险命令清单；
     - D9 Python 版本；
     - D10 计分口径。
2. **T2-0 关卡：先核实外部条件，再写代码。** 结论有两类。
   - 会改变方向的发现：
     - `qwen3-coder-next` 在百炼返回 404；
     - Moonshot 已把 `kimi-k2.6` 标为停用；
     - SWE-bench 镜像的 `/testbed` 里留着基准之后的提交和标签（实现说明 0.3、0.8a）。
     - 作者因此写了 ADR 017：不做主模型选型，直接用 Qwen3.6-35B-A3B，Kimi 经百炼调用。
   - 后续任务要以实测为准的事实：
     - swebench 5.0.2 的实际导入路径与计划里的猜测不同（0.2）；
     - 有缓存命中时，`totalTokens = input + cacheRead + output`（0.6）。
3. **T2-1 至 T2-11：先把零件做完。** 顺序是：
   - T1 遗留的 M3、M5；
   - 新事件；
   - stdio 桥；
   - Python 客户端与拦截策略；
   - 运行包；
   - 模型代理；
   - 容器与网络；
   - 历史截断；
   - 评分；
   - 任务集与金标准预检。
4. **MVP 里程碑（作者 2026-11-26）。** 作者认为设计偏重，决定 T2-12、T2-13 先做精简版，再做 T2-14 Mac 冷烟，其余挪后。跑通后作者按「出基线最少需要什么」逐项砍（方案 B，2026-11-27）：
   - 开发集改为 30 题、每题 2 次；
   - 不做并发、运行中预算取消、代理对账；
   - 新增 T2-14b：重复、统计、极简续跑、Kimi 冒烟。
5. **上服务器。** 作者决定只跑 Qwen，租阿里云香港 x86 服务器。在服务器上依次做了：
   - x86 冒烟；
   - dev-v1 定版；
   - 整体审查后的修复；
   - 两次基线开跑，两次都中止；
   - 离线成本诊断。
6. **收尾方案 C（作者 2026-11-28）。** 先做不依赖基线的收尾项；验收 2、5、6 等基线跑完再补。

**验证手段。**
- **先 RED 再实现。** 每个小任务都记录 RED 现象。T2-1 的 Step 3 甚至写明了「现象和这里写的不一样就停下」。
- **变异检查。** 举三个例子：
  - T2-9 做了 11 项变异，全部被测试抓住；
  - T2-7 做了 4 项；
  - T2-8 第一次「把 key 放进命令行参数」的变异**没被抓住**，因为 `docker inspect` 看不到 CLI 参数。测试改成监视每次 docker 调用的 argv 之后才抓住（计划 Task 8 勾选记录）。
- **小批量先验。** 规模一步步放大：
  - Mac 上 1 个实例的冒烟；
  - 补跑一次，专门在运行中的容器里核对 `docker top` 和 curl；
  - x86 冒烟；
  - dev-v1 的 30 个镜像先各跑一遍截断检查（整体审查 I3）；
  - 才开跑基线，并预先定好刹车规则：前 5 题跑完后按实际花费推算全程，超过报价 2 倍就先停（控制会话提出，作者同意报价时一并接受）。
- **真实镜像核对。** 用 swebench 镜像和 Epoch 镜像各测一遍有效基准与截断，发现了合成仓库里没有的两类问题：老提交带 badTimezone，以及全零的坏引用 `origin/HEAD`（计划 Task 9 勾选记录）。

**弯路、返修与决定（谁决定的）。**
- **评测协议层的错误会悄悄污染分母。** 一共四处，前三处由整体审查（AI 子 agent，`final-review.md`）报出，第四处在开跑时撞上：
  - 代理容器挂掉后，后续运行都会被记成 `run_failed` 留在分母里（I1）；
  - 限流正则 `429|rate.?limit` 会匹配 `264292` 这样的数字，把真实失败记成限流后排除，抬高成功率（M2）；
  - 尝试目录被整个可写地挂进容器，agent 可以放符号链接，让宿主机（服务器上是 root）写任意路径（I2）；
  - 第一次开跑基线时，百炼对每个请求返回 403（账号开着「仅用免费额度」），每题都会记成 `run_failed`，悄悄产出 0% 的基线。
  - 处理：前三处由作者决定修法（模型服务出错算 `infra_error`，并先改 design 3.11；挂载改为子目录；每次尝试前检查代理）。403 一处由作者决定「401/403 立即中止整次评测」（`9907ab6`）。
- **T2-6 的真 bug 到 T2-13 才暴露。** `fp-env.sh` source conda activate 时不带参数，runner 的参数被当成了 activate 的参数，每次真实运行都会 `infra_error`。T2-6 的测试只测了无参调用，T2-12 用的又是没有 conda 的镜像，所以都没抓到。按 workflow 3.3 先写复现测试再修（`86eb4d1`）。
- **冒烟集从 2 题缩成 1 题（作者决定）。**
  - 3 个候选里，django-11099 空补丁时有一条 FAIL_TO_PASS 照样通过；requests-2317 的测试依赖外网。两者都不满足入选标准。
  - 剩下的 astropy-12907 在 Epoch arm64 镜像里工作区不干净。作者再决定：Mac 改用官方 arm64 镜像，并定下规则「工作区不干净就报错」。
- **dev-v1 第一次定版失败。** Docker Hub 匿名拉取被限流，17 个候选无法测量。作者亲手在服务器上 `docker login` 后，用同一种子重跑，用时 2989 秒。
- **第二次开跑：首题就超支。** 首题 `astropy__astropy-13579` 用了 93 次请求、13.50 元。控制会话按事先定的刹车规则停下。作者先选了方案 C（工具上限 100 → 40），离线分析之后又撤回，恢复 100。理由是：13579 是 dev-v1 里唯一的「1-4 hours」题；100 次上限已经把单题花费封顶在约 11–16 元；上限 40 会截断难题（实现说明「T2 收尾」偏差表）。
- **作者在 T2-6~9 补审后新加了一条硬规则**：偏离计划必须留记录，写明提议人、理由、证据和确认人；没有作者确认不得勾选；「作者决定」只能写在有作者原话的地方（workflow 3.3，提交 `a04fc7e`）。

**一条可迁移的经验。** 评测框架最危险的不是崩溃，而是**状态显示 complete、分母却悄悄错了**。上面四处问题，每一处都不会报错，只会让数字偏高或偏低。所以要把「这次失败算谁的」写成规则，而且先写进规范：
- agent 的失败留在分母里；
- 基础设施失败重试后排除，并逐条列出；
- 账号级错误直接中止整次评测。

然后对每条规则都要有测试和反例（比如 `264292` 不能被当成 429）。

---

## 2. 整体目标和核心逻辑

### 2.1 目标与交付物

**目标**（tasks.md T2）：建立之后每一项改动的「尺子」。一条命令跑完版本化的 SWE-bench 任务集，输出：
- 成功率：均值、波动与区间；
- token、轮数、耗时、失败类型、花费；
- 完整轨迹。

并产出 Qwen 主模型的开发集基线报告。

**交付物**（✓ 已交付，✗ 未交付）：

| 项 | 状态 | 证据 / 口径 |
|---|---|---|
| Python 评测框架 `eval/forgepilot_eval/` | ✓ | 11 个文件，本阶段 +1503 行；测试 `eval/tests/` 10 个文件 +2564 行（`git diff --numstat`） |
| TS 侧：stdio 桥 `packages/engine-client/src/stdio-bridge.ts`、契约事件 `model.request.finished`、诊断文件打开时限（M3） | ✓ | 契约 `engine.md`、`agent-events.md` 自 T2-4 之后没有再改（实现说明「收尾一致性检查」） |
| 模型代理 `eval/runtime/model-proxy.mjs`、运行包脚本 `scripts/build-eval-bundle.sh`、启动脚本 `fp-entry.sh` / `fp-env.sh` | ✓ | node、rg 的 sha256 与官方校验文件一致；fd 没有官方校验文件，用 GitHub API 的 digest（作者确认） |
| 评测配置 `eval/configs/qwen3.6.yaml`、`kimi-k2.6.yaml` | ✓ | 采样参数取自模型卡里 SWE 评测所用的值，出处写在配置注释里 |
| 任务集 `smoke-v1` | ✓ | 1 题（astropy-12907），sha256 `7462bbd3…6ecd` |
| 任务集 `dev-v1` | ✓ | 30 题，覆盖 11 个仓库；45 个候选中 44 个通过预检，排除 `psf__requests-1921`；种子 20261125；sha256 `e9c3137d…e002`（实现说明「dev-v1 定版」） |
| 真实冒烟 4 次 | ✓ | 都是 resolved 1/1。Mac Qwen 两次 0.4198 元、0.7642 元；Mac Kimi 1.0566 元；x86 Qwen 0.7732 元 |
| 离线诊断：`scripts/run-anatomy.py`、`scripts/context-replay.py`、`tests/integration/pi-request-capture.test.ts`、`eval/traces/`（4 次运行，4.5 MB） | ✓ | 只读已有文件，不调用 API |
| dev-v1 上的 Qwen 基线（30 题 × 2 次） | ✗ | 两次开跑都中止：一次全部 403、花费 0；一次只跑完首题，13.50 元 |
| 基线报告 `docs/evals/<日期>-T2-baseline.md`、账单对账 | ✗ | 没写，也没对账 |
| Kimi 组 | ✗（推迟） | tasks.md 验收 6，作者 2026-11-27 |

本阶段真实模型的花费：上表 4 次冒烟加 13579，按单价估算约 16.5 元（4 次冒烟加 13579 的 `actual_cost` 相加），**未经账单核对**。实现说明还注明，Mac 冒烟的花费可能被免费额度抵扣了。T2-0 的探测请求没有单独记花费。

### 2.2 主入口

```bash
PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run \
  --config eval/configs/qwen3.6.yaml \
  --taskset eval/tasksets/dev-v1.json \
  --repeats 2 \
  --out eval/runs/<名字> \
  [--env-file <.env 路径>] [--resume] [--yes]
```

- 入口是 `eval/forgepilot_eval/__main__.py` 的 `main()` → `run_eval()`。
- 退出码：
  - 0：评测完整，并且 check-secrets 扫描干净；
  - 1：评测无效、扫描发现问题、用户取消，或模型服务返回 401/403 而中止；
  - 2：开跑前的检查没通过。
- `--env-file` 默认是仓库根的 `.env`。key 只从这个文件读，也只交给代理容器。

### 2.3 流程图

```
任务集 JSON（instance_ids、每平台 name@digest、probe_blobs）+ 配置 YAML + .env 里的一个 key
  │
  ▼  开跑前检查 ──[校验关口] 运行包有 bin/fp-entry 与 VERSION？本平台有镜像？.env 有 key？
  │               --out 已存在且没带 --resume → 拒绝；带了 --resume → 核对 run.json 四项
  ▼  打印预计花费（题数 × 重复 × assumed_tokens_per_run）──[人工关口] 等确认（--yes 跳过）
  ▼  start_proxy：代理容器 fp-proxy-<run>，接 internal 网络和本次专用的出网网络，key 用 -e 变量名传入
  │
  ├─ for 每次重复 k，for 每道题（rep-k/<id>/done.json 已存在就跳过）:
  │    for 每次尝试（D10：infra_error / rate_limited 最多重试 2 次）:
  │      ──[校验关口] 代理还在运行吗？不在就中止，不写 done.json
  │      Sandbox：新容器，只接 --internal 网络，/fp 只读，/fp-out = 尝试目录下的 fp-out/
  │        ├ resolve_effective_base ──[校验关口] 工作区干净？base_commit 是 HEAD 或其祖先？
  │        ├ truncate_history + verify_truncated ──[校验关口] 只剩 fp-base？金标准 blob 查不到？
  │        ├ docker exec -i … /fp/bin/fp-entry → stdio 桥 → runner → pi（模型请求 → 代理 → 百炼）
  │        │    每次工具调用 → intercept_request → Policy.decide（工具白名单 / 危险命令 / 100 次上限）
  │        ├ _classify：timeout / tool_budget / run_failed / rate_limited / infra_error / none
  │        │    ──[校验关口] 401/403 → ProviderAccessError，中止整次评测
  │        └ extract_patch（git add -A && git diff --cached --binary <有效基准>）→ 删容器
  │      failure_type == none → grade：同一镜像的新容器、默认网络、swebench 的回退链和 eval_script
  │           评分阶段的 infra_error 只重新评分（最多 2 次），不重跑 agent
  │    ──[校验关口] 再查一次代理 → 写 done.json
  ▼  aggregate：D10 排除 → 成功率、每次重复的均值与样本标准差、按题 bootstrap 95% 区间、token/轮数/耗时、失败计数、花费
  ▼  summary.json / summary.md
  ▼  finally（含异常和 SIGTERM）：存 proxy.jsonl → check-secrets 扫描 ──[校验关口] → cleanup_run 按标签删容器与网络
```

### 2.4 内部逐步做了什么

1. **开跑前检查**（`__main__.py` `run_eval`）。
   - **做什么**：确认运行包、本平台镜像和 key 都在；带 `--resume` 时，核对 `run.json` 的 `config_hash`、`taskset_sha256`、运行包 `VERSION`、`repeats` 四项。
   - **为什么**：路径写错时要在启动任何容器之前就失败；配置变了还续跑，会把两种口径混进同一个分母。
   - 预计花费按 `assumed_tokens_per_run` 计算，假设的来源也一起打印出来。Qwen 当前的值是 400000 输入 + 13000 输出，来源是 smoke-2026-11-26 的实测 ×2。
2. **代理**（`sandbox.py` `start_proxy`、`eval/runtime/model-proxy.mjs`）。
   - **做什么**：
     - 只放行 `POST /<route>/chat/completions`；
     - 把 `model` 改写成固定 ID；
     - 删除联网搜索类参数；
     - 写入采样参数 `temperature`、`top_p`；
     - 换上真实的 key；
     - 每个请求写一行日志，只记字段名、采样参数和状态码。
   - **为什么**：任务容器里不能有 key，也不能上网。另外 pi 1.5.1 不发 `top_p`，只有调用参数带 `temperature` 时才发它（T2-12 偏差表），所以采样参数由代理写进去，不改契约。
   - 代理不接 Docker 默认网络，因为评分容器在默认网络里运行 agent 写的代码（T2-7 审查发现，作者决定）。
3. **任务容器**（`sandbox.py` `Sandbox`）。
   - **做什么**：用 `docker run -d --network fp-eval-<run>` 启动，这个网络是 `--internal`；`-v bundle:/fp:ro`；`-v <尝试目录>/fp-out:/fp-out`；容器带 `fp-run=<run>` 标签。
   - **为什么**：容器里访问 github、`host.docker.internal`、1.1.1.1 都必须失败（T2-14 补跑：curl 退出码 6/6/7）。只挂 `fp-out` 子目录，宿主机自己写的文件就不会被容器里的符号链接劫持（I2 修复）。
   - 运行包里的 node、rg、fd、runner 由 `scripts/build-eval-bundle.sh` 打包；`fp-env.sh` 先激活 testbed 的 conda 环境，所以 agent 跑的 `python` 是 `envs/testbed` 里的那个。
4. **有效基准与历史截断**（`repo_prep.py`）。
   - **做什么**：
     - 有效基准取容器启动时的 HEAD（作者 2026-11-25 指出：swebench 镜像的 HEAD 是 `base_commit` 之上一个叫 `SWE-bench` 的环境提交，不能把它当成泄露删掉）；
     - 只留 `fp-base` 分支，删掉其余引用、`.git/refs` 下 for-each-ref 看不到的坏引用、`packed-refs` 里多余的条目、伪引用；
     - `reflog expire` 后 `gc --prune=now`；
     - 最后自检四项：`rev-list --all --not <基准>` 为空；只剩 `fp-base` 一个引用；`fsck --connectivity-only --unreachable` 为空；任务集里的金标准 blob 用 `cat-file -e` 查不到。
   - **为什么**：镜像里带着修复之后的提交和标签（0.3），agent 执行 `git log --all` 就可能看到答案（验收 8）。自检不通过就抛 `HistoryLeak`，这类镜像的确定性问题不重试。
5. **跑 agent**（`engine_client.py` `run_task`、`packages/engine-client/src/stdio-bridge.ts`）。
   - **做什么**：
     - Python 用 `docker exec -i <容器> /fp/bin/fp-entry <runner 参数>` 启动 stdio 桥，一行一条协议消息；
     - 读线程把 stdout 的行放进队列，主循环带超时取出；
     - 到墙钟上限（1800 s）或工具调用超限，就写 `cancel`；之后 15 秒还没有终止事件，就删容器、杀掉桥进程。
   - **为什么**：协议本身不变（T1 的 WebSocket 帧，原样换成 JSON 行），runner 仍只监听容器内的 127.0.0.1。评测框架不导入任何 TS 代码，T12 接 Claude Code 时不需要改它（验收 7）。
   - agent 循环、工具和重试都由 **pi 1.5.1 提供**，本项目只负责驱动和拦截。
6. **拦截策略**（`policy.py`）。
   - **做什么**：
     - 未激活的工具拒绝；
     - bash 命令在「命令位置」命中危险清单就拒绝：命令位置指开头，或 `;`、`&`、`|`、换行、`$(`、反引号之后，单引号里的分隔符不算；
     - 第 101 次调用拒绝，并置 `exhausted`，由 `should_cancel` 取消任务。
   - **为什么**：既要拦住真正危险的命令，又不能误拦 `grep -rn "curl" .` 这类命令，误拦会悄悄拉低成功率。已知不拦的情况（`sudo curl`、`bash -c '…'`、绝对路径等）写进 D8 并接受，因为容器本来就断网，T3 起会由策略服务替换。
7. **分类与取补丁**（`run_task.py` `_classify`、`extract_patch`）。
   - **做什么**：用最后一次请求的 `errorMessage` 区分：
     - 独立的 `429` → `rate_limited`；
     - `5xx` 或 `Connection error.` → `infra_error`；
     - `401/403` → 中止整次评测；
     - 其余 → `run_failed`。

     取补丁用 `git add -A && git diff --cached --binary <有效基准>`，经 base64 传出。
   - **为什么**：`add -A` 会带上新建文件和二进制文件；`.gitignore` 忽略的构建产物不进补丁，这是有意的。除 `infra_error` 外，所有运行都取补丁，留作诊断。
8. **评分**（`grade.py`）。
   - **做什么**：用同一镜像新建容器，不挂运行包；沿用 swebench 的 `GIT_APPLY_CMDS` 回退链打补丁，每次重试前还原工作区；用 `exec_run_with_timeout` 跑 `make_test_spec(inst).eval_script`，再用 `get_eval_report` 判定。
   - **为什么**：不信任 agent 容器里的任何结果。打补丁、跑测试、判定的逻辑都**由 swebench 5.0.2 提供**。本项目的有意差异写在 T2-10 偏差表里：
     - 不加 `SYS_ADMIN`；
     - `image_assets` 不为空时直接报错；
     - swebench 报 `infra_failure` 时记 `infra_error` 并排除，官方是留在分母里的。
9. **汇总**（`report.py` `aggregate`）。
   - **做什么**：
     - D10 排除：`infra_error`、`rate_limited` 重试后仍失败的记为「无法测量」，逐条列出；超过 5% 就判无效；
     - 非冒烟集出现非 amd64 的评分结果，也判无效；
     - 每次重复算一个成功率，给出均值与样本标准差（ddof=1）；
     - 按题做 bootstrap，重抽样 10000 次，种子 0；
     - 花费按 `input + cacheRead + cacheWrite` 计输入价、`output` 计输出价，`reasoning` 已含在 `output` 里，不重复计。
   - **为什么**：见 4.5、4.6。
10. **收尾**（`__main__.py` 的 `finally`）。
    - **做什么**：依次存代理日志、做 check-secrets 扫描、`cleanup_run` 按标签清理；SIGTERM 也映射成 `sys.exit(143)`，走同一个 finally。
    - **为什么**：结果先落盘再清理；清理时出的错不能盖掉原始异常。

---

## 3. 手动实践

下面 5 步都不需要 API key，也不花钱。我在本工作区逐条跑过（HEAD `dbf55d6`），每条都写了实际结果。只有第 4 步需要 Docker Desktop 在运行。

### 步骤 1：看 pi 把上一轮的思考原样发回去（假模型，约 1 秒）

```bash
cd <工作区根>
pnpm vitest run tests/integration/pi-request-capture.test.ts
```

- **实际结果**：`Tests 9 passed (9)`。
- **再看哪里**：打开这个测试文件，找断言第 2 个请求体里 assistant 消息带 `reasoning_content: "SECRET-THOUGHT-1"` 的用例。
- **看懂什么**：pi 1.5.1 会把上一轮的思考作为 `reasoning_content` 回传（`request-capture-report.md`）。在测试过的关闭方式里，compat 标志、模型字段、思考级别都关不掉它，只有用扩展的 `context` 事件删掉才行。
- **注意**：这些测试只证明「请求体里有这段思考」，**不证明百炼会对它计费**（见第 5 节的边界）。

### 步骤 2：直接调用拦截策略，看哪些命令被拦（不需要 Docker）

```bash
PYTHONPATH=eval eval/.venv/bin/python -c "
from forgepilot_eval.config import load_config
from forgepilot_eval.policy import Policy, PolicyConfig
cfg = load_config('eval/configs/qwen3.6.yaml')
p = Policy(PolicyConfig(cfg.tools, cfg.danger_patterns, cfg.max_tool_calls))
for c in ['grep -rn \"curl\" .', 'echo git pushd', 'ls; curl x', 'rm -rf \"/\"', 'sudo curl x', 'grep -E \"wget|curl\" .']:
    print(repr(c), '->', p.decide({'toolName':'bash','input':{'command':c}}))
print('powershell ->', p.decide({'toolName':'powershell','input':{}}))
"
```

实际输出（`rm -rf "/"` 那行的 reason 很长，这里省略）：

```
'grep -rn "curl" .' -> {'decision': 'allow'}
'echo git pushd' -> {'decision': 'allow'}
'ls; curl x' -> {'decision': 'block', 'reason': "dangerous command (matches 'curl')"}
'rm -rf "/"' -> {'decision': 'block', ...}
'sudo curl x' -> {'decision': 'allow'}
'grep -E "wget|curl" .' -> {'decision': 'allow'}
powershell -> {'decision': 'block', 'reason': 'tool not enabled: powershell'}
```

- **看懂什么**：
  - 引号里的 `|` 不算命令位置，所以 `grep -E "wget|curl"` 放行；
  - `rm -rf "/"` 引号里的内容照样参与匹配，所以被拦；
  - `sudo curl x` 放行，这是 D8 写明接受的已知不拦。

### 步骤 3：用 13579 的轨迹做反事实重放（纯 Python 标准库，约 0.1 秒）

```bash
T=eval/traces
python3 scripts/context-replay.py $T/2026-11-28-astropy-13579-qwen3.6-cap100/rep-1/astropy__astropy-13579/1 \
  --out /tmp/fp-replay \
  --fit $T/2026-11-26-smoke-astropy-12907-qwen3.6-mac-a/astropy__astropy-12907/1 \
        $T/2026-11-26-smoke-astropy-12907-qwen3.6-mac-b/astropy__astropy-12907/1 \
        $T/2026-11-27-smoke-astropy-12907-qwen3.6-x86/rep-1/astropy__astropy-12907/1
```

产物在 `/tmp/fp-replay/`：`replay.md`（结论表）、`replay.csv`（逐轮输入）、`replay.svg`（曲线）。stdout 打印的就是 `replay.md`。实际结果中的关键行：

- `α = 0.314 token/字符`（R² 0.977，154 个点）；重建校验：总输入 7,034,357，与实际值相同；
- 基线 13.50 元（如果按隐式缓存 20% 计价是 3.45 元）；只留最近 5 条工具输出 9.04 元；单次输出截断到 4k 字符 10.90 元；pi 压缩在 contextWindow 65536 时 7.12 元、49152 时 6.51 元；
- 来源分解：13579 的系统提示与题目占 5%、工具结果 39%、文字与调用参数 36%、思考内容 19%；

**改一处看变化**：去掉 `--fit` 及其后的三个目录，只用 13579 一条轨迹来拟合。我跑出的结果是 α 变为 0.297（R² 0.975，92 个点），「只留最近 5 条」变为 9.29 元。说明 α 依赖拟合用的样本，所以重放出来的数字只是估计。

### 步骤 4：解剖一次运行（需要联网读 HF 数据集取题目难度，不需要 key）

```bash
PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py \
  eval/traces/2026-11-28-astropy-13579-qwen3.6-cap100/rep-1/astropy__astropy-13579/1 --out /tmp/fp-anatomy
```

- 产物在 `/tmp/fp-anatomy/`：`summary.md`、`tokens.csv`、`tokens.svg`、`steps.csv`、`tail.csv`。运行时会打印 HF 未认证的警告，不影响结果。
- 先看 `summary.md` 的四处：
  - 第 1 节：模型请求 93 次，`tool.started` 也是 93，拦截计数 90，差的 3 次是 edit 参数校验失败，这类调用不经过拦截回调；
  - 第 2 节：每次请求的输入按 **1,252 token/轮** 线性增长（R² 0.992），首轮 3,837、末轮 129,509，而且单调不减，说明没有发生过压缩；
  - 第 4 节：步骤标签里「探查」占 59 步；
  - 第 5 节：题目难度 `1-4 hours`；金标准补丁只改 1 个文件（+3/−1）；agent 第 3 步就读到了这个文件，第 19 步首次编辑它。

### 步骤 5：假模型端到端，走一遍主命令（需要 Docker Desktop，约 1 分钟）

```bash
eval/.venv/bin/pytest eval/tests/test_report.py -k end_to_end -q
docker ps -a --filter label=fp-run -q | wc -l      # 应为 0
docker network ls --filter label=fp-run -q | wc -l # 应为 0
```

- **实际结果**：`1 passed, 33 deselected in 59.50s`，两个计数都是 0。
- **测试做了什么**（`test_report.py` `test_end_to_end_smoke_with_fake_model`）：
  - 在 egress 网络里起一个假模型容器，脚本两轮：先 `bash: echo fix > new_file.py`，再回答 `done`；
  - 把配置里的百炼地址换成假模型地址；
  - 直接调用 `cli.main(["run", …, "--yes"])`，跑的是真实的 smoke-v1 镜像、真实的截断、真实的 swebench 评分。
- **首次运行要注意**：conftest 的 `bundle` fixture 会先重建 `eval/.cache/bundle-linux-arm64`；本机还要已有 astropy-12907 的 arm64 镜像，没有的话会先拉取，时间会长很多。
- 产物在 pytest 的 `tmp_path` 下，即 `pytest-of-<用户>/pytest-N/test_end_to_end_smoke_with_fak0/`：

```
.env  c.yaml  fake/{fake.mjs,turns.json}
t13-<8 位>/
├── run.json  proxy.jsonl  summary.json  summary.md
└── rep-1/astropy__astropy-12907/
    ├── done.json
    └── 1/
        ├── events.jsonl  patch.diff  record.json
        ├── fp-out/{models.json,raw.jsonl}     ← 只有这个子目录挂进了容器
        └── grade/1/{grade.log,report.json}
```

- **先看** `summary.md`。我这次看到的是：状态 complete；成功率 0.0%（resolved 0 / 分母 1）；`unresolved: 1`；预计花费 0.86 元；实际花费 0.0000 元。成功率为 0 是对的：假补丁只新建了 `new_file.py`，没有修 bug。这正说明评分是真的在判对错，而不是只要有补丁就算通过。
- **再看** `fp-out/models.json`：`apiKey` 是字面串 `unused`，真实的 key 只在代理容器里。

### 未验证：真实模型主命令

`PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run --config eval/configs/qwen3.6.yaml --taskset eval/tasksets/smoke-v1.json --out eval/runs/smoke-<日期> --env-file <.env 路径>`

这条命令需要 `DASHSCOPE_API_KEY`，按校准值每次约 0.86 元。本次**没有跑**，结果引用自实现说明「T2-14」。

---

## 4. 重点学习内容

### 4.1 断网的任务容器 + 旁路模型代理：key 不进容器，agent 也上不了网

- **它解决什么问题**：
  - agent 能上网，就能直接从 GitHub 拿到修复提交；
  - key 放进任务容器，agent 的 `env` 或 `cat` 就能读到它。
- **怎么做**：
  - 任务容器只接 `docker network create --internal` 建的网络；
  - 代理容器同时接 internal 网络（别名 `fp-model-proxy`）和本次专用的出网网络，不接默认网络；
  - key 用 `docker create -e DASHSCOPE_API_KEY` 传给代理，只写变量名，值从子进程环境继承，所以不出现在命令行参数里；
  - runner 读到的 `models.json` 里，`apiKey` 是字面串 `unused`。
- **为什么不用备选方案**：
  - 「容器能上网，但在工具策略里拦 curl」靠不住：D8 的已知不拦清单已经说明，`sudo curl`、`bash -c` 都能绕过。网络层隔离不依赖命令解析。
  - 「`DOCKER_HOST=ssh://` 远程驱动」被 design 3.11 否了：绑定挂载解析的是远端路径，笔记本休眠也会中断长跑。
- **仓库里的例子**（`sandbox.py` `start_proxy`）：

```python
passthrough = [a for k in ["FP_PROXY_ROUTES", *env] for a in ("-e", k)]
_docker("create", "--name", name, "--label", f"{LABEL}={run}",
        "--network", net, "--network-alias", PROXY_ALIAS,
        *passthrough, PROXY_IMAGE, "node", "/model-proxy.mjs", env=child_env, timeout=600)
```

- **测试怎么证明 key 不进 argv**：T2-8 起初用 `docker inspect` 检查，结果「把 key 改成 `-e K=V`」的变异没被抓住；改成监视每次 docker 调用的 argv 才抓住。变异检查测出了**测试本身**看不见的地方。

### 4.2 有效基准 + 历史截断 + 金标准 blob 探针：在沙箱里用 git 查不到答案

- **它解决什么问题**：SWE-bench 镜像不是浅克隆。以 requests 为例，`git rev-list --all` 有 6299 条，而 HEAD 的祖先只有 3690 条（0.8a），修复之后的提交仍能从标签等引用到达。
- **怎么做**：见 2.4 第 4 步。关键是「以哪个提交为基准」：
  - swebench 镜像的 HEAD 比 `base_commit` 多一个环境提交；
  - Epoch 镜像的 HEAD 就是 `base_commit`。

  评分也是在容器启动时的 HEAD 上打补丁，所以截断、自检、取补丁都用这个 HEAD（作者指出，Review Focus 3）。
- **为什么不用备选方案**：
  - 只删标签不 gc：对象还在，`git cat-file` 照样能读到。变异「不 gc」让 5 条测试失败。
  - 浅克隆重建仓库：会改变镜像里的仓库状态，评分时补丁可能对不上。
  - 只信 `for-each-ref`：requests x86 镜像里有一个 for-each-ref 看不到的全零 `refs/remotes/origin/HEAD`，所以截断脚本要直接删 `.git/refs` 下的文件。
  - 金标准 blob 探针是最后一道保险：引用删干净了，修复后的文件内容也必须查不到。
- **仓库里的例子**：dev-v1 的 30 个镜像各跑一遍 `resolve_effective_base` + `truncate_history`，全部通过，每题 1–7 秒（实现说明「dev-v1 定版」，整体审查 I3）。

### 4.3 stdio 桥：换传输方式，不换协议

- **它解决什么问题**：T1 的 runner 讲 WebSocket，只监听 127.0.0.1。Python 在容器外，又不能导入 TS（验收 7）。
- **怎么做**：
  - 桥在容器内启动 runner，用 `spawnRunner` 的 `listening` 拿到端口，再用 `ws` 直连；
  - stdin 每行作为一个文本帧发出，每个收到的帧写成一行 stdout；
  - 帧里含换行时以 2 退出；runner 被强杀时退出码为 137。

  Python 侧只用 `subprocess` + 读线程 + 队列。
- **为什么不用备选方案**：
  - 「把 runner 端口映射到宿主机」：要打开端口，而任务容器只接 internal 网络，宿主机连不进去。
  - 「Python 直接调 pi SDK」：违反验收 7，T12 换 Claude Code 时就得改评测框架。

  桥只有 57 行（`stdio-bridge.ts`），协议消息原样透传。
- **一个容易漏的点**（作者对 T2-5 的要求）：桥一直不输出时，主循环也不能卡在 `readline()` 上。测试用一个「忽略 stdin、永不输出」的假桥，断言 `run_task` 在 `timeout_s + grace_s + 2` 秒内返回，并且 `kill` 被调用过（计划 Task 5）。

### 4.4 在新容器里评分，并明确写出与 swebench 官方的差异

- **它解决什么问题**：agent 容器里的测试结果不可信，agent 可能改了测试文件或环境。
- **怎么做**：
  - 用同一镜像新建容器，走默认网络，不挂运行包；
  - 打补丁、跑 `eval_script`、`get_eval_report` 判定，都**直接用 swebench 5.0.2**；
  - 本项目只多做了几件事：每次重试前还原工作区；区分「容器坏了」和「补丁打不上」；记录评分用的镜像名、digest 和架构。
- **为什么不自己写判定**：用官方判定，结果才能和 SWE-bench 的定义对齐。偏离官方的每一处都写进 T2-10 偏差表，由作者附条件确认：
  - 不加 `SYS_ADMIN` 的条件是：定版任务集的每个实例，金标准补丁在不加 `SYS_ADMIN` 时 FAIL_TO_PASS 必须全部通过；
  - `infra_failure` 排除这一条，要在报告里注明与官方算法不同。
- **入选标准的关键一条**：空补丁时，FAIL_TO_PASS 的**每一条**测试都必须失败。django-11099 就因为空补丁时有一条照样通过而被排除。这条证明评分器真的在区分对错。

### 4.5 计分口径（D10）：「失败」「无法测量」「中止」三种结果分开

- **它解决什么问题**：Docker 抖一下、Docker Hub 限一次流，都不应该算成模型能力差；反过来，账号额度用完也不能算成「模型 0 分」。
- **怎么做**：

| 结果 | 怎么处理 | 来源 |
|---|---|---|
| `patch_apply_failed`、`empty_patch`、`run_failed`、`timeout`、`tool_budget` | 算失败，留在分母里 | D10 |
| `infra_error`（含上游 5xx、代理 502、连接不上）、`rate_limited`（独立的 429） | 重试 2 次，仍失败就记为「无法测量」，排除并逐条列出；超过 5% 判整次无效 | D10，design 3.11（作者 2026-11-27） |
| 401/403 | 立即中止整次评测，不写这道题的 `done.json`，修好后可以续跑 | design 3.11（作者 2026-11-28） |
| BaseMismatch、HistoryLeak、工作区不干净 | 镜像的确定性问题，不重试 | 作者 2026-11-26 |

- **为什么不像 swebench 官方那样留在分母里**：基线是以后配对比较的参照，一次 Docker 故障不能被读成「新版本变差了」。design 3.11 另外规定，配对比较时只要有一格无法测量，结论就是「不确定」，不能拿剩下的格子求平均。
- **仓库里的例子**（`run_task.py`）：

```python
RATE_LIMIT = re.compile(r"\b429\b|rate.?limit", re.I)  # 独立的 429，不匹配 264292 这类数字
MODEL_SERVICE_ERROR = re.compile(r"(?:5\d\d\b|Connection error\.)")
ACCESS_DENIED = re.compile(r"40[13]\b")
```

### 4.6 统计：每次重复的均值与标准差，加按题 bootstrap 区间

- **它解决什么问题**：30 道题、每题 2 次，单个成功率的波动很大，需要说清楚「这个数有多不确定」。
- **怎么做**：
  - 每次重复各算一个成功率，给出均值和样本标准差（ddof=1；N=1 时标准差为空）；
  - 另外先算每道题在各次可测重复里的平均成功，再对题目重抽样 10000 次，种子 0，取 2.5% 和 97.5% 分位。
- **为什么用按题 bootstrap，而不是只看重复之间的标准差**：方案 B 的理由是，40 题、成功率约 40% 时，按题抽样的误差约为 ±8 个百分点。从 2 次加到 3 次，压不下这部分误差。误差的主要来源是「抽到哪些题」，而不是「同一道题跑几次」，所以区间要对题目重抽样。
- **已知的小问题**（推迟的 minor）：百分位下标不对称（250 和 9749），报告里的说法与实现不完全相符。
- **例子**：`report.py` 的 `bootstrap_ci95`。T2-14b 的测试用例：2 次重复成功率为 [0.5, 0.25] 时，均值 0.375、样本标准差约 0.1768；全对时区间为 [1, 1]。

### 4.7 成本诊断：无缓存时每轮重发整段历史，输入随轮数近似平方增长

- **它解决什么问题**：冒烟题只有 18–29 轮，按它校准的报价是 51.62 元。dev-v1 首题却跑了 93 轮，单题就花了 13.50 元。
- **事实**（实现说明「基线第二次开跑」、`run-anatomy` 输出）：
  - 百炼上的 qwen3.6-35b-a3b 不支持缓存（0.6）；
  - pi 每轮都把整段历史重发一遍，每轮输入约增长 1,252 token，所以累计输入近似随轮数平方增长：第 20 次请求时累计 58 万，第 50 次时 244 万；
  - pi 的自动压缩阈值是 contextWindow − reserveTokens = 262144 − 16384 = 245760，而这次的最大单轮输入是 129509，没有达到阈值，所以压缩没有触发（执行账本离线第 1–2 项）。
- **怎么做诊断**：只读已有轨迹，不改产品代码，不调用 API（作者 2026-11-28 指示）：
  - `run-anatomy.py` 做计数与分解；
  - `context-replay.py` 拟合「每字符工具输出 ≈ α token」，在**轨迹不变**的前提下重算各种上下文策略要发多少 token；
  - 请求捕获测试核实 pi 把思考作为 `reasoning_content` 回传。
- **为什么先做离线分析、不直接把上限压到 40**：上限 40 会截断难题、压低基线成功率，而且只按 dev-v1 唯一一道「1-4 hours」题来推算。离线按难度分布预测 30 × 1 约 11–141 元，100 次上限已经把单题封顶在约 11–16 元，所以作者撤回了方案 C。
- **这个方法的局限**写在 `context-replay.py` 的文件头里：丢上下文的策略在真实运行中可能让 agent 多走几轮，甚至改变成败，所以重放出来的数字**既不是花费上界，也不能预测成功率**。

### 4.8 把 AI 写的代码和别人推的代码审到可信

- **它解决什么问题**：
  - 代码是 AI 写的，测试也是 AI 写的，「测试通过」本身不够；
  - 协作者推的 4 个小任务没有任何过程记录。
- **怎么做**：
  - 每个小任务都有 RED 记录和变异检查；控制会话自己复跑全量测试，不只信实现者的报告；
  - 规格+质量审查与 ponytail 审查分开派；同一任务返修最多 3 轮（T2-14b 正好用满 3 轮）；
  - 协作者的提交按作者要求并行补审（4 名任务审查员 + 1 名 ponytail 审查员）。补审在 Mac 上发现 `tar --wildcards` 不受 macOS bsdtar 支持，导致 24 个 docker 用例在 Mac 上一条都没跑起来（执行账本「控制会话本机全量」一行）。
- **为什么不只靠整体审查**：整体审查只在最后做一次，越晚发现的 bug，修复成本越高。fp-env 的 bug 从 T2-6 拖到 T2-13 才被发现，就是因为前两次测试用的镜像都没有 conda。
- **例子**：T2-9 的变异清单，11 项全部被抓住：不 expire reflog（3 条测试失败）、不 gc（5）、自检漏 fsck（1）、`extract_patch` 不 `add -A`（3）……其中「只在 update-ref 一处放过标签」没有让测试失败，原因已经查明：后面的删文件和重写 packed-refs 仍会删掉标签，属于纵深防御，不是漏测。

---

## 5. 面试问题与参考回答

### 问题：你这个评测框架是怎么搭的？跑一道题时内部发生了什么？

我先定了一个约束：评测框架用 Python 写，只通过跨进程协议驱动 agent，不导入任何引擎代码。这样以后把 pi 换成 Claude Code 时，框架不用改。

跑一道 SWE-bench 题的过程是这样的：
- 起一个新的 Docker 容器，只接 internal 网络；
- 先把仓库历史截断到题目的基准版本，再做自检，确认用 git 查不到修复后的文件内容；
- 然后用 `docker exec` 启动一个 stdio 桥，桥在容器里启动 runner，runner 里跑 pi；
- 模型请求经过旁路的代理容器转发，key 只在代理容器里；
- 每次工具调用都回调到 Python，由它按危险命令清单决定放行还是拒绝；
- agent 结束后取出补丁，删掉容器，在同一镜像的新容器里用 swebench 官方的脚本打补丁、跑测试、判定；
- 最后汇总成功率、每次重复的标准差、按题 bootstrap 区间、token、花费和失败类型。

agent 循环和工具是 pi 提供的，评分判定是 swebench 提供的；我做的是把它们串起来，并设计隔离和计分规则。这些都是我定方案、写计划、逐个审查，由 AI 按我的计划实现的。目前这套框架在 Mac 和 x86 服务器上用真实模型各跑通了冒烟题，30 题的开发集也定版了，但开发集上的基线还没跑完。

### 问题：怎么防止 agent「作弊」，比如上网搜答案、翻 git 历史？

这一块我分了三层：
- **网络**：任务容器只接 Docker 的 internal 网络，上不了外网，也访问不到宿主机。冒烟时我们在运行中的容器里实测过，curl github、host.docker.internal 和 1.1.1.1 都失败。模型请求只能走代理，代理只放行一个接口，还会删掉联网搜索类参数。
- **git 历史**：开工核实时发现，SWE-bench 镜像不是浅克隆，修复之后的提交还挂在标签上。所以每次运行前都截断历史：只留一个分支，其余引用删掉，再 gc，最后用金标准补丁里文件的 blob 做探针，确认查不到。这里有个细节是我指出来的：swebench 官方镜像的 HEAD 比题目的 base_commit 多一个环境设置提交，如果按 base_commit 截断，就会把这个环境提交当成泄露删掉。所以我定了「以容器启动时的 HEAD 为有效基准」。开发集 30 个镜像在开跑前都单独跑过一遍截断检查，这是整体审查提出、我同意加的。
- **评分**：评分不信 agent 容器里的任何结果，在新容器里重新打补丁、跑测试。

### 问题：做这个过程中遇到过什么问题？基线为什么还没出来？

最有意思的是第二次开跑基线。第一道题 astropy-13579 用了 93 轮、703 万输入 token，单题 13.5 元，而冒烟题只有 18 到 29 轮。开跑前定好了刹车规则：前 5 题后推算全程，超过报价两倍就先停。这条是 AI 提出、我同意的；第一道题跑完推算就已远超两倍，按规则停了下来。

停下来以后，我要求不改产品代码、不调用 API，先把原因查清楚。查到三点：
- 这个模型在百炼上不支持缓存；
- pi 每轮都把整段历史重发一遍，输入大约每轮增长 1250 token，累计量近似随轮数平方增长；
- pi 的自动压缩阈值是 24.6 万，而这道题最大单轮才 13 万，所以压缩一直没触发。

我让 AI 写了一个反事实重放脚本，算不同上下文策略下同一条轨迹要发多少 token；又要求补一个抓请求体的测试，确认 pi 会把上一轮的思考原文作为 reasoning_content 发回去。

我一开始想把工具调用上限从 100 压到 40。分析之后又撤回了：这是 30 题里唯一一道标为 1 到 4 小时的题，压到 40 会截断难题，人为压低成功率；100 的上限已经把单题封顶在十几元。

在那之前还有一次开跑，是账号开着「仅用免费额度」，每个请求都返回 403。原逻辑会把这当成 agent 失败，悄悄给出一个 0% 的基线。我决定以后遇到 401/403 就直接中止整次评测，并先把这条写进设计文档，再改代码。

所以现在的状态是：框架和冒烟是通的，dev-v1 上的 Qwen 基线还没有成功率数字，下一步是重跑。

### 问题：你怎么保证评测出来的数字是对的？

我觉得评测框架最怕的不是报错，而是状态显示「完成」、分母却悄悄错了。这类问题我们碰到过好几次：
- 一次是开跑基线时撞上的 403；
- 几次是整体审查报出来的：代理容器挂掉以后，后续每题都会快速失败，被算成模型失败；判断限流的正则写成 `429|rate.?limit`，会匹配到 264292 这样的数字，把真实失败当限流排除掉，反而抬高成功率；
- 还有一次是 Docker 故障被记成了模型失败。

所以我把计分口径写成了规则：
- agent 自己的失败留在分母里；
- 基础设施失败和限流重试两次，仍失败的记为「无法测量」，排除并逐条列出；排除超过 5% 就判整次无效；
- 账号级错误直接中止。

每条规则都配了测试和反例，比如 264292 不能被当成 429。另外，成功率除了给每次重复的均值和样本标准差，还给按题 bootstrap 的 95% 区间。因为 30 道题时，误差主要来自抽到哪些题，多跑几次压不下去。

### 问题：代码主要是 AI 写的，你怎么确认它可靠？

我的做法是流程上不信任单一环节：
- 每个小任务都要求先写测试、看到它失败，再实现；
- 实现完先做规格和质量审查，再单独做一次反过度设计审查，最后停下来，等我自己看完代码再继续；
- 关键模块要做变异检查，就是故意把实现改坏，看测试能不能抓住。有一次「把 key 写进命令行参数」的变异没被抓住，原因是测试用 docker inspect 检查，而它根本看不到命令行参数。后来测试改成监视每次 docker 调用的参数，才真的能抓住。

还有一段是协作者直接推上来的 4 个小任务，没有过程记录。我要求并行补审，在 Mac 上就发现运行包脚本用了 macOS 不支持的 tar 参数，导致一整批 Docker 测试在 Mac 上根本没跑起来。之后我加了一条硬规则：任何偏离计划的地方都必须写明谁提议、理由、证据和谁确认，没有我确认不能勾选。

### 讲的时候守住的边界

- **x86 预检**：不要说「冷烟集在 x86 上做过金标准预检」，要说「x86 冒烟证明同一条命令在 x86 上可用；dev-v1 的 45 个候选在 x86 上做了完整预检；冷烟集的 x86 金标准预检漏做了，已记为遗漏」。
- **协作者**：只说「一位协作者参与了其中 4 个小任务，我对这些提交做了补审」，不展开身份，也不把补审发现说成协作者的过失。
- **基线没有数字**：不要说「Qwen3.6 在 SWE-bench 上的成功率是 X%」或「我们的 agent 解决了 X%」，要说「框架已经能输出成功率、区间和花费，冒烟题四次都 resolved，但 dev-v1 的 30 题基线两次开跑都中止了，还没有成功率」。冒烟集只有 1 道题，4 次 resolved 不能说成成功率 100%。
- **没有留出集数字**：不要说「在没见过的题上测过」，要说「留出集推迟了：开工核实时没有晚于模型发布日期的 Python 题；重新启用条件写进了验收」。design 3.11 规定，简历上的数字只能来自留出集；T2 验收 1 也写明，在留出集重新启用之前不写端到端成功率。开发集分数本身也可能偏高。
- **不和排行榜、模型卡比**：不要说「我们比模型卡低 / 接近官方分数」，要说「项目规定不引用第三方排行榜分数；脚手架、步数上限、重复次数都不同，没有可比性」。
- **13579 只是一道题**：不要说「每道题要 13.5 元」或「基线要花 300–700 元」，要说「最难的一道（dev-v1 唯一的 1-4 小时题）花了 13.5 元；300–700 元是拿这一道题推算的，后来按难度分布预测 30 题跑一遍约 11–141 元，也只是预测，没有实跑」。
- **重放数字有前提**：不要说「换成只留最近 5 条工具输出就能降到 9 元」，要说「在轨迹不变的假设下，同一条轨迹要发的 token 会降到这个量；真实运行可能多走几轮或改变成败，所以这个数既不是上界，也不能预测成功率」。
- **思考内容是否被计费未证实**：不要说「pi 重发思考导致多花了钱」，要说「抓请求体证实 pi 把上一轮思考作为 reasoning_content 发回去；但百炼文档写的是 preserve_thinking 默认关闭时不计费，我们的离线残差分析支持『被计费』，这只是推断，还需要一次真实对照请求才能定论，这次没做」。
- **花费没对账**：不要说「实际花费是 X 元」，要说「按 token 和价目表算出来是 X 元，还没和百炼账单对过；冒烟的花费可能被免费额度抵扣了」。
- **Kimi 对照没做**：不要说「和 Kimi K2.6 对比过」，要说「Kimi 配置和 Mac 上一次冒烟做了，dev-v1 上的对照组推迟了」。
- **主模型不是评测选出来的**：不要说「我们评测后选了 Qwen3.6」，要说「按 ADR 015 的倾向直接定的（ADR 017），T2 只测它的基线」。
- **能力的归属**：agent 循环、工具、重试、上下文压缩是 pi 1.5.1 提供的；打补丁、测试脚本、判定是 swebench 5.0.2 提供的；数据集和镜像来自 SWE-bench 官方，Mac 上早期用过 Epoch AI 的镜像；网络隔离用的是 Docker 的 internal 网络。不要把这些说成自己做的。
- **谁做了什么**：要说「我设计了方案、定了规则、审查了代码，由 AI 按我的计划实现」，不要说「我手写了」。整体审查发现的 I1、I2、M2 是 AI 审查员报出的，要说「审查报出来，我决定怎么修」，不要说成「我发现的」。T2-6 至 T2-9 是协作者做的。
