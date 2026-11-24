import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRepo, readRules, toolDecision } from "../../scripts/t1-real-run.js";

// 10A2 调用方拦截：只放行 read，且只放行解析软链接后落在本题副本内、已存在的文件（作者 2026-11-24 决定）
let root: string;
let copy: string;
const p = (...s: string[]) => join(root, ...s);
const read = (path: unknown) => toolDecision({ toolName: "read", input: { path } }, copy);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-t1u-")));
  copy = p("copy-1");
  mkdirSync(join(copy, "sub"), { recursive: true });
  writeFileSync(join(copy, "a.py"), "x\n");
  writeFileSync(join(copy, "sub/b.py"), "y\n");
  mkdirSync(p("copy-10"));
  writeFileSync(p("copy-10/a.py"), "secret\n");
  writeFileSync(p("outside.txt"), "secret\n");
  symlinkSync(p("outside.txt"), join(copy, "link.py"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("toolDecision：read 路径", () => {
  it("副本内正常文件放行（相对、@ 前缀、绝对、子目录）", () => {
    for (const path of ["a.py", "@a.py", join(copy, "a.py"), "sub/b.py", "sub/../a.py"]) expect(read(path), path).toEqual({ decision: "allow" });
  });
  it.each([
    ["副本外绝对路径", () => p("outside.txt")],
    ["../ 跳出", () => "../outside.txt"],
    ["子目录 ../../ 跳出", () => "sub/../../outside.txt"],
    ["副本内软链接指向副本外", () => "link.py"],
    ["前缀相似的兄弟目录（相对）", () => "../copy-10/a.py"],
    ["前缀相似的兄弟目录（绝对）", () => p("copy-10/a.py")],
    ["~ 展开到家目录", () => "~/.bashrc"],
    ["不存在的文件", () => "nope.py"],
  ])("%s → 拒绝，理由说明只能读副本内文件", (_, path) => {
    const d = read(path());
    expect(d.decision).toBe("block");
    expect(d).toHaveProperty("reason", expect.stringContaining("仓库副本内"));
  });
  it("家目录本身也不放行", () => expect(read("~").decision).toBe("block"));
  it("path 缺失或不是字符串 → 拒绝", () => {
    for (const input of [{}, { path: 1 }, null, "a.py"]) expect(toolDecision({ toolName: "read", input }, copy).decision).toBe("block");
  });
  it("副本目录本身经软链接给出也能放行其中文件", () => {
    symlinkSync(copy, p("copy-alias"));
    expect(toolDecision({ toolName: "read", input: { path: "a.py" } }, p("copy-alias"))).toEqual({ decision: "allow" });
  });
});

describe("toolDecision：其他工具", () => {
  it.each(["bash", "edit", "write", "grep", "no_such_tool"])("%s → 拒绝，理由写明改用 read", (toolName) => {
    expect(toolDecision({ toolName, input: { command: "ls", path: "a.py" } }, copy)).toEqual({
      decision: "block",
      reason: `此任务不提供 ${toolName}，请使用 read 读取文件`,
    });
  });
});

describe("规则来源", () => {
  it("AGENTS.md 取自副本的 main 引用，而不是工作区", async () => {
    const sample = p("sample");
    mkdirSync(sample);
    writeFileSync(join(sample, "m.py"), "pass\n");
    writeFileSync(join(sample, "AGENTS.md"), "MAIN-RULES\n");
    const dir = p("repo");
    const { files, baseCommit } = makeRepo(sample, dir);
    expect(files).toEqual(["AGENTS.md", "m.py"]);
    writeFileSync(join(dir, "AGENTS.md"), "WORKTREE-RULES\n");
    expect(await readRules(dir)).toEqual([{ repo: "sample", path: "AGENTS.md", content: "MAIN-RULES\n", sourceCommit: baseCommit }]);
  });
});
