#!/usr/bin/env python3
"""反事实重放：沿用一条真实轨迹，重算不同上下文策略下的每轮输入 token 与花费。只读，不调 API。

  python3 scripts/context-replay.py <尝试目录> --out <输出目录> [--fit <其他尝试目录> ...]

前提（结论只在这个前提下成立）：轨迹不变——每轮 agent 发出同样的工具调用、拿到同样的结果。
真实运行里，丢掉上下文的策略可能让 agent 重新读文件、多走几轮，也可能改变成败，所以这里的数字
既不是花费上界，也不能预测成功率；它只回答「同一条轨迹在该策略下要发多少 token」。

做法：第 j 次请求之后、第 j+1 次请求之前追加到上下文的量 inc_j = input_{j+1} - input_j，
拆成「工具结果」与「其余（assistant 消息与格式开销）」两部分：工具结果 token ≈ α × 输出字符数，
α 用最小二乘拟合 inc_j = α·chars_j + β·output_j + γ 得到。各策略只改工具结果部分，或按 pi 的规则压缩。
"""
import argparse
import json
from pathlib import Path

PRICE_IN, PRICE_OUT = 1.8, 10.8  # 元/百万，qwen3.6-35b-a3b 北京
IMPLICIT = 0.2  # 百炼隐式缓存命中按输入单价 20%（https://help.aliyun.com/zh/model-studio/context-cache）
PLACEHOLDER = 15  # 被替换的旧工具输出留一行占位，约 15 token
TRUNC_MARK = 12  # 截断提示约 12 token
# pi 1.5.1 默认（dist/core/settings-defaults.js）：compaction enabled、reserveTokens 16384、keepRecentTokens 20000；
# 触发：上下文 token > contextWindow - reserveTokens（dist/core/compaction/compaction.js shouldCompact）
RESERVE, KEEP_RECENT = 16384, 20000
SUMMARY_OUT = 2000  # 假设摘要长度（pi 用模型输出上限，本配置 maxTokens 8192）
SUMMARY_PROMPT = 600  # 摘要请求的系统提示与指令，估计值


def load(d: Path):
    ev = [json.loads(x) for x in (d / "events.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    reqs = [e["usage"] for e in ev if e["type"] == "model.request.finished"]
    fin = {e["callId"]: e for e in ev if e["type"] == "tool.finished"}
    chars = [0] * len(reqs)  # 第 j 次请求返回的工具调用（可能并行多个、也可能没有）的输出字符之和
    j = -1
    for e in ev:
        if e["type"] == "model.request.finished":
            j += 1
        elif e["type"] == "tool.started" and j >= 0:
            o = (fin.get(e["callId"]) or {}).get("output") or {}
            chars[j] += sum(len(c.get("text", "")) for c in o.get("content", []) if isinstance(c, dict))
    return reqs, chars


def solve3(rows):
    """最小二乘 y = a·x1 + b·x2 + c（正规方程，3×3 高斯消元）。"""
    m = [[0.0] * 4 for _ in range(3)]
    for x1, x2, y in rows:
        v = (x1, x2, 1.0)
        for i in range(3):
            for j in range(3):
                m[i][j] += v[i] * v[j]
            m[i][3] += v[i] * y
    for i in range(3):
        p = max(range(i, 3), key=lambda r: abs(m[r][i])); m[i], m[p] = m[p], m[i]
        for r in range(3):
            if r != i:
                f = m[r][i] / m[i][i]
                m[r] = [a - f * b for a, b in zip(m[r], m[i])]
    return [m[i][3] / m[i][i] for i in range(3)]


def fit_alpha(dirs: list[Path]):
    rows = []
    for d in dirs:
        reqs, chars = load(d)
        for j in range(len(reqs) - 1):
            rows.append((chars[j], reqs[j]["output"], reqs[j + 1]["input"] - reqs[j]["input"]))
    a, b, c = solve3(rows)
    my = sum(r[2] for r in rows) / len(rows)
    ss = sum((r[2] - (a * r[0] + b * r[1] + c)) ** 2 for r in rows); st = sum((r[2] - my) ** 2 for r in rows)
    return a, b, c, 1 - ss / st, len(rows)


def replay(reqs, chars, alpha, strategy: str, param=None):
    """返回 (每轮输入列表, 额外请求列表[(input, output)])。"""
    n = len(reqs); base = reqs[0]["input"]
    tool = [alpha * c for c in chars]
    other = [reqs[j + 1]["input"] - reqs[j]["input"] - tool[j] for j in range(n - 1)]  # 非工具部分保持真实值
    if strategy == "truncate":
        tool = [alpha * min(c, param) + (TRUNC_MARK if c > param else 0) for c in chars]
    inputs, extra = [], []
    summary, start = 0, 0  # 压缩后：上下文 = base + summary + 第 start..i-1 条条目
    for i in range(n):
        if strategy == "keep_last":
            ctx = base + sum(other[j] + (tool[j] if j >= i - param else PLACEHOLDER) for j in range(i))
        elif strategy == "compact":
            ctx = base + summary + sum(other[j] + tool[j] for j in range(start, i))
        else:
            ctx = base + sum(other[j] + tool[j] for j in range(i))
        inputs.append(round(ctx))
        if strategy == "compact" and i < n - 1 and ctx + reqs[i]["output"] > param - RESERVE:
            extra.append((round(ctx + reqs[i]["output"] + SUMMARY_PROMPT), SUMMARY_OUT))
            kept, s = 0, i + 1  # pi 保留最近约 keepRecentTokens 的条目
            while s - 1 > start and kept + other[s - 2] + tool[s - 2] <= KEEP_RECENT:
                s -= 1; kept += other[s - 1] + tool[s - 1]
            start, summary = s - 1 if s - 1 > start else i, SUMMARY_OUT
    return inputs, extra


def cost(inputs, outputs, extra, cached=False):
    if cached:  # 只追加：本轮输入里上一轮的输入 + 输出视为命中
        hit = sum(min(inputs[k - 1] + outputs[k - 1], inputs[k]) for k in range(1, len(inputs)))
        tin = sum(inputs) - hit + hit * IMPLICIT
    else:
        tin = sum(inputs)
    tin += sum(e[0] for e in extra)
    return (tin * PRICE_IN + (sum(outputs) + sum(e[1] for e in extra)) * PRICE_OUT) / 1e6


def decompose(d: Path, alpha: float) -> dict:
    """累计输入按来源分解：第 j 轮追加的内容此后被重发 (n-1-j) 次。思考内容是否真被重发以请求体捕获测试为准。"""
    reqs, ch = load(d); n = len(reqs)
    w = [n - 1 - j for j in range(n)]
    parts = {"系统提示+题目": reqs[0]["input"] * n,
             "工具结果": sum(alpha * ch[j] * w[j] for j in range(n - 1)),
             "文字+工具调用参数": sum((reqs[j]["output"] - reqs[j]["reasoning"]) * w[j] for j in range(n - 1)),
             "思考内容": sum(reqs[j]["reasoning"] * w[j] for j in range(n - 1))}
    tot = sum(r["input"] for r in reqs)
    return {"run": d.parts[2], "turns": n, "total": tot, "cost": cost([r["input"] for r in reqs], [r["output"] for r in reqs], []),
            **{k: v / tot for k, v in parts.items()}, "未解释": 1 - sum(parts.values()) / tot}


def run_cost(n: int, base: float, g: float, out_per_turn: float) -> float:
    """每轮输入 ≈ base + g·(i-1) 时 n 轮的原价花费：总输入 = n·base + g·n(n-1)/2。"""
    return ((n * base + g * n * (n - 1) / 2) * PRICE_IN + n * out_per_turn * PRICE_OUT) / 1e6


# 每档难度的轮数区间：「15 min - 1 hour」下限取冒烟实测（同档 astropy-12907：18、18、29 轮），
# 其余是假设，没有实测，换来实测后改这里。shortcut: 轮数区间靠手填，有了试跑数据后改成从运行目录拟合
TURNS = {"<15 min fix": (10, 25), "15 min - 1 hour": (18, 60), "1-4 hours": (60, 100), ">4 hours": (80, 100)}


def predict(taskset: Path, fit_dirs: list[Path]) -> list[str]:
    import collections
    from datasets import load_dataset

    curves = []
    for d in fit_dirs:
        reqs, _ = load(d)
        n = len(reqs)
        curves.append((d.parts[2], n, reqs[0]["input"], (reqs[-1]["input"] - reqs[0]["input"]) / (n - 1),
                       sum(r["output"] for r in reqs) / n, cost([r["input"] for r in reqs], [r["output"] for r in reqs], [])))
    base = max(c[2] for c in curves); gs = [c[3] for c in curves]; outs = [c[4] for c in curves]
    ts = json.loads(taskset.read_text())
    want = set(ts["instance_ids"])
    diff = collections.Counter(r["difficulty"] for r in load_dataset(ts["dataset"], split="test", revision=ts["revision"]) if r["instance_id"] in want)
    lo = sum(k * run_cost(TURNS[d][0], base, min(gs), min(outs)) for d, k in diff.items())
    hi = sum(k * run_cost(TURNS[d][1], base, max(gs), max(outs)) for d, k in diff.items())
    mid = sum(k * run_cost(round(sum(TURNS[d]) / 2), base, sum(gs) / len(gs), sum(outs) / len(outs)) for d, k in diff.items())
    return ["", "## 全集花费预测（dev-v1 × 1 次，原价，无上下文管理）", "",
            "拟合用的运行（每轮输入 ≈ 首轮 + g ×（轮次 − 1））：", "",
            "| 运行 | 轮数 | 首轮输入 | g（token/轮） | 平均输出/轮 | 实际花费 |", "|---|---|---|---|---|---|",
            *[f"| {c[0]} | {c[1]} | {c[2]:,} | {c[3]:,.0f} | {c[4]:,.0f} | {c[5]:.2f} 元 |" for c in curves],
            "", f"难度分布：{dict(diff)}；每档轮数区间 {TURNS}（只有「15 min - 1 hour」的下限与「1-4 hours」的 93 轮有实测，其余是假设）", "",
            f"- 低（各档轮数取下限、g 与输出取最小）：**{lo:.0f} 元**",
            f"- 中（取中点与平均）：**{mid:.0f} 元**",
            f"- 高（取上限与最大）：**{hi:.0f} 元**",
            f"- 单题花费随轮数近似平方增长：同样 g = {sum(gs)/len(gs):,.0f}，20 轮约 {run_cost(20, base, sum(gs)/len(gs), sum(outs)/len(outs)):.2f} 元、"
            f"50 轮约 {run_cost(50, base, sum(gs)/len(gs), sum(outs)/len(outs)):.2f} 元、100 轮约 {run_cost(100, base, sum(gs)/len(gs), sum(outs)/len(outs)):.2f} 元"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("attempt_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fit", nargs="*", default=[], help="另外用于拟合 α 的尝试目录")
    ap.add_argument("--predict", help="任务集文件；给了就按难度分布预测全集花费（需要 datasets，用 eval 的 venv 跑）")
    a = ap.parse_args()
    d = Path(a.attempt_dir); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    reqs, chars = load(d)
    outputs = [r["output"] for r in reqs]
    alpha, beta, gamma, r2, nrows = fit_alpha([d] + [Path(x) for x in a.fit])
    strategies = [("基线（实际）", "base", None), ("只留最近 5 条工具输出", "keep_last", 5),
                  ("只留最近 10 条", "keep_last", 10), ("只留最近 20 条", "keep_last", 20),
                  ("单次工具输出截断到 4k 字符", "truncate", 4000),
                  ("pi 压缩，默认 contextWindow 262144", "compact", 262144),
                  ("pi 压缩，contextWindow 65536", "compact", 65536),
                  ("pi 压缩，contextWindow 49152", "compact", 49152)]
    res, curves = [], {}
    for name, s, p in strategies:
        ins, extra = replay(reqs, chars, alpha, s, p)
        curves[name] = ins
        append_only = s in ("base", "truncate")  # 只追加的上下文才能吃到前缀缓存
        res.append((name, sum(ins) + sum(e[0] for e in extra), max(ins), len(extra), cost(ins, outputs, extra),
                    cost(ins, outputs, extra, cached=True) if append_only else None))
    real = sum(r["input"] for r in reqs)
    with (out / "replay.csv").open("w", encoding="utf-8") as f:
        f.write("turn," + ",".join(curves) + ",actual\n")
        for i in range(len(reqs)):
            f.write(f"{i+1}," + ",".join(str(curves[k][i]) for k in curves) + f",{reqs[i]['input']}\n")
    colors = ["#222", "#2a6fdb", "#5a9be8", "#9cc3f0", "#d9822b", "#888", "#2a9d5c", "#7cc79b"]
    w, h, pad = 820, 380, 55; my = max(max(v) for v in curves.values())
    poly = lambda v: " ".join(f"{pad + (w - 2*pad) * i / (len(v) - 1):.1f},{h - pad - (h - 2*pad) * y / my:.1f}" for i, y in enumerate(v))
    (out / "replay.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h + 20*len(curves)}" font-family="sans-serif" font-size="12">'
        f'<rect width="100%" height="100%" fill="white"/><text x="{pad}" y="25">每轮输入 token（重放，最大 {my:,}）</text>'
        + "".join(f'<polyline points="{poly(v)}" fill="none" stroke="{c}" stroke-width="2"/>'
                  f'<text x="{pad}" y="{h + 18*(k+1)}" fill="{c}">— {name}</text>' for k, ((name, v), c) in enumerate(zip(curves.items(), colors)))
        + "</svg>", encoding="utf-8")
    md = [f"# 上下文策略反事实重放：{d}", "", "由 `scripts/context-replay.py` 生成。**前提：轨迹不变。** 丢上下文的策略在真实运行里可能让 agent 多走几轮或改变成败，"
          "所以下表既不是花费上界，也不能预测成功率；只说明同一条轨迹在各策略下要发多少 token。", "",
          f"- 工具结果 token 系数 α = {alpha:.3f} token/字符（拟合 inc = α·字符 + {beta:.2f}·输出 + {gamma:.0f}，R² {r2:.3f}，{nrows} 个点）",
          f"- 重建校验：基线重放的总输入 {res[0][1]:,}，实际 {real:,}",
          f"- pi 压缩按 1.5.1 默认 reserveTokens {RESERVE}、keepRecentTokens {KEEP_RECENT}；摘要输出假设 {SUMMARY_OUT} token、摘要请求另加 {SUMMARY_PROMPT} token", "",
          "| 策略 | 总输入 token | 最大单轮输入 | 额外摘要请求 | 花费（原价） | 花费（假设隐式缓存 20%，仅只追加策略） |", "|---|---|---|---|---|---|",
          *[f"| {n} | {t:,} | {m:,} | {e} | {c:.2f} 元 | {'' if cc is None else f'{cc:.2f} 元'} |" for n, t, m, e, c, cc in res],
          "", "- 「只留最近 k 条」和压缩都会改写历史前缀，和前缀缓存冲突：每轮前缀都变，缓存命中率接近 0，所以这两类不算缓存价。",
          "- 曲线：`replay.svg`；逐轮：`replay.csv`"]
    dec = [decompose(x, alpha) for x in [d] + [Path(p) for p in a.fit]]
    keys = ["系统提示+题目", "工具结果", "文字+工具调用参数", "思考内容", "未解释"]
    md += ["", "## 累计输入的来源分解（α 用全部运行合并拟合）", "",
           "| 运行 | 轮数 | 累计输入 | 花费 | " + " | ".join(keys) + " |", "|---|---|---|---|" + "---|" * len(keys),
           *[f"| {r['run']} | {r['turns']} | {r['total']:,} | {r['cost']:.2f} 元 | " + " | ".join(f"{r[k]:.0%}" for k in keys) + " |" for r in dec]]
    if a.predict:
        md += predict(Path(a.predict), [d] + [Path(x) for x in a.fit])
    (out / "replay.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
