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
from forgepilot_eval.engine_client import RunResult
from forgepilot_eval.policy import Policy, PolicyConfig
from forgepilot_eval.repo_prep import BaseMismatch
from forgepilot_eval import run_task as run_task_mod
from forgepilot_eval.run_task import TaskRecord, add_request, proxy_routes, run_instance
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
    assert cfg.max_tool_calls == 100 and cfg.task_timeout_s == 1800
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


@pytest.mark.parametrize("edit, error", [
    (("drop", "temperature"), "sampling.temperature"),
    (("drop", "top_p"), "sampling.top_p"),
    (("add", "  top_k: 20"), "sampling only accepts"),
    (("drop", "max_tool_calls"), "max_tool_calls"),
    (("drop", "compat"), "model.compat"),  # 缺失时 thinking 可能悄悄失效（D7 显式写出）
    (("drop", "pi"), "model.pi"),
])
def test_invalid_config_rejected(tmp_path, edit, error):
    kind, arg = edit
    path = write_config(tmp_path, drop=arg if kind == "drop" else None)
    if kind == "add":
        path.write_text(path.read_text().replace("  top_p: 0.95", f"  top_p: 0.95\n{arg}"))
    with pytest.raises(ValueError, match=error):
        load_config(path)


@pytest.mark.parametrize("stop_reason, usage, complete", [
    ("stop", {"input": 3, "output": 2, "cacheRead": 1, "cacheWrite": 0, "reasoning": 1}, True),
    ("error", None, True),  # 出错请求按契约用量为 null、不计费，不算用量未知（作者 2026-11-26）
    ("stop", None, False),  # 成功返回却没有用量
    ("toolUse", None, False),
    ("aborted", None, False),  # 中止的请求上游可能已部分计费，算用量未知（作者 2026-11-26）
])
def test_usage_complete_false_unless_error_request(stop_reason, usage, complete):
    rec = TaskRecord("i", "h", "s")
    add_request(rec, {"type": "model.request.finished", "stopReason": stop_reason, "usage": usage})
    assert rec.requests == 1 and rec.usage_complete is complete
    assert rec.usage == (usage or dict.fromkeys(rec.usage, 0))


def test_config_hash_follows_prompt_content(tmp_path):
    a = config_hash(load_config(write_config(tmp_path)))
    assert a == config_hash(load_config(write_config(tmp_path)))
    b = config_hash(load_config(write_config(tmp_path, prompt="Fix this:\n{problem_statement}\n")))
    assert a != b



# run.failed 时最后一次请求的 errorMessage → failure_type。样例取自 pi 1.5.1 经真实代理的实际输出
# （下方 docker 用例：假模型返回 5xx、代理 502、端口不通、代理名字解析不了）。
@pytest.mark.parametrize("message, expected", [
    ('500: {"message":"upstream boom"}', "infra_error"),
    ('503: {"message":"upstream boom"}', "infra_error"),
    ('502: {"message":"upstream unreachable"}', "infra_error"),  # 代理连不上上游
    ("502 <html>Bad Gateway</html>", "infra_error"),  # 非 JSON 响应体时 openai SDK 的格式
    ("503 status code (no body)", "infra_error"),
    ("Connection error.: connect ECONNREFUSED 172.19.0.2:8081", "infra_error"),
    ("Connection error.: getaddrinfo EAI_AGAIN fp-no-such-proxy", "infra_error"),
    ("Connection error.", "infra_error"),
    ('429: {"message":"rate limit"}', "rate_limited"),
    ("429 Too Many Requests", "rate_limited"),
    ('400: {"message":"Rate limit exceeded for this key"}', "rate_limited"),
    ('400: {"message":"invalid request: 264292 tokens"}', "run_failed"),  # M2：数字里的 429 不算
    ('400: {"message":"context length 5000 exceeds 4096"}', "run_failed"),  # 数字里的 500 不算
    ('404: {"message":"model not found"}', "run_failed"),
    ('413: {"message":"request entity too large"}', "run_failed"),
    ('400: {"message":"upstream said 403 forbidden"}', "run_failed"),  # 403 不在开头不算
    ("terminated: other side closed (UND_ERR_SOCKET)", "run_failed"),  # 不在作者给的三类里
    ("Provider finish_reason: network_error", "run_failed"),
    (None, "run_failed"),
])
def test_classify_run_failed_by_last_error(message, expected):
    res = RunResult({"type": "run.failed", "reason": message or "model error"}, None, False)
    policy = Policy(PolicyConfig(["bash"], [], 10))
    assert run_task_mod._classify(res, policy, message)[0] == expected


@pytest.mark.parametrize("message", [
    '403: {"message":"Free quota exhausted. Please upgrade.","type":"AllocationQuota.FreeTierOnly","code":"AllocationQuota.FreeTierOnly"}',  # 基线首次开跑时百炼的实际返回（作者 2026-11-28）
    '401: {"message":"Incorrect API key provided."}',
    "403 Forbidden",
])
def test_classify_provider_access_denied_aborts(message):
    """模型服务 401/403：账号或配置问题，抛 ProviderAccessError 中止整次评测，不归入任何 failure_type。"""
    res = RunResult({"type": "run.failed", "reason": message}, None, False)
    with pytest.raises(run_task_mod.ProviderAccessError, match="--resume"):
        run_task_mod._classify(res, Policy(PolicyConfig(["bash"], [], 10)), message)

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
    assert (d / "fp-out" / "raw.jsonl").stat().st_size > 0  # runner 写的文件在挂载子目录里
    assert (d / "fp-out" / "models.json").is_file()
    assert sorted(p.name for p in d.iterdir()) == ["events.jsonl", "fp-out", "patch.diff", "record.json"]


def test_symlink_in_mount_not_followed_by_host_writes(stack, tmp_path):
    """容器在 /fp-out 放指向挂载外的符号链接：宿主机写 patch.diff、record.json 不跟随它（I2）。"""
    victim = tmp_path / "victim.txt"
    victim.write_text("original")
    rec, d, _ = stack(tool(f"ln -s {victim} /fp-out/patch.diff; ln -s {victim} /fp-out/record.json"))
    assert rec.failure_type == "empty_patch", rec.failure_reason
    assert victim.read_text() == "original"
    assert not (d / "patch.diff").is_symlink() and not (d / "record.json").is_symlink()
    assert (d / "fp-out" / "patch.diff").is_symlink()  # 链接确实建成了，只是落在挂载里


def test_dangerous_command_blocked(stack):
    rec, d, _ = stack(tool("curl x"))
    finished = [e for e in events(d) if e["type"] == "tool.finished"]
    assert len(finished) == 1 and finished[0]["isError"] is True
    assert rec.failure_type == "empty_patch"
    assert (d / "patch.diff").read_text() == ""


def budget_turns():
    calls = [{"kind": "toolCall", "name": "bash", "args": {"command": f"echo {i} > f{i}.py"}, "id": f"c{i}"} for i in range(3)]
    return calls + [{"kind": "text", "chunks": ["done"]}]


def test_tool_budget_keeps_partial_patch(stack):
    rec, d, _ = stack(budget_turns(), max_tool_calls=1)
    assert rec.failure_type == "tool_budget", rec.failure_reason
    assert "f0.py" in (d / "patch.diff").read_text()  # 除 infra_error 外都取补丁，留作诊断


def test_patch_failure_keeps_failure_type(stack, monkeypatch):
    def boom(*a):
        raise RuntimeError("git diff failed")
    monkeypatch.setattr(run_task_mod, "extract_patch", boom)
    rec, d, _ = stack(budget_turns(), max_tool_calls=1)
    assert rec.failure_type == "tool_budget"
    assert "patch not extracted: RuntimeError: git diff failed" in rec.failure_reason
    assert (d / "patch.diff").read_text() == ""


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
    assert rec.usage_complete is True  # 出错请求的用量为 null，不算未知


def last_error(d: Path) -> str | None:
    return [e for e in events(d) if e["type"] == "model.request.finished"][-1].get("errorMessage")


@pytest.mark.parametrize("status", [500, 503])
def test_upstream_5xx_is_infra_error(stack, status):
    rec, d, reqs = stack([{"kind": "error", "status": status, "body": {"error": {"message": "upstream boom"}}}] * 6)
    assert events(d)[-1]["type"] == "run.failed"
    assert rec.failure_type == "infra_error", (rec.failure_type, last_error(d))
    assert len(reqs) > 1  # pi 重试过


def test_proxy_502_upstream_unreachable_is_infra_error(stack, monkeypatch):
    real = proxy_routes
    monkeypatch.setitem(globals(), "proxy_routes",
                        lambda cfg: {k: {**v, "base": "http://fp-no-such-upstream:9/v1"} for k, v in real(cfg).items()})
    rec, d, reqs = stack(tool("true"))
    assert reqs == []
    assert rec.failure_type == "infra_error", (rec.failure_type, last_error(d))


@pytest.mark.parametrize("attr,value", [("PROXY_PORT", 8081), ("PROXY_ALIAS", "fp-no-such-proxy")])
def test_proxy_not_connectable_is_infra_error(stack, monkeypatch, attr, value):
    """连不上代理：端口不通（连接被拒）、代理容器不在（名字解析不了）。"""
    monkeypatch.setattr(run_task_mod, attr, value)
    rec, d, reqs = stack(tool("true"))
    assert reqs == []
    assert rec.failure_type == "infra_error", (rec.failure_type, last_error(d))


def test_provider_403_raises_and_keeps_record(stack):
    body = {"error": {"message": "Free quota exhausted. Please upgrade.", "type": "AllocationQuota.FreeTierOnly"}}
    err, d, reqs = stack([{"kind": "error", "status": 403, "body": body}] * 3)
    assert isinstance(err, run_task_mod.ProviderAccessError), (err, last_error(d))
    assert last_error(d).startswith("403: ") and "FreeTierOnly" in last_error(d)
    record = json.loads((d / "record.json").read_text())
    assert record["failure_type"] == "infra_error" and "ProviderAccessError" in record["failure_reason"]


def test_client_error_stays_run_failed(stack):
    """模型服务以 4xx 拒绝请求（不是服务出错）：仍是 run_failed；错误信息里的 264292 不算 429。"""
    rec, d, _ = stack([{"kind": "error", "status": 400,
                        "body": {"error": {"message": "invalid request: 264292 tokens"}}}] * 6)
    assert events(d)[-1]["type"] == "run.failed"
    assert rec.failure_type == "run_failed", (rec.failure_type, last_error(d))


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
