"""单任务运行（T2 计划 Task 12，MVP 精简版）：一个实例的一次重复 = 新容器 → 截断历史 → agent 经代理跑 → 取补丁 → 删容器。

不评分：failure_type 为 none 表示待评分，评分字段由 T2-13 调用 grade 后填上（作者 2026-11-26）。
模型代理由调用方按 proxy_routes(cfg) 先启动（每次评测一个）。
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import EvalConfig, config_hash
from .engine_client import run_task
from .policy import Policy, PolicyConfig
from .repo_prep import extract_patch, resolve_effective_base, truncate_history
from .sandbox import PROXY_ALIAS, PROXY_PORT, Sandbox

REPO_DIR = "/testbed"
RATE_LIMIT = re.compile(r"429|rate.?limit", re.I)
USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "reasoning")


@dataclass
class TaskRecord:
    instance_id: str
    config_hash: str
    taskset_sha256: str
    failure_type: str = "infra_error"  # none（待评分）/ empty_patch / run_failed / rate_limited / timeout / tool_budget / infra_error
    failure_reason: str | None = None
    usage: dict = field(default_factory=lambda: dict.fromkeys(USAGE_KEYS, 0))  # 累加；reasoning 是 output 的子集
    usage_complete: bool = True  # 有请求的用量为 null（未知）时为 False
    requests: int = 0  # model.request.finished 的条数
    tool_calls: int = 0
    wall_s: float = 0.0  # agent 运行（run_task）的墙钟
    snapshot: dict | None = None  # 取自 run.started
    grade_status: str | None = None
    grade_image: str | None = None
    grade_image_digest: str | None = None
    grade_arch: str | None = None


def add_request(rec: TaskRecord, ev: dict) -> None:
    """累加一条 model.request.finished 的用量。出错的请求（如 429）按契约用量为 null 且不计费，不算用量未知；
    其余请求（含中止的，上游可能已部分计费）没有用量就标 usage_complete=False（作者 2026-11-26）。"""
    rec.requests += 1
    if ev.get("usage") is None:
        if ev.get("stopReason") != "error":
            rec.usage_complete = False
    else:
        for k in USAGE_KEYS:
            rec.usage[k] += ev["usage"].get(k, 0)


def proxy_routes(cfg: EvalConfig) -> dict:
    """start_proxy 的 routes：采样参数经 params 由代理写进每个请求（pi 1.5.1 不发 top_p）。"""
    m = cfg.model
    return {m["route"]: {"base": m["base"], "keyEnv": m["keyEnv"], "model": m["id"], "params": dict(cfg.sampling)}}


def models_json(cfg: EvalConfig) -> dict:
    """容器里 runner 读的 pi models.json：经代理访问，apiKey 是字面占位串（key 只在代理里）。"""
    m = cfg.model
    return {"providers": {m["provider"]: {
        "baseUrl": f"http://{PROXY_ALIAS}:{PROXY_PORT}/{m['route']}", "api": "openai-completions", "apiKey": "unused",
        "compat": m["compat"], "models": [{"id": m["id"], **m["pi"]}],
    }}}


def run_instance(inst: dict, cfg: EvalConfig, run: str, out_dir: Path, attempt: int) -> TaskRecord:
    """inst 需含 instance_id、base_commit、problem_statement、image（按本机平台选好的 name@digest）、
    probe_blobs（任务集里的值）、taskset_sha256。写出 out_dir/<instance_id>/<attempt>/ 下的 events.jsonl、
    raw.jsonl（runner 写）、patch.diff、record.json。任何异常都先写 record.json（infra_error 加原因）再抛出。"""
    iid = inst["instance_id"]
    d = Path(out_dir) / iid / str(attempt)
    d.mkdir(parents=True)  # 不覆盖已有的运行
    rec = TaskRecord(iid, config_hash(cfg), inst["taskset_sha256"])
    policy = Policy(PolicyConfig(cfg.tools, cfg.danger_patterns, cfg.max_tool_calls))
    last_error: list[str | None] = [None]  # 最后一次请求的 errorMessage
    patch = ""

    def on_event(ev: dict) -> None:
        events.write(json.dumps(ev, ensure_ascii=False) + "\n")
        if ev["type"] == "run.started":
            rec.snapshot = ev.get("snapshot")
        elif ev["type"] == "model.request.finished":
            add_request(rec, ev)
            last_error[0] = ev.get("errorMessage")

    with open(d / "events.jsonl", "w", encoding="utf-8") as events:
        try:
            (d / "models.json").write_text(json.dumps(models_json(cfg)), encoding="utf-8")
            prompt = cfg.prompt_file.read_text(encoding="utf-8").replace("{problem_statement}", inst["problem_statement"])
            start = {"type": "start_task", "requestId": "py-start", "sessionId": f"{iid}-{attempt}", "prompt": prompt,
                     "model": {"provider": cfg.model["provider"], "id": cfg.model["id"]},
                     "contextFiles": [], "interceptMode": "callback"}
            with Sandbox(run, inst["image"], cfg.bundle, d) as sb:
                eff = resolve_effective_base(sb, REPO_DIR, inst["base_commit"])
                truncate_history(sb, REPO_DIR, eff, inst["probe_blobs"])
                cmd = sb.entry_cmd(["--models", "/fp-out/models.json", "--workdir", REPO_DIR,
                                    "--sessions-root", "/fp-out/sessions", "--record-pi-events", "/fp-out/raw.jsonl",
                                    "--tools", ",".join(cfg.tools), "--thinking", cfg.thinking])
                t0 = time.monotonic()
                res = run_task(cmd, start, policy.decide, on_event, cfg.task_timeout_s, kill=sb.kill,
                               should_cancel=lambda: policy.exhausted)
                rec.wall_s = round(time.monotonic() - t0, 3)
                rec.failure_type, rec.failure_reason = _classify(res, policy, last_error[0])
                if rec.failure_type != "infra_error":  # 失败运行的半成品补丁也留作诊断
                    try:
                        patch = extract_patch(sb, REPO_DIR, eff)
                    except Exception as e:
                        if rec.failure_type == "none":  # 待评分的运行没有补丁就是基础设施错误
                            raise
                        rec.failure_reason = f"{rec.failure_reason}; patch not extracted: {type(e).__name__}: {e}"
                    if rec.failure_type == "none" and not patch.strip():
                        rec.failure_type, rec.failure_reason = "empty_patch", "agent made no changes"
        except BaseException as e:
            rec.failure_type, rec.failure_reason = "infra_error", f"{type(e).__name__}: {e}"
            raise
        finally:
            rec.tool_calls = policy.calls
            (d / "patch.diff").write_bytes(patch.encode("utf-8", errors="surrogateescape"))
            (d / "record.json").write_text(json.dumps(asdict(rec), indent=2, ensure_ascii=False), encoding="utf-8")
    return rec


def _classify(res, policy: Policy, last_error: str | None) -> tuple[str, str | None]:
    if res.timed_out:
        return "timeout", "task wall clock limit reached"
    if policy.exhausted:
        return "tool_budget", f"tool call limit reached ({policy.cfg.max_tool_calls})"
    if res.failure:  # 桥或 runner 异常退出、协议错误
        return "infra_error", res.failure
    t = res.terminal
    if t["type"] == "run.failed":
        if last_error and RATE_LIMIT.search(last_error):
            return "rate_limited", t.get("reason")
        return "run_failed", t.get("reason")
    if t["type"] == "run.cancelled":
        return "run_failed", "run cancelled without a cancel request"
    return "none", None
