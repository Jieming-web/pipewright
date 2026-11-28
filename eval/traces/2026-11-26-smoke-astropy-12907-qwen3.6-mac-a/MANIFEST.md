# 轨迹固定用例：2026-11-26-smoke-astropy-12907-qwen3.6-mac-a

- 角色：T2-14 Mac 冒烟第 1 次（smoke-v1，「15 min - 1 hour」档），重放脚本拟合 token 系数用。
- 来源：`eval/runs/smoke-2026-11-26`（Mac arm64（Docker Desktop），代码 18dd007，运行包 2ef360f；当时目录布局为旧版（无 rep-k、无 fp-out）），由控制会话 2026-11-28 收录；`raw.jsonl` 以 gzip 压缩，其余文件原样
- 实例：`astropy__astropy-12907`；结果：failure_type `none`、评分 `resolved`、评分架构 `arm64`
- 模型：{'provider': 'qwen-api', 'id': 'qwen3.6-35b-a3b'}；引擎：{'name': 'pi', 'version': '1.5.1'}
- 模型请求 18 次，首个 2026-11-26T12:33:47.548Z，末个 2026-11-26T12:34:49.657Z（UTC）；用量 输入 194,578、输出 6,439（reasoning 2,384）、cacheRead 0
- 花费（按 1.8 / 10.8 元每百万，原价、无缓存）：0.4198 元
- config_hash `b6b48eb970e315fe7386e74edd8e41487fdefd04049fc1ad7bf40d0e95894463`；taskset_sha256 `7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`
- 复跑分析：`python3 scripts/context-replay.py <尝试目录> --out <目录>`；`PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py <尝试目录> --out <目录>`

## 文件与 sha256

| 文件 | 字节 | sha256 | 备注 |
|---|---|---|---|
| `astropy__astropy-12907/1/events.jsonl` | 114,553 | `b0fac352f44f974c6a050e821c4e3181e49f3328e61a9cc7406c511c44568155` |  |
| `astropy__astropy-12907/1/grade/1/grade.log` | 306,651 | `a760a143de8ede445032022d989b67a20560bc440800034019a3fc9dc8ea1f33` |  |
| `astropy__astropy-12907/1/grade/1/report.json` | 1,845 | `a2847d31d494a34531b2adfd8617cfde91a8ddf102cd21cd14cf36201b78cd72` |  |
| `astropy__astropy-12907/1/models.json` | 420 | `9f31f1ef8fb887d07cfba3f6c85b4eb1c418932ff397f33333d8aedd1e400622` |  |
| `astropy__astropy-12907/1/patch.diff` | 504 | `0172ca0d430e58fc42e46d478f879e667a9a6e262295d7b49aea68cbc53d5986` |  |
| `astropy__astropy-12907/1/raw.jsonl.gz` | 112,548 | `1c18b49a9b396208f686e8310b0baa6767ea18e64efe9db9d021e1a8b33ea974` | 解压后 7,242,968 字节，sha256 ca5d0411e10d7db7a25f7d810484b119e6e2df4726f6f7b3f85c01827112f197 |
| `astropy__astropy-12907/1/record.json` | 1,020 | `7e5528d9a7fbf005d78a163445e33bab45689b79c3207a482277ae0c1b235beb` |  |
| `proxy.jsonl` | 5,292 | `eef85f0f9183008aea4e26eb2afb4d30899d80311898e2ba4302703604b03a42` |  |
| `summary.json` | 1,225 | `99ee03e90b049b48b563b8ac589495efd484cdbb0186949b569716cc432565e5` |  |
| `summary.md` | 1,063 | `77be5d3251320156acb61841204ae7436925bf460fbf8f7e6b98e02313e4dcab` |  |
