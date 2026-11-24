import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

describe("checkSecrets：本机路径检查（10A6，用于要提交的录制样本）", () => {
  // 仓库在家目录内：仓库路径已被家目录覆盖，不重复报告
  const LOCAL = { home: "/Users/fakeuser", repo: "/Users/fakeuser/work/repo", username: "fakeuser" };
  // 思考开启时的录制行：思考内容里出现本机路径
  const thinkingLine = (text: string) =>
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text } });

  it("思考内容里的本机路径：按文件:行:列报告家目录与用户名段，仓库在家目录内时不重复报仓库路径，不输出命中内容", () => {
    const f = p("scan/rec.jsonl");
    const line2 = thinkingLine("先看 /Users/fakeuser/work/repo/cli.py 第 7 行");
    writeFileSync(f, `${thinkingLine("ok")}\n${line2}\n`);
    const col = line2.indexOf("/Users/fakeuser") + 1;
    const problems = checkSecrets({ names: [], paths: [p("scan")], env, repoRoot: repo(true), localPaths: LOCAL });
    expect(problems).toEqual([`本机路径（家目录）出现在 ${f}:2:${col}`, `本机路径（用户名）出现在 ${f}:2:${col + "/Users/".length}`]);
    expect(problems.join("\n")).not.toContain("/Users/fakeuser");
    expect(problems.join("\n")).not.toContain("cli.py");
  });

  it("仓库不在家目录内：单独报告仓库路径", () => {
    const f = p("scan/rec.jsonl");
    writeFileSync(f, thinkingLine("/srv/build/repo/cli.py"));
    const problems = checkSecrets({ names: [], paths: [p("scan")], env, repoRoot: repo(true), localPaths: { ...LOCAL, repo: "/srv/build/repo" } });
    expect(problems).toEqual([`本机路径（仓库路径）出现在 ${f}:1:${thinkingLine("/srv").indexOf("/srv") + 1}`]);
  });

  it("短而常见的用户名（me）：普通词不算，只按路径段匹配（中间段、结尾段、反斜杠路径），同一行多处逐处报告", () => {
    const f = p("scan/a/me.jsonl");
    const words = "give me some memes, meet me at home; /home/meta/x; /home/mel";
    const paths = "/home/me/x and /home/me and C:\\Users\\me\\y";
    writeFileSync(f, `${words}\n${paths}\n`);
    const problems = checkSecrets({ names: [], paths: [p("scan")], env, repoRoot: repo(true), localPaths: { home: "/Users/nobody", repo: "/srv/r", username: "me" } });
    const cols = ["/me/", "/me ", "\\me\\"].map((seg) => paths.indexOf(seg) + 2);
    expect(problems).toEqual(cols.map((c) => `本机路径（用户名）出现在 ${f}:2:${c}`));
  });

  it("不给 localPaths：不做本机路径检查（.tmp 原始录制只做 key 检查）", () => {
    writeFileSync(p("scan/rec.jsonl"), thinkingLine("/Users/fakeuser/x"));
    expect(checkSecrets({ names: ["FAKE_KEY"], paths: [p("scan")], env, repoRoot: repo(true) })).toEqual([]);
  });

  it("本机路径检查的值为空：报告无法检查，而不是当作通过", () => {
    expect(checkSecrets({ names: [], paths: [p("scan")], env, repoRoot: repo(true), localPaths: { ...LOCAL, username: "" } })).toEqual(["本机路径（用户名）为空，无法检查"]);
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

  it("--local-paths：用本机家目录、仓库路径、用户名检查；命中非零退出、只报文件与位置；可不带 --env", () => {
    const f = p("scan/a/rec.jsonl");
    writeFileSync(f, JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: `${homedir()}/secret-proj-10a6` } }) + "\n");
    const hit = cli(["--local-paths", p("scan")], {});
    expect(hit.code).toBe(1);
    expect(hit.out).toMatch(new RegExp(`本机路径（家目录）出现在 ${f}:1:\\d+`));
    expect(hit.out).not.toContain("secret-proj-10a6");
    rmSync(f);
    const ok = cli(["--local-paths", "--env", "FAKE_KEY", p("scan")], env);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("本机路径");
  }, 20_000);

  it("缺 --env 或路径：退出 2", () => {
    expect(cli([p("scan")], env).code).toBe(2);
    expect(cli(["--env", "FAKE_KEY"], env).code).toBe(2);
  }, 20_000);
});
