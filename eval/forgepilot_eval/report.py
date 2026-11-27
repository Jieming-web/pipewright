"""汇总与花费（T2 计划 Task 13 MVP 精简版、Task 14b；D10）。

结果（outcome）：待评分的运行取评分结果（resolved / unresolved / patch_apply_failed / infra_error），
其余取运行阶段的 failure_type。`scoring.retry_then_exclude` 里的结果是「无法测量」：从分母排除并逐条列出。
"""

from __future__ import annotations

import random
from collections import Counter
from statistics import mean, median, stdev

from .config import EvalConfig
from .run_task import TaskRecord

COST_NOTE = "input+cacheRead+cacheWrite 按输入价、output 按输出价（reasoning 已含在 output 里，不重复计）；缓存不打折"
BOOTSTRAP_RESAMPLES = 10000
BOOTSTRAP_SEED = 0
TOKEN_NOTE = "每次运行 token = input + cacheRead + output（reasoning 已含在 output 里）"


def outcome(r: TaskRecord) -> str:
    return r.grade_status if r.failure_type == "none" else r.failure_type


def tokens(usage: dict) -> int:
    return usage["input"] + usage["cacheRead"] + usage["output"]


def estimate_cost(cfg: EvalConfig, n_runs: int) -> float:
    """元；按 assumed_tokens_per_run 估计，来源见它的 source 字段。"""
    a, p = cfg.assumed_tokens_per_run, cfg.price
    return n_runs * (a["input"] * p["input_per_m"] + a["output"] * p["output_per_m"]) / 1e6


def actual_cost(records: list[TaskRecord], cfg: EvalConfig) -> float:
    """元；records 为全部尝试（重试掉的也花了钱）。"""
    p = cfg.price
    return sum((u["input"] + u["cacheRead"] + u["cacheWrite"]) * p["input_per_m"] + u["output"] * p["output_per_m"]
               for u in (r.usage for r in records)) / 1e6


def _stats(xs: list[float]) -> dict | None:
    return {"mean": mean(xs), "median": median(xs)} if xs else None


def _rate(finals: list[TaskRecord], cfg: EvalConfig) -> float | None:
    measured = [outcome(r) == "resolved" for r in finals if outcome(r) not in cfg.scoring["retry_then_exclude"]]
    return mean(measured) if measured else None


def bootstrap_ci95(reps: list[list[TaskRecord]], cfg: EvalConfig) -> list[float] | None:
    """按题重抽样：每题取其可测重复的平均成功，一次都不可测的题不参与；百分位法，种子固定。"""
    by_task: dict[str, list[TaskRecord]] = {}
    for r in (r for rep in reps for r in rep):
        by_task.setdefault(r.instance_id, []).append(r)
    per_task = [x for x in (_rate(rs, cfg) for rs in by_task.values()) if x is not None]
    if not per_task:
        return None
    rng, n = random.Random(BOOTSTRAP_SEED), len(per_task)
    means = sorted(sum(rng.choices(per_task, k=n)) / n for _ in range(BOOTSTRAP_RESAMPLES))
    return [means[int(0.025 * BOOTSTRAP_RESAMPLES)], means[int(0.975 * BOOTSTRAP_RESAMPLES) - 1]]


def aggregate(reps: list[list[TaskRecord]], cfg: EvalConfig, taskset_name: str, attempts: list[TaskRecord]) -> dict:
    """reps：每次重复里每个实例最后一次尝试；attempts：全部尝试（算花费）。排除比例与合并成功率按全部运行算。"""
    sc = cfg.scoring
    finals = [r for rep in reps for r in rep]
    rates = [_rate(rep, cfg) for rep in reps]
    known = [x for x in rates if x is not None]
    excluded = [r for r in finals if outcome(r) in sc["retry_then_exclude"]]
    measured = [r for r in finals if outcome(r) not in sc["retry_then_exclude"]]
    resolved = sum(outcome(r) == "resolved" for r in measured)
    frac = len(excluded) / len(finals) if finals else 0.0
    invalid = []
    if frac > sc["max_excluded_fraction"]:
        invalid.append(f"无法测量的运行占 {frac:.1%}，超过 {sc['max_excluded_fraction']:.0%}（D10）")
    # 正式评测只认 amd64 评分，arm64 只用于冒烟；在 D10 排除之后检查（作者 2026-11-26）
    if not taskset_name.startswith("smoke"):
        bad = sorted({r.grade_arch for r in measured if r.grade_arch and r.grade_arch != "amd64"})
        if bad:
            invalid.append(f"任务集 {taskset_name} 不是冒烟集，评分架构必须是 amd64，实际有 {', '.join(bad)}")
    return {
        "status": "invalid" if invalid else "complete",
        "invalid_reasons": invalid,
        "runs": len(finals),
        "measured": len(measured),
        "resolved": resolved,
        "success_rate": resolved / len(measured) if measured else None,
        "repeats": {"success_rates": rates, "mean": mean(known) if known else None,
                    "stdev": stdev(known) if len(known) > 1 else None},  # 样本标准差（ddof=1）
        "bootstrap_ci95": bootstrap_ci95(reps, cfg),
        "excluded_fraction": frac,
        "excluded": [{"instance_id": r.instance_id, "failure_type": outcome(r), "failure_reason": r.failure_reason}
                     for r in excluded],
        "failure_types": dict(Counter(outcome(r) for r in finals)),
        "per_run": {  # 只算进分母的运行
            "tokens": _stats([tokens(r.usage) for r in measured]),
            "requests": _stats([r.requests for r in measured]),
            "wall_s": _stats([r.wall_s for r in measured]),
        },
        "token_note": TOKEN_NOTE,
        "cost": {
            "actual_yuan": actual_cost(attempts, cfg),
            "runs": len(attempts),
            "usage_unknown_runs": sum(not r.usage_complete for r in attempts),
            "note": COST_NOTE,
        },
    }


def render_md(s: dict) -> str:
    def st(k):
        v = s["per_run"][k]
        return "—" if v is None else f"{v['mean']:.1f} / {v['median']:.1f}"

    def pct(x):
        return "—" if x is None else f"{x:.1%}"

    rate = pct(s["success_rate"])
    rp, ci = s["repeats"], s["bootstrap_ci95"]
    c = s["cost"]
    lines = [
        f"# 评测汇总：{s['taskset']['name']}-v{s['taskset']['version']}",
        "",
        f"- 状态：**{s['status']}**" + "".join(f"\n  - {r}" for r in s["invalid_reasons"]),
        f"- 成功率：{rate}（resolved {s['resolved']} / 分母 {s['measured']}；共 {s['runs']} 次运行（题 × 重复），"
        f"无法测量 {len(s['excluded'])} 次，占 {s['excluded_fraction']:.1%}）",
        f"- 各次重复成功率：{'、'.join(pct(x) for x in rp['success_rates'])}；均值 {pct(rp['mean'])}，"
        f"样本标准差 {pct(rp['stdev'])}",
        f"- 按题 bootstrap 95% 区间（{BOOTSTRAP_RESAMPLES} 次，种子 {BOOTSTRAP_SEED}）："
        + ("—" if ci is None else f"[{ci[0]:.1%}, {ci[1]:.1%}]"),
        f"- 模型：{s['model']}；配置 hash：`{s['config_hash']}`；任务集 sha256：`{s['taskset']['sha256']}`；平台：{s['platform']}",
        "",
        "| 每次运行（分母内） | 均值 / 中位数 |",
        "|---|---|",
        f"| token | {st('tokens')} |",
        f"| 轮数（模型请求数） | {st('requests')} |",
        f"| 耗时（秒） | {st('wall_s')} |",
        "",
        f"{s['token_note']}。",
        "",
        "## 结果计数",
        "",
        *[f"- {k}：{v}" for k, v in sorted(s["failure_types"].items())],
        "",
        "## 花费",
        "",
        f"- 实际：{c['actual_yuan']:.4f} 元（{c['runs']} 次尝试，含重试）；预计：{s['estimate']['yuan']:.2f} 元"
        f"（假设来源：{s['estimate']['source']}）",
        f"- 口径：{c['note']}",
        *([f"- **用量未知的运行：{c['usage_unknown_runs']} 次**（实际花费偏低）"] if c["usage_unknown_runs"] else []),
        "",
        "## 无法测量（从分母排除）",
        "",
        *([f"- {e['instance_id']}：{e['failure_type']}，{e['failure_reason']}" for e in s["excluded"]] or ["无"]),
        "",
    ]
    return "\n".join(lines)
