"""swebench 评分（T2 计划 Task 10，D4）。

不信任 agent 容器里的任何结果：在同一镜像新建的容器里打补丁、跑测试。容器在 Docker 默认网络上
（测试前的 pip install 要联网），不挂运行包，连不到模型代理（代理只接 fp-eval-<run> 与 fp-egress-<run>）。
打补丁、跑测试脚本、判定都沿用 swebench 5.0.2 run_instance 的做法。docker 出错抛 DockerError（调用方按基础设施错误归类）。
"""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path

import docker
from swebench.harness.constants import APPLY_PATCH_FAIL, APPLY_PATCH_PASS
from swebench.harness.docker_utils import exec_run_with_timeout
from swebench.harness.grading import get_eval_report
from swebench.harness.run_evaluation import GIT_APPLY_CMDS
from swebench.harness.utils import make_test_spec

from .sandbox import LABEL, RUN_TIMEOUT_S, DockerError, _docker, _force_remove

PATCH_FILE = "/tmp/patch.diff"
WORKDIR = "/testbed"


def grade(inst: dict, patch: str, out_dir: Path, timeout_s: int = 1800) -> str:
    """返回 resolved / unresolved / patch_apply_failed；日志写入 out_dir/grade.log，容器无论结果都删除。

    inst 为 SWE-bench 数据集行，`image` 为实例镜像（按本机架构），可选 `run` 为容器的 fp-run 标签值（默认 `grade`）。
    """
    spec = make_test_spec(inst)
    name = f"fp-grade-{uuid.uuid4().hex[:8]}"
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "grade.log", "w", errors="replace") as log, tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "patch.diff").write_bytes(patch.encode("utf-8", errors="surrogateescape"))
        (tmp / "eval.sh").write_text(spec.eval_script)
        try:
            _docker("run", "-d", "--name", name, "--label", f"{LABEL}={inst.get('run', 'grade')}",
                    spec.image, "tail", "-f", "/dev/null", timeout=RUN_TIMEOUT_S)
            _docker("cp", str(tmp / "patch.diff"), f"{name}:{PATCH_FILE}")
            _docker("cp", str(tmp / "eval.sh"), f"{name}:/eval.sh")

            if not _apply(name, log):
                log.write(f"{APPLY_PATCH_FAIL}\n")
                return "patch_apply_failed"

            try:
                container = docker.from_env(timeout=timeout_s + 60).containers.get(name)
                output, timed_out, runtime = exec_run_with_timeout(container, "/bin/bash /eval.sh", timeout_s)
            except docker.errors.DockerException as e:
                raise DockerError(f"eval script exec failed: {e}") from e
            log.write(output)
            if timed_out:
                log.write(f"\n\n测试超时：超过 {timeout_s} 秒（Timeout error: {timeout_s} seconds exceeded.），记为 unresolved\n")
                return "unresolved"
            # 判定只读测试输出（同 swebench 的 test_output.txt），不混入打补丁的输出
            (tmp / "test_output.txt").write_text(output)
            report = get_eval_report(spec, {"instance_id": spec.instance_id, "model_patch": patch},
                                     str(tmp / "test_output.txt"), include_tests_status=True)
            log.write(f"\nTest runtime: {runtime:.2f}s\nreport: {json.dumps(report, indent=2)}\n")
            return "resolved" if report[spec.instance_id]["resolved"] else "unresolved"
        finally:
            _force_remove(name)


def _apply(name: str, log) -> bool:
    """swebench 的 GIT_APPLY_CMDS 回退链：每次重试前还原工作区；都失败时再查补丁是否其实已经打上。"""
    def run(cmd: str):
        return _docker("exec", "-w", WORKDIR, name, "bash", "-c", cmd, check=False)

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
