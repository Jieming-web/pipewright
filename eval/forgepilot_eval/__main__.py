"""一条命令跑完任务集（T2 计划 Task 13，MVP 精简版）：

    PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run --config <yaml> --taskset <json> --out eval/runs/<名字> [--yes] [--env-file <.env>]

按顺序逐个实例「运行 → 评分」；infra_error 与 rate_limited 按 D10 重试（rate_limited 先退避），确定性的基础设施
错误不重试；写 summary.json / summary.md；无论怎样结束都按标签清理；最后用 check-secrets 扫描输出目录。
退出码：0 = 评测完整且扫描干净；1 = 无效、扫描发现问题或取消；2 = 开跑前检查不通过。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

from .config import config_hash, load_config
from .grade import grade
from .repo_prep import BaseMismatch, DirtyWorktree, HistoryLeak
from .report import aggregate, estimate_cost, outcome, render_md
from .run_task import TaskRecord, proxy_routes, run_instance
from .sandbox import cleanup_run, start_proxy
from .taskset import local_platform, taskset_sha256

REPO = Path(__file__).resolve().parents[2]
RATE_LIMIT_BACKOFF_S = 60
DETERMINISTIC = (BaseMismatch, HistoryLeak, DirtyWorktree)  # 镜像的确定性性质，重试只是白跑（作者 2026-11-26）
RUN_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")  # 评测名进容器名、网络名与标签


def load_rows(ts: dict) -> dict[str, dict]:
    """任务集只记 instance_id，数据集行按任务集里固定的 dataset 与 revision 取。"""
    from datasets import load_dataset

    want = set(ts["instance_ids"])
    rows = {r["instance_id"]: dict(r) for r in load_dataset(ts["dataset"], split="test", revision=ts["revision"])
            if r["instance_id"] in want}
    missing = want - set(rows)
    if missing:
        raise ValueError(f"{ts['dataset']}@{ts['revision']} has no rows for {sorted(missing)}")
    return rows


def read_env_key(path: Path, name: str) -> str | None:
    for line in path.read_text(encoding="utf-8").splitlines():
        k, sep, v = line.partition("=")
        if sep and k.strip().removeprefix("export ").strip() == name:
            return v.strip().strip("'\"")
    return None


def run_one(inst: dict, cfg, run: str, out: Path) -> list[TaskRecord]:
    """一个实例的全部尝试（最后一条是最终结果）。run_instance 交出 infra_error 有两种方式：返回带 infra_error 的
    record，或写好 record.json 后抛异常——两种都接住；没写出 record 的异常照常抛出。"""
    recs: list[TaskRecord] = []
    for attempt in range(1, cfg.scoring["max_retries"] + 2):
        if recs and outcome(recs[-1]) == "rate_limited":
            time.sleep(RATE_LIMIT_BACKOFF_S)
        d = out / inst["instance_id"] / str(attempt)
        deterministic = False
        try:
            rec = run_instance(inst, cfg, run, out, attempt)
        except Exception as e:
            if not (d / "record.json").exists():
                raise
            rec = TaskRecord(**json.loads((d / "record.json").read_text(encoding="utf-8")))
            deterministic = isinstance(e, DETERMINISTIC)
        if rec.failure_type == "none":
            patch = (d / "patch.diff").read_bytes().decode("utf-8", errors="surrogateescape")
            g = grade(inst, patch, d / "grade", run, cfg.grade_timeout_s)
            rec.grade_status, rec.grade_image, rec.grade_image_digest, rec.grade_arch = g.status, g.image, g.image_digest, g.arch
            (d / "record.json").write_text(json.dumps(asdict(rec), indent=2, ensure_ascii=False), encoding="utf-8")
        recs.append(rec)
        print(f"  {inst['instance_id']} #{attempt}: {outcome(rec)}" + (f"（{rec.failure_reason}）" if rec.failure_reason else ""),
              flush=True)
        if deterministic or outcome(rec) not in cfg.scoring["retry_then_exclude"]:
            break
    return recs


def check_secrets(out: Path, name: str, value: str) -> bool:
    r = subprocess.run(["node", "--experimental-strip-types", str(REPO / "scripts" / "check-secrets.ts"),
                        "--env", name, "--local-paths", str(out)], cwd=REPO, env={**os.environ, name: value})
    return r.returncode == 0


def run_eval(a: argparse.Namespace) -> int:
    out = Path(a.out)
    if out.exists():
        print(f"输出目录已存在，拒绝运行：{out}", file=sys.stderr)
        return 2
    if not RUN_NAME.fullmatch(out.name):
        print(f"输出目录名只能含字母、数字、_ . -（它也是容器与网络名）：{out.name}", file=sys.stderr)
        return 2
    cfg = load_config(a.config)
    if not (cfg.bundle / "bin" / "fp-entry").is_file():
        print(f"运行包里没有 bin/fp-entry：{cfg.bundle}；先运行 scripts/build-eval-bundle.sh {local_platform()}",
              file=sys.stderr)
        return 2
    ts = json.loads(Path(a.taskset).read_text(encoding="utf-8"))
    plat = local_platform()
    no_image = [i for i in ts["instance_ids"] if plat not in ts["images"][i]]
    if no_image:
        print(f"任务集 {ts['name']} 没有 {plat} 镜像：{no_image}", file=sys.stderr)
        return 2
    key_env = cfg.model["keyEnv"]
    key = read_env_key(Path(a.env_file), key_env)
    if not key:
        print(f"{a.env_file} 里没有 {key_env}", file=sys.stderr)
        return 2

    n = len(ts["instance_ids"])
    assumed = cfg.assumed_tokens_per_run
    est = estimate_cost(cfg, n)
    print(f"预计花费：{est:.2f} 元（{n} 次运行 × 每次 {assumed['input']} 输入 + {assumed['output']} 输出 token，"
          f"重试另计；假设来源：{assumed['source']}）")
    if not a.yes and input("继续？[y/N] ").strip().lower() != "y":
        print("已取消")
        return 1

    rows = load_rows(ts)
    sha = taskset_sha256(a.taskset)
    run = out.name
    out.mkdir(parents=True)
    error: BaseException | None = None
    try:
        start_proxy(run, proxy_routes(cfg), {key_env: key})
        finals, attempts = [], []
        for iid in ts["instance_ids"]:
            inst = {**rows[iid], "image": ts["images"][iid][plat], "probe_blobs": ts["probe_blobs"][iid],
                    "taskset_sha256": sha}
            recs = run_one(inst, cfg, run, out)
            attempts += recs
            finals.append(recs[-1])
        s = {"taskset": {"name": ts["name"], "version": ts["version"], "sha256": sha},
             "config_hash": config_hash(cfg), "model": cfg.model["id"], "platform": plat,
             "estimate": {"yuan": est, "source": assumed["source"]},
             **aggregate(finals, cfg, ts["name"], attempts)}
        (out / "summary.json").write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
        (out / "summary.md").write_text(render_md(s), encoding="utf-8")
    except BaseException as e:
        error = e
        raise
    finally:
        try:
            cleanup_run(run)
        except Exception as ce:
            if error is None:
                print("评测完成、清理失败", file=sys.stderr)
                raise
            print(f"cleanup_run 也失败了（原始异常照常抛出）：{type(ce).__name__}: {ce}", file=sys.stderr)

    clean = check_secrets(out, key_env, key)
    rate = "—" if s["success_rate"] is None else f"{s['success_rate']:.1%}"
    print(f"状态 {s['status']}；成功率 {rate}；实际花费 {s['cost']['actual_yuan']:.4f} 元；汇总：{out / 'summary.md'}")
    return 0 if s["status"] == "complete" and clean else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="forgepilot_eval")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="跑完一个任务集并汇总")
    r.add_argument("--config", required=True)
    r.add_argument("--taskset", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--yes", action="store_true", help="跳过花费确认")
    r.add_argument("--env-file", default=str(REPO / ".env"), help="API key 只从这里读（默认仓库根的 .env）")
    return run_eval(p.parse_args(argv))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # 让 SIGTERM 也走 finally 清理
    sys.exit(main())
