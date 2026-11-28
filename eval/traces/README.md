# 轨迹固定用例

被离线分析（`scripts/run-anatomy.py`、`scripts/context-replay.py`）用到的真实运行，原样收录、只追加不修改，保证分析能只凭 git 复跑。每个目录的 `MANIFEST.md` 写明来源、角色、结果、花费和每个文件的 sha256；`raw.jsonl` 以 gzip 压缩。

这与计划 Global Constraints「运行产物写到 `eval/runs/`，不进 git」不同：作者 2026-11-28 同意把这几次被分析的运行作为固定用例入库（其余运行仍不进 git），入库前 check-secrets 扫描干净（含 gzip 内容）。

| 目录 | 角色 |
|---|---|
| `2026-11-28-astropy-13579-qwen3.6-cap100` | 花费重尾回归用例（不计入基线） |
| `2026-11-26-smoke-astropy-12907-qwen3.6-mac-a` | Mac 冒烟，重放拟合用 |
| `2026-11-26-smoke-astropy-12907-qwen3.6-mac-b` | Mac 冒烟补跑，重放拟合用 |
| `2026-11-27-smoke-astropy-12907-qwen3.6-x86` | x86 冒烟（验收 9），重放拟合用 |
