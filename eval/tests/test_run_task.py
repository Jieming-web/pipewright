"""T2-12：评测配置与单任务运行（计划 Task 12，MVP 精简版）。

docker 用例：「实例」是 buildpack-deps:jammy-scm 里建的小仓库；假模型（tests/helpers/fake-openai-cli.ts，
用 esbuild 打成单个 .mjs）跑在 node:24-slim 容器里，只接本次运行的出网网络，经真实模型代理按容器名访问。
"""

import dataclasses
import glob
import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from conftest import REPO
from forgepilot_eval import sandbox
from forgepilot_eval.config import config_hash, load_config
from forgepilot_eval.policy import Policy, PolicyConfig
from forgepilot_eval.repo_prep import BaseMismatch
from forgepilot_eval.run_task import proxy_routes, run_instance
from forgepilot_eval.sandbox import cleanup_run, start_proxy
from test_policy import HITS, MISSES

CONFIG = REPO / "eval" / "configs" / "qwen3.6.yaml"
SCM_IMAGE = "buildpack-deps:jammy-scm"
REPO_SETUP = r"""
set -e
git config --global user.email fp@test.invalid
git config --global user.name fp
git init -q /testbed && cd /testbed
printf 'print(1)\n' > main.py
git add -A; git commit -qm base; echo "BASE=$(git rev-parse HEAD)"
"""


def sh(*cmd, check=False, **kw):
    return subprocess.run(list(cmd), capture_output=True, text=True, check=check, **kw)


def tool(cmd):
    return [{"kind": "toolCall", "name": "bash", "args": {"command": cmd}, "id": "c1"},
            {"kind": "text", "chunks": ["done"]}]


# ---------- 配置（不需要 Docker） ----------

def write_config(tmp_path: Path, drop: str | None = None, prompt: str = "{problem_statement}\n") -> Path:
    text = CONFIG.read_text()
    if drop:
        text = "\n".join(l for l in text.splitlines() if not l.strip().startswith(f"{drop}:"))
    (tmp_path / "prompts").mkdir(exist_ok=True)
    (tmp_path / "prompts" / "swe-v1.txt").write_text(prompt)
    (tmp_path / "configs").mkdir(exist_ok=True)
    path = tmp_path / "configs" / "c.yaml"
    path.write_text(text)
    return path


def test_qwen_config_values():
    cfg = load_config(CONFIG)
    assert cfg.sampling == {"temperature": 1.0, "top_p": 0.95}
    assert cfg.thinking == "low"
    assert cfg.tools == ["read", "bash", "edit", "write", "grep", "find", "ls"]
    assert cfg.max_tool_calls == 100 and cfg.task_timeout_s == 1800
    assert cfg.price == {"input_per_m": 1.8, "output_per_m": 10.8}
    assert cfg.assumed_tokens_per_run["source"]
    assert cfg.prompt_file.read_text() == "{problem_statement}\n"
    assert proxy_routes(cfg) == {"qwen": {
        "base": "https://dashscope.aliyuncs.com/compatible-mode/v1", "keyEnv": "DASHSCOPE_API_KEY",
        "model": "qwen3.6-35b-a3b", "params": {"temperature": 1.0, "top_p": 0.95}}}


def test_config_danger_list_matches_d8():
    """配置里的清单与 T2-5 测过的 D8 清单行为一致：命中样例全拒，放行样例全放。"""
    cfg = load_config(CONFIG)
    p = Policy(PolicyConfig(cfg.tools, cfg.danger_patterns, 10_000))
    bash = lambda c: {"toolName": "bash", "input": {"command": c}}  # noqa: E731
    assert all(p.decide(bash(c))["decision"] == "block" for c in HITS)
    assert all(p.decide(bash(c))["decision"] == "allow" for c in MISSES)


@pytest.mark.parametrize("field", ["temperature", "top_p"])
def test_missing_sampling_field_rejected(tmp_path, field):
    with pytest.raises(ValueError, match=f"sampling.{field}"):
        load_config(write_config(tmp_path, drop=field))


def test_unknown_sampling_field_rejected(tmp_path):
    path = write_config(tmp_path)
    path.write_text(path.read_text().replace("  top_p: 0.95", "  top_p: 0.95\n  top_k: 20"))
    with pytest.raises(ValueError, match="sampling"):
        load_config(path)


def test_missing_top_level_field_rejected(tmp_path):
    with pytest.raises(ValueError, match="max_tool_calls"):
        load_config(write_config(tmp_path, drop="max_tool_calls"))


def test_config_hash_follows_prompt_content(tmp_path):
    a = config_hash(load_config(write_config(tmp_path)))
    assert a == config_hash(load_config(write_config(tmp_path)))
    b = config_hash(load_config(write_config(tmp_path, prompt="Fix this:\n{problem_statement}\n")))
    assert a != b


# ---------- 单任务运行（Docker、假模型） ----------

@pytest.fixture(scope="module")
def repo_image(docker):
    tag = uuid.uuid4().hex[:8]
    cname, image = f"fp-t12-repo-{tag}", f"fp-t12-repo:{tag}"
    r = sh("docker", "run", "--name", cname, "--network", "none", SCM_IMAGE, "bash", "-c", REPO_SETUP, timeout=600)
    assert r.returncode == 0, r.stdout + r.stderr
    base = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)["BASE"]
    sh("docker", "commit", cname, image, check=True)
    sh("docker", "rm", "-f", cname)
    yield image, base
    sh("docker", "rmi", "-f", image)


@pytest.fixture(scope="module")
def fake_js(tmp_path_factory):
    """假模型打成一个不依赖 node_modules 的 .mjs，可在 node:24-slim 容器里直接运行。"""
    esbuild = sorted(glob.glob(str(REPO / "node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild")))[-1]
    out = tmp_path_factory.mktemp("fake") / "fake.mjs"
    sh(esbuild, str(REPO / "tests/helpers/fake-openai-cli.ts"), "--bundle", "--platform=node", "--format=esm",
       f"--outfile={out}", check=True)
    return out


@pytest.fixture
def stack(docker, bundle, repo_image, fake_js, tmp_path):
    """返回 go(turns, **cfg 覆盖) -> (TaskRecord 或异常, 本次输出目录, 假模型收到的请求体)。"""
    run = f"t12-{uuid.uuid4().hex[:8]}"
    image, base = repo_image

    def go(turns, base_commit=None, **overrides):
        fake_dir = tmp_path / "fake"
        fake_dir.mkdir()
        shutil.copy(fake_js, fake_dir / "fake.mjs")
        (fake_dir / "turns.json").write_text(json.dumps(turns))
        fake = f"fp-fake-{run}"
        net = sandbox.ensure_egress_network(run)
        r = sh("docker", "run", "-d", "--name", fake, "--label", f"fp-run={run}", "--network", net,
               "-v", f"{fake_dir}:/fake", sandbox.PROXY_IMAGE, "node", "/fake/fake.mjs", "/fake/turns.json",
               "--host", "0.0.0.0", "--requests-out", "/fake/requests.json")
        assert r.returncode == 0, r.stderr
        for _ in range(100):
            line = sh("docker", "logs", fake).stdout
            if line.startswith("FAKE_LISTENING"):
                break
            time.sleep(0.2)
        else:
            pytest.fail(sh("docker", "logs", fake).stderr)
        port = line.split()[1].rsplit(":", 1)[1].split("/")[0]
        cfg = load_config(CONFIG)
        cfg = dataclasses.replace(cfg, model={**cfg.model, "base": f"http://{fake}:{port}/v1"}, **overrides)
        start_proxy(run, proxy_routes(cfg), {"DASHSCOPE_API_KEY": "sk-fake-t12"})
        inst = {"instance_id": "synth__repo-1", "base_commit": base_commit or base, "image": image,
                "problem_statement": "Please fix {the} bug.", "probe_blobs": [], "taskset_sha256": "ab" * 32}
        out = tmp_path / "out"
        try:
            result = run_instance(inst, cfg, run, out, attempt=1)
        except Exception as e:  # noqa: BLE001 — 异常路径的用例要检查它
            result = e
        sh("docker", "stop", "-t", "10", fake)
        reqs = json.loads((fake_dir / "requests.json").read_text())
        assert sh("docker", "ps", "-aq", "--filter", f"label=fp-run={run}", "--filter", "name=fp-task-").stdout == ""
        return result, out / "synth__repo-1" / "1", reqs

    yield go
    cleanup_run(run)


def events(d: Path) -> list[dict]:
    return [json.loads(l) for l in (d / "events.jsonl").read_text().splitlines()]


def test_settled_run_writes_patch_and_record(stack):
    rec, d, reqs = stack(tool("echo fix > new_file.py"))
    assert rec.failure_type == "none", rec.failure_reason
    assert "new_file.py" in (d / "patch.diff").read_text()
    assert rec.snapshot["engine"]["name"] == "pi"
    assert rec.requests == 2 and len(reqs) == 2
    assert rec.usage == {"input": 2, "output": 2, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0}
    assert rec.usage_complete is True
    assert rec.tool_calls == 1
    assert rec.wall_s > 0
    # 采样参数由代理按配置写进每个请求
    assert all(q["temperature"] == 1.0 and q["top_p"] == 0.95 for q in reqs)
    assert reqs[0]["messages"][-1]["content"] in ("Please fix {the} bug.\n", [{"type": "text", "text": "Please fix {the} bug.\n"}])
    record = json.loads((d / "record.json").read_text())
    assert record["config_hash"] == config_hash(load_config(CONFIG))
    assert record["taskset_sha256"] == "ab" * 32
    assert record["instance_id"] == "synth__repo-1"
    for k in ("grade_status", "grade_image", "grade_image_digest", "grade_arch"):
        assert record[k] is None  # 评分由 T2-13 填
    types = [e["type"] for e in events(d)]
    assert types[0] == "run.started" and types[-1] == "run.settled"
    assert (d / "raw.jsonl").stat().st_size > 0


def test_dangerous_command_blocked(stack):
    rec, d, _ = stack(tool("curl x"))
    finished = [e for e in events(d) if e["type"] == "tool.finished"]
    assert len(finished) == 1 and finished[0]["isError"] is True
    assert rec.failure_type == "empty_patch"
    assert (d / "patch.diff").read_text() == ""


def test_tool_budget(stack):
    turns = [{"kind": "toolCall", "name": "bash", "args": {"command": "true"}, "id": f"c{i}"} for i in range(3)]
    rec, _, _ = stack(turns + [{"kind": "text", "chunks": ["done"]}], max_tool_calls=1)
    assert rec.failure_type == "tool_budget", rec.failure_reason


def test_timeout(stack):
    t = time.monotonic()
    rec, _, _ = stack([{"kind": "text", "chunks": ["a", "b"], "chunkDelayMs": 60_000}], task_timeout_s=2)
    assert rec.failure_type == "timeout"
    assert time.monotonic() - t < 60


def test_rate_limited(stack):
    rec, d, reqs = stack([{"kind": "error", "status": 429, "body": {"error": {"message": "rate limit"}}}] * 6)
    assert rec.failure_type == "rate_limited", rec.failure_reason
    assert len(reqs) > 1  # pi 重试过
    assert events(d)[-1]["type"] == "run.failed"


def test_wrong_bundle_is_infra_error(stack, tmp_path):
    rec, d, _ = stack(tool("true"), bundle=tmp_path / "no-such-bundle")
    assert rec.failure_type == "infra_error"
    assert "fp-entry" in rec.failure_reason  # docker exec 的报错走 stdout，被记为协议错误
    assert json.loads((d / "record.json").read_text())["failure_type"] == "infra_error"


def test_exception_writes_record_then_raises(stack):
    err, d, _ = stack(tool("true"), base_commit="0" * 40)
    assert isinstance(err, BaseMismatch)
    record = json.loads((d / "record.json").read_text())
    assert record["failure_type"] == "infra_error"
    assert "BaseMismatch" in record["failure_reason"]
