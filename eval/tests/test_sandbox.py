"""T2-8：容器沙箱与网络（计划 Task 8，D1，作者补 2）。

任务容器只接 internal 网络：上不了网、访问不到宿主机，只能经旁路代理访问模型；key 只在代理容器里。
假模型服务跑在只接默认网络的辅助容器里（internal 网络访问不到宿主机），代理按它在默认网络上的 IP 转发。
"""

import json
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from conftest import REPO, REQUESTS_IMAGE
from forgepilot_eval import sandbox
from forgepilot_eval.sandbox import Sandbox, cleanup_run, ensure_network, start_proxy

pytestmark = pytest.mark.docker

FAKE_KEY = "sk-fake-sandbox-test-91c2"


def sh(*cmd, check=False):
    return subprocess.run(list(cmd), capture_output=True, text=True, check=check)


def labelled(kind: str, run: str) -> list[str]:
    return sh("docker", kind, "ls", "-q", *(["-a"] if kind == "container" else []),
              "--filter", f"label=fp-run={run}").stdout.split()


@pytest.fixture
def run_name(docker):
    name = f"t8-{uuid.uuid4().hex[:8]}"
    yield name
    cleanup_run(name)


@pytest.fixture
def fake_upstream(docker, tmp_path, run_name):
    """辅助容器：假模型服务，只接默认 bridge 网络；返回它在默认网络上的 base URL。"""
    turns = tmp_path / "turns.json"
    turns.write_text(json.dumps([{"kind": "text", "chunks": ["hello-from-fake"]}]))
    name = f"fp-fake-{run_name}"
    r = sh("docker", "run", "-d", "--rm", "--name", name, "--label", f"fp-run={run_name}",
           "-v", f"{REPO}:/repo:ro", "-v", f"{turns}:/turns.json:ro", "-w", "/repo", "node:24-slim",
           "node", "--import", "tsx", "tests/helpers/fake-openai-cli.ts", "/turns.json", "--host", "0.0.0.0")
    assert r.returncode == 0, r.stderr
    port = None
    for _ in range(100):
        out = sh("docker", "logs", name).stdout
        if "FAKE_LISTENING" in out:
            port = out.split("FAKE_LISTENING ")[1].split()[0].rsplit(":", 1)[1]
            break
        time.sleep(0.2)
    assert port, sh("docker", "logs", name).stderr
    ip = sh("docker", "inspect", "-f", "{{.NetworkSettings.Networks.bridge.IPAddress}}", name).stdout.strip()
    return f"http://{ip}:{port}"


@pytest.fixture
def stack(run_name, fake_upstream, bundle, tmp_path):
    ensure_network(run_name)
    proxy = start_proxy(
        run_name,
        {"fake": {"base": fake_upstream, "keyEnv": "DASHSCOPE_API_KEY", "model": "fake-model"}},
        {"DASHSCOPE_API_KEY": FAKE_KEY},
    )
    out = tmp_path / "out"
    out.mkdir()
    with Sandbox(run_name, REQUESTS_IMAGE, bundle, out) as sb:
        yield sb, proxy


def test_ensure_network_internal_labelled_and_reused(run_name):
    a = ensure_network(run_name)
    b = ensure_network(run_name)
    assert a == b == f"fp-eval-{run_name}"
    info = json.loads(sh("docker", "network", "inspect", a).stdout)[0]
    assert info["Internal"] is True
    assert info["Labels"]["fp-run"] == run_name


def test_no_internet_no_host(stack):
    sb, _ = stack
    code, _ = sb.exec("curl -sS --max-time 5 https://github.com", timeout_s=30)
    assert code != 0
    code, _ = sb.exec("curl -sS --max-time 5 http://host.docker.internal", timeout_s=30)
    assert code != 0
    code, _ = sb.exec("curl -sS --max-time 5 http://1.1.1.1", timeout_s=30)
    assert code != 0


def test_model_via_proxy(stack):
    sb, proxy = stack
    body = json.dumps({"model": "x", "stream": False, "messages": [{"role": "user", "content": "hi"}]})
    code, out = sb.exec(
        ["curl", "-sS", "--max-time", "10", "-H", "content-type: application/json", "-d", body,
         "http://fp-model-proxy:8080/fake/chat/completions"],
        timeout_s=30,
    )
    assert code == 0, out
    assert "hello-from-fake" in out
    logs = proxy.logs()
    assert logs and logs[-1]["route"] == "fake" and logs[-1]["status"] == 200


def test_key_only_in_proxy(stack):
    sb, proxy = stack
    code, out = sb.exec("env", timeout_s=30)
    assert code == 0
    assert "DASHSCOPE_API_KEY" not in out and FAKE_KEY not in out
    env = sh("docker", "inspect", "-f", "{{json .Config.Env}}", proxy.name).stdout
    assert FAKE_KEY in env  # 只在代理容器的环境里


def test_key_not_in_docker_argv(run_name, fake_upstream, monkeypatch):
    """key 只经子进程环境传给 docker CLI（-e 变量名），不出现在任何 docker 命令行参数里（ps 可见）。"""
    seen: list[list[str]] = []
    real = sandbox.subprocess.run

    def spy(argv, *a, **kw):
        seen.append(list(argv))
        return real(argv, *a, **kw)

    monkeypatch.setattr(sandbox.subprocess, "run", spy)
    start_proxy(run_name, {"fake": {"base": fake_upstream, "keyEnv": "DASHSCOPE_API_KEY", "model": "m"}},
                {"DASHSCOPE_API_KEY": FAKE_KEY})
    assert any("create" in a for a in seen)
    assert all(FAKE_KEY not in arg for a in seen for arg in a)


def test_bundle_and_out_mounts(stack):
    sb, _ = stack
    code, out = sb.exec("touch /fp/x", timeout_s=30)
    assert code != 0
    code, out = sb.exec("echo ok > /fp-out/probe && cat /fp-out/probe", timeout_s=30)
    assert code == 0 and out.strip() == "ok"
    assert sb.entry_cmd(["--models", "m.json"]) == ["docker", "exec", "-i", sb.id, "/fp/bin/fp-entry", "--models", "m.json"]
    assert sb.image_digest().startswith("sha256:") or "@sha256:" in sb.image_digest()


def test_exec_timeout(stack):
    sb, _ = stack
    t = time.monotonic()
    code, _ = sb.exec("sleep 30", timeout_s=2)
    assert code != 0
    assert time.monotonic() - t < 10


def test_container_removed_on_exception(run_name, bundle, tmp_path):
    ensure_network(run_name)
    with pytest.raises(RuntimeError):
        with Sandbox(run_name, REQUESTS_IMAGE, bundle, tmp_path) as sb:
            cid = sb.id
            raise RuntimeError("boom")
    assert sh("docker", "inspect", cid).returncode != 0


def test_kill_removes_container(run_name, bundle, tmp_path):
    ensure_network(run_name)
    with Sandbox(run_name, REQUESTS_IMAGE, bundle, tmp_path) as sb:
        sb.kill()
        assert sh("docker", "inspect", sb.id).returncode != 0
    # __exit__ 再删一次也不报错


def test_cleanup_run_removes_everything(run_name, fake_upstream, bundle, tmp_path):
    ensure_network(run_name)
    start_proxy(run_name, {"fake": {"base": fake_upstream, "keyEnv": "K", "model": "m"}}, {"K": "v"})
    sb = Sandbox(run_name, REQUESTS_IMAGE, bundle, tmp_path).__enter__()  # 模拟崩溃：不走 __exit__
    assert labelled("container", run_name) and labelled("network", run_name)
    cleanup_run(run_name)
    assert labelled("container", run_name) == []
    assert labelled("network", run_name) == []
    assert sh("docker", "inspect", sb.id).returncode != 0


def test_proxy_image_pinned():
    assert "@sha256:" in sandbox.PROXY_IMAGE
