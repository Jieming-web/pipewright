"""T2-6：评测运行包与启动脚本（计划 Task 6）。

运行包只读挂载到 SWE-bench 实例镜像的 /fp；fp-entry 激活 testbed 后启动 stdio 桥与 runner。
需要 Docker；首次运行会构建运行包（下载缓存在 eval/.cache/downloads/）并拉取实例镜像。
"""

import os
import subprocess
import uuid
from pathlib import Path

import pytest

from conftest import ARCH, REPO, REQUESTS_IMAGE as IMAGE

BUILD = REPO / "scripts" / "build-eval-bundle.sh"

pytestmark = pytest.mark.docker


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


@pytest.fixture(scope="module")
def container(bundle: Path):
    name = f"fp-t6-{uuid.uuid4().hex[:8]}"
    r = run(
        ["docker", "run", "-d", "--rm", "--name", name, "-v", f"{bundle}:/fp:ro", IMAGE, "sleep", "600"],
        timeout=1800,
    )
    assert r.returncode == 0, r.stderr
    try:
        yield name
    finally:
        run(["docker", "rm", "-f", name])


def exec_bash(container: str, script: str):
    return run(["docker", "exec", container, "bash", "-c", script], timeout=120)


def test_bundle_layout(bundle: Path):
    for rel in [
        "node/bin/node",
        "bin/rg",
        "bin/fd",
        "bin/fp-entry",
        "bin/fp-env",
        "app/runner/dist/main.js",
        "app/client/dist/stdio-bridge.js",
        "VERSION",
    ]:
        assert (bundle / rel).exists(), rel
    assert os.access(bundle / "bin" / "fp-entry", os.X_OK)
    parts = (bundle / "VERSION").read_text().split()
    assert len(parts) == 3
    assert len(parts[0].removesuffix("-dirty")) == 40
    assert parts[1] == "pi@1.5.1"
    assert parts[2].startswith("node@24.")


def test_fp_entry_starts_runner(container: str):
    r = exec_bash(container, "/fp/bin/fp-entry")
    assert r.returncode != 0
    assert "--models is required" in r.stderr, r.stderr


def test_fp_env_tools_and_testbed(container: str):
    r = exec_bash(
        container,
        ". /fp/bin/fp-env && bash -c 'which python; rg --version; fd --version; node --version'",
    )
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert "envs/testbed" in lines[0], lines
    assert lines[1].startswith("ripgrep 16."), lines
    assert any(l.startswith("fd 10.") for l in lines), lines
    assert lines[-1].startswith("v24."), lines


def test_sha256_mismatch_fails(tmp_path: Path):
    """下载缓存里放一个被篡改的 node 包：脚本必须因 sha256 不符失败，不生成运行包。"""
    dl = tmp_path / "downloads"
    dl.mkdir()
    node_arch = "x64" if ARCH == "linux-x64" else "arm64"
    (dl / f"node-v24.15.0-linux-{node_arch}.tar.xz").write_bytes(b"tampered")
    out = tmp_path / "out"
    r = run(
        ["bash", str(BUILD), ARCH],
        cwd=REPO,
        env={**os.environ, "FP_DOWNLOAD_DIR": str(dl), "FP_BUNDLE_OUT": str(out)},
        timeout=300,
    )
    assert r.returncode != 0
    assert "sha256" in r.stderr
    assert not out.exists()


def test_unknown_arch_rejected():
    r = run(["bash", str(BUILD), "linux-riscv"], cwd=REPO)
    assert r.returncode != 0
