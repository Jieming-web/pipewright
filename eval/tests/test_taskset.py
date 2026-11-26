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

def fake_refs(inst):
    iid = inst["instance_id"]
    return {"linux-arm64": f"ghcr.io/epoch-research/swe-bench.eval.arm64.{iid}@sha256:a-{iid}",
            "linux-x64": f"{inst['image'].rsplit(':', 1)[0]}@sha256:x-{iid}"}


@pytest.fixture
def build(monkeypatch, tmp_path):
    """build_taskset 的假环境：本机为 arm64，镜像解析与预检都是假的；failing 里的候选预检不通过。"""
    state = {"failing": set(), "seen": [], "max_gold_s": set()}

    def fake_precheck(inst, bundle, max_gold_s=None):
        state["seen"].append(inst["instance_id"])
        state["max_gold_s"].add(max_gold_s)
        assert bundle == tmp_path / "bundle"
        assert inst["image"] == fake_refs(inst)["linux-arm64"]  # 传入按本机平台选好的 name@digest
        if inst["instance_id"] in state["failing"]:
            return PrecheckResult(False, ["gold patch: expected resolved, got unresolved"], [])
        return PrecheckResult(True, [], [f"blob-{inst['instance_id']}"])

    monkeypatch.setattr(taskset.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(taskset, "image_refs", fake_refs)
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
    assert doc["images"] == {i: fake_refs(by_id[i]) for i in doc["instance_ids"]}  # 两个平台的 name@digest
    assert taskset_sha256(out) == taskset_sha256(out) and len(taskset_sha256(out)) == 64


def test_build_smoke_taskset_limits_gold_time(build, tmp_path):
    build_taskset("smoke", 1, make_rows(), 3, 1, tmp_path / "bundle", tmp_path / "s.json")
    assert build["max_gold_s"] == {600}


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
    """替换预检用到的 docker 操作，记录调用。st 里改各检查的结果；grade_s 为每次评分的假耗时。"""
    calls = {"grade": [], "cleanup": [], "node": [], "probe": [], "pull": []}
    st = {"gold": ["resolved"], "empty": ["unresolved"], "empty_f2p_success": [], "node": (0, "v24.15.0\n"),
          "grade_s": 1.0, "node_raises": 0}
    clock = [0.0]

    def fake_grade(inst, patch, out_dir, run, timeout_s=1800):
        kind = "gold" if patch else "empty"
        calls["grade"].append((inst["image"], kind, run, timeout_s))
        clock[0] += st["grade_s"]
        seq = st[kind]
        status = seq.pop(0) if len(seq) > 1 else seq[0]
        if status != "infra_error":
            out_dir.mkdir(parents=True, exist_ok=True)
            f2p = inst["FAIL_TO_PASS"]
            success = f2p if kind == "gold" else st["empty_f2p_success"]
            (out_dir / "report.json").write_text(json.dumps({inst["instance_id"]: {"tests_status": {
                "FAIL_TO_PASS": {"success": success, "failure": [t for t in f2p if t not in success]}}}}))
        return GradeResult(status, inst["image"], "sha256:x", "arm64")

    def fake_node(image, bundle, run):
        calls["node"].append((image, bundle, run))
        if st["node_raises"]:
            st["node_raises"] -= 1
            raise DockerError("docker run failed (125): daemon hiccup")
        return st["node"]

    def fake_probe(inst):
        calls["probe"].append((inst["image"], inst["run"]))
        return ["blob1"]

    monkeypatch.setattr(taskset, "grade", fake_grade)
    monkeypatch.setattr(taskset, "_node_version", fake_node)
    monkeypatch.setattr(taskset, "_ensure_image", lambda image: calls["pull"].append(image))
    monkeypatch.setattr(taskset, "gold_probe_blobs", fake_probe)
    monkeypatch.setattr(taskset, "cleanup_run", calls["cleanup"].append)
    monkeypatch.setattr(taskset.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(taskset, "RUNS", tmp_path / "runs")
    return calls, st


def test_precheck_all_pass(fakes):
    calls, _ = fakes
    r = taskset.precheck(INST, "/bundle")
    assert r == PrecheckResult(True, [], ["blob1"])
    run = calls["grade"][0][2]
    assert [g[:3] for g in calls["grade"]] == [("img@sha256:arm", "gold", run), ("img@sha256:arm", "empty", run)]
    assert calls["node"] == [("img@sha256:arm", "/bundle", run)]
    assert calls["probe"] == [("img@sha256:arm", run)]
    assert calls["cleanup"] == [run]
    assert calls["pull"] == ["img@sha256:arm"]


def test_precheck_lists_each_failure(fakes):
    calls, st = fakes
    st["gold"], st["empty"] = ["unresolved"], ["resolved"]
    st["node"] = (127, "exec: no such file\n")
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok
    assert len(r.reasons) == 3
    assert "gold" in r.reasons[0] and "unresolved" in r.reasons[0]
    assert "empty" in r.reasons[1] and "resolved" in r.reasons[1]
    assert "node" in r.reasons[2] and "127" in r.reasons[2]
    assert r.probe_blobs == [] and calls["probe"] == []
    assert len(calls["grade"]) == 2  # 检查不通过不是 infra_error，不重试


def test_precheck_empty_patch_must_fail_every_f2p(fakes):
    # 入选标准 (2)：空补丁整体 unresolved 还不够，FAIL_TO_PASS 有一条通过就不入选
    _, st = fakes
    st["empty_f2p_success"] = ["t::b"]
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok and len(r.reasons) == 1 and "t::b" in r.reasons[0]


def test_precheck_gold_wall_clock_limit(fakes):
    # 入选标准 (4)：冷烟集金标准评分墙钟超过上限即不通过（不算 infra_error，不重试）
    calls, st = fakes
    st["grade_s"] = 601
    r = taskset.precheck(INST, "/bundle", max_gold_s=600)
    assert not r.ok and len(r.reasons) == 1 and "600" in r.reasons[0]
    assert len(calls["grade"]) == 2
    assert calls["grade"][0][3] == 600  # 金标准评分的测试时限也设为上限
    st["grade_s"] = 599
    assert taskset.precheck(INST, "/bundle", max_gold_s=600).ok
    assert taskset.precheck(INST, "/bundle").ok  # 开发集不套用


def test_precheck_retries_infra_error(fakes):
    calls, st = fakes
    st["gold"] = ["infra_error", "infra_error", "resolved"]
    r = taskset.precheck(INST, "/bundle")
    assert r.ok
    assert [g[1] for g in calls["grade"]] == ["gold", "gold", "gold", "empty"]


def test_precheck_retries_docker_error(fakes):
    calls, st = fakes
    st["node_raises"] = 1
    assert taskset.precheck(INST, "/bundle").ok
    assert len(calls["node"]) == 2


def test_precheck_unmeasurable_after_two_retries(fakes):
    calls, st = fakes
    st["empty"] = ["infra_error"]
    r = taskset.precheck(INST, "/bundle")
    assert not r.ok and r.probe_blobs == []
    assert len(r.reasons) == 1 and "unmeasurable" in r.reasons[0] and "3 attempts" in r.reasons[0]
    assert [g[1] for g in calls["grade"]].count("empty") == 3  # 首次 + 重试 2 次
    assert len(set(calls["cleanup"])) == 1


def test_precheck_cleans_up_on_error(fakes, monkeypatch):
    calls, _ = fakes

    def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(taskset, "grade", boom)
    with pytest.raises(RuntimeError):
        taskset.precheck(INST, "/bundle")
    assert len(calls["cleanup"]) == 1


# ---------- 镜像来源 ----------

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
    refs = taskset.image_refs(inst)
    # Mac 统一用 Epoch（不先试官方 arm64、不逐实例回退）；x86 用数据集名
    assert refs == {"linux-arm64": "ghcr.io/epoch-research/swe-bench.eval.arm64.psf__requests-2317@sha256:1",
                    "linux-x64": "swebench/sweb.eval.x86_64.psf_1776_requests-2317@sha256:2"}
    assert [a[-3] for a in seen] == ["ghcr.io/epoch-research/swe-bench.eval.arm64.psf__requests-2317:latest",
                                     "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest"]


def test_local_platform(monkeypatch):
    for machine, want in (("arm64", "linux-arm64"), ("aarch64", "linux-arm64"), ("x86_64", "linux-x64"), ("AMD64", "linux-x64")):
        monkeypatch.setattr(taskset.platform, "machine", lambda m=machine: m)
        assert taskset.local_platform() == want


def test_node_version_docker_failure_is_infra(monkeypatch):
    class R:
        def __init__(self, code, out="", err=""):
            self.returncode, self.stdout, self.stderr = code, out, err

    results = iter([R(125, err="pull access denied"), R(127, err="no such file")])
    monkeypatch.setattr(taskset, "_docker", lambda *a, **k: next(results))
    with pytest.raises(DockerError, match="125"):  # docker 自身出错 → 由 precheck 按 infra_error 重试
        taskset._node_version("img", "/bundle", "r")
    assert taskset._node_version("img", "/bundle", "r") == (127, "no such file")  # 运行包问题 → 检查不通过


def test_ensure_image_pulls_only_when_missing(monkeypatch):
    seen = []

    class R:
        def __init__(self, code):
            self.returncode = code

    monkeypatch.setattr(taskset, "_docker", lambda *a, **k: seen.append(a[:2]) or R(0 if a[0] == "pull" else len(seen) - 1))
    taskset._ensure_image("img@sha256:a")  # 第一次 inspect 返回 0：已有，不拉
    taskset._ensure_image("img@sha256:a")  # 第二次 inspect 非 0：拉取
    assert seen == [("image", "inspect"), ("image", "inspect"), ("pull", "img@sha256:a")]
