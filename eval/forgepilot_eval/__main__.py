"""一条命令跑完任务集（T2 计划 Task 13 MVP 精简版、Task 14b）：

    PYTHONPATH=eval eval/.venv/bin/python -m forgepilot_eval run --config <yaml> --taskset <json> --out eval/runs/<名字> [--repeats N] [--resume] [--yes] [--env-file <.env>]

逐个实例「运行 → 评分」；infra_error 与 rate_limited 按 D10 重试（rate_limited 先退避），确定性的基础设施错误不重试，评分阶段的 infra_error 只重新评分；
写 summary.json / summary.md；无论怎样结束都先存代理日志（proxy.jsonl）、用 check-secrets 扫描输出目录，再按标签清理。
退出码：0 = 评测完整且扫描干净；1 = 无效、扫描发现问题或取消；2 = 开跑前检查不通过。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
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
    record，或写好 record.json 后抛异常——两种都接住；只有 run_instance 写 record 之前的异常才直接抛出。
    评分阶段的 infra_error 只用同一份补丁重新评分，不重跑 agent（作者 2026-11-26）。"""
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
            for n in range(1, cfg.scoring["max_retries"] + 2):
                g = grade(inst, patch, d / "grade" / str(n), run, cfg.grade_timeout_s)
                print(f"  {inst['instance_id']} #{attempt} 评分 {n}: {g.status}", flush=True)
                if g.status != "infra_error":
                    break
            rec.grade_status, rec.grade_image, rec.grade_image_digest, rec.grade_arch = g.status, g.image, g.image_digest, g.arch
            (d / "record.json").write_text(json.dumps(asdict(rec), indent=2, ensure_ascii=False), encoding="utf-8")
        recs.append(rec)
        print(f"  {inst['instance_id']} #{attempt}: {outcome(rec)}" + (f"（{rec.failure_reason}）" if rec.failure_reason else ""),
              flush=True)
        if deterministic or rec.failure_type == "none" or outcome(rec) not in cfg.scoring["retry_then_exclude"]:
            break
    return recs


def check_secrets(out: Path, name: str, value: str) -> bool:
    """不抛异常（在 finally 里调用，不能盖住原始异常或挡住清理）；跑不起来算不干净。"""
    try:
        r = subprocess.run(["node", "--experimental-strip-types", str(REPO / "scripts" / "check-secrets.ts"),
                            "--env", name, "--local-paths", str(out)], cwd=REPO, env={**os.environ, name: value})
    except OSError as e:
        print(f"check-secrets 没跑起来：{e}", file=sys.stderr)
        return False
    return r.returncode == 0


def run_eval(a: argparse.Namespace) -> int:
    out = Path(a.out)
    if out.exists() and not a.resume:
        print(f"输出目录已存在，拒绝运行：{out}（续跑加 --resume）", file=sys.stderr)
        return 2
    if a.repeats < 1:
        print("--repeats 至少为 1", file=sys.stderr)
        return 2
    cfg = load_config(a.config)
    if not all((cfg.bundle / f).is_file() for f in ("bin/fp-entry", "VERSION")):
        print(f"运行包里没有 bin/fp-entry 或 VERSION：{cfg.bundle}；先运行 scripts/build-eval-bundle.sh {local_platform()}",
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

    sha = taskset_sha256(a.taskset)
    meta = {"config_hash": config_hash(cfg), "taskset_sha256": sha,
            "VERSION": (cfg.bundle / "VERSION").read_text(encoding="utf-8").strip(), "repeats": a.repeats}
    if out.exists():  # 只有带 --resume 才走到这里
        old = json.loads((out / "run.json").read_text(encoding="utf-8")) if (out / "run.json").is_file() else {}
        diff = [k for k in meta if old.get(k) != meta[k]]
        if diff:
            print(f"run.json 与本次不一致，拒绝续跑：{', '.join(diff)}", file=sys.stderr)
            return 2

    n = len(ts["instance_ids"])
    todo = sum(not (out / f"rep-{k}" / i / "done.json").exists()
               for k in range(1, a.repeats + 1) for i in ts["instance_ids"])
    assumed = cfg.assumed_tokens_per_run
    est = estimate_cost(cfg, todo)
    print(f"预计花费：{est:.2f} 元（{todo} 次运行（{n} 题 × {a.repeats} 次重复，已完成的不算）× 每次 {assumed['input']} 输入 + "
          f"{assumed['output']} 输出 token，重试另计；假设来源：{assumed['source']}）")
    if not a.yes and input("继续？[y/N] ").strip().lower() != "y":
        print("已取消")
        return 1

    rows = load_rows(ts)
    run = out.name
    out.mkdir(parents=True, exist_ok=True)
    (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    error: BaseException | None = None
    proxy = None
    try:
        proxy = start_proxy(run, proxy_routes(cfg), {key_env: key})
        reps, attempts = [], []
        for k in range(1, a.repeats + 1):
            rep, finals = out / f"rep-{k}", []
            for iid in ts["instance_ids"]:
                d = rep / iid
                if (d / "done.json").exists():
                    recs = [TaskRecord(**x) for x in json.loads((d / "done.json").read_text(encoding="utf-8"))]
                else:
                    if d.resolve().parent != rep.resolve():  # 只许删 <out>/rep-<k>/<instance_id>/
                        raise ValueError(f"实例目录不在 {rep} 下：{d}")
                    if d.exists():
                        shutil.rmtree(d)
                    inst = {**rows[iid], "image": ts["images"][iid][plat], "probe_blobs": ts["probe_blobs"][iid],
                            "taskset_sha256": sha}
                    recs = run_one(inst, cfg, run, rep)
                    d.mkdir(parents=True, exist_ok=True)
                    (d / "done.json").write_text(json.dumps([asdict(r) for r in recs], indent=2, ensure_ascii=False),
                                                 encoding="utf-8")
                attempts += recs
                finals.append(recs[-1])
            reps.append(finals)
        s = {"taskset": {"name": ts["name"], "version": ts["version"], "sha256": sha},
             "config_hash": meta["config_hash"], "model": cfg.model["id"], "platform": plat,
             "estimate": {"yuan": est, "source": assumed["source"]},
             **aggregate(reps, cfg, ts["name"], attempts)}
        (out / "summary.json").write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
        (out / "summary.md").write_text(render_md(s), encoding="utf-8")
    except BaseException as e:
        error = e
        raise
    finally:
        # 收尾顺序：存代理日志 → 扫描（含异常结束）→ 清理；前两步不抛异常
        if proxy is not None:
            try:  # 每行只有路由、字段名、采样参数与状态码；供 T2-14 核对 temperature/top_p（作者 2026-11-26）；续跑追加
                with (out / "proxy.jsonl").open("a", encoding="utf-8") as f:
                    f.write("".join(json.dumps(x) + "\n" for x in proxy.logs()))
            except Exception as pe:
                print(f"代理日志没存下：{type(pe).__name__}: {pe}", file=sys.stderr)
        clean = check_secrets(out, key_env, key)
        try:
            cleanup_run(run)
        except Exception as ce:
            if error is None:
                print("评测完成、清理失败", file=sys.stderr)
                raise
            print(f"cleanup_run 也失败了（原始异常照常抛出）：{type(ce).__name__}: {ce}", file=sys.stderr)

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
    r.add_argument("--repeats", type=int, default=1, help="每道题跑几次（每次重复写到 <out>/rep-<k>/）")
    r.add_argument("--resume", action="store_true", help="续跑已存在的 --out：核对 run.json，跳过有 done.json 的")
    r.add_argument("--yes", action="store_true", help="跳过花费确认")
    r.add_argument("--env-file", default=str(REPO / ".env"), help="API key 只从这里读（默认仓库根的 .env）")
    return run_eval(p.parse_args(argv))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # 让 SIGTERM 也走 finally 清理
    sys.exit(main())
