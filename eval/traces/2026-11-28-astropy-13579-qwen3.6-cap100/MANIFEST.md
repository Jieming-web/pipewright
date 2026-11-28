# 轨迹固定用例：2026-11-28-astropy-13579-qwen3.6-cap100

- 角色：花费重尾回归用例（成本诊断用，不计入基线）。dev-v1 唯一「1-4 hours」题；冻结配置（工具调用上限 100）下 93 轮、resolved、13.50 元。同一运行中第 2 题 astropy-14508 开跑即被控制会话 SIGTERM 中止（无请求、无 done.json），不收录。
- 来源：`eval/runs/dev-v1-qwen-cap100-aborted`（香港 x86 服务器（阿里云 ecs.e-c1m2.2xlarge），代码 9907ab6），由控制会话 2026-11-28 收录；`raw.jsonl` 以 gzip 压缩，其余文件原样
- 实例：`astropy__astropy-13579`；结果：failure_type `none`、评分 `resolved`、评分架构 `amd64`
- 模型：{'provider': 'qwen-api', 'id': 'qwen3.6-35b-a3b'}；引擎：{'name': 'pi', 'version': '1.5.1'}
- 模型请求 93 次，首个 2026-11-27T18:33:22.504Z，末个 2026-11-27T18:45:12.710Z（UTC）；用量 输入 7,034,357、输出 78,061（reasoning 21,562）、cacheRead 0
- 花费（按 1.8 / 10.8 元每百万，原价、无缓存）：13.5049 元
- config_hash `b20c5698d622136a0f2a92a1e6f842b07fda44e6e78a2c010144dadf31a7e94e`；taskset_sha256 `e9c3137d9918687ebc6553b9efbf576ed19198f9ea2393443c959b040c63e002`
- 复跑分析：`python3 scripts/context-replay.py <尝试目录> --out <目录>`；`PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py <尝试目录> --out <目录>`

## 文件与 sha256

| 文件 | 字节 | sha256 | 备注 |
|---|---|---|---|
| `proxy.jsonl` | 27,342 | `342822a1282117d865552ed24ac80274a19fe388202c17f5d3158921874fded9` |  |
| `rep-1/astropy__astropy-13579/1/events.jsonl` | 594,853 | `4e2b0aa27031406c80dfe1a902a2759ccc5811f467bd2fc3d75ba1b14f0cc160` |  |
| `rep-1/astropy__astropy-13579/1/fp-out/models.json` | 420 | `9f31f1ef8fb887d07cfba3f6c85b4eb1c418932ff397f33333d8aedd1e400622` |  |
| `rep-1/astropy__astropy-13579/1/fp-out/raw.jsonl.gz` | 1,345,013 | `9ef34c89bb34788783ccee0783b6352b1349e1e289738794ef439a0a103ba220` | 解压后 119,679,177 字节，sha256 0db071926de4f60f733d9150c94a3e34d23822fc47d529549e7bd416594d7f6a |
| `rep-1/astropy__astropy-13579/1/grade/1/grade.log` | 319,354 | `f26e3d643587cc7b75490d58797b2ada27b962e4559029cacee4acb9af388b4d` |  |
| `rep-1/astropy__astropy-13579/1/grade/1/report.json` | 4,751 | `81eb716c3b8c64a4106691e248ec18df0eb97402bd835d5f9547fa9fe84e114c` |  |
| `rep-1/astropy__astropy-13579/1/patch.diff` | 6,622 | `97e8d778c284ed73635b7f566e244538cb8cf0823c7576c953c43dd4e58403b1` |  |
| `rep-1/astropy__astropy-13579/1/record.json` | 1,026 | `39a93507c3298281c3e758815287babb9fc65810eb9221e303e02cbe7881cf93` |  |
| `rep-1/astropy__astropy-13579/done.json` | 1,096 | `b65b71b3054b4c4c14646a9dcab51348a1ebe9c1a5afdf53964163d6d6cfc223` |  |
| `run.json` | 270 | `36d508bcf0e328208f57962d12363da710045063269f2c4ac8d2956817ff10a2` |  |
