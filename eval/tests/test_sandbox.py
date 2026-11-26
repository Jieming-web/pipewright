"""T2-8：容器沙箱与网络（计划 Task 8，D1，作者补 2）。

任务容器只接 internal 网络：上不了网、访问不到宿主机，只能经旁路代理访问模型；key 只在代理容器里。
代理另接本次运行专用的出网网络 fp-egress-<run>，不接默认网络；假模型服务跑在只接出网网络的辅助容器里。
"""

import json
import os
import subprocess
import tarfile
import time
import uuid

import pytest

from conftest import REQUESTS_IMAGE
from forgepilot_eval import sandbox
from forgepilot_eval.sandbox import DockerError, Sandbox, cleanup_run, ensure_network, start_proxy

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


# 最小假模型服务：不挂宿主机 node_modules（Mac 上 esbuild 平台不匹配），Mac arm64 与 x86 都能跑
FAKE_SERVER = (
    "require('http').createServer((q, r) => { q.resume(); q.on('end', () => {"
    " r.writeHead(200, {'content-type': 'application/json'});"
    " r.end(JSON.stringify({choices: [{index: 0, message: {role: 'assistant', content: 'hello-from-fake'}}]}));"
    " }); }).listen(8000, () => console.log('FAKE_LISTENING'));"
)


@pytest.fixture
def fake_upstream(docker, run_name):
    """辅助容器：假模型服务，只接本次运行的出网网络（代理也接在上面）；返回按容器名访问的 base URL。"""
    net = sandbox.ensure_egress_network(run_name)
    name = f"fp-fake-{run_name}"
    r = sh("docker", "run", "-d", "--rm", "--name", name, "--label", f"fp-run={run_name}", "--network", net,
           sandbox.PROXY_IMAGE, "node", "-e", FAKE_SERVER)
    assert r.returncode == 0, r.stderr
    for _ in range(100):
        if "FAKE_LISTENING" in sh("docker", "logs", name).stdout:
            break
        time.sleep(0.2)
    else:
        pytest.fail(sh("docker", "logs", name).stderr)
    return f"http://{name}:8000/v1"


@pytest.fixture
def fake_docker(tmp_path, monkeypatch):
    """PATH 最前面放一个假 docker：记录每次调用的参数；hang(子命令…) 让这些子命令卡住，
    环境变量 FAKE_DOCKER_FAIL 里列出的子命令以 1 退出；run/ps/network 在 stdout 打印 fake-id。
    用 exec sleep，超时时被杀的就是卡住的进程本身，不留下占着管道的孙进程。超时常量调成 1 秒。"""
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    (bin_dir / "docker").write_text(
        '#!/bin/bash\necho "$*" >> "$FAKE_DOCKER_LOG"\n'
        'case " $FAKE_DOCKER_HANG " in *" $1 "*) exec sleep 30;; esac\n'
        'case " $FAKE_DOCKER_FAIL " in *" $1 "*) exit 1;; esac\n'
        'case "$1" in run|ps|network) echo fake-id;; esac\nexit 0\n')
    (bin_dir / "docker").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_DOCKER_LOG", str(log))
    for k in ("RUN_TIMEOUT_S", "RM_TIMEOUT_S", "PROXY_READY_S", "CLEANUP_RM_TIMEOUT_S"):
        monkeypatch.setattr(sandbox, k, 1, raising=False)

    def hang(*subcmds: str) -> None:
        monkeypatch.setenv("FAKE_DOCKER_HANG", " ".join(subcmds))

    return hang, lambda: log.read_text().splitlines() if log.exists() else []


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


def test_proxy_not_reachable_from_default_network(run_name, stack):
    """默认网络上的容器（模拟 Task 10 的评分容器）按 IP 连不到代理；代理只接 internal 与本次运行的出网网络。"""
    _, proxy = stack
    nets = json.loads(sh("docker", "inspect", "-f", "{{json .NetworkSettings.Networks}}", proxy.name).stdout)
    ips = [n["IPAddress"] for n in nets.values()]
    assert ips and all(ips), nets
    for ip in ips:
        r = sh("docker", "run", "--rm", "--label", f"fp-run={run_name}", "--network", "bridge", REQUESTS_IMAGE,
               "curl", "-sS", "--max-time", "5", f"http://{ip}:8080/fake/chat/completions")
        assert r.returncode in (7, 28), (ip, r.returncode, r.stdout, r.stderr)  # 7 连不上、28 超时
    assert set(nets) == {f"fp-eval-{run_name}", f"fp-egress-{run_name}"}


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


def test_enter_start_failure_removes_container(run_name, tmp_path):
    """docker run 建好容器后启动失败（镜像里没有 sleep）：__enter__ 抛 DockerError，且不留下容器。"""
    empty = tmp_path / "empty.tar"
    tarfile.open(empty, "w").close()
    image = f"fp-t8-empty:{run_name}"
    sh("docker", "import", str(empty), image, check=True)
    try:
        ensure_network(run_name)
        with pytest.raises(DockerError):
            Sandbox(run_name, image, tmp_path, tmp_path).__enter__()
        assert labelled("container", run_name) == []
    finally:
        sh("docker", "rmi", "-f", image)


def test_enter_timeout_raises_docker_error_and_removes(fake_docker, tmp_path):
    """docker run 卡住：按时限抛 DockerError（不是 TimeoutExpired），并按容器名删除。"""
    hang, calls = fake_docker
    hang("run")
    t = time.monotonic()
    with pytest.raises(DockerError):
        Sandbox("t8-fake", "img", tmp_path, tmp_path).__enter__()
    assert time.monotonic() - t < 10
    name = next(c for c in calls() if c.startswith("run ")).split("--name ")[1].split()[0]
    assert f"rm -f {name}" in calls()


def test_exit_bounded_and_keeps_original_exception(fake_docker, tmp_path):
    """离开 with 时 docker rm 卡住：按短时限放弃，原异常照常抛出，不被盖掉。"""
    hang, _ = fake_docker
    hang("rm")
    t = time.monotonic()
    with pytest.raises(ValueError):
        with Sandbox("t8-fake", "img", tmp_path, tmp_path):
            raise ValueError("original")
    assert time.monotonic() - t < 10


def test_proxy_ready_wait_bounded(fake_docker):
    """代理就绪等待期间 docker logs 卡住：按就绪上限抛 DockerError，并删除代理容器。"""
    hang, calls = fake_docker
    hang("logs")
    t = time.monotonic()
    with pytest.raises(DockerError):
        start_proxy("t8-fake", {"fake": {"base": "http://x/v1", "keyEnv": "K", "model": "m"}}, {"K": "v"})
    assert time.monotonic() - t < 10
    assert "rm -f fp-proxy-t8-fake" in calls()


@pytest.mark.parametrize("mode", ["hang", "fail"])
def test_cleanup_run_container_rm_failure_still_removes_networks(fake_docker, monkeypatch, mode):
    """批量删容器超时或失败：仍继续删网络，最后再抛 DockerError（计划 Task 8，作者 2026-11-26）。"""
    hang, calls = fake_docker
    if mode == "hang":
        hang("rm")
    else:
        monkeypatch.setenv("FAKE_DOCKER_FAIL", "rm")
    t = time.monotonic()
    with pytest.raises(DockerError):
        cleanup_run("t8-fake")
    assert time.monotonic() - t < 10
    assert "rm -f fake-id" in calls()
    assert "network rm fake-id" in calls()


def test_cleanup_run_removes_everything(run_name, fake_upstream, bundle, tmp_path):
    ensure_network(run_name)
    start_proxy(run_name, {"fake": {"base": fake_upstream, "keyEnv": "K", "model": "m"}}, {"K": "v"})
    sb = Sandbox(run_name, REQUESTS_IMAGE, bundle, tmp_path).__enter__()  # 模拟崩溃：不走 __exit__
    assert labelled("container", run_name)
    assert sh("docker", "network", "inspect", f"fp-egress-{run_name}").returncode == 0
    cleanup_run(run_name)
    assert labelled("container", run_name) == []
    assert labelled("network", run_name) == []
    assert sh("docker", "inspect", sb.id).returncode != 0
