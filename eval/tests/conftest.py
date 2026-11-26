"""docker 测试共用的 fixture：Docker 可用性、本机架构、运行包、实例镜像。"""

import platform
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

ARCH = {"x86_64": "linux-x64", "amd64": "linux-x64", "aarch64": "linux-arm64", "arm64": "linux-arm64"}[
    platform.machine().lower()
]
# Task 0 已验证的实例；x86 用 swebench 官方镜像（平台变更 P1）
REQUESTS_IMAGE = {
    "linux-x64": "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest",
    "linux-arm64": "swebench/sweb.eval.arm64.psf_1776_requests-2317:latest",
}[ARCH]


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="session")
def docker():
    if not docker_available():
        pytest.skip("Docker 不可用")


@pytest.fixture(scope="session")
def bundle(docker) -> Path:
    r = subprocess.run(
        ["bash", str(REPO / "scripts" / "build-eval-bundle.sh"), ARCH],
        cwd=REPO, capture_output=True, text=True, timeout=1800,
    )
    assert r.returncode == 0, f"构建运行包失败：\n{r.stdout}\n{r.stderr}"
    out = REPO / "eval" / ".cache" / f"bundle-{ARCH}"
    assert out.is_dir()
    return out
