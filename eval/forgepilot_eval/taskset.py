"""任务集：按仓库分层抽样与金标准预检（T2 计划 Task 11）。

任务集文件一旦提交就不再修改，有变更就发新版本；记录与续跑核对都用 taskset_sha256。
镜像每个平台只用一个来源、按 digest 锁定（design 3.11）：Mac arm64 统一用 Epoch AI，x86 用数据集里的镜像名。
"""

from __future__ import annotations

import hashlib
import json
import math
import platform
import random
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .grade import INFRA_ERRORS, grade
from .repo_prep import gold_probe_blobs
from .sandbox import LABEL, RUN_TIMEOUT_S, DockerError, _docker, cleanup_run

DATASET = "SWE-bench/SWE-bench_Verified"
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"  # T2-0 实测（实现说明 0.2）
RUNS = Path(__file__).resolve().parents[1] / "runs"  # 预检的评分日志写到 eval/runs/<run>/，不进 git
ATTEMPTS = 3  # infra_error 同样配置重试最多 2 次，仍失败记为「无法测量」（design 3.11）
SMOKE_GOLD_MAX_S = 600  # 入选标准 (4)：冷烟集金标准评分墙钟上限


@dataclass
class PrecheckResult:
    ok: bool
    reasons: list[str]
    probe_blobs: list[str]


class _Unmeasurable(Exception):
    pass


def stratified_sample(rows: list[dict], n: int, seed: int) -> list[str]:
    """按 repo 分层：每个仓库至少 1 个（n 小于仓库数时按种子随机选 n 个仓库、每个 1 个），其余名额按仓库条数
    比例分配，余数按种子随机分；仓库内按种子随机抽。结果按 instance_id 排序。"""
    by_repo: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        by_repo[r["repo"]].append(r["instance_id"])
    if n > len(rows):
        raise ValueError(f"n={n} exceeds {len(rows)} available rows")
    rng = random.Random(seed)
    repos = sorted(by_repo)
    if n < len(repos):
        repos = sorted(rng.sample(repos, n))
    rest = n - len(repos)
    alloc = {repo: 1 + min(rest * len(by_repo[repo]) // len(rows), len(by_repo[repo]) - 1) for repo in repos}
    left = n - sum(alloc.values())
    while left:
        open_repos = [repo for repo in repos if alloc[repo] < len(by_repo[repo])]
        for repo in rng.sample(open_repos, min(left, len(open_repos))):
            alloc[repo] += 1
            left -= 1
    return sorted(i for repo in repos for i in rng.sample(sorted(by_repo[repo]), alloc[repo]))


def local_platform() -> str:
    return "linux-arm64" if platform.machine().lower() in ("arm64", "aarch64") else "linux-x64"


def image_refs(inst: dict) -> dict[str, str]:
    """两个平台的 `name@digest`：arm64 为 Epoch AI 的镜像，x86 为数据集 image 字段；digest 取 registry 当前值。"""
    names = {"linux-arm64": f"ghcr.io/epoch-research/swe-bench.eval.arm64.{inst['instance_id']}:latest",
             "linux-x64": inst["image"]}
    refs = {}
    for plat, name in names.items():
        out = _docker("buildx", "imagetools", "inspect", name, "--format", "{{json .Manifest}}").stdout
        refs[plat] = f"{name.rsplit(':', 1)[0]}@{json.loads(out)['digest']}"
    return refs


def _ensure_image(image: str) -> None:
    """本地没有就拉取（失败抛 DockerError，按 infra_error 处理）；在金标准计时之前做，墙钟不含拉取。"""
    if _docker("image", "inspect", image, check=False).returncode != 0:
        _docker("pull", image, timeout=RUN_TIMEOUT_S)


def _node_version(image: str, bundle, run: str) -> tuple[int, str]:
    r = _docker("run", "--rm", "--label", f"{LABEL}={run}", "--network", "none",
                "-v", f"{Path(bundle).resolve()}:/fp:ro", image, "/fp/node/bin/node", "--version",
                check=False, timeout=RUN_TIMEOUT_S)
    if r.returncode == 125:  # docker 自身出错（拉取、建容器），不是运行包的问题
        raise DockerError(f"docker run failed (125): {r.stderr.strip()}")
    return r.returncode, r.stdout + r.stderr


def precheck(inst: dict, bundle, max_gold_s: float | None = None) -> PrecheckResult:
    """入选标准：(1) 金标准补丁 → resolved；(2) 空补丁时 FAIL_TO_PASS 每一条都失败；(3) 挂载运行包后
    node --version 成功；(4) max_gold_s 不为空时（冷烟集）金标准评分墙钟不超过它。inst["image"] 由调用方按本机
    平台选好（name@digest）；评分与正式评分一样不加 SYS_ADMIN。每条不满足的标准各记一条原因；通过时取金标准探针。
    infra_error 同样配置重试最多 2 次，仍失败返回「unmeasurable」。"""
    run = f"precheck-{uuid.uuid4().hex[:8]}"
    last = ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return _precheck_once(inst, bundle, run, RUNS / run / inst["instance_id"] / f"attempt-{attempt}", max_gold_s)
        except (_Unmeasurable, *INFRA_ERRORS) as e:
            last = f"{type(e).__name__}: {e}"
        finally:
            cleanup_run(run)
    return PrecheckResult(False, [f"unmeasurable: infra_error in all {ATTEMPTS} attempts; last: {last}"], [])


def _precheck_once(inst: dict, bundle, run: str, out: Path, max_gold_s: float | None) -> PrecheckResult:
    iid = inst["instance_id"]
    reasons = []
    _ensure_image(inst["image"])
    start = time.monotonic()
    gold = grade(inst, inst["patch"], out / "gold", run, timeout_s=int(max_gold_s or 1800))
    gold_s = time.monotonic() - start
    if gold.status == "infra_error":
        raise _Unmeasurable(f"gold grading infra_error (log: {out / 'gold' / 'grade.log'})")
    if gold.status != "resolved":
        reasons.append(f"gold patch: expected resolved, got {gold.status} (log: {out / 'gold' / 'grade.log'})")
    if max_gold_s is not None and gold_s > max_gold_s:
        reasons.append(f"gold grading wall clock {gold_s:.0f}s exceeds {max_gold_s:.0f}s")

    empty = grade(inst, "", out / "empty", run)
    if empty.status == "infra_error":
        raise _Unmeasurable(f"empty-patch grading infra_error (log: {out / 'empty' / 'grade.log'})")
    report = out / "empty" / "report.json"
    passing = json.loads(report.read_text())[iid]["tests_status"]["FAIL_TO_PASS"]["success"] if report.exists() else None
    if empty.status != "unresolved" or passing is None or passing:
        reasons.append(f"empty patch: expected unresolved with every FAIL_TO_PASS failing, got {empty.status}, "
                       f"FAIL_TO_PASS passing: {'no report' if passing is None else passing}")

    code, text = _node_version(inst["image"], bundle, run)
    if code != 0 or not text.startswith("v"):
        reasons.append(f"node --version with bundle failed ({code}): {text.strip()[-500:]}")
    blobs = [] if reasons else gold_probe_blobs({**inst, "run": run})  # 被排除的不需要探针；金标准打不上时它会抛错
    (out / "precheck.json").write_text(json.dumps({
        "image": inst["image"], "gold": gold.status, "gold_s": round(gold_s, 1), "gold_digest": gold.image_digest,
        "arch": gold.arch, "empty": empty.status, "empty_f2p_passing": passing, "node": text.strip(),
        "reasons": reasons, "probe_blobs": blobs}, indent=2, ensure_ascii=False))
    return PrecheckResult(not reasons, reasons, blobs)


def build_taskset(name: str, version: int, rows: list[dict], n: int, seed: int, bundle, out: Path) -> None:
    """抽 n×1.5（向上取整）个候选逐个预检，再用同一种子从通过的候选里分层抽 n 个，写出任务集。
    通过的不足 n 个（含全部无法测量）时报错，不写文件；不覆盖已有文件。名字以 smoke 开头的为冷烟集。"""
    by_id = {r["instance_id"]: r for r in rows}
    candidates = stratified_sample(rows, math.ceil(n * 1.5), seed)
    max_gold_s = SMOKE_GOLD_MAX_S if name.startswith("smoke") else None
    images, results = {}, {}
    for iid in candidates:
        images[iid] = image_refs(by_id[iid])
        results[iid] = precheck({**by_id[iid], "image": images[iid][local_platform()]}, bundle, max_gold_s)
    passed = [iid for iid in candidates if results[iid].ok]
    excluded = [{"id": iid, "reasons": results[iid].reasons} for iid in candidates if not results[iid].ok]
    if len(passed) < n:
        raise RuntimeError(f"only {len(passed)} of {len(candidates)} candidates passed precheck, need {n}: "
                           f"{json.dumps(excluded, ensure_ascii=False)}")
    chosen = stratified_sample([by_id[iid] for iid in passed], n, seed)
    doc = {
        "name": name,
        "version": version,
        "dataset": DATASET,
        "revision": REVISION,
        "seed": seed,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "selection": {"method": "stratified by repo", "n": n, "candidates": candidates,
                      "precheck_platform": local_platform(), "gold_max_s": max_gold_s},
        "precheck": {"passed": passed, "excluded": excluded},
        "instance_ids": chosen,
        "images": {iid: images[iid] for iid in chosen},
        "probe_blobs": {iid: results[iid].probe_blobs for iid in chosen},
    }
    with Path(out).open("x", encoding="utf-8") as f:  # 已提交的任务集不改，有变更发新版本
        f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def taskset_sha256(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
