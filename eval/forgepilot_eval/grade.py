"""swebench 评分（T2 计划 Task 10，D4）。

不信任 agent 容器里的任何结果：在同一镜像新建的容器里打补丁、跑测试。容器在 Docker 默认网络上
（测试前的 pip install 要联网），不挂运行包，连不到模型代理（代理只接 fp-eval-<run> 与 fp-egress-<run>）。
打补丁、跑测试脚本、判定都沿用 swebench 5.0.2 run_instance 的做法；与它的有意差异（不加 SYS_ADMIN、
不还原 image_assets、infra 类问题归为 infra_error）见实现说明 T2-10 偏差表。
"""

from __future__ import annotations

import json
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

import docker
import requests
from swebench.harness.constants import APPLY_PATCH_FAIL, APPLY_PATCH_PASS
from swebench.harness.docker_utils import exec_run_with_timeout
from swebench.harness.grading import get_eval_report
from swebench.harness.run_evaluation import GIT_APPLY_CMDS
from swebench.harness.utils import make_test_spec

from .sandbox import LABEL, RUN_TIMEOUT_S, DockerError, _docker, _force_remove

PATCH_FILE = "/tmp/patch.diff"
# docker 或容器本身出错：按 D10 记 infra_error，不算模型失败
INFRA_ERRORS = (DockerError, docker.errors.DockerException, requests.RequestException)


@dataclass
class GradeResult:
    status: str  # resolved / unresolved / patch_apply_failed / infra_error
    image: str
    image_digest: str = ""  # 容器没建起来时为空
    arch: str = ""  # docker 的架构名，如 amd64、arm64


def grade(inst: dict, patch: str, out_dir: Path, run: str, timeout_s: int = 1800) -> GradeResult:
    """inst 为 SWE-bench 数据集行，`image` 由调用方按本机架构选好；评分容器打 fp-run=<run> 标签。
    日志写入 out_dir/grade.log；容器无论结果（含异常）都删除。image_assets 不为空时抛 ValueError。"""
    spec = make_test_spec(inst)
    if spec.image_assets:
        raise ValueError(f"{spec.instance_id}: image_assets is not empty; grade does not restore image assets")
    result = GradeResult("infra_error", spec.image)
    name = f"fp-grade-{uuid.uuid4().hex[:8]}"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "grade.log", "w", encoding="utf-8", errors="replace") as log, \
            tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "patch.diff").write_bytes(patch.encode("utf-8", errors="surrogateescape"))
        (tmp / "eval.sh").write_text(spec.eval_script, encoding="utf-8")
        try:
            _docker("run", "-d", "--name", name, "--label", f"{LABEL}={run}",
                    spec.image, "tail", "-f", "/dev/null", timeout=RUN_TIMEOUT_S)
            result.image_digest, result.arch = _image_info(spec.image)
            result.status = _grade_in(name, spec, patch, tmp, log, timeout_s)
        except INFRA_ERRORS as e:
            log.write(f"\ninfra_error: {type(e).__name__}: {e}\n")
        finally:
            _force_remove(name)
    return result


def _grade_in(name: str, spec, patch: str, tmp: Path, log, timeout_s: int) -> str:
    _docker("cp", str(tmp / "patch.diff"), f"{name}:{PATCH_FILE}")
    _docker("cp", str(tmp / "eval.sh"), f"{name}:/eval.sh")
    if not _apply(name, log):
        _docker("exec", name, "true")  # 容器坏了就抛 DockerError（infra_error），不当成补丁打不上
        log.write(f"{APPLY_PATCH_FAIL}\n")
        return "patch_apply_failed"

    client = docker.from_env(timeout=timeout_s + 60)
    try:
        output, timed_out, runtime = exec_run_with_timeout(client.containers.get(name), "/bin/bash /eval.sh", timeout_s)
    finally:
        client.close()
    log.write(output)
    if timed_out:
        log.write(f"\n\n测试超时：超过 {timeout_s} 秒（Timeout error: {timeout_s} seconds exceeded.），记为 unresolved\n")
        return "unresolved"
    # 判定只读测试输出（同 swebench 的 test_output.txt），不混入打补丁的输出
    (tmp / "test_output.txt").write_text(output, encoding="utf-8")
    report = get_eval_report(spec, {"instance_id": spec.instance_id, "model_patch": patch},
                             str(tmp / "test_output.txt"), include_tests_status=True)
    log.write(f"\nTest runtime: {runtime:.2f}s\nreport: {json.dumps(report, indent=2)}\n")
    entry = report[spec.instance_id]
    if entry.get("infra_failure"):  # swebench 判为环境问题（如断网、OOM）；官方留在分母，这里按 D10 排除
        return "infra_error"
    return "resolved" if entry["resolved"] else "unresolved"


def _image_info(image: str) -> tuple[str, str]:
    """(digest, 架构)：有 RepoDigests 用第一个，否则用镜像 Id（同 Sandbox.image_digest）。"""
    out = _docker("image", "inspect", image, "--format", "{{json .RepoDigests}} {{.Id}} {{.Architecture}}").stdout
    digests, image_id, arch = out.strip().rsplit(" ", 2)
    return (json.loads(digests) or [image_id])[0], arch


def _apply(name: str, log) -> bool:
    """swebench 的 GIT_APPLY_CMDS 回退链：每次重试前还原工作区；都失败时再查补丁是否其实已经打上。"""
    def run(cmd: str):
        return _docker("exec", "-w", "/testbed", name, "bash", "-c", cmd, check=False)

    for attempt, cmd in enumerate(GIT_APPLY_CMDS):
        if attempt:
            run("git checkout -- . ; git clean -fd")
        r = run(f"{cmd} {PATCH_FILE}")
        log.write(f"$ {cmd} {PATCH_FILE}  (exit {r.returncode})\n{r.stdout}{r.stderr}\n")
        if r.returncode == 0:
            log.write(f"{APPLY_PATCH_PASS}\n")
            return True
    r = run(f"git apply --check --reverse {PATCH_FILE}")
    if r.returncode == 0:
        log.write(f"{APPLY_PATCH_PASS}: verified already applied\n")
        return True
    return False
