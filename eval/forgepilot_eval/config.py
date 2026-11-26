"""评测配置（T2 计划 Task 12；D7、D8、D10）：从 YAML 读取，开跑前固定，config_hash 记进每条记录。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import yaml

from .taskset import local_platform

FIELDS = ["model", "thinking", "sampling", "tools", "danger_patterns", "max_tool_calls", "task_timeout_s",
          "grade_timeout_s", "prompt_file", "price", "assumed_tokens_per_run", "scoring"]
MODEL_FIELDS = ["provider", "id", "route", "base", "keyEnv", "compat", "pi"]  # compat、pi 写进 pi 的 models.json，缺了 thinking 可能悄悄失效
SAMPLING_FIELDS = ["temperature", "top_p"]  # D7：必须显式写出；只允许这两项（代理只注入这两项）
DEFAULT_BUNDLE = Path(__file__).resolve().parents[1] / ".cache" / f"bundle-{local_platform()}"


@dataclass
class EvalConfig:
    raw: dict  # 解析后的 YAML 原文，config_hash 用
    model: dict
    thinking: str
    sampling: dict
    tools: list[str]
    danger_patterns: list[str]
    max_tool_calls: int
    task_timeout_s: int
    grade_timeout_s: int
    prompt_file: Path
    price: dict
    assumed_tokens_per_run: dict
    scoring: dict
    bundle: Path = DEFAULT_BUNDLE  # 不在 YAML 里：按本机架构取 scripts/build-eval-bundle.sh 的产出


def load_config(path) -> EvalConfig:
    path = Path(path)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    missing = [k for k in FIELDS if k not in raw] + [f"model.{k}" for k in MODEL_FIELDS if k not in raw.get("model", {})]
    sampling = raw.get("sampling") or {}
    missing += [f"sampling.{k}" for k in SAMPLING_FIELDS if not isinstance(sampling.get(k), (int, float))]
    if missing:
        raise ValueError(f"{path}: missing or invalid config fields: {', '.join(missing)}")
    extra = set(sampling) - set(SAMPLING_FIELDS)
    if extra:
        raise ValueError(f"{path}: sampling only accepts {SAMPLING_FIELDS}, got {sorted(extra)}")
    fields = {k: raw[k] for k in FIELDS}
    fields["prompt_file"] = (path.parent / raw["prompt_file"]).resolve()
    return EvalConfig(raw=raw, **fields)


def config_hash(cfg: EvalConfig) -> str:
    """规范化 YAML、提示词文件内容与 sampling 一起做 sha256。"""
    h = hashlib.sha256()
    h.update(json.dumps(cfg.raw, sort_keys=True, ensure_ascii=False).encode())
    h.update(cfg.prompt_file.read_bytes())
    h.update(json.dumps(cfg.sampling, sort_keys=True).encode())
    return h.hexdigest()
