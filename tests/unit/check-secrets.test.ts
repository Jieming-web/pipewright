import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSecrets } from "../../scripts/check-secrets.js";

// 10A3 密钥检查：只用假 key，不读真实 .env
const REPO = join(import.meta.dirname, "../..");
const KEY = "sk-fake-10a3-0123456789abcdef";
let root: string;
const p = (...s: string[]) => join(root, ...s);
const env = { FAKE_KEY: KEY };
/** 临时 git 仓库，ignored 时写 .gitignore 忽略 .env */
function repo(ignored: boolean): string {
  const dir = p(ignored ? "repo-ok" : "repo-bad");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (ignored) writeFileSync(join(dir, ".gitignore"), ".env\n");
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-secrets-")));
  mkdirSync(p("scan/a/b"), { recursive: true });
  writeFileSync(p("scan/clean.json"), '{"ok":true}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkSecrets", () => {
  it("未命中：没有问题", () => {
    expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan"), p("scan/clean.json")], env, repoRoot: repo(true) })).toEqual([]);
  });

  it("命中文件：列出文件，不含 key 原文", () => {
    writeFileSync(p("report.json"), `{"leak":"${KEY}"}`);
    const problems = checkSecrets({ names: ["FAKE_KEY"], paths: [p("report.json"), p("scan")], env, repoRoot: repo(true) });
    expect(problems).toEqual([`FAKE_KEY 的值出现在 ${p("report.json")}`]);
    expect(problems.join("\n")).not.toContain(KEY);
  });

  it("目录递归：深层文件命中", () => {
    writeFileSync(p("scan/a/b/run.jsonl"), `x${KEY}y\n`);
    expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: repo(true) })).toEqual([`FAKE_KEY 的值出现在 ${p("scan/a/b/run.jsonl")}`]);
  });

  it("变量未设置或为空：报告变量名", () => {
    const repoRoot = repo(true);
    for (const e of [{}, { FAKE_KEY: "" }])
      expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env: e, repoRoot })).toEqual(["环境变量 FAKE_KEY 未设置或为空，无法检查"]);
  });

  it("二进制文件中含 key：命中", () => {
    writeFileSync(p("scan/a/blob.bin"), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(KEY), Buffer.from([0, 0])]));
    expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: repo(true) })).toEqual([`FAKE_KEY 的值出现在 ${p("scan/a/blob.bin")}`]);
  });

  it("目录内的软链接：不跟随，逐个报告为未检查", () => {
    writeFileSync(p("outside.txt"), KEY);
    mkdirSync(p("outside-dir"));
    writeFileSync(p("outside-dir/x.txt"), KEY);
    symlinkSync(p("outside.txt"), p("scan/a/link.txt"));
    symlinkSync(p("outside-dir"), p("scan/a/b/linkdir"));
    const problems = checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: repo(true) });
    expect(problems.sort()).toEqual([`软链接未检查：${p("scan/a/b/linkdir")}`, `软链接未检查：${p("scan/a/link.txt")}`]);
  });

  it("读不了的文件记为问题并继续扫描，其他命中照常列出", () => {
    writeFileSync(p("scan/a/locked.txt"), "x");
    chmodSync(p("scan/a/locked.txt"), 0);
    writeFileSync(p("scan/a/b/hit.txt"), KEY);
    const problems = checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan"), p("no-such-file")], env, repoRoot: repo(true) });
    chmodSync(p("scan/a/locked.txt"), 0o600);
    expect(problems.sort()).toEqual(
      [`FAKE_KEY 的值出现在 ${p("scan/a/b/hit.txt")}`, `无法读取 ${p("scan/a/locked.txt")}：EACCES`, `无法读取 ${p("no-such-file")}：ENOENT`].sort(),
    );
  });

  it("git 检查本身失败（不是 git 仓库）：单独说明，不说成未被忽略", () => {
    mkdirSync(p("not-a-repo"));
    const problems = checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: p("not-a-repo") });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^无法用 git 检查 \\.env 是否被忽略（${p("not-a-repo")}）`));
  });

  it(".env 未被 git 忽略：报告", () => {
    expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: repo(false) })).toEqual([`.env 未被 git 忽略（${p("repo-bad")}）`]);
  });
});

describe("check-secrets CLI", () => {
  const cli = (args: string[], e: NodeJS.ProcessEnv) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/check-secrets.ts"), ...args], { cwd: REPO, env: { ...process.env, ...e }, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  it("命中：非零退出，列出文件，输出不含 key；未命中：退出 0", () => {
    writeFileSync(p("scan/a/leak.txt"), KEY);
    const hit = cli(["--env", "FAKE_KEY", p("scan")], env);
    expect(hit.code).toBe(1);
    expect(hit.out).toContain(p("scan/a/leak.txt"));
    expect(hit.out).not.toContain(KEY);
    rmSync(p("scan/a/leak.txt"));
    expect(cli(["--env", "FAKE_KEY", p("scan")], env).code).toBe(0);
  }, 20_000);

  it("变量未设置：非零退出并说明", () => {
    const r = cli(["--env", "FAKE_KEY_UNSET_10A3", p("scan")], {});
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAKE_KEY_UNSET_10A3 未设置");
  }, 20_000);

  it("缺 --env 或路径：退出 2", () => {
    expect(cli([p("scan")], env).code).toBe(2);
    expect(cli(["--env", "FAKE_KEY"], env).code).toBe(2);
  }, 20_000);
});
