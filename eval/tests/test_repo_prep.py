"""T2-9：有效基准、仓库历史截断与自检（计划 Task 9，验收 8，Review Focus 3）。

有效基准 = 容器启动时 /testbed 的 HEAD：swebench 镜像是 base_commit 之上的额外提交 `SWE-bench`，
Epoch 镜像就是 base_commit（实现说明 0.8a）。截断、自检、取补丁都以有效基准为准。
镜像按平台变更 P1 用 x86_64；base_commit 取自 SWE-bench_Verified（2026-11-25 经 datasets-server 核对）。
"""

import subprocess
import uuid
from pathlib import Path

import pytest

from conftest import REQUESTS_IMAGE
from forgepilot_eval.repo_prep import (
    BaseMismatch,
    DirtyWorktree,
    HistoryLeak,
    extract_patch,
    gold_probe_blobs,
    resolve_effective_base,
    truncate_history,
    verify_truncated,
)
from forgepilot_eval.sandbox import Sandbox, cleanup_run, ensure_network

pytestmark = pytest.mark.docker

SCM_IMAGE = "buildpack-deps:jammy-scm"
REQUESTS_BASE = "091991be0da19de9108dbe5e3752917fea3d7fdc"
DJANGO_IMAGE = "ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest"
DJANGO_BASE = "d26b2424437dabeeca94d7900b37d2df4410da0c"
TESTBED = "/testbed"
SYN = "/repo"

# 合成仓库：base → 环境提交 SWE-bench（HEAD，模拟 swebench 镜像）→ 未来分支上的 fix；
# fix 由分支、轻量标签、附注标签、远程引用、refs/original 指向，另有 notes 与 stash，HEAD 的 reflog 也经过 fix。
SYNTH_SETUP = r"""
set -e
git config --global user.email fp@test.invalid
git config --global user.name fp
git config --global init.defaultBranch main
git init -q /repo && cd /repo
printf 'one\n' > a.txt; printf 'keep\n' > b.txt; printf 'build/\n' > .gitignore
git add -A; git commit -qm base; echo "BASE=$(git rev-parse HEAD)"
printf 'env\n' > env.txt; git add -A; git commit -qm SWE-bench; echo "ENV=$(git rev-parse HEAD)"
git checkout -qb future
printf 'fixed\n' > a.txt; printf 'secret fix\n' > fix_new.txt; : > fix_empty.txt; git rm -q b.txt
git add -A; git commit -qm fix  # 改、新建、新建空文件、删除各一
FIX=$(git rev-parse HEAD); echo "FIX=$FIX"
echo "FIX_NEW_BLOB=$(git rev-parse HEAD:fix_new.txt)"; echo "FIX_A_BLOB=$(git rev-parse HEAD:a.txt)"
git tag v-fix; git tag -a -m annotated v-fix-annotated
git checkout -q main
git remote add origin https://example.invalid/repo.git
git update-ref refs/remotes/origin/main "$FIX"
git update-ref refs/original/refs/heads/main "$FIX"
git notes add -m 'note about fix' "$FIX"
printf 'wip\n' >> b.txt; git stash -q
git pack-refs --all
test -z "$(git status --porcelain)"
"""


def sh(*cmd, check=False, **kw):
    return subprocess.run(list(cmd), capture_output=True, text=True, check=check, **kw)


@pytest.fixture(scope="module")
def run(docker):
    name = f"t9-{uuid.uuid4().hex[:8]}"
    ensure_network(name)
    yield name
    cleanup_run(name)


@pytest.fixture(scope="module")
def synth(run):
    """合成仓库做成临时镜像，每个用例从它新起容器；返回 (镜像名, 各提交与 blob 的 hash)。"""
    if sh("docker", "image", "inspect", SCM_IMAGE).returncode != 0:
        sh("docker", "pull", "-q", SCM_IMAGE, check=True, timeout=1800)
    cname = f"fp-t9-synth-{run}"
    r = sh("docker", "run", "--name", cname, "--label", f"fp-run={run}", "--network", "none",
           SCM_IMAGE, "bash", "-c", SYNTH_SETUP, timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr
    ids = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    image = f"fp-t9-synth:{run}"
    sh("docker", "commit", cname, image, check=True)
    sh("docker", "rm", "-f", cname)
    yield image, ids
    sh("docker", "rmi", "-f", image)


@pytest.fixture
def new_sandbox(run, bundle, tmp_path):
    opened: list[Sandbox] = []

    def make(image: str) -> Sandbox:
        sb = Sandbox(run, image, bundle, tmp_path).__enter__()
        opened.append(sb)
        return sb

    yield make
    for sb in opened:
        sb.kill()


def git(sb: Sandbox, repo: str, args: str, timeout_s: float = 300) -> str:
    code, out = sb.exec(f"git -C {repo} {args}", timeout_s=timeout_s)
    assert code == 0, out
    return out.strip()


def patch_files(patch: str) -> list[str]:
    return sorted(line.split(" b/", 1)[1] for line in patch.splitlines() if line.startswith("diff --git "))


def apply_check_in_fresh(new_sandbox, image: str, repo: str, patch: str, tmp_path: Path) -> None:
    (tmp_path / "patch.diff").write_text(patch, errors="surrogateescape")
    fresh = new_sandbox(image)
    code, out = fresh.exec(f"git -C {repo} apply --check /fp-out/patch.diff", timeout_s=120)
    assert code == 0, out


# ---------- 合成仓库 ----------

def test_synth_effective_base_is_head_env_commit(synth, new_sandbox):
    image, ids = synth
    sb = new_sandbox(image)
    assert resolve_effective_base(sb, SYN, ids["BASE"]) == ids["ENV"]
    assert resolve_effective_base(sb, SYN, ids["ENV"]) == ids["ENV"]  # base_commit 就是 HEAD（Epoch 情形）


def test_synth_base_mismatch(synth, new_sandbox):
    image, ids = synth
    sb = new_sandbox(image)
    with pytest.raises(BaseMismatch):
        resolve_effective_base(sb, SYN, ids["FIX"])  # HEAD 的后代，不是祖先
    with pytest.raises(BaseMismatch):
        resolve_effective_base(sb, SYN, "0" * 40)  # 库里没有


def test_synth_dirty_worktree_rejected(synth, new_sandbox):
    # 容器启动时工作区有未提交改动（如 Epoch astropy 的 pyproject.toml）就报错，否则会混进 agent 补丁（作者 2026-11-26）
    image, ids = synth
    sb = new_sandbox(image)
    assert git(sb, SYN, "status --porcelain") == ""  # 起始干净，DirtyWorktree 只能来自下面这处改动
    code, out = sb.exec(f"printf 'env tweak\\n' >> {SYN}/env.txt", timeout_s=30)
    assert code == 0, out
    with pytest.raises(DirtyWorktree, match="env.txt"):
        resolve_effective_base(sb, SYN, ids["BASE"])


def test_synth_verify_before_truncate_reports_leaks(synth, new_sandbox):
    image, ids = synth
    sb = new_sandbox(image)
    issues = verify_truncated(sb, SYN, ids["ENV"], [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])
    text = "\n".join(issues)
    for ref in ["refs/heads/main", "refs/heads/future", "refs/tags/v-fix", "refs/tags/v-fix-annotated",
                "refs/remotes/origin/main", "refs/original/refs/heads/main", "refs/notes/commits", "refs/stash"]:
        assert ref in text, ref
    assert ids["FIX"] in text  # 基准之后的提交
    assert ids["FIX_NEW_BLOB"] in text and ids["FIX_A_BLOB"] in text  # 探针 blob


def test_synth_truncate_removes_future_keeps_env(synth, new_sandbox):
    image, ids = synth
    sb = new_sandbox(image)
    probes = [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]]
    before = git(sb, SYN, "ls-files -s")
    truncate_history(sb, SYN, ids["ENV"], probes)
    assert verify_truncated(sb, SYN, ids["ENV"], probes) == []
    assert set(git(sb, SYN, "log --all --format=%H").split()) == {ids["ENV"], ids["BASE"]}
    assert git(sb, SYN, "rev-parse HEAD") == ids["ENV"]
    assert git(sb, SYN, "symbolic-ref HEAD") == "refs/heads/fp-base"
    assert git(sb, SYN, "for-each-ref --format='%(refname)'") == "refs/heads/fp-base"
    assert git(sb, SYN, "remote") == ""
    assert git(sb, SYN, "reflog show --all") == ""
    assert git(sb, SYN, "ls-files -s") == before and git(sb, SYN, "status --porcelain") == ""
    code, _ = sb.exec(f"git -C {SYN} cat-file -e {ids['FIX']}", timeout_s=30)
    assert code != 0


def test_synth_fsck_catches_unreachable(synth, new_sandbox):
    """只删引用、不 gc：引用与可达性都干净，只有 fsck 能报出残留的未来对象。"""
    image, ids = synth
    sb = new_sandbox(image)
    git(sb, SYN, f"checkout -q -B fp-base {ids['ENV']}")
    git(sb, SYN, "remote remove origin")
    git(sb, SYN, "for-each-ref --format='delete %(refname)' | grep -v ' refs/heads/fp-base$' "
                 f"| git -C {SYN} update-ref --stdin")
    git(sb, SYN, "reflog expire --expire=now --expire-unreachable=now --all")
    issues = verify_truncated(sb, SYN, ids["ENV"], [])
    assert issues and all("unreachable" in i for i in issues), issues


def test_synth_broken_ref_reported_and_removed(synth, new_sandbox):
    """for-each-ref 看不到的坏引用（requests x86 镜像里的 refs/remotes/origin/HEAD 指向全零）：自检报出，截断删掉。"""
    image, ids = synth
    sb = new_sandbox(image)
    code, out = sb.exec(f"mkdir -p {SYN}/.git/refs/remotes/origin && printf '%040d\\n' 0 > {SYN}/.git/refs/remotes/origin/HEAD",
                        timeout_s=30)
    assert code == 0, out
    assert any("refs/remotes/origin/HEAD" in i for i in verify_truncated(sb, SYN, ids["ENV"], []))
    truncate_history(sb, SYN, ids["ENV"], [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])
    assert verify_truncated(sb, SYN, ids["ENV"], []) == []
    code, _ = sb.exec(f"test -e {SYN}/.git/refs/remotes/origin/HEAD", timeout_s=30)
    assert code != 0


def test_synth_symref_with_remote_config_removed(synth, new_sandbox):
    """残留符号引用 refs/remotes/origin/HEAD -> origin/main，而 remote 配置已删（remote remove 帮不上）：
    update-ref 不跟随符号引用，截断照常成功。"""
    image, ids = synth
    sb = new_sandbox(image)
    git(sb, SYN, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main")
    git(sb, SYN, "config --remove-section remote.origin")
    truncate_history(sb, SYN, ids["ENV"], [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])
    assert git(sb, SYN, "for-each-ref --format='%(refname)'") == "refs/heads/fp-base"


def test_synth_pseudo_refs_removed(synth, new_sandbox):
    """ORIG_HEAD、FETCH_HEAD 等伪引用指向基准之后的提交：截断后 .git 里（对象库之外）找不到这个提交的 hash。"""
    image, ids = synth
    sb = new_sandbox(image)
    pseudo = ["ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
    code, out = sb.exec(f"cd {SYN} && " + " && ".join(f"echo {ids['FIX']} > .git/{p}" for p in pseudo), timeout_s=30)
    assert code == 0, out
    truncate_history(sb, SYN, ids["ENV"], [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])
    code, out = sb.exec(f"grep -rlF {ids['FIX']} {SYN}/.git --exclude-dir=objects", timeout_s=30)
    assert code == 1 and out == "", out


def test_truncate_history_probe_blobs_required():
    """probe_blobs 必填（计划 Task 9）：漏传时直接 TypeError，不会静默跳过探针检查。"""
    with pytest.raises(TypeError):
        truncate_history(None, SYN, "0" * 40)


def test_synth_truncate_raises_history_leak(synth, new_sandbox):
    """截断后的自检不通过（这里用一个截断后仍存在的 blob 作探针）就抛 HistoryLeak。"""
    image, ids = synth
    sb = new_sandbox(image)
    keep = git(sb, SYN, "rev-parse HEAD:env.txt")
    with pytest.raises(HistoryLeak) as e:
        truncate_history(sb, SYN, ids["ENV"], [keep])
    assert keep in str(e.value)


def test_synth_extract_patch_new_binary_deleted_ignored(synth, new_sandbox, tmp_path):
    image, ids = synth
    sb = new_sandbox(image)
    truncate_history(sb, SYN, ids["ENV"], [ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])
    code, out = sb.exec(
        f"cd {SYN} && printf 'changed\\n' > a.txt && printf 'new\\n' > new.txt && rm b.txt"
        " && printf '\\x00\\x01\\xff' > bin.dat && mkdir -p build && echo o > build/out.o", timeout_s=30)
    assert code == 0, out
    patch = extract_patch(sb, SYN, ids["ENV"])
    assert patch_files(patch) == ["a.txt", "b.txt", "bin.dat", "new.txt"]  # 被 .gitignore 忽略的 build/ 不进补丁
    assert "GIT binary patch" in patch
    apply_check_in_fresh(new_sandbox, image, SYN, patch, tmp_path)


def test_synth_gold_probe_blobs(synth, new_sandbox):
    image, ids = synth
    sb = new_sandbox(image)
    gold = git(sb, SYN, f"diff --binary {ids['ENV']} {ids['FIX']}") + "\n"
    blobs = gold_probe_blobs({"image": image, "patch": gold, "repo_path": SYN})
    assert sorted(blobs) == sorted([ids["FIX_NEW_BLOB"], ids["FIX_A_BLOB"]])


# ---------- swebench 镜像：HEAD 是 base_commit 之上的 SWE-bench 提交 ----------

def test_swebench_image(new_sandbox, tmp_path):
    sb = new_sandbox(REQUESTS_IMAGE)
    eff = resolve_effective_base(sb, TESTBED, REQUESTS_BASE)
    assert eff != REQUESTS_BASE
    assert git(sb, TESTBED, "rev-parse HEAD^") == REQUESTS_BASE
    assert int(git(sb, TESTBED, "tag | wc -l")) > 0  # 截断前确有标签
    truncate_history(sb, TESTBED, eff, [])
    assert verify_truncated(sb, TESTBED, eff, []) == []  # 不把 SWE-bench 提交误报为泄露
    assert git(sb, TESTBED, "log -1 --format=%s") == "SWE-bench"
    assert git(sb, TESTBED, "rev-parse HEAD") == eff
    assert git(sb, TESTBED, "tag") == ""
    assert git(sb, TESTBED, "rev-list --count --all") == git(sb, TESTBED, "rev-list --count HEAD")
    code, out = sb.exec(f"echo '# fp probe' >> {TESTBED}/requests/__init__.py", timeout_s=30)
    assert code == 0, out
    patch = extract_patch(sb, TESTBED, eff)
    assert patch_files(patch) == ["requests/__init__.py"]
    apply_check_in_fresh(new_sandbox, REQUESTS_IMAGE, TESTBED, patch, tmp_path)


# ---------- Epoch 镜像：HEAD 就是 base_commit ----------

def test_epoch_image(new_sandbox, tmp_path):
    sb = new_sandbox(DJANGO_IMAGE)
    eff = resolve_effective_base(sb, TESTBED, DJANGO_BASE)
    assert eff == DJANGO_BASE
    truncate_history(sb, TESTBED, eff, [])
    assert verify_truncated(sb, TESTBED, eff, []) == []
    assert git(sb, TESTBED, "tag") == ""
    code, out = sb.exec(f"echo '# fp probe' >> {TESTBED}/django/__init__.py", timeout_s=30)
    assert code == 0, out
    patch = extract_patch(sb, TESTBED, eff)
    assert patch_files(patch) == ["django/__init__.py"]
    apply_check_in_fresh(new_sandbox, DJANGO_IMAGE, TESTBED, patch, tmp_path)


def test_gold_probe_blobs_uses_testbed_for_dataset_rows(monkeypatch):
    # 数据集行的 repo 是 GitHub 名（如 astropy/astropy），不是容器里的仓库路径；T2-11 真实预检时 cd 失败
    from forgepilot_eval import repo_prep

    seen = []

    def fake_run(argv, **kw):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(repo_prep.subprocess, "run", fake_run)
    gold_probe_blobs({"image": "img", "patch": "p", "repo": "astropy/astropy"})
    assert seen[0][-1] == "/testbed"

