#!/usr/bin/env python3
"""T2 过程成本测量，输出 CSV 到 stdout。只读：不改仓库、不改运行产物。

  python3 scripts/process-cost.py tasks [--ledger <progress.md>] [--since 15b3f77]
  python3 scripts/process-cost.py phases eval/runs/<运行名> [...]

tasks：按 git log --numstat 给每个小任务算提交数、墙钟、代码/测试/文档行；按执行账本算返修轮数与审查抓到的问题数。
  归属规则：提交标题含「T2-N」的归 N；其余归到下一个「计划勾选 T2-N」提交所属的 N；最后一个勾选之后的归最后那个任务。
  span_h = 该任务第一个到最后一个提交的时长；elapsed_h = 上一个任务的勾选提交到本任务勾选提交的时长（含等作者的时间）。
  rounds = 账本「fix round R/5」的最大 R；review_fixed = 各轮「X addressed」之和（审查与 ponytail 发现、经返修落实的问题数）。
phases：从运行目录的文件时间与事件时间算一次运行各阶段用时（秒）。
"""
import argparse
import csv
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LEDGER = REPO / ".superpowers/sdd/2026-11-25-T2-eval-framework/progress.md"
TAG = re.compile(r"T2-(\d+b?)")
TICK = re.compile(r"计划勾选 T2-(\d+b?)")
ROUND = re.compile(r"^- (?:Task |T2-)(\d+b?(?:~\d+)?)[：:\s]*fix round (\d+)/5\s*[（(](\d+) addressed", re.M)
# T2-14 的计划勾选没有单独提交，以它最后一个提交为边界。shortcut: 手写边界，以后每个任务都有勾选提交就删掉
EXTRA_TICKS = {"fcf03d3": "14"}


def kind(path: str) -> str:
    if re.search(r"(^|/)tests?/|(^|/)test_[^/]*\.py$|\.test\.ts$", path):
        return "test"
    if path.endswith(".md") or path.startswith("docs/"):
        return "doc"
    if re.search(r"\.(py|ts|mjs|js|sh)$", path):
        return "code"
    return "other"  # 配置、任务集、workflow 等


def commits(since: str) -> list[dict]:
    out = subprocess.run(["git", "-C", str(REPO), "log", "--reverse", "--numstat", "--format=%x00%h%x09%at%x09%s",
                          f"{since}..HEAD"], capture_output=True, text=True, check=True).stdout
    res = []
    for block in out.split("\0")[1:]:
        head, *rest = block.strip("\n").split("\n")
        sha, at, subject = head.split("\t", 2)
        lines = defaultdict(int)
        for r in rest:
            if not r.strip():
                continue
            add, dele, path = r.split("\t", 2)
            if add == "-":  # 二进制文件
                continue
            k = kind(path)
            lines[f"{k}_add"] += int(add)
            lines[f"{k}_del"] += int(dele)
        res.append({"sha": sha, "at": int(at), "subject": subject, "lines": lines})
    return res


def assign(cs: list[dict]) -> tuple[dict, dict]:
    """返回 {任务: [提交]} 与 {任务: 勾选提交时间}。"""
    by_task, ticks, pending, last = defaultdict(list), {}, [], None
    for c in cs:
        tick = TICK.search(c["subject"])
        n = tick.group(1) if tick else EXTRA_TICKS.get(c["sha"])
        tag = TAG.search(c["subject"])
        if n:
            by_task[n] += pending + [c]
            pending, last = [], n
            ticks.setdefault(n, c["at"])  # 同一任务多次勾选时取第一次
        elif tag:
            by_task[tag.group(1)].append(c)
        else:
            pending.append(c)
    if pending and last:
        by_task[last] += pending
    return by_task, ticks


def rounds(ledger: Path) -> dict:
    res = defaultdict(lambda: [0, 0])
    for t, r, x in ROUND.findall(ledger.read_text(encoding="utf-8")):
        res[t][0] = max(res[t][0], int(r))
        res[t][1] += int(x)
    return res


def order(t: str) -> tuple:
    m = re.match(r"(\d+)(b?)(?:~(\d+))?", t)
    return int(m.group(1)), m.group(2), m.group(3) or ""


def tasks(a) -> None:
    by_task, ticks = assign(commits(a.since))
    rr = rounds(Path(a.ledger))
    cols = ["task", "commits", "span_h", "elapsed_h", "code_add", "code_del", "test_add", "test_del",
            "doc_add", "doc_del", "other_add", "other_del", "rounds", "review_fixed", "note"]
    w = csv.DictWriter(sys.stdout, cols)
    w.writeheader()
    tick_order = sorted(ticks, key=lambda t: ticks[t])
    for t in sorted(set(by_task) | set(rr), key=order):
        cs = by_task.get(t, [])
        row = {c: "" for c in cols}
        row["task"] = f"T2-{t}"
        if cs:
            lines = defaultdict(int)
            for c in cs:
                for k, v in c["lines"].items():
                    lines[k] += v
            row.update({k: lines.get(k, 0) for k in cols if k.endswith(("_add", "_del"))})
            row["commits"] = len(cs)
            row["span_h"] = round((max(c["at"] for c in cs) - min(c["at"] for c in cs)) / 3600, 2)
        if t in ticks:
            i = tick_order.index(t)
            prev = ticks[tick_order[i - 1]] if i else min(c["at"] for c in cs)
            row["elapsed_h"] = round((ticks[t] - prev) / 3600, 2)
        if "~" in t:
            row["note"] = "组合返修，只有账本列"
        elif t in ("6", "7", "8", "9"):
            row["note"] = "返修计在 T2-6~9 行"
        if t in rr:
            row["rounds"], row["review_fixed"] = rr[t]
        elif cs and t not in ("6", "7", "8", "9"):
            row["rounds"], row["review_fixed"] = 0, 0
        w.writerow(row)


def ts(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def phases(a) -> None:
    cols = ["run", "attempt_dir", "setup_s", "prep_s", "agent_s", "extract_s", "grade_s", "total_s",
            "agent_pct", "prep_pct", "grade_pct"]
    w = csv.DictWriter(sys.stdout, cols)
    w.writeheader()
    for run in map(Path, a.runs):
        for rec_path in sorted(run.glob("**/record.json")):
            d = rec_path.parent
            ev = [json.loads(x) for x in (d / "events.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
            started = next(e["at"] for e in ev if e["type"] == "run.started")
            reports = sorted(d.glob("grade/*/report.json"))
            t_models = (d / "models.json").stat().st_mtime  # 写完 models.json 后才起容器
            t_patch = (d / "patch.diff").stat().st_mtime  # 取补丁并删容器之后写
            t_graded = reports[-1].stat().st_mtime if reports else t_patch
            agent = json.loads(rec_path.read_text(encoding="utf-8"))["wall_s"]
            p = {
                "setup_s": t_models - run.stat().st_birthtime,  # 代理启动等（数据集下载在建目录之前，不在内）
                "prep_s": ts(started) - t_models,  # 起容器 + 有效基准 + 截断与自检 + runner 启动
                "agent_s": agent,
                "extract_s": t_patch - ts(ev[-1]["at"]),  # 取补丁 + 删容器
                "grade_s": t_graded - t_patch,  # 新容器评分（含重评）
            }
            total = sum(p.values())
            w.writerow({"run": run.name, "attempt_dir": str(d.relative_to(run)),
                        **{k: round(v, 1) for k, v in p.items()}, "total_s": round(total, 1),
                        "agent_pct": round(100 * agent / total), "prep_pct": round(100 * p["prep_s"] / total),
                        "grade_pct": round(100 * p["grade_s"] / total)})


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tasks")
    t.add_argument("--ledger", default=str(LEDGER))
    t.add_argument("--since", default="15b3f77")  # T1 收尾提交，T2 之前的最后一个
    ph = sub.add_parser("phases")
    ph.add_argument("runs", nargs="+")
    a = ap.parse_args()
    tasks(a) if a.cmd == "tasks" else phases(a)


if __name__ == "__main__":
    main()
