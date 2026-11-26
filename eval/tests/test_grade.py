"""T2-10：swebench 评分（计划 Task 10，D4）。

实例 astropy__astropy-12907（Task 0 拉过镜像；测试不联网，比 requests 稳定）。数据集行取自 SWE-bench_Verified
固定 revision；镜像按本机架构选（平台变更 P1）：Mac 用 arm64 实例镜像，x86 用数据集里的官方镜像。
"""

import subprocess
import uuid

import pytest

from conftest import ARCH
from forgepilot_eval.grade import grade
from forgepilot_eval.sandbox import cleanup_run

pytestmark = [pytest.mark.docker, pytest.mark.swebench]

INSTANCE = "astropy__astropy-12907"
VERIFIED_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
ASTROPY_IMAGE = {
    "linux-x64": "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest",
    "linux-arm64": "swebench/sweb.eval.arm64.astropy_1776_astropy-12907:latest",
}[ARCH]


@pytest.fixture(scope="module")
def row():
    from datasets import load_dataset

    ds = load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=VERIFIED_REVISION)
    return dict(next(r for r in ds if r["instance_id"] == INSTANCE))


@pytest.fixture
def inst(docker, row):
    run = f"t10-{uuid.uuid4().hex[:8]}"
    yield {**row, "image": ASTROPY_IMAGE, "run": run}
    left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=fp-run={run}"],
                          capture_output=True, text=True).stdout.split()
    cleanup_run(run)
    assert left == [], "评分容器没有删除"


def test_gold_patch_resolved(inst, tmp_path):
    assert grade(inst, inst["patch"], tmp_path) == "resolved"
    assert ">>>>> Start Test Output" in (tmp_path / "grade.log").read_text()


def test_empty_patch_unresolved(inst, tmp_path):
    assert grade(inst, "", tmp_path) == "unresolved"
    assert ">>>>> Start Test Output" in (tmp_path / "grade.log").read_text()


def test_garbage_patch_apply_failed(inst, tmp_path):
    assert grade(inst, "this is not a patch\n@@ garbage @@\n", tmp_path) == "patch_apply_failed"
    log = (tmp_path / "grade.log").read_text()
    assert ">>>>> Patch Apply Failed" in log
    assert ">>>>> Start Test Output" not in log  # 打不上就不跑测试


def test_timeout_unresolved(inst, tmp_path):
    assert grade(inst, inst["patch"], tmp_path, timeout_s=1) == "unresolved"
    assert "测试超时" in (tmp_path / "grade.log").read_text()
