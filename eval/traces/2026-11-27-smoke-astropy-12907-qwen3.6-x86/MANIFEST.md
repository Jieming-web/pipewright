# 轨迹固定用例：2026-11-27-smoke-astropy-12907-qwen3.6-x86

- 角色：T2-15 x86 冒烟（验收 9），重放脚本拟合用。
- 来源：`eval/runs/smoke-x86-2026-11-27`（香港 x86 服务器，代码 46a383c（挂载子目录修复之前，raw.jsonl 在尝试目录里）），由控制会话 2026-11-28 收录；`raw.jsonl` 以 gzip 压缩，其余文件原样
- 实例：`astropy__astropy-12907`；结果：failure_type `none`、评分 `resolved`、评分架构 `amd64`
- 模型：{'provider': 'qwen-api', 'id': 'qwen3.6-35b-a3b'}；引擎：{'name': 'pi', 'version': '1.5.1'}
- 模型请求 29 次，首个 2026-11-27T15:05:18.743Z，末个 2026-11-27T15:06:34.999Z（UTC）；用量 输入 392,538、输出 6,169（reasoning 1,620）、cacheRead 0
- 花费（按 1.8 / 10.8 元每百万，原价、无缓存）：0.7732 元
- config_hash `b20c5698d622136a0f2a92a1e6f842b07fda44e6e78a2c010144dadf31a7e94e`；taskset_sha256 `7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`
- 复跑分析：`python3 scripts/context-replay.py <尝试目录> --out <目录>`；`PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py <尝试目录> --out <目录>`

## 文件与 sha256

| 文件 | 字节 | sha256 | 备注 |
|---|---|---|---|
| `proxy.jsonl` | 8,526 | `7c9e9434bb77586e40d8ca255f93903b3583089e2fe11af8b5a6a101e217be3f` |  |
| `rep-1/astropy__astropy-12907/1/events.jsonl` | 142,530 | `e302881325f5637cfc50cb6223b111c92393056530873d67e08a426af7858753` |  |
| `rep-1/astropy__astropy-12907/1/grade/1/grade.log` | 755,391 | `4aa72d10473efe0f831523ce811450c70c9ca0810a15cd7d3d0eb33e72fef889` |  |
| `rep-1/astropy__astropy-12907/1/grade/1/report.json` | 1,845 | `a2847d31d494a34531b2adfd8617cfde91a8ddf102cd21cd14cf36201b78cd72` |  |
| `rep-1/astropy__astropy-12907/1/models.json` | 420 | `9f31f1ef8fb887d07cfba3f6c85b4eb1c418932ff397f33333d8aedd1e400622` |  |
| `rep-1/astropy__astropy-12907/1/patch.diff` | 504 | `7f233cc776d064f8e1d7d39bf0a846434e59d14cc07ac33aab803b7b758ee755` |  |
| `rep-1/astropy__astropy-12907/1/raw.jsonl.gz` | 105,851 | `831202600c3af47374d45a90df7d1f8a953adba8f6225281b39830be08075bb0` | 解压后 5,268,778 字节，sha256 4adcc0fe45278ac0392a720ca262c9a166f5f63bf612736c5823ebec31fe0179 |
| `rep-1/astropy__astropy-12907/1/record.json` | 1,022 | `f3d1b855afc0e6f15d9463b8c62604f31e7d7d51b940510aae36ed0a6c75588b` |  |
| `rep-1/astropy__astropy-12907/done.json` | 1,092 | `9de1cb74726b1bdd0f98790b4a8e4dd439df617da8ea5f158e43e4ac7fdfe5aa` |  |
| `run.json` | 270 | `b06634a324cda6327b73e29796acf2127c97e9e9601606311c86a35f060008b9` |  |
| `summary.json` | 1,332 | `3128e40ce7d329b415a20503006e3a5ba02a5569c41d4a3b4c81340f50b5a7a6` |  |
| `summary.md` | 1,200 | `25e74354874ce0a3a70980c354c6ef14df868743abc564ce53bfb8d52149eec1` |  |
