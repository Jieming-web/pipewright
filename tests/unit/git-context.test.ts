import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitContextFiles } from "../../packages/engine-client/src/git-context.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function makeRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "fp-git-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "t");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "commit.gpgsign", "false");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(d, p), c);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "init");
  return d;
}
const src = (repo: string, repoDir: string, over: Partial<{ baseRef: string; paths: string[] }> = {}) => ({
  repo, repoDir, baseRef: "main", paths: ["AGENTS.md"], ...over,
});

describe("readGitContextFiles", () => {
  it("reads from base ref, not the checked-out task branch or worktree", async () => {
    const d = makeRepo({ "AGENTS.md": "rule A" });
    const mainSha = git(d, "rev-parse", "main");
    git(d, "checkout", "-q", "-b", "task");
    writeFileSync(join(d, "AGENTS.md"), "rule B");
    git(d, "commit", "-qam", "b");
    writeFileSync(join(d, "AGENTS.md"), "rule C uncommitted");
    expect(await readGitContextFiles([src("r", d)])).toEqual([
      { repo: "r", path: "AGENTS.md", content: "rule A", sourceCommit: mainSha },
    ]);
    expect(mainSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns files from two repos with correct labels", async () => {
    const a = makeRepo({ "AGENTS.md": "a" });
    const b = makeRepo({ "AGENTS.md": "b" });
    const r = await readGitContextFiles([src("ra", a), src("rb", b)]);
    expect(r.map((f) => [f.repo, f.content])).toEqual([["ra", "a"], ["rb", "b"]]);
  });

  it("omits a missing file at a valid ref; empty list is valid; no worktree fallback", async () => {
    const d = makeRepo({ "x.txt": "x" });
    writeFileSync(join(d, "AGENTS.md"), "only in worktree");
    expect(await readGitContextFiles([src("r", d)])).toEqual([]);
    expect(await readGitContextFiles([])).toEqual([]);
  });

  it("rejects a missing ref", async () => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("r", d, { baseRef: "nope" })])).rejects.toThrow(/r.*nope/);
  });

  it("rejects a ref starting with '-'", async () => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("r", d, { baseRef: "--all" })])).rejects.toThrow(/r.*baseRef/);
  });

  it("rejects duplicate repo ids and duplicate paths", async () => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("r", d), src("r", d)])).rejects.toThrow(/\[r\] duplicate repo/);
    await expect(readGitContextFiles([src("r", d, { paths: ["AGENTS.md", "AGENTS.md"] })])).rejects.toThrow(/\[r\] duplicate path/);
  });

  it.each(["../x", "/abs", "./a"])("rejects illegal path %s", async (p) => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("r", d, { paths: [p] })])).rejects.toThrow(/r.*path/);
  });

  it("rejects an illegal repo id", async () => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("a/b", d)])).rejects.toThrow(/a\/b/);
  });

  it("throws when repoDir is not a git repo", async () => {
    const d = mkdtempSync(join(tmpdir(), "fp-notgit-"));
    dirs.push(d);
    await expect(readGitContextFiles([src("r", d)])).rejects.toThrow(/r/);
  });
});
