"""T2-13：汇总、花费与一条命令（计划 Task 13，MVP 精简版）。

汇总与花费是纯函数；命令的单元用例把 run_instance、grade、代理、清理换成假的，只有 check-secrets 真跑；
最后一条 docker 用例用假模型把 smoke-v1 从头跑到尾（不调真实模型）。
"""

import dataclasses
import json
import time
import uuid
from dataclasses import asdict
from pathlib import Path

import pytest

from conftest import ARCH, REPO
from forgepilot_eval import __main__ as cli
from forgepilot_eval import sandbox
from forgepilot_eval.config import load_config
from forgepilot_eval.grade import GradeResult
from forgepilot_eval.repo_prep import BaseMismatch
from forgepilot_eval.report import actual_cost, aggregate, estimate_cost
from forgepilot_eval.run_task import TaskRecord
from forgepilot_eval.sandbox import DockerError
from test_run_task import fake_js, sh  # noqa: F401 — fake_js 是 fixture

CONFIG = REPO / "eval" / "configs" / "qwen3.6.yaml"
KEY = "sk-fake-t13-0123456789"


def rec(iid="i", ft="none", grade=None, arch="amd64", usage=None, **kw) -> TaskRecord:
    r = TaskRecord(iid, "h", "s", failure_type=ft, grade_status=grade, grade_arch=arch if grade else None, **kw)
    if usage:
        r.usage.update(usage)
    return r


# ---------- 花费 ----------

def test_estimate_cost():
    cfg = load_config(CONFIG)  # 1.8 / 10.8 元每百万；每次 150 万输入 + 3 万输出
    assert estimate_cost(cfg, 2) == pytest.approx(2 * (1.5 * 1.8 + 0.03 * 10.8))


def test_actual_cost_counts_cache_at_input_price_and_reasoning_once():
    cfg = load_config(CONFIG)
    a = rec(usage={"input": 1_000_000, "cacheRead": 500_000, "cacheWrite": 500_000, "output": 100, "reasoning": 80})
    assert actual_cost([a], cfg) == pytest.approx((2_000_000 * 1.8 + 100 * 10.8) / 1e6)
    assert actual_cost([rec(usage={"output": 100, "reasoning": 80})], cfg) == pytest.approx(100 * 10.8 / 1e6)


# ---------- 汇总（D10） ----------

def test_d10_failures_in_denominator_and_excluded_listed():
    cfg = load_config(CONFIG)
    finals = [rec("a", grade="resolved"), rec("b", grade="patch_apply_failed"), rec("c", ft="empty_patch"),
              rec("d", ft="infra_error", failure_reason="HistoryLeak: x")]
    s = aggregate(finals, cfg, "smoke", finals)
    assert s["measured"] == 3 and s["resolved"] == 1
    assert s["success_rate"] == pytest.approx(1 / 3)
    assert s["excluded"] == [{"instance_id": "d", "failure_type": "infra_error", "failure_reason": "HistoryLeak: x"}]
    assert s["failure_types"] == {"resolved": 1, "patch_apply_failed": 1, "empty_patch": 1, "infra_error": 1}
    assert s["status"] == "invalid"  # 1/4 超过 5%


@pytest.mark.parametrize("n_ok, status", [(20, "complete"), (19, "complete"), (18, "invalid")])
def test_d10_five_percent_threshold(n_ok, status):
    """排除比例「超过」5% 才无效：1/21、1/20 有效，1/19 无效。grade 为 infra_error 的同样排除。"""
    cfg = load_config(CONFIG)
    finals = [rec(str(i), grade="resolved") for i in range(n_ok)] + [rec("x", grade="infra_error", arch="")]
    assert aggregate(finals, cfg, "smoke", finals)["status"] == status


def test_non_smoke_taskset_requires_amd64_grading():
    cfg = load_config(CONFIG)
    many = [rec(str(i), grade="resolved") for i in range(20)]
    arm = [rec("arm", grade="unresolved", arch="arm64")]
    assert aggregate(many + arm, cfg, "smoke", many + arm)["status"] == "complete"  # 冒烟集不受影响
    s = aggregate(many + arm, cfg, "dev", many + arm)
    assert s["status"] == "invalid" and any("arm64" in r for r in s["invalid_reasons"])
    # 评分 infra_error 且 grade_arch 为空的记录已按 D10 排除，不参与架构检查
    infra = [rec("x", grade="infra_error", arch="")]
    assert aggregate(many + infra, cfg, "dev", many + infra)["status"] == "complete"


def test_per_run_stats_token_caliber_and_cost():
    cfg = load_config(CONFIG)
    a = rec("a", grade="resolved", usage={"input": 10, "cacheRead": 5, "cacheWrite": 7, "output": 3, "reasoning": 2},
            requests=4, wall_s=10.0)
    b = rec("b", grade="unresolved", usage={"input": 30, "output": 2}, requests=2, wall_s=20.0, usage_complete=False)
    retried = rec("b", ft="infra_error", usage={"input": 1_000_000})  # 被重试掉的那次也花了钱
    s = aggregate([a, b], cfg, "smoke", [a, retried, b])
    assert s["per_run"]["tokens"] == {"mean": 25, "median": 25}  # input+cacheRead+output：18 与 32
    assert s["per_run"]["requests"] == {"mean": 3, "median": 3}
    assert s["per_run"]["wall_s"] == {"mean": 15, "median": 15}
    assert s["cost"]["actual_yuan"] == pytest.approx(actual_cost([a, retried, b], cfg))
    assert s["cost"]["runs"] == 3 and s["cost"]["usage_unknown_runs"] == 1


# ---------- 命令（假 run_instance / grade / 代理） ----------

@pytest.fixture
def env(tmp_path, monkeypatch):
    """返回 go(scripts, grades=None, args=…) -> (退出码, 输出目录, calls)。scripts[iid] 是各次尝试的结果。"""
    bundle = tmp_path / "bundle"
    (bundle / "bin").mkdir(parents=True)
    (bundle / "bin" / "fp-entry").write_text("")
    monkeypatch.setattr(cli, "load_config", lambda p: dataclasses.replace(load_config(p), bundle=bundle))
    envf = tmp_path / ".env"
    envf.write_text(f"OTHER=1\nDASHSCOPE_API_KEY={KEY}\n")
    calls = {"run": [], "grade": [], "proxy": [], "cleanup": [], "sleep": []}
    class FakeProxy:
        def logs(self):
            return [{"route": "qwen", "fields": ["model"], "sampling": {"temperature": 1.0, "top_p": 0.95}, "status": 200}]

    def start_proxy(run, routes, e):
        calls["proxy"].append((run, routes, e))
        return FakeProxy()

    monkeypatch.setattr(cli, "start_proxy", start_proxy)
    monkeypatch.setattr(cli, "cleanup_run", calls["cleanup"].append)
    monkeypatch.setattr(cli.time, "sleep", calls["sleep"].append)
    monkeypatch.setattr(cli, "load_rows", lambda ts: {i: {"instance_id": i, "row": True} for i in ts["instance_ids"]})

    def go(scripts, grades=None, args=(), out_name="t13-run"):
        ids = list(scripts)
        ts = tmp_path / "ts.json"
        ts.write_text(json.dumps({"name": "smoke", "version": 1, "dataset": "d", "revision": "r", "instance_ids": ids,
                                  "images": {i: {"linux-arm64": f"{i}-arm", "linux-x64": f"{i}-x64"} for i in ids},
                                  "probe_blobs": {i: [f"blob-{i}"] for i in ids}}))
        grades = {i: list(g) for i, g in (grades or {}).items()}

        def run_instance(inst, cfg, run, out, attempt):
            iid = inst["instance_id"]
            calls["run"].append((iid, attempt, inst["image"], inst["probe_blobs"], inst["row"]))
            kind = scripts[iid][attempt - 1]
            if kind == "bug":  # 还没写出 record.json 就出错
                raise ValueError("boom")
            d = out / iid / str(attempt)
            d.mkdir(parents=True)
            r = TaskRecord(iid, "h", inst["taskset_sha256"], failure_type="none" if kind == "leak" else kind,
                           usage={"input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0}, requests=2)
            err = {"raise": DockerError("docker run failed"), "mismatch": BaseMismatch("base_commit is not HEAD")}.get(kind)
            if err:  # 同真实 run_instance：先写 infra_error 的 record 再抛
                r.failure_type, r.failure_reason = "infra_error", f"{type(err).__name__}: {err}"
            (d / "patch.diff").write_text("diff --git a/x b/x\n" if kind == "none" else "")
            (d / "events.jsonl").write_text(f'{{"leak": "{KEY}"}}\n' if kind == "leak" else "{}\n")
            (d / "record.json").write_text(json.dumps(asdict(r)))
            if err:
                raise err
            return r

        def grade(inst, patch, out_dir, run, timeout_s):
            calls["grade"].append((inst["instance_id"], patch, out_dir, run, timeout_s, inst["image"]))
            status = grades.get(inst["instance_id"], []).pop(0) if grades.get(inst["instance_id"]) else "resolved"
            return GradeResult(status, inst["image"], "sha256:x" if status != "infra_error" else "", "arm64" if status != "infra_error" else "")

        monkeypatch.setattr(cli, "run_instance", run_instance)
        monkeypatch.setattr(cli, "grade", grade)
        out = tmp_path / "runs" / out_name
        code = cli.main(["run", "--config", str(CONFIG), "--taskset", str(ts), "--out", str(out),
                         "--env-file", str(envf), *(["--yes"] if "--no-yes" not in args else []),
                         *[a for a in args if a != "--no-yes"]])
        return code, out, calls

    return go


def summary(out: Path) -> dict:
    return json.loads((out / "summary.json").read_text())


def test_clean_run_grades_and_writes_summary(env):
    code, out, calls = env({"a__a-1": ["none"], "b__b-2": ["empty_patch"]})
    assert code == 0
    assert [c[:2] for c in calls["run"]] == [("a__a-1", 1), ("b__b-2", 1)]
    # 按本机架构从任务集 images 取镜像，probe_blobs 取任务集的值，数据集行并入 inst
    assert calls["run"][0][2] == {"linux-arm64": "a__a-1-arm", "linux-x64": "a__a-1-x64"}[ARCH]
    assert calls["run"][0][3] == ["blob-a__a-1"] and calls["run"][0][4] is True
    # 只评分待评分（failure_type=none）的运行；补丁取自 patch.diff；评分超时取配置
    assert [(g[0], g[1], g[2], g[4]) for g in calls["grade"]] == [
        ("a__a-1", "diff --git a/x b/x\n", out / "a__a-1" / "1" / "grade" / "1", 1800)]
    # 清理前把代理日志原样存下（T2-14 核对采样参数）
    proxy = [json.loads(l) for l in (out / "proxy.jsonl").read_text().splitlines()]
    assert proxy == [{"route": "qwen", "fields": ["model"], "sampling": {"temperature": 1.0, "top_p": 0.95}, "status": 200}]
    rec_a = json.loads((out / "a__a-1" / "1" / "record.json").read_text())
    assert (rec_a["grade_status"], rec_a["grade_image_digest"], rec_a["grade_arch"]) == ("resolved", "sha256:x", "arm64")
    s = summary(out)
    assert s["status"] == "complete" and s["success_rate"] == 0.5
    assert s["failure_types"] == {"resolved": 1, "empty_patch": 1}
    assert s["taskset"]["name"] == "smoke" and len(s["config_hash"]) == 64
    assert "成功率" in (out / "summary.md").read_text()
    # 代理只拿到 key 变量；评测名即输出目录名；无论如何都清理
    assert calls["proxy"][0][0] == "t13-run" and calls["proxy"][0][2] == {"DASHSCOPE_API_KEY": KEY}
    assert calls["cleanup"] == ["t13-run"]
    assert KEY not in (out / "summary.json").read_text() + (out / "summary.md").read_text()


def test_infra_error_retries(env):
    """运行阶段：infra_error 两种交出方式（返回值；写好 record 后抛异常）都重试，最多 3 次，仍失败就排除。
    评分阶段：infra_error 只用同一份补丁重新评分（最多 2 次），不重跑 agent（作者 2026-11-26）。"""
    code, out, calls = env({"a__a-1": ["infra_error", "raise", "none"], "b__b-2": ["raise"] * 3, "c__c-3": ["none"]},
                           grades={"a__a-1": ["infra_error", "resolved"], "c__c-3": ["infra_error"] * 3})
    assert [c[:2] for c in calls["run"]] == [("a__a-1", 1), ("a__a-1", 2), ("a__a-1", 3),
                                            ("b__b-2", 1), ("b__b-2", 2), ("b__b-2", 3), ("c__c-3", 1)]
    d = out / "a__a-1" / "3"
    assert [(g[0], g[1], g[2]) for g in calls["grade"]] == [
        ("a__a-1", "diff --git a/x b/x\n", d / "grade" / "1"), ("a__a-1", "diff --git a/x b/x\n", d / "grade" / "2"),
        *[("c__c-3", "diff --git a/x b/x\n", out / "c__c-3" / "1" / "grade" / str(n)) for n in (1, 2, 3)]]
    assert json.loads((d / "record.json").read_text())["grade_status"] == "resolved"
    s = summary(out)
    assert s["failure_types"] == {"resolved": 1, "infra_error": 2}
    assert [e["instance_id"] for e in s["excluded"]] == ["b__b-2", "c__c-3"]
    assert "DockerError" in s["excluded"][0]["failure_reason"]
    assert s["status"] == "invalid" and code != 0 and calls["sleep"] == []


def test_deterministic_infra_error_not_retried(env):
    code, out, calls = env({"a__a-1": ["mismatch"]})
    assert [c[1] for c in calls["run"]] == [1]
    s = summary(out)
    assert s["excluded"][0]["failure_type"] == "infra_error" and "BaseMismatch" in s["excluded"][0]["failure_reason"]
    assert code != 0


def test_rate_limited_backs_off_then_excluded(env):
    code, out, calls = env({"a__a-1": ["rate_limited"] * 3})
    assert [c[1] for c in calls["run"]] == [1, 2, 3]
    assert calls["sleep"] == [60, 60]
    assert summary(out)["excluded"][0]["failure_type"] == "rate_limited"


def test_out_exists_refused(env, tmp_path):
    (tmp_path / "runs" / "t13-run").mkdir(parents=True)
    code, _, calls = env({"a__a-1": ["none"]})
    assert code != 0 and calls["run"] == [] and calls["proxy"] == []


def test_missing_fp_entry_refused_before_any_container(env, tmp_path):
    (tmp_path / "bundle" / "bin" / "fp-entry").unlink()
    code, out, calls = env({"a__a-1": ["none"]})
    assert code != 0 and calls["proxy"] == [] and calls["run"] == [] and not out.exists()


def test_estimate_printed_and_declined(env, monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    code, out, calls = env({"a__a-1": ["none"]}, args=["--no-yes"])
    text = capsys.readouterr().out
    assert "预计花费" in text and "未校准的保守估计" in text  # assumed_tokens_per_run.source
    assert code != 0 and calls["proxy"] == [] and not out.exists()


def test_secret_in_output_fails(env):
    code, out, _ = env({"a__a-1": ["leak"]})
    assert summary(out)["status"] == "complete"
    assert code != 0


def test_cleanup_failure_does_not_mask_original_error(env, monkeypatch, capsys):
    def bad_cleanup(run):
        raise DockerError("rm hung")
    monkeypatch.setattr(cli, "cleanup_run", bad_cleanup)
    with pytest.raises(ValueError, match="boom"):
        env({"a__a-1": ["bug"]})
    assert "rm hung" in capsys.readouterr().err


def test_secrets_scanned_on_abnormal_end(env, capfd):
    """异常结束时也扫描输出目录（已写出的轨迹里可能有 key）；原始异常照常抛出。"""
    with pytest.raises(ValueError, match="boom"):
        env({"a__a-1": ["leak"], "b__b-2": ["bug"]})
    assert "DASHSCOPE_API_KEY 的值出现在" in capfd.readouterr().err


# ---------- 一条命令从头到尾（Docker、假模型、smoke-v1） ----------

@pytest.mark.docker
@pytest.mark.swebench
def test_end_to_end_smoke_with_fake_model(docker, bundle, fake_js, tmp_path):  # noqa: F811
    run = f"t13-{uuid.uuid4().hex[:8]}"
    fake_dir = tmp_path / "fake"
    fake_dir.mkdir()
    (fake_dir / "fake.mjs").write_bytes(fake_js.read_bytes())
    (fake_dir / "turns.json").write_text(json.dumps([
        {"kind": "toolCall", "name": "bash", "args": {"command": "echo fix > new_file.py"}, "id": "c1"},
        {"kind": "text", "chunks": ["done"]}]))
    fake = f"fp-fake-{run}"
    try:
        net = sandbox.ensure_egress_network(run)  # 代理接这个网络，经容器名访问假模型
        r = sh("docker", "run", "-d", "--name", fake, "--label", f"fp-run={run}", "--network", net,
               "-v", f"{fake_dir}:/fake", sandbox.PROXY_IMAGE, "node", "/fake/fake.mjs", "/fake/turns.json",
               "--host", "0.0.0.0")
        assert r.returncode == 0, r.stderr
        for _ in range(100):
            line = sh("docker", "logs", fake).stdout
            if line.startswith("FAKE_LISTENING"):
                break
            time.sleep(0.2)
        port = line.split()[1].rsplit(":", 1)[1].split("/")[0]
        cfg_text = CONFIG.read_text().replace("https://dashscope.aliyuncs.com/compatible-mode/v1",
                                              f"http://{fake}:{port}/v1")
        cfg_text = cfg_text.replace("../prompts/swe-v1.txt", str(REPO / "eval" / "prompts" / "swe-v1.txt"))
        cfg_path = tmp_path / "c.yaml"
        cfg_path.write_text(cfg_text)
        envf = tmp_path / ".env"
        envf.write_text(f"DASHSCOPE_API_KEY={KEY}\n")
        out = tmp_path / run
        code = cli.main(["run", "--config", str(cfg_path), "--taskset", str(REPO / "eval/tasksets/smoke-v1.json"),
                         "--out", str(out), "--env-file", str(envf), "--yes"])
        s = summary(out)
        assert s["failure_types"] == {"unresolved": 1}, s
        assert s["status"] == "complete" and code == 0
        assert s["per_run"]["requests"]["mean"] == 2
        d = out / "astropy__astropy-12907" / "1"
        assert "new_file.py" in (d / "patch.diff").read_text()
        record = json.loads((d / "record.json").read_text())
        assert record["grade_status"] == "unresolved" and record["grade_arch"] == {"linux-arm64": "arm64", "linux-x64": "amd64"}[ARCH]
        assert (d / "grade" / "1" / "grade.log").exists()
        proxy = [json.loads(l) for l in (out / "proxy.jsonl").read_text().splitlines()]
        assert len(proxy) == 2 and all((p["sampling"]["temperature"], p["sampling"]["top_p"]) == (1.0, 0.95) for p in proxy)
        assert KEY not in (out / "proxy.jsonl").read_text()  # check-secrets 也扫它（退出码 0 已证明）
    finally:
        left = [sh("docker", *kind, "--filter", f"label=fp-run={run}").stdout.strip()
                for kind in (["ps", "-aq"], ["network", "ls", "-q"])]
        sandbox.cleanup_run(run)
    assert left == ["", ""], "命令结束后仍有本次评测的容器或网络"
