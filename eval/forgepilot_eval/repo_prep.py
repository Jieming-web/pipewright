"""有效基准、仓库历史截断与自检、取补丁（T2 计划 Task 9，验收 8，Review Focus 2、3）。

有效基准（作者 2026-11-25 决定）= 容器启动时仓库的 HEAD：swebench 镜像的 HEAD 是 base_commit 之上的
额外提交 `SWE-bench`（环境设置），Epoch 镜像的 HEAD 就是 base_commit（实现说明 0.8a）。评分也在这个 HEAD 上
打补丁，所以截断、自检、取补丁、金标准 blob 都以有效基准为准，不用数据集的 base_commit。
"""

from __future__ import annotations

import base64
import shlex
import subprocess
import uuid

from .sandbox import LABEL, DockerError, Sandbox

KEEP_REF = "refs/heads/fp-base"
EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
GIT_TIMEOUT_S = 900  # 大仓库（django 约 5 万提交）gc 需要时间


class BaseMismatch(RuntimeError):
    """base_commit 既不是 HEAD 也不是它的祖先；这次运行记为 infra_error。"""


class DirtyWorktree(RuntimeError):
    """容器启动时工作区有未提交改动：它们会混进 agent 补丁，预检排除这类实例（作者 2026-11-26）。"""


class HistoryLeak(RuntimeError):
    """截断后自检不通过；不运行这个任务，记为 infra_error。"""

    def __init__(self, issues: list[str]):
        super().__init__("history truncation check failed:\n" + "\n".join(issues))
        self.issues = issues


def _git(sb: Sandbox, repo: str, args: str, timeout_s: float = GIT_TIMEOUT_S) -> tuple[int, str]:
    return sb.exec(f"git -C {shlex.quote(repo)} {args}", timeout_s=timeout_s)


def _git_ok(sb: Sandbox, repo: str, args: str, timeout_s: float = GIT_TIMEOUT_S) -> str:
    code, out = _git(sb, repo, args, timeout_s)
    if code != 0:
        raise RuntimeError(f"git {args} failed ({code}): {out.strip()[-2000:]}")
    return out


def resolve_effective_base(sb: Sandbox, repo: str, base_commit: str) -> str:
    """返回 HEAD；工作区有未提交改动（含未跟踪文件）时抛 DirtyWorktree；base_commit 不是 HEAD 或其祖先
    （含库里没有这个提交）时抛 BaseMismatch。"""
    dirty = _git_ok(sb, repo, "status --porcelain", 300).strip()
    if dirty:
        raise DirtyWorktree(f"worktree at {repo} has uncommitted changes at container start: {dirty[:1000]}")
    head = _git_ok(sb, repo, "rev-parse --verify 'HEAD^{commit}'", 60).strip()
    code, out = _git(sb, repo, f"merge-base --is-ancestor {shlex.quote(base_commit)} HEAD", 300)
    if code != 0:
        raise BaseMismatch(f"base_commit {base_commit} is not HEAD ({head}) or its ancestor: {out.strip()}")
    return head


def truncate_history(sb: Sandbox, repo: str, eff_base: str, probe_blobs: list[str]) -> None:
    """只留 fp-base 分支（指向有效基准）及其历史，删掉其余引用与不可达对象，然后自检，不通过抛 HistoryLeak。

    probe_blobs 必填：任务集里的金标准 blob，截断后一并自检（T2-9 偏差，作者 2026-11-25 确认）。
    """
    q = shlex.quote(repo)
    base = shlex.quote(eff_base)
    script = f"""
set -eo pipefail
cd {q}
git checkout -q -B fp-base {base}
for r in $(git remote); do git remote remove "$r"; done
git for-each-ref --format='delete %(refname)' | {{ grep -v ' {KEEP_REF}$' || true; }} | git update-ref --no-deref --stdin
# for-each-ref 看不到的坏引用（requests x86 镜像里有指向全零的 refs/remotes/origin/HEAD）直接删文件
find .git/refs -mindepth 1 \\( -type f -o -type l \\) ! -path .git/{KEEP_REF} -delete
find .git/refs -mindepth 2 -type d -empty -delete
if [ -f .git/packed-refs ]; then
  awk '/^#/ || $2 == "{KEEP_REF}"' .git/packed-refs > .git/packed-refs.fp && mv .git/packed-refs.fp .git/packed-refs
fi
test "$(git rev-parse --verify {KEEP_REF})" = {base}
rm -f .git/ORIG_HEAD .git/FETCH_HEAD .git/MERGE_HEAD .git/CHERRY_PICK_HEAD .git/REVERT_HEAD
git reflog expire --expire=now --expire-unreachable=now --all
git gc --prune=now --quiet
"""
    code, out = sb.exec(script, timeout_s=GIT_TIMEOUT_S)
    if code != 0:
        raise HistoryLeak([f"truncation failed ({code}): {out.strip()[-2000:]}"])
    issues = verify_truncated(sb, repo, eff_base, probe_blobs)
    if issues:
        raise HistoryLeak(issues)


def verify_truncated(sb: Sandbox, repo: str, eff_base: str, probe_blobs: list[str]) -> list[str]:
    """返回所有仍存在的问题，空列表表示通过。"""
    issues: list[str] = []
    base = shlex.quote(eff_base)

    code, out = _git(sb, repo, f"rev-list --all --not {base}")
    if code != 0:
        issues.append(f"rev-list failed ({code}): {out.strip()[-500:]}")
    else:
        issues += [f"commit not in effective base history: {c}" for c in out.split()]

    # stderr 不参与解析（坏引用的 warning 由 rev-list 与 fsck 报出）
    code, out = _git(sb, repo, "for-each-ref --format='%(refname)' 2>/dev/null", 120)
    if code != 0:
        issues.append(f"for-each-ref failed ({code}): {out.strip()[-500:]}")
    else:
        issues += [f"extra ref: {r}" for r in out.split() if r != KEEP_REF]

    # --connectivity-only：不检查对象内容格式。requests 镜像的历史里有 badTimezone 的老提交，完整 fsck 会以 6 退出，
    # 那不是泄露；连通性检查仍会列出不可达对象，缺对象等连通性错误仍以非零退出。
    code, out = _git(sb, repo, "fsck --connectivity-only --unreachable --no-reflogs --no-progress")
    if code != 0:
        issues.append(f"fsck failed ({code}): {out.strip()[-500:]}")
    else:
        issues += [f"fsck: {line}" for line in out.splitlines() if line.strip()]

    for b in probe_blobs:
        code, _ = _git(sb, repo, f"cat-file -e {shlex.quote(b)}", 60)
        if code == 0:
            issues.append(f"probe blob present: {b}")
    return issues


def extract_patch(sb: Sandbox, repo: str, eff_base: str) -> str:
    """`git add -A` 后取 `git diff --cached --binary <有效基准>`（含新建与二进制文件；.gitignore 忽略的不进）。

    补丁经 base64 传出，避免 stderr 混入和非 UTF-8 内容被改写；非 UTF-8 字节以 surrogateescape 保留，
    写文件时用 `errors="surrogateescape"` 还原原始字节。
    """
    q = shlex.quote(repo)
    script = (f"set -o pipefail; cd {q} && git add -A 2>/tmp/fp-patch.err"
              f" && git diff --cached --binary --no-color --no-ext-diff {shlex.quote(eff_base)} 2>>/tmp/fp-patch.err"
              " | base64 -w0 || { echo; echo FP_PATCH_ERR; cat /tmp/fp-patch.err; exit 1; }")
    code, out = sb.exec(script, timeout_s=300)
    if code != 0:
        raise RuntimeError(f"extract_patch failed ({code}): {out.strip()[-2000:]}")
    return base64.b64decode(out.strip()).decode("utf-8", errors="surrogateescape")


_GOLD_SCRIPT = r"""
set -eo pipefail
cd "$1"
cat > /tmp/gold.patch
git apply /tmp/gold.patch 2>/dev/null || patch --batch --fuzz=5 -p1 -i /tmp/gold.patch >/dev/null
git add -A
git diff --cached --raw --no-abbrev HEAD | awk '$5 !~ /^D/ {print $4}' | sort -u > /tmp/new.txt
git rev-list --objects HEAD | cut -d' ' -f1 | sort -u > /tmp/base.txt
comm -23 /tmp/new.txt /tmp/base.txt
"""


def gold_probe_blobs(inst: dict) -> list[str]:
    """把金标准补丁打到有效基准（镜像启动时的 HEAD）上，返回补丁改动后每个文件的新 blob hash。

    inst 字段：`image`（实例镜像）、`patch`（金标准补丁文本）、`repo_path`（容器内仓库路径，默认 `/testbed`）、
    可选 `run`（容器的 fp-run 标签值，默认 `gold-probe`）。
    临时容器 `--network none`、用完即删。打补丁先 `git apply`，失败再 `patch --batch --fuzz=5 -p1`（同 swebench
    的回退思路）；都失败抛 DockerError。删除的文件没有新 blob；空 blob 和有效基准历史里已有的 blob 不算探针
    （它们截断后本来就该在，否则自检会误报）。只在预检时调用（Task 11），结果存进任务集。
    """
    repo = inst.get("repo_path", "/testbed")  # 不用 repo：数据集行的 repo 是 GitHub 名
    name = f"fp-gold-{uuid.uuid4().hex[:8]}"
    r = subprocess.run(
        ["docker", "run", "--rm", "-i", "--name", name, "--label", f"{LABEL}={inst.get('run', 'gold-probe')}",
         "--network", "none", inst["image"], "bash", "-c", _GOLD_SCRIPT, "gold", repo],
        input=inst["patch"].encode("utf-8", errors="surrogateescape"), capture_output=True, timeout=1800,
    )
    if r.returncode != 0:
        raise DockerError(f"gold patch probe failed ({r.returncode}): {r.stderr.decode(errors='replace').strip()[-2000:]}")
    return [b for b in r.stdout.decode().split() if b != EMPTY_BLOB]
