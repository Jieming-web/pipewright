# AGENTS.md

本文件给在本仓库中工作的编码 agent（如 Codex）看。

本项目的规范索引和硬规则在 `CLAUDE.md`，开始任何工作前先读它，并严格遵守其中的硬规则（先确定任务、写计划经作者审过再实现、先写测试、验收通过才算完成、推送和合并须作者同意等）。完整工作流见 `docs/workflow.md`；`CLAUDE.md` 与 `docs/workflow.md` 冲突时，以 `docs/workflow.md` 为准。

注意：本文件只用于开发本仓库。ForgePilot 产品在处理用户仓库时读取的 `AGENTS.md`（见 `docs/specs/design.md` 3.15.3）是另一回事，两者无关。
