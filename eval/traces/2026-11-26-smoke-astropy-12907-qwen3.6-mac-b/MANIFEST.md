# 轨迹固定用例：2026-11-26-smoke-astropy-12907-qwen3.6-mac-b

- 角色：T2-14 Mac 冒烟补跑（核对 docker top 与容器网络），重放脚本拟合用。
- 来源：`eval/runs/smoke-2026-11-26b`（Mac arm64，代码 b60f0cf，运行包 2ef360f；旧版目录布局），由控制会话 2026-11-28 收录；`raw.jsonl` 以 gzip 压缩，其余文件原样
- 实例：`astropy__astropy-12907`；结果：failure_type `none`、评分 `resolved`、评分架构 `arm64`
- 模型：{'provider': 'qwen-api', 'id': 'qwen3.6-35b-a3b'}；引擎：{'name': 'pi', 'version': '1.5.1'}
- 模型请求 18 次，首个 2026-11-26T12:51:11.582Z，末个 2026-11-26T12:52:29.703Z（UTC）；用量 输入 378,239、输出 7,721（reasoning 3,309）、cacheRead 0
- 花费（按 1.8 / 10.8 元每百万，原价、无缓存）：0.7642 元
- config_hash `b20c5698d622136a0f2a92a1e6f842b07fda44e6e78a2c010144dadf31a7e94e`；taskset_sha256 `7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`
- 复跑分析：`python3 scripts/context-replay.py <尝试目录> --out <目录>`；`PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py <尝试目录> --out <目录>`

## 文件与 sha256

| 文件 | 字节 | sha256 | 备注 |
|---|---|---|---|
| `astropy__astropy-12907/1/events.jsonl` | 169,772 | `60ba57df8dae38663c801fc60d330329792fb403278aea0b9e83372152a31a04` |  |
| `astropy__astropy-12907/1/grade/1/grade.log` | 306,651 | `50628bd13600bb0b86b348746003c80fc48ee4523917b52da5bc37f4e35de9af` |  |
| `astropy__astropy-12907/1/grade/1/report.json` | 1,845 | `a2847d31d494a34531b2adfd8617cfde91a8ddf102cd21cd14cf36201b78cd72` |  |
| `astropy__astropy-12907/1/models.json` | 420 | `9f31f1ef8fb887d07cfba3f6c85b4eb1c418932ff397f33333d8aedd1e400622` |  |
| `astropy__astropy-12907/1/patch.diff` | 504 | `0172ca0d430e58fc42e46d478f879e667a9a6e262295d7b49aea68cbc53d5986` |  |
| `astropy__astropy-12907/1/raw.jsonl.gz` | 191,160 | `316d1eda8c7fbff282844ea71ee410cc1480111882d8ae072ff9a303603f6bf4` | 解压后 12,036,689 字节，sha256 8343903238cbc822f6c3e5e5c48548d83a83860445af936c782f78ff4b52cceb |
| `astropy__astropy-12907/1/record.json` | 1,020 | `f85ff36a99282b5f308acd4658b5d8a0f50b1d8f698fa4cc84669593f219fc40` |  |
| `proxy.jsonl` | 5,292 | `eef85f0f9183008aea4e26eb2afb4d30899d80311898e2ba4302703604b03a42` |  |
| `summary.json` | 1,199 | `9ac3d14fb99bd928ae354931b7150eb6764e8e70740a915e6dcac20b1a25d4f6` |  |
| `summary.md` | 1,037 | `67a7aa044f1f10cf1f7aecf70cd3815df4a3a051cf542e058c12e0c60a532c82` |  |
