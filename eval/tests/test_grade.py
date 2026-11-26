"""T2-10：swebench 评分（计划 Task 10，D4）。

实例 astropy__astropy-12907（Task 0 拉过镜像；测试不联网，比 requests 稳定）。数据集行取自 SWE-bench_Verified
固定 revision；镜像按本机架构选（平台变更 P1）：Mac 用 arm64 实例镜像，x86 用数据集里的官方镜像。
"""

import subprocess
import uuid

import pytest
import requests
import urllib3

from conftest import ARCH
from forgepilot_eval import grade as grade_mod
from forgepilot_eval.grade import grade
from forgepilot_eval.sandbox import cleanup_run

pytestmark = [pytest.mark.docker, pytest.mark.swebench]

INSTANCE = "astropy__astropy-12907"
VERIFIED_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
ASTROPY_IMAGE = {
    "linux-x64": "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest",
    "linux-arm64": "swebench/sweb.eval.arm64.astropy_1776_astropy-12907:latest",
}[ARCH]
DOCKER_ARCH = {"linux-x64": "amd64", "linux-arm64": "arm64"}[ARCH]


@pytest.fixture(scope="module")
def row():
    from datasets import load_dataset

    ds = load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=VERIFIED_REVISION)
    return dict(next(r for r in ds if r["instance_id"] == INSTANCE))


@pytest.fixture
def inst(docker, row):
    return {**row, "image": ASTROPY_IMAGE}


@pytest.fixture
def run(docker):
    run = f"t10-{uuid.uuid4().hex[:8]}"
    yield run
    left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=fp-run={run}"],
                          capture_output=True, text=True).stdout.split()
    cleanup_run(run)
    assert left == [], "评分容器没有删除"


def fake_exec(monkeypatch, fn):
    """替换 swebench 的 exec_run_with_timeout（不真跑测试脚本）。"""
    monkeypatch.setattr(grade_mod, "exec_run_with_timeout", fn)


def test_gold_patch_resolved(inst, run, tmp_path):
    r = grade(inst, inst["patch"], tmp_path, run)
    assert r.status == "resolved"
    assert r.image == ASTROPY_IMAGE
    assert r.image_digest.startswith(("swebench/sweb.eval.", "sha256:"))
    assert "sha256:" in r.image_digest
    assert r.arch == DOCKER_ARCH


def test_empty_patch_unresolved(inst, run, tmp_path):
    assert grade(inst, "", tmp_path, run).status == "unresolved"
    assert ">>>>> Start Test Output" in (tmp_path / "grade.log").read_text(encoding="utf-8")


def test_garbage_patch_apply_failed(inst, run, tmp_path):
    assert grade(inst, "this is not a patch\n@@ garbage @@\n", tmp_path, run).status == "patch_apply_failed"
    log = (tmp_path / "grade.log").read_text(encoding="utf-8")
    assert ">>>>> Patch Apply Failed" in log
    assert ">>>>> Start Test Output" not in log  # 打不上就不跑测试


def test_timeout_unresolved(inst, run, tmp_path):
    assert grade(inst, inst["patch"], tmp_path, run, timeout_s=1).status == "unresolved"
    assert "测试超时" in (tmp_path / "grade.log").read_text(encoding="utf-8")


def test_container_labelled_with_run(inst, run, tmp_path, monkeypatch):
    seen = {}

    def spy(container, cmd, timeout):
        seen.update(container.labels)
        return "", True, 0.0  # 当作超时，不真跑测试

    fake_exec(monkeypatch, spy)
    grade(inst, "", tmp_path, run)
    assert seen.get("fp-run") == run


def test_image_assets_rejected(inst, run, tmp_path):
    with pytest.raises(ValueError, match="image_assets"):
        grade({**inst, "image_assets": '{"a.png": "https://example.invalid/a.png"}'}, "", tmp_path, run)


def test_sdk_connection_error_is_infra_error(inst, run, tmp_path, monkeypatch):
    def boom(container, cmd, timeout):
        raise requests.exceptions.ConnectionError("stream broken")

    fake_exec(monkeypatch, boom)
    r = grade(inst, "", tmp_path, run)
    assert r.status == "infra_error"
    assert "stream broken" in (tmp_path / "grade.log").read_text(encoding="utf-8")


def test_urllib3_stream_error_is_infra_error(inst, run, tmp_path, monkeypatch):
    def boom(container, cmd, timeout):
        raise urllib3.exceptions.ProtocolError("connection reset")  # 读原始流时守护进程重启

    fake_exec(monkeypatch, boom)
    assert grade(inst, "", tmp_path, run).status == "infra_error"
    # 容器已删由 run fixture 的 teardown 断言


def test_container_broken_during_apply_is_infra_error(inst, run, tmp_path, monkeypatch):
    real = grade_mod._docker
    killed = []

    def kill_before_first_exec(*args, **kw):
        if args[0] == "exec" and not killed:
            killed.append(args[3])  # exec -w /testbed <name> ...
            real("kill", args[3])
        return real(*args, **kw)

    monkeypatch.setattr(grade_mod, "_docker", kill_before_first_exec)
    assert grade(inst, inst["patch"], tmp_path, run).status == "infra_error"
    assert killed


def test_report_infra_failure_is_infra_error(inst, run, tmp_path, monkeypatch):
    fake_exec(monkeypatch, lambda container, cmd, timeout: ("no tests", False, 0.1))
    monkeypatch.setattr(grade_mod, "get_eval_report", lambda *a, **kw: {
        INSTANCE: {"resolved": False, "infra_failure": True, "infra_failure_reason": "network_unreachable"}})
    assert grade(inst, "", tmp_path, run).status == "infra_error"


def test_unexpected_exception_still_removes_container(inst, run, tmp_path, monkeypatch):
    def boom(container, cmd, timeout):
        raise RuntimeError("unexpected")

    fake_exec(monkeypatch, boom)
    with pytest.raises(RuntimeError, match="unexpected"):
        grade(inst, "", tmp_path, run)
    # 容器已删由 run fixture 的 teardown 断言
