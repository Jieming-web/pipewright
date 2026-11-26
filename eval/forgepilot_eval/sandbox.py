"""评测容器沙箱与网络（T2 计划 Task 8，D1）。

- 每次评测一个 internal 网络 fp-eval-<run>：任务容器只接它，上不了网，也访问不到宿主机。
- 模型代理容器 fp-proxy-<run> 同时接 internal 网络（别名 fp-model-proxy）与默认 bridge 网络；API key 只经
  `-e 变量名` 从子进程环境传给它，不进命令行参数。
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


class DockerError(RuntimeError):
    pass


def _docker(*args: str, env: dict | None = None, timeout: float = 600, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["docker", *args], capture_output=True, text=True, env=env, timeout=timeout)
    if check and r.returncode != 0:
        raise DockerError(f"docker {args[0]} failed ({r.returncode}): {r.stderr.strip()}")
    return r


def network_name(run: str) -> str:
    return f"fp-eval-{run}"


def ensure_network(run: str) -> str:
    """创建 internal 网络（已存在就复用），返回网络名。"""
    name = network_name(run)
    if _docker("network", "inspect", name, check=False).returncode != 0:
        _docker("network", "create", "--internal", "--label", f"{LABEL}={run}", name)
    return name


@dataclass
class ProxyHandle:
    name: str

    def logs(self) -> list[dict]:
        """代理 stdout 的请求日志行（每行一个 JSON 对象）。"""
        out = _docker("logs", self.name).stdout
        return [json.loads(line) for line in out.splitlines() if line.startswith("{")]

    def stop(self) -> None:
        _docker("rm", "-f", self.name, check=False)


def start_proxy(run: str, routes: dict, env: dict, ready_timeout_s: float = 30) -> ProxyHandle:
    """启动模型代理容器。routes 见 model-proxy.mjs 的 FP_PROXY_ROUTES；env 为 key 变量名 → 值，只传给代理。"""
    name = f"fp-proxy-{run}"
    net = ensure_network(run)
    child_env = {**os.environ, **env, "FP_PROXY_ROUTES": json.dumps(routes)}
    passthrough = [a for k in ["FP_PROXY_ROUTES", *env] for a in ("-e", k)]
    _docker(
        "create", "--name", name, "--label", f"{LABEL}={run}",
        "--network", net, "--network-alias", PROXY_ALIAS,
        *passthrough, PROXY_IMAGE, "node", "/model-proxy.mjs",
        env=child_env,
    )
    try:
        _docker("cp", str(PROXY_SCRIPT), f"{name}:/model-proxy.mjs")
        _docker("network", "connect", "bridge", name)
        _docker("start", name)
        deadline = time.monotonic() + ready_timeout_s
        while time.monotonic() < deadline:
            r = _docker("logs", name, check=False)
            if "model-proxy listening on" in r.stderr:
                return ProxyHandle(name)
            if _docker("inspect", "-f", "{{.State.Running}}", name, check=False).stdout.strip() == "false":
                raise DockerError(f"model proxy exited: {r.stderr.strip()}")
            time.sleep(0.2)
        raise DockerError("model proxy did not become ready")
    except BaseException:
        _docker("rm", "-f", name, check=False)
        raise


class Sandbox:
    """一个任务、一次重复一个容器；离开上下文（含异常）一律删除。"""

    def __init__(self, run: str, image: str, bundle: Path, out_dir: Path):
        self.run = run
        self.image = image
        self.bundle = Path(bundle).resolve()
        self.out_dir = Path(out_dir).resolve()
        self.id = ""

    def __enter__(self) -> "Sandbox":
        name = f"fp-task-{self.run}-{uuid.uuid4().hex[:8]}"
        r = _docker(
            "run", "-d", "--name", name, "--label", f"{LABEL}={self.run}",
            "--network", network_name(self.run),
            "-v", f"{self.bundle}:/fp:ro", "-v", f"{self.out_dir}:/fp-out",
            self.image, "sleep", "infinity",
            timeout=1800,  # 首次使用镜像时含拉取
        )
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
        if self.id:
            _docker("rm", "-f", self.id, check=False)

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
