import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  git(d, "commit", "-q", "--allow-empty", "-m", "init");
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

  it("rejects a symlink rule file", async () => {
    const d = makeRepo({ "CLAUDE.md": "x" });
    symlinkSync("CLAUDE.md", join(d, "AGENTS.md"));
    git(d, "add", "-A");
    git(d, "commit", "-qm", "link");
    await expect(readGitContextFiles([src("r", d)])).rejects.toThrow(/\[r\] AGENTS\.md is not a regular file/);
  });

  it("accepts exactly 256 KiB and rejects 256 KiB + 1", async () => {
    const d = makeRepo({ "AGENTS.md": "a".repeat(256 * 1024) });
    expect((await readGitContextFiles([src("r", d)]))[0]!.content.length).toBe(256 * 1024);
    writeFileSync(join(d, "AGENTS.md"), "a".repeat(256 * 1024 + 1));
    git(d, "commit", "-qam", "big");
    await expect(readGitContextFiles([src("r", d)])).rejects.toThrow(/\[r\] AGENTS\.md.*262145/);
  });

  it("ignores inherited GIT_DIR", async () => {
    const d = makeRepo({ "AGENTS.md": "a" });
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = join(d, "bogus");
    try {
      expect(await readGitContextFiles([src("r", d)])).toHaveLength(1);
    } finally {
      if (old === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = old;
    }
  });

  it("rejects non-UTF-8 content", async () => {
    const d = makeRepo({});
    writeFileSync(join(d, "AGENTS.md"), Buffer.from([0xff, 0xfe]));
    git(d, "add", "-A");
    git(d, "commit", "-qm", "bin");
    await expect(readGitContextFiles([src("r", d)])).rejects.toThrow(/\[r\] AGENTS\.md.*UTF-8/);
  });

  it("rejects a directory path", async () => {
    const d = makeRepo({});
    mkdirSync(join(d, "AGENTS.md"));
    writeFileSync(join(d, "AGENTS.md", "f"), "x");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "dir");
    await expect(readGitContextFiles([src("r", d)])).rejects.toThrow(/not a regular file/);
  });

  it("omits a path that goes through a symlinked directory", async () => {
    const d = makeRepo({});
    mkdirSync(join(d, "real"));
    writeFileSync(join(d, "real", "AGENTS.md"), "x");
    symlinkSync("real", join(d, "link"));
    git(d, "add", "-A");
    git(d, "commit", "-qm", "l");
    expect(await readGitContextFiles([src("r", d, { paths: ["link/AGENTS.md"] })])).toEqual([]);
  });

  it.each(["", "   "])("rejects blank baseRef %j", async (ref) => {
    const d = makeRepo({ "AGENTS.md": "a" });
    await expect(readGitContextFiles([src("r", d, { baseRef: ref })])).rejects.toThrow(/baseRef/);
  });
});
