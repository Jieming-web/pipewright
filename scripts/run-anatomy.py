#!/usr/bin/env python3
"""单次运行解剖：只读已有文件，不调 API、不改任何东西。

  PYTHONPATH=eval eval/.venv/bin/python scripts/run-anatomy.py <尝试目录> --out <输出目录>
  例：... eval/runs/dev-v1-qwen-cap100-aborted/rep-1/astropy__astropy-13579/1 --out /tmp/anatomy

尝试目录下要有 events.jsonl、record.json（以及 fp-out/raw.jsonl）；上两级是运行目录（proxy.jsonl、run.json）。
输出：summary.md（全部结论数字）、tokens.csv、tokens.svg、steps.csv。
"""
import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path

PRICE = {"input": 1.8, "output": 10.8}  # 元/百万，qwen3.6-35b-a3b 百炼北京（实现说明 0.6）
# 百炼上下文缓存（https://help.aliyun.com/zh/model-studio/context-cache）：隐式缓存命中按输入单价 20%，
# 显式缓存命中 10%、创建 125%。qwen3.6-35b-a3b 不支持缓存（实现说明 0.6），下面的缓存价只是假设对照。
IMPLICIT, EXPLICIT_HIT, EXPLICIT_CREATE = 0.2, 0.1, 1.25
TEST_RX = re.compile(r"\b(pytest|python3?\s+-m\s+pytest|python3?\s+-c|python3?\s+\S+\.py|tox)\b")
READ_CMD_RX = re.compile(r"\b(cat|sed\s+-n|head|tail|grep|rg|less|nl|awk)\b")


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]


def gold_info(iid: str, ts_path: Path | None) -> dict:
    from datasets import load_dataset  # 只读本地缓存；离线用 HF_HUB_OFFLINE=1

    ts = json.loads(ts_path.read_text()) if ts_path else {"dataset": "SWE-bench/SWE-bench_Verified", "revision": None}
    row = next(r for r in load_dataset(ts["dataset"], split="test", revision=ts.get("revision")) if r["instance_id"] == iid)
    files = re.findall(r"^diff --git a/(\S+) b/", row["patch"], re.M)
    added = sum(1 for x in row["patch"].splitlines() if x.startswith("+") and not x.startswith("+++"))
    removed = sum(1 for x in row["patch"].splitlines() if x.startswith("-") and not x.startswith("---"))
    f2p = json.loads(row["FAIL_TO_PASS"]) if isinstance(row["FAIL_TO_PASS"], str) else row["FAIL_TO_PASS"]
    p2p = json.loads(row["PASS_TO_PASS"]) if isinstance(row["PASS_TO_PASS"], str) else row["PASS_TO_PASS"]
    return {"difficulty": row.get("difficulty"), "files": files, "added": added, "removed": removed,
            "fail_to_pass": len(f2p), "pass_to_pass": len(p2p), "problem_chars": len(row["problem_statement"])}


def out_text(ev: dict) -> str:
    o = ev.get("output") or {}
    if isinstance(o, dict):
        return "".join(c.get("text", "") for c in o.get("content", []) if isinstance(c, dict))
    return str(o)


def summarize_input(tool: str, inp: dict) -> str:
    if tool == "bash":
        return (inp.get("command") or "").replace("\n", " ⏎ ")[:120]
    return json.dumps(inp, ensure_ascii=False)[:120]


def code_step(tool: str, inp: dict, gold: list[str]) -> str:
    blob = json.dumps(inp, ensure_ascii=False)
    touches_gold = any(g in blob or Path(g).name in blob for g in gold)
    if tool in ("edit", "write"):
        return "编辑"
    if tool == "bash" and TEST_RX.search(inp.get("command") or ""):
        return "测试"
    if touches_gold and (tool in ("read", "grep", "find") or (tool == "bash" and READ_CMD_RX.search(inp.get("command") or ""))):
        return "定位"
    return "探索"


def linfit(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx; a = my - b * mx
    ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys)); ss_tot = sum((y - my) ** 2 for y in ys)
    return a, b, 1 - ss_res / ss_tot


def svg(rows: list[dict], path: Path) -> None:
    w, h, pad = 760, 360, 50
    xs = [r["i"] for r in rows]; ys = [r["input"] for r in rows]
    mx, my = max(xs), max(ys) or 1
    pt = lambda x, y: (pad + (w - 2 * pad) * (x - 1) / max(mx - 1, 1), h - pad - (h - 2 * pad) * y / my)
    line = " ".join(f"{a:.1f},{b:.1f}" for a, b in (pt(x, y) for x, y in zip(xs, ys)))
    cum = 0; cl = []
    for x, y in zip(xs, ys):
        cum += y; cl.append((x, cum))
    cmax = cum or 1
    cline = " ".join(f"{a:.1f},{b:.1f}" for a, b in ((pt(x, 0)[0], h - pad - (h - 2 * pad) * c / cmax) for x, c in cl))
    path.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="sans-serif" font-size="12">'
        f'<rect width="100%" height="100%" fill="white"/>'
        f'<line x1="{pad}" y1="{h-pad}" x2="{w-pad}" y2="{h-pad}" stroke="#888"/><line x1="{pad}" y1="{pad}" x2="{pad}" y2="{h-pad}" stroke="#888"/>'
        f'<polyline points="{line}" fill="none" stroke="#2a6fdb" stroke-width="2"/>'
        f'<polyline points="{cline}" fill="none" stroke="#d9822b" stroke-width="2" stroke-dasharray="5,4"/>'
        f'<text x="{pad}" y="{pad-15}">每次请求输入 token（蓝，左轴最大 {my:,}）；累计输入（橙虚线，最大 {cmax:,}）</text>'
        f'<text x="{w-pad-60}" y="{h-pad+30}">请求序号 1–{mx}</text></svg>', encoding="utf-8")


SIM = 0.9  # 与更早一步的相似度达到它就算「近似重复」


def tail_section(started: list[dict], steps: list[dict], start: int, out: Path) -> list[str]:
    """调试尾巴：从第 start 步起逐步列出，并检测「相同/近似测试命令」与「相近编辑」。"""
    from difflib import SequenceMatcher

    def text(s: dict) -> str:
        inp = s.get("input") or {}
        return inp.get("command") if s["toolName"] == "bash" else json.dumps(inp, sort_keys=True, ensure_ascii=False)

    rows = []
    for k, (s, st) in enumerate(zip(started, steps), 1):
        dup, sim = None, 0.0
        if st["label"] in ("测试", "编辑", "循环"):
            for j in range(k - 1, 0, -1):  # 找最相似的更早同类步骤
                if steps[j - 1]["tool"] != st["tool"]:
                    continue
                r = SequenceMatcher(None, text(started[j - 1]), text(s), autojunk=False).ratio()
                if r > sim:
                    dup, sim = j, r
        rows.append({**st, "dup_of": dup if sim >= SIM else None, "sim": round(sim, 3)})
    tail = [r for r in rows if r["step"] >= start]
    with (out / "tail.csv").open("w", encoding="utf-8") as f:
        f.write("step,tool,label,isError,out_chars,dup_of,sim,summary\n")
        for r in tail:
            f.write(f'{r["step"]},{r["tool"]},{r["label"]},{r["isError"]},{r["out_chars"]},{r["dup_of"] or ""},{r["sim"]},"{r["summary"].replace(chr(34), chr(39))}"\n')
    near = [r for r in tail if r["dup_of"]]
    tests = [r for r in tail if r["label"] in ("测试", "循环") and r["tool"] == "bash"]
    edits = [r for r in tail if r["tool"] in ("edit", "write")]
    return ["", f"## 6. 调试尾巴（第 {start}–{len(rows)} 步，逐步见 tail.csv）", "",
            f"- 共 {len(tail)} 步：测试类 bash {len(tests)}、编辑 {len(edits)}（出错 {sum(1 for r in edits if r['isError'])}）、其他 {len(tail) - len(tests) - len(edits)}",
            f"- 与更早同类步骤相似度 ≥ {SIM} 的步（近似重复）：{len(near)} 步",
            *[f"  - 第 {r['step']} 步 {r['tool']}（{r['label']}）≈ 第 {r['dup_of']} 步，相似度 {r['sim']}，输出 {r['out_chars']:,} 字符：`{r['summary'][:70]}`" for r in near],
            f"- 测试类 bash 的输出字符：合计 {sum(r['out_chars'] for r in tests):,}，出错 {sum(1 for r in tests if r['isError'])} 次"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("attempt_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--taskset", default="eval/tasksets/dev-v1.json")
    ap.add_argument("--tail-from", type=int, default=19)
    a = ap.parse_args()
    d = Path(a.attempt_dir); run_dir = d.parent.parent.parent; out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    rec = json.loads((d / "record.json").read_text())
    ev = load_jsonl(d / "events.jsonl")
    iid = rec["instance_id"]
    done = d.parent / "done.json"
    attempts = len(json.loads(done.read_text())) if done.exists() else None
    reqs = [e for e in ev if e["type"] == "model.request.finished"]
    started = [e for e in ev if e["type"] == "tool.started"]
    finished = {e["callId"]: e for e in ev if e["type"] == "tool.finished"}
    proxy = load_jsonl(run_dir / "proxy.jsonl") if (run_dir / "proxy.jsonl").exists() else []
    other_attempts = [p for p in run_dir.glob("rep-*/*/*/events.jsonl") if p != d / "events.jsonl"]
    other_reqs = sum(1 for p in other_attempts for e in load_jsonl(p) if e["type"] == "model.request.finished")
    raw = d / "fp-out" / "raw.jsonl"
    raw_types = Counter()
    if raw.exists():
        for line in raw.open(encoding="utf-8"):
            try:
                raw_types[json.loads(line).get("type", "?")] += 1
            except json.JSONDecodeError:
                raw_types["<坏行>"] += 1
    compaction = {k: v for k, v in raw_types.items() if "compact" in k.lower()}

    # 逐轮 token
    rows, prev = [], None
    for i, e in enumerate(reqs, 1):
        u = e.get("usage") or {}
        r = {"i": i, "stopReason": e.get("stopReason"), **{k: u.get(k, 0) for k in ("input", "cacheRead", "cacheWrite", "output", "reasoning")}}
        r["delta_input"] = r["input"] - (prev["input"] + prev["output"]) if prev else r["input"]
        rows.append(r); prev = r
    a0, slope, r2 = linfit([r["i"] for r in rows], [r["input"] for r in rows])
    with (out / "tokens.csv").open("w", encoding="utf-8") as f:
        cols = ["i", "stopReason", "input", "cacheRead", "cacheWrite", "output", "reasoning", "delta_input"]
        f.write(",".join(cols) + "\n")
        for r in rows:
            f.write(",".join(str(r[c]) for c in cols) + "\n")
    svg(rows, out / "tokens.svg")
    tin = sum(r["input"] + r["cacheRead"] + r["cacheWrite"] for r in rows); tout = sum(r["output"] for r in rows)
    list_cost = tin * PRICE["input"] / 1e6 + tout * PRICE["output"] / 1e6
    # 假设缓存：每次请求的前缀 = 上一次请求的输入 + 输出（只有新的工具结果是新增）
    cacheable = sum(min(rows[k - 1]["input"] + rows[k - 1]["output"], rows[k]["input"]) for k in range(1, len(rows)))
    fresh = tin - cacheable
    implicit_cost = (fresh + cacheable * IMPLICIT) * PRICE["input"] / 1e6 + tout * PRICE["output"] / 1e6
    explicit_cost = (fresh * EXPLICIT_CREATE + cacheable * EXPLICIT_HIT) * PRICE["input"] / 1e6 + tout * PRICE["output"] / 1e6

    # 轨迹开放编码
    g = gold_info(iid, Path(a.taskset) if Path(a.taskset).exists() else None)
    seen, steps = set(), []
    for k, s in enumerate(started, 1):
        inp = s.get("input") or {}
        key = (s["toolName"], json.dumps(inp, sort_keys=True))
        label = "循环" if key in seen else code_step(s["toolName"], inp, g["files"])
        seen.add(key)
        fin = finished.get(s["callId"], {})
        steps.append({"step": k, "tool": s["toolName"], "label": label, "isError": fin.get("isError"),
                      "out_chars": len(out_text(fin)), "summary": summarize_input(s["toolName"], inp),
                      "touches_gold": any(x in json.dumps(inp) or Path(x).name in json.dumps(inp) for x in g["files"])})
    with (out / "steps.csv").open("w", encoding="utf-8") as f:
        f.write("step,tool,label,isError,out_chars,touches_gold,summary\n")
        for s in steps:
            f.write(f'{s["step"]},{s["tool"]},{s["label"]},{s["isError"]},{s["out_chars"]},{s["touches_gold"]},"{s["summary"].replace(chr(34), chr(39))}"\n')
    labels = Counter(s["label"] for s in steps)
    first_gold_read = next((s["step"] for s in steps if s["touches_gold"] and s["label"] in ("定位", "探索")), None)
    first_gold_edit = next((s["step"] for s in steps if s["touches_gold"] and s["label"] == "编辑"), None)
    edits_gold = sorted({x for s in steps if s["label"] == "编辑" for x in g["files"] if x in s["summary"] or Path(x).name in s["summary"]})
    top10 = sorted(steps, key=lambda s: -s["out_chars"])[:10]
    out_chars_total = sum(s["out_chars"] for s in steps)
    errs = [s for s in steps if s["isError"]]

    md = [f"# 运行解剖：{iid}", "",
          f"来源：`{d}`；运行目录 `{run_dir}`。本文件由 `scripts/run-anatomy.py` 生成。", "",
          "## 1. 计数", "",
          f"- 模型请求（`model.request.finished`）：{len(reqs)}；`tool.started`：{len(started)}；`tool.finished`：{len(finished)}，其中出错 {len(errs)}",
          f"- record.json：`tool_calls`（拦截策略计数）={rec['tool_calls']}，`requests`={rec['requests']}，failure_type=`{rec['failure_type']}`，评分 `{rec.get('grade_status')}`",
          f"- 代理日志 proxy.jsonl：{len(proxy)} 行（整次运行）；同一运行其他尝试的模型请求 {other_reqs} 次",
          f"- D10 尝试次数（done.json）：{attempts}",
          f"- `tool.started` 与拦截计数之差：{len(started) - rec['tool_calls']}（拦截计数只统计经过 intercept 回调的调用）",
          f"- raw.jsonl 事件类型：{dict(raw_types.most_common(12))}；压缩事件：{compaction or '无'}",
          "", "## 2. 逐轮 token", "",
          f"- 每次请求输入的线性拟合：截距 {a0:,.0f}，斜率 **{slope:,.0f} token/轮**，R² {r2:.3f}；首轮 {rows[0]['input']:,}，末轮 {rows[-1]['input']:,}",
          f"- 输入是否单调不减（没有压缩或截断历史）：{all(rows[k]['input'] >= rows[k-1]['input'] for k in range(1, len(rows)))}",
          f"- 每轮新增输入（delta_input，≈上一轮工具结果）：中位数 {sorted(r['delta_input'] for r in rows[1:])[len(rows)//2 - 1]:,}，最大 {max(r['delta_input'] for r in rows[1:]):,}",
          f"- 累计：输入 {tin:,}（cacheRead {sum(r['cacheRead'] for r in rows):,}），输出 {tout:,}（reasoning {sum(r['reasoning'] for r in rows):,}）",
          "- 曲线：`tokens.svg`；逐轮：`tokens.csv`",
          "", "## 3. 花费", "",
          f"- 原价（输入 {PRICE['input']}、输出 {PRICE['output']} 元/百万）：**{list_cost:.2f} 元**（输入 {tin*PRICE['input']/1e6:.2f}、输出 {tout*PRICE['output']/1e6:.2f}）",
          f"- 假设可缓存前缀 {cacheable:,} token（每轮前缀 = 上一轮输入 + 输出），新增 {fresh:,}",
          f"- 若按隐式缓存价（命中 {IMPLICIT:.0%}）：{implicit_cost:.2f} 元；若按显式缓存（命中 {EXPLICIT_HIT:.0%}、创建 {EXPLICIT_CREATE:.0%}）：{explicit_cost:.2f} 元",
          "- 出处：https://help.aliyun.com/zh/model-studio/context-cache ；qwen3.6-35b-a3b 不支持缓存（实现说明 0.6，https://help.aliyun.com/zh/model-studio/qwen3-6-35b-a3b），以上缓存价仅为对照，本次 cacheRead 为 0",
          "", "## 4. 轨迹编码", "",
          f"- 步骤标签：{dict(labels)}（规则：edit/write=编辑；bash 跑 pytest/python=测试；读写金标准文件=定位；与之前完全相同的工具+参数=循环；其余=探索）",
          f"- 工具结果总字符 {out_chars_total:,}（约 {out_chars_total//4:,} token）",
          "- 输出最长的 10 次工具调用：", "",
          "| 步 | 工具 | 标签 | 字符数 | 摘要 |", "|---|---|---|---|---|",
          *[f"| {s['step']} | {s['tool']} | {s['label']} | {s['out_chars']:,} | `{s['summary'][:80]}` |" for s in top10],
          "", f"- 出错的工具调用 {len(errs)} 次：步 {[s['step'] for s in errs]}",
          "", "## 5. 题目难度", "",
          f"- 数据集 difficulty：`{g['difficulty']}`；问题描述 {g['problem_chars']:,} 字符",
          f"- 金标准补丁：{len(g['files'])} 个文件 {g['files']}，+{g['added']}/-{g['removed']} 行；FAIL_TO_PASS {g['fail_to_pass']} 条，PASS_TO_PASS {g['pass_to_pass']} 条",
          f"- agent 第一次读到金标准文件：第 {first_gold_read} 步；第一次编辑金标准文件：第 {first_gold_edit} 步；编辑过的金标准文件 {edits_gold or '无'}",
          ]
    md += tail_section(started, steps, a.tail_from, out)
    (out / "summary.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
