"""T2-11：任务集抽样与金标准预检（计划 Task 11）。单元测试，不碰 docker：预检、评分、探针、镜像解析都用假函数。"""

import json
from collections import Counter

import pytest

from forgepilot_eval import taskset
from forgepilot_eval.grade import GradeResult
from forgepilot_eval.sandbox import DockerError
from forgepilot_eval.taskset import PrecheckResult, build_taskset, stratified_sample, taskset_sha256


def make_rows():
    """3 个仓库，条数 10 / 5 / 1。"""
    rows = []
    for repo, count in (("org/big", 10), ("org/mid", 5), ("org/one", 1)):
        rows += [{"repo": repo, "instance_id": f"{repo.split('/')[1]}__x-{i}",
                  "image": f"swebench/sweb.eval.x86_64.{repo.split('/')[1]}_1776_x-{i}:latest"} for i in range(count)]
    return rows


def repos_of(ids, rows):
    repo = {r["instance_id"]: r["repo"] for r in rows}
    return Counter(repo[i] for i in ids)


def test_sample_covers_every_repo():
    rows = make_rows()
    ids = stratified_sample(rows, 8, seed=1)
    assert len(ids) == len(set(ids)) == 8
    assert set(repos_of(ids, rows)) == {"org/big", "org/mid", "org/one"}
    assert ids == sorted(ids)


def test_sample_proportional():
    # 每仓库 1 个，余下 5 个按 10/5/1 比例：big 至少 1+3，mid 至少 1+1，one 恰 1
    counts = repos_of(stratified_sample(make_rows(), 8, seed=3), make_rows())
    assert counts["org/big"] >= 4 and counts["org/mid"] >= 2 and counts["org/one"] == 1


def test_sample_deterministic_by_seed():
    rows = make_rows()
    assert stratified_sample(rows, 8, seed=7) == stratified_sample(rows, 8, seed=7)
    assert stratified_sample(rows, 8, seed=7) != stratified_sample(rows, 8, seed=8)


def test_sample_n_too_large():
    with pytest.raises(ValueError):
        stratified_sample(make_rows(), 17, seed=1)


def test_sample_fewer_than_repos():
    # n 小于仓库数：按种子随机选 n 个仓库、每个 1 个（作者 2026-11-26）
    rows = make_rows()
    picks = {seed: stratified_sample(rows, 2, seed) for seed in range(30)}
    for ids in picks.values():
        assert len(ids) == 2 and set(repos_of(ids, rows).values()) == {1}
    assert stratified_sample(rows, 2, 5) == picks[5]
    assert len({frozenset(repos_of(ids, rows)) for ids in picks.values()}) == 3  # 三种仓库组合都出现过



# ---------- build_taskset ----------

def fake_refs(inst, platforms):
    iid = inst["instance_id"]
    refs = {"linux-arm64": f"swebench/sweb.eval.arm64.{iid.replace('__', '_1776_')}@sha256:a-{iid}",
            "linux-x64": f"{inst['image'].rsplit(':', 1)[0]}@sha256:x-{iid}"}
    return {p: refs[p] for p in platforms}


@pytest.fixture
def build(monkeypatch, tmp_path):
    """build_taskset 的假环境：本机默认 x86（开发集在 x86 上定版），镜像解析与预检都是假的；
    failing 里的候选预检不通过；refs_fail[iid] 为该候选镜像解析还要失败的次数。"""
    state = {"failing": set(), "seen": [], "max_gold_s": set(), "platforms": set(), "refs_fail": {}, "machine": "x86_64"}

    def refs(inst, platforms):
        state["platforms"].add(tuple(platforms))
        if state["refs_fail"].get(inst["instance_id"]):
            state["refs_fail"][inst["instance_id"]] -= 1
            raise DockerError("docker buildx failed (1): registry timeout")
        return fake_refs(inst, platforms)

    def fake_precheck(inst, bundle, max_gold_s=None):
        state["seen"].append(inst["instance_id"])
        state["max_gold_s"].add(max_gold_s)
        assert bundle == tmp_path / "bundle"
        tag = "a" if taskset.local_platform() == "linux-arm64" else "x"
        assert inst["image"].endswith(f"@sha256:{tag}-{inst['instance_id']}")  # 传入本机平台的 name@digest
        if inst["instance_id"] in state["failing"]:
            return PrecheckResult(False, ["gold patch: expected resolved, got unresolved"], [])
        return PrecheckResult(True, [], [f"blob-{inst['instance_id']}"])

    monkeypatch.setattr(taskset.platform, "machine", lambda: state["machine"])
    monkeypatch.setattr(taskset, "image_refs", refs)
    monkeypatch.setattr(taskset, "precheck", fake_precheck)
    return state


def test_build_taskset_excludes_failed_candidates(build, tmp_path):
    rows = make_rows()
    candidates = stratified_sample(rows, 12, seed=5)  # n=8 → 候选 8×1.5=12
    build["failing"] = set(candidates[:2])
    out = tmp_path / "t.json"
    build_taskset("unit", 1, rows, 8, 5, tmp_path / "bundle", out)
    doc = json.loads(out.read_text(encoding="utf-8"))

    assert build["seen"] == candidates
    assert build["max_gold_s"] == {None}  # 10 分钟上限只套冷烟集
    assert doc["name"] == "unit" and doc["version"] == 1 and doc["seed"] == 5
    assert doc["dataset"] == "SWE-bench/SWE-bench_Verified"
    assert doc["revision"] == "78f471bf655a3137b2e8a75af1501690ec009ec3"
    assert doc["created"] and doc["selection"]["candidates"] == candidates
    assert sorted(e["id"] for e in doc["precheck"]["excluded"]) == sorted(build["failing"])
    assert all(e["reasons"] for e in doc["precheck"]["excluded"])
    assert doc["precheck"]["passed"] == [c for c in candidates if c not in build["failing"]]
    assert len(doc["instance_ids"]) == 8 and not build["failing"] & set(doc["instance_ids"])
    assert set(doc["instance_ids"]) <= set(doc["precheck"]["passed"])
    assert set(doc["probe_blobs"]) == set(doc["instance_ids"])
    assert all(doc["probe_blobs"][i] == [f"blob-{i}"] for i in doc["instance_ids"])
    by_id = {r["instance_id"]: r for r in rows}
    # 开发集只记 x86、不解析 arm64（作者 2026-11-26）
    assert build["platforms"] == {("linux-x64",)}
    assert doc["images"] == {i: fake_refs(by_id[i], ["linux-x64"]) for i in doc["instance_ids"]}
    assert taskset_sha256(out) == taskset_sha256(out) and len(taskset_sha256(out)) == 64


def test_build_smoke_taskset_records_both_platforms(build, tmp_path):
    build["machine"] = "arm64"
    rows = make_rows()
    build_taskset("smoke", 1, rows, 3, 1, tmp_path / "bundle", tmp_path / "s.json")
    doc = json.loads((tmp_path / "s.json").read_text())
    assert build["max_gold_s"] == {600}
    by_id = {r["instance_id"]: r for r in rows}
    assert doc["images"] == {i: fake_refs(by_id[i], ["linux-arm64", "linux-x64"]) for i in doc["instance_ids"]}


def test_build_dev_taskset_only_on_x86(build, tmp_path):
    build["machine"] = "arm64"  # 开发集只记 x86 镜像，Mac 上没法用本机镜像预检
    with pytest.raises(ValueError, match="x86"):
        build_taskset("unit", 1, make_rows(), 8, 5, tmp_path / "bundle", tmp_path / "t.json")
    assert build["seen"] == []


def test_build_taskset_image_refs_infra_retried(build, tmp_path):
    # 解析 digest 失败属拉取类 infra：同配置重试最多 2 次，仍失败记为无法测量并排除，不中止（design 3.11）
    rows = make_rows()
    candidates = stratified_sample(rows, 12, seed=5)
    build["refs_fail"] = {candidates[0]: 2, candidates[1]: 3}
    build_taskset("unit", 1, rows, 8, 5, tmp_path / "bundle", tmp_path / "t.json")
    doc = json.loads((tmp_path / "t.json").read_text())
    assert candidates[0] in doc["precheck"]["passed"]
    [excluded] = doc["precheck"]["excluded"]
    assert excluded["id"] == candidates[1] and "unmeasurable" in excluded["reasons"][0]
    assert "registry timeout" in excluded["reasons"][0] and candidates[1] not in build["seen"]


def test_build_taskset_candidates_capped_at_rows(build, tmp_path):
    # smoke-v1：候选只有 astropy 一条、n=1（作者 2026-11-26）；n×1.5 向上取整为 2，超过可选条数时取全部
    build["machine"] = "arm64"
    rows = [r for r in make_rows() if r["repo"] == "org/one"]
    out = tmp_path / "s.json"
    build_taskset("smoke", 1, rows, 1, 1, tmp_path / "bundle", out)
    doc = json.loads(out.read_text())
    assert doc["selection"]["candidates"] == doc["instance_ids"] == ["one__x-0"]


def test_build_taskset_too_few_passed_writes_nothing(build, tmp_path):
    rows = make_rows()
    build["failing"] = set(stratified_sample(rows, 12, seed=5)[:5])  # 只剩 7 个通过，不足 n=8
    out = tmp_path / "t.json"
    with pytest.raises(RuntimeError, match="7 of 12"):
        build_taskset("unit", 1, rows, 8, 5, tmp_path / "bundle", out)
    assert not out.exists()


def test_build_taskset_refuses_overwrite(build, tmp_path):
    out = tmp_path / "t.json"
    out.write_text("committed\n")
    with pytest.raises(FileExistsError):
        build_taskset("unit", 1, make_rows(), 8, 5, tmp_path / "bundle", out)
    assert out.read_text() == "committed\n"


# ---------- precheck ----------

INST = {"instance_id": "org__repo-1", "image": "img@sha256:arm", "patch": "diff --git a/f b/f\n",
        "FAIL_TO_PASS": ["t::a", "t::b"]}


@pytest.fixture
def fakes(monkeypatch, tmp_path):
    """替换预检用到的 docker 操作，按顺序记录调用。st 里改各检查的结果；grade_s 为每次评分的假耗时。"""
    calls = {"order": [], "cleanup": [], "probe": []}
    st = {"gold": ["resolved"], "empty": ["unresolved"], "empty_f2p_success": [], "image_reasons": [],
          "grade_s": 1.0, "checks_raise": 0, "report": None}
    clock = [0.0]

    def fake_grade(inst, patch, out_dir, run, timeout_s=1800):
        kind = "gold" if patch else "empty"
        calls["order"].append((kind, inst["image"], run, timeout_s))
        clock[0] += st["grade_s"]
        seq = st[kind]
        status = seq.pop(0) if len(seq) > 1 else seq[0]
        if status != "infra_error":
            out_dir.mkdir(parents=True, exist_ok=True)
            f2p = inst["FAIL_TO_PASS"]
            success = f2p if kind == "gold" else st["empty_f2p_success"]
            report = st["report"] or {inst["instance_id"]: {"tests_status": {
                "FAIL_TO_PASS": {"success": success, "failure": [t for t in f2p if t not in success]}}}}
            (out_dir / "report.json").write_text(json.dumps(report))
        return GradeResult(status, inst["image"], "sha256:x", "arm64")

    def fake_checks(inst, bundle, run, out):
        calls["order"].append(("checks", inst["image"], run, bundle))
        if st["checks_raise"]:
            st["checks_raise"] -= 1
            raise DockerError("docker run failed (125): daemon hiccup")
        return list(st["image_reasons"])

    def fake_probe(inst):
        calls["probe"].append((inst["image"], inst["run"]))
        return ["blob1"]

    monkeypatch.setattr(taskset, "grade", fake_grade)
    monkeypatch.setattr(taskset, "_image_checks", fake_checks)
    monkeypatch.setattr(taskset, "gold_probe_blobs", fake_probe)
    monkeypatch.setattr(taskset, "cleanup_run", calls["cleanup"].append)
    monkeypatch.setattr(taskset.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(taskset, "RUNS", tmp_path / "runs")
    return calls, st


def kinds(calls):
    return [c[0] for c in calls["order"]]


def test_precheck_all_pass(fakes):
    calls, _ = fakes
    r = taskset.precheck(INST, "/bundle")
    assert r == PrecheckResult(True, [], ["blob1"])
    run = calls["order"][0][2]
    # 先做便宜的镜像检查，再跑两次评分（作者 2026-11-26）
    assert [c[:3] for c in calls["order"]] == [("checks", "img@sha256:arm", run), ("gold", "img@sha256:arm", run),
                                              ("empty", "img@sha256:arm", run)]
    assert calls["order"][0][3] == "/bundle"
    assert calls["probe"] == [("img@sha256:arm", run)]
    assert calls["cleanup"] == [run]


def test_precheck_image_checks_fail_early(fakes):
    # 工作区不干净、BaseMismatch、node 失败都是镜像的确定性性质：记原因、排除，不跑评分、不重试
    calls, st = fakes
    st["image_reasons"] = ["worktree dirty", "node failed"]
    r = taskset.precheck(INST, "/bundle")
    assert r == PrecheckResult(False, ["worktree dirty", "node failed"], [])
    assert kinds(calls) == ["checks"] and calls["probe"] == []


def test_precheck_lists_each_grading_failure(fakes):
    calls, st = fakes
    st["gold"], st["empty"] = ["unresolved"], ["resolved"]
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok
    assert len(r.reasons) == 2
    assert "gold" in r.reasons[0] and "unresolved" in r.reasons[0]
    assert "empty" in r.reasons[1] and "resolved" in r.reasons[1]
    assert r.probe_blobs == [] and calls["probe"] == []
    assert kinds(calls) == ["checks", "gold", "empty"]  # 检查不通过不是 infra_error，不重试


def test_precheck_empty_patch_must_fail_every_f2p(fakes):
    # 入选标准 (2)：空补丁整体 unresolved 还不够，FAIL_TO_PASS 有一条通过就不入选
    _, st = fakes
    st["empty_f2p_success"] = ["t::b"]
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok and len(r.reasons) == 1 and "t::b" in r.reasons[0]


def test_precheck_report_without_tests_status(fakes):
    # swebench 在日志里没有可解析的测试输出时，报告不带 tests_status：记原因、排除，不能抛 KeyError 中止整个定版
    _, st = fakes
    st["report"] = {INST["instance_id"]: {"resolved": False, "infra_failure": False}}
    st["gold"] = ["unresolved"]
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok and r.probe_blobs == []
    assert any("empty" in x and "no tests_status" in x for x in r.reasons)


def test_precheck_gold_wall_clock_limit(fakes):
    # 入选标准 (4)：冷烟集金标准评分墙钟超过上限即不通过（不算 infra_error，不重试）
    calls, st = fakes
    st["grade_s"] = 601
    r = taskset.precheck(INST, "/bundle", max_gold_s=600)
    assert not r.ok and len(r.reasons) == 1 and "600" in r.reasons[0]
    assert kinds(calls) == ["checks", "gold", "empty"]
    assert calls["order"][1][3] == 600  # 金标准评分的测试时限也设为上限
    st["grade_s"] = 599
    assert taskset.precheck(INST, "/bundle", max_gold_s=600).ok
    assert taskset.precheck(INST, "/bundle").ok  # 开发集不套用


@pytest.mark.parametrize("setup, ok, attempts", [
    ({"gold": ["infra_error", "infra_error", "resolved"]}, True, 3),  # 评分 infra_error 重试后恢复
    ({"checks_raise": 1}, True, 2),  # 镜像检查时 docker 出错（DockerError）重试后恢复
    ({"empty": ["infra_error"]}, False, 3),  # 首次 + 重试 2 次仍失败 → 无法测量
    ({"checks_raise": 3}, False, 3),
])
def test_precheck_infra_retries(fakes, setup, ok, attempts):
    calls, st = fakes
    st.update(setup)
    r = taskset.precheck(INST, "/bundle")
    assert r.ok == ok
    assert kinds(calls).count("checks") == attempts
    assert len(set(calls["cleanup"])) == 1 and len(calls["cleanup"]) == attempts  # 每次尝试后都清理
    if not ok:
        assert r.probe_blobs == [] and len(r.reasons) == 1
        assert "unmeasurable" in r.reasons[0] and "3 attempts" in r.reasons[0]


def test_precheck_cleans_up_on_error(fakes, monkeypatch):
    calls, _ = fakes

    def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(taskset, "grade", boom)
    with pytest.raises(RuntimeError):
        taskset.precheck(INST, "/bundle")
    assert len(calls["cleanup"]) == 1


# ---------- 镜像来源与镜像检查 ----------

def test_image_refs_fixed_source_per_platform(monkeypatch):
    seen = []

    class R:
        def __init__(self, ref):
            self.stdout = json.dumps({"mediaType": "x", "digest": f"sha256:{len(seen)}"})

    def fake_docker(*args, **kw):
        seen.append(args)
        return R(args)

    monkeypatch.setattr(taskset, "_docker", fake_docker)
    inst = {"instance_id": "psf__requests-2317", "image": "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest"}
    refs = taskset.image_refs(inst, ["linux-arm64", "linux-x64"])
    # Mac 统一用官方 arm64（不逐实例回退，作者 2026-11-26）；x86 用数据集名
    assert refs == {"linux-arm64": "swebench/sweb.eval.arm64.psf_1776_requests-2317@sha256:1",
                    "linux-x64": "swebench/sweb.eval.x86_64.psf_1776_requests-2317@sha256:2"}
    assert [a[-3] for a in seen] == ["swebench/sweb.eval.arm64.psf_1776_requests-2317:latest",
                                     "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest"]
    seen.clear()
    assert taskset.image_refs(inst, ["linux-x64"]) == {"linux-x64": "swebench/sweb.eval.x86_64.psf_1776_requests-2317@sha256:1"}
    assert len(seen) == 1  # 开发集不解析 arm64


def test_local_platform(monkeypatch):
    for machine, want in (("arm64", "linux-arm64"), ("aarch64", "linux-arm64"), ("x86_64", "linux-x64"), ("AMD64", "linux-x64")):
        monkeypatch.setattr(taskset.platform, "machine", lambda m=machine: m)
        assert taskset.local_platform() == want


def test_image_checks(monkeypatch, tmp_path):
    # 一个挂运行包的任务容器里查：启动时工作区干净、base_commit 与镜像对得上（resolve_effective_base）、node --version
    from forgepilot_eval.repo_prep import BaseMismatch, DirtyWorktree

    seen = {}

    class FakeSandbox:
        def __init__(self, run, image, bundle, out_dir):
            seen["sandbox"] = (run, image, bundle, out_dir)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            seen["exited"] = True

        def exec(self, cmd, timeout_s):
            return seen["node"]

    def fake_base(sb, repo, base_commit):
        seen["base"] = (repo, base_commit)
        if seen.get("raise"):
            raise seen["raise"]
        return "head"

    monkeypatch.setattr(taskset, "Sandbox", FakeSandbox)
    monkeypatch.setattr(taskset, "ensure_network", lambda run: seen.setdefault("net", run))
    monkeypatch.setattr(taskset, "resolve_effective_base", fake_base)
    inst = {"image": "img@sha256:a", "base_commit": "abc"}

    seen["node"] = (0, "v24.15.0\n")
    assert taskset._image_checks(inst, "/bundle", "r1", tmp_path) == []
    assert seen["sandbox"] == ("r1", "img@sha256:a", "/bundle", tmp_path) and seen["net"] == "r1"
    assert seen["base"] == ("/testbed", "abc") and seen["exited"]

    seen["raise"], seen["node"] = DirtyWorktree("worktree has uncommitted changes: M pyproject.toml"), (127, "no such file")
    reasons = taskset._image_checks(inst, "/bundle", "r1", tmp_path)
    assert len(reasons) == 2 and "pyproject.toml" in reasons[0] and "127" in reasons[1]

    # 预检里 BaseMismatch 直接排除并注明原因（作者 2026-11-26；Task 12 正式运行仍按 infra_error）
    seen["raise"], seen["node"] = BaseMismatch("base_commit abc is not HEAD or its ancestor"), (0, "v24.15.0\n")
    assert taskset._image_checks(inst, "/bundle", "r1", tmp_path) == ["base_commit abc is not HEAD or its ancestor"]
