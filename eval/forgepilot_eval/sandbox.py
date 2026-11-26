"""评测容器沙箱与网络（T2 计划 Task 8，D1）。

- 每次评测一个 internal 网络 fp-eval-<run>：任务容器只接它，上不了网，也访问不到宿主机。
- 模型代理容器 fp-proxy-<run> 同时接 internal 网络（别名 fp-model-proxy）与本次运行专用的出网网络
  fp-egress-<run>（普通 bridge），不接默认网络：评分容器在默认网络上跑 agent 的补丁与测试，不得能连到代理。
  API key 只经 `-e 变量名` 从子进程环境传给它，不进命令行参数。
- docker 卡住时一律按时限抛 DockerError（调用方按基础设施错误归类）。
- 本次评测创建的容器与网络都带标签 fp-run=<run>，崩溃后用 cleanup_run 按标签清理。
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# node:24-slim，2026-11-25 本机拉取时的 digest（Task 0 未记录 digest，Task 8 固定）
PROXY_IMAGE = "node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530"
PROXY_SCRIPT = Path(__file__).resolve().parents[1] / "runtime" / "model-proxy.mjs"
PROXY_ALIAS = "fp-model-proxy"
PROXY_PORT = 8080
LABEL = "fp-run"
RUN_TIMEOUT_S = 1800  # docker run 首次使用镜像时含拉取
RM_TIMEOUT_S = 30
PROXY_READY_S = 30


class DockerError(RuntimeError):
    pass


def _docker(*args: str, env: dict | None = None, timeout: float = 60, check: bool = True) -> subprocess.CompletedProcess:
    try:
        r = subprocess.run(["docker", *args], capture_output=True, text=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise DockerError(f"docker {args[0]} timed out after {timeout:g}s") from None
    if check and r.returncode != 0:
        raise DockerError(f"docker {args[0]} failed ({r.returncode}): {r.stderr.strip()}")
    return r


def network_name(run: str) -> str:
    return f"fp-eval-{run}"


def _ensure_net(name: str, run: str, *flags: str) -> str:
    if _docker("network", "inspect", name, check=False).returncode != 0:
        _docker("network", "create", *flags, "--label", f"{LABEL}={run}", name)
    return name


def ensure_network(run: str) -> str:
    """创建 internal 网络（已存在就复用），返回网络名。"""
    return _ensure_net(network_name(run), run, "--internal")


def ensure_egress_network(run: str) -> str:
    """创建本次运行专用的出网网络 fp-egress-<run>（普通 bridge，已存在就复用），返回网络名。"""
    return _ensure_net(f"fp-egress-{run}", run)


def _force_remove(name: str) -> None:
    """docker rm -f；docker 卡住时按短时限放弃（按标签的 cleanup_run 兜底），不盖掉调用方正在处理的异常。"""
    try:
        _docker("rm", "-f", name, check=False, timeout=RM_TIMEOUT_S)
    except DockerError:
        pass


@dataclass
class ProxyHandle:
    name: str

    def logs(self) -> list[dict]:
        """代理 stdout 的请求日志行（每行一个 JSON 对象）。"""
        out = _docker("logs", self.name).stdout
        return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def start_proxy(run: str, routes: dict, env: dict) -> ProxyHandle:
    """启动模型代理容器。routes 见 model-proxy.mjs 的 FP_PROXY_ROUTES；env 为 key 变量名 → 值，只传给代理。"""
    name = f"fp-proxy-{run}"
    net = ensure_network(run)
    egress = ensure_egress_network(run)
    child_env = {**os.environ, **env, "FP_PROXY_ROUTES": json.dumps(routes)}
    passthrough = [a for k in ["FP_PROXY_ROUTES", *env] for a in ("-e", k)]
    _docker(
        "create", "--name", name, "--label", f"{LABEL}={run}",
        "--network", net, "--network-alias", PROXY_ALIAS,
        *passthrough, PROXY_IMAGE, "node", "/model-proxy.mjs",
        env=child_env, timeout=600,  # 首次使用代理镜像时含拉取
    )
    try:
        _docker("cp", str(PROXY_SCRIPT), f"{name}:/model-proxy.mjs")
        _docker("network", "connect", egress, name)
        _docker("start", name)
        deadline = time.monotonic() + PROXY_READY_S
        left = lambda: max(deadline - time.monotonic(), 0.1)  # 每次 docker 调用也受就绪上限约束
        while time.monotonic() < deadline:
            r = _docker("logs", name, check=False, timeout=left())
            if "model-proxy listening on" in r.stderr:
                return ProxyHandle(name)
            if _docker("inspect", "-f", "{{.State.Running}}", name, check=False, timeout=left()).stdout.strip() == "false":
                raise DockerError(f"model proxy exited: {r.stderr.strip()}")
            time.sleep(0.2)
        raise DockerError("model proxy did not become ready")
    except BaseException:
        _force_remove(name)
        raise


class Sandbox:
    """一个任务、一次重复一个容器；离开上下文（含异常）一律删除。"""

    def __init__(self, run: str, image: str, bundle: Path, out_dir: Path):
        self.run = run
        self.image = image
        self.bundle = Path(bundle).resolve()
        self.out_dir = Path(out_dir).resolve()
        self.name = f"fp-task-{run}-{uuid.uuid4().hex[:8]}"
        self.id = ""

    def __enter__(self) -> "Sandbox":
        try:
            r = _docker(
                "run", "-d", "--name", self.name, "--label", f"{LABEL}={self.run}",
                "--network", network_name(self.run),
                "-v", f"{self.bundle}:/fp:ro", "-v", f"{self.out_dir}:/fp-out",
                self.image, "sleep", "infinity",
                timeout=RUN_TIMEOUT_S,
            )
        except BaseException:
            self.kill()  # 启动失败或超时：容器可能已建好，按名字删
            raise
        self.id = r.stdout.strip()
        return self

    def exec(self, cmd: str | list[str], timeout_s: float) -> tuple[int, str]:
        """在容器内执行；字符串按 bash -c 执行。返回 (退出码, stdout+stderr)；超时返回 124。
        超时只结束 docker exec 客户端，容器内的进程可能仍在运行，由删除容器兜底。"""
        argv = ["bash", "-c", cmd] if isinstance(cmd, str) else list(cmd)
        try:
            r = subprocess.run(["docker", "exec", self.id, *argv], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, errors="replace", timeout=timeout_s)
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            return 124, out
        return r.returncode, r.stdout

    def entry_cmd(self, runner_args: list[str]) -> list[str]:
        return ["docker", "exec", "-i", self.id, "/fp/bin/fp-entry", *runner_args]

    def image_digest(self) -> str:
        r = _docker("image", "inspect", self.image, "--format", "{{json .RepoDigests}} {{.Id}}")
        digests, image_id = r.stdout.strip().rsplit(" ", 1)
        repo_digests = json.loads(digests) or []
        return repo_digests[0] if repo_digests else image_id

    def kill(self) -> None:
        _force_remove(self.name)

    def __exit__(self, *exc) -> None:
        self.kill()


def cleanup_run(run: str) -> None:
    """按标签删除本次评测的所有容器与网络。"""
    ids = _docker("ps", "-aq", "--filter", f"label={LABEL}={run}").stdout.split()
    if ids:
        _docker("rm", "-f", *ids, check=False)
    nets = _docker("network", "ls", "-q", "--filter", f"label={LABEL}={run}").stdout.split()
    for n in nets:
        _docker("network", "rm", n, check=False)
