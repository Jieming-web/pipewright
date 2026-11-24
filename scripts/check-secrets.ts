// 跑真实 API 后查密钥泄露：在报告、录制等文件里找环境变量的原文，并确认 .env 被 git 忽略。输出只写变量名与文件，不写值。
// 用法：node --env-file=<.env> --import tsx scripts/check-secrets.ts --env <变量名> [--env <变量名>...] <文件或目录>...
// 退出码：0 无问题；1 有问题（命中、变量未设置、文件读不了、目录内软链接、.env 未被忽略或无法检查）；2 参数错误
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** 返回问题列表，空表示通过 */
export function checkSecrets(o: { names: string[]; paths: string[]; env: NodeJS.ProcessEnv; repoRoot: string }): string[] {
  const problems: string[] = [];
  const cantRead = (f: string, e: unknown) => problems.push(`无法读取 ${f}：${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  const values = o.names.flatMap((name) => {
    if (o.env[name]) return [[name, o.env[name]] as const];
    problems.push(`环境变量 ${name} 未设置或为空，无法检查`);
    return [];
  });
  // 参数里给的路径照常跟随；目录里的软链接不跟随，记为未检查（fail safe）。readdirSync 的 recursive 会进入软链接目录，故自己遍历
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isSymbolicLink()) problems.push(`软链接未检查：${f}`);
      else if (e.isDirectory()) visit(f, walk);
      else if (e.isFile()) files.push(f);
    }
  };
  const visit = (p: string, fn: (p: string) => void) => {
    try {
      fn(p);
    } catch (e) {
      cantRead(p, e);
    }
  };
  for (const p of o.paths) visit(p, (p) => (statSync(p).isDirectory() ? walk(p) : files.push(p)));
  // shortcut: 整文件读入内存，适合报告与录制这类小目录；扫大目录时再改流式
  for (const f of files) {
    try {
      const buf = readFileSync(f);
      for (const [name, value] of values) if (buf.includes(value)) problems.push(`${name} 的值出现在 ${f}`);
    } catch (e) {
      cantRead(f, e);
    }
  }
  const git = spawnSync("git", ["check-ignore", "-q", ".env"], { cwd: o.repoRoot, encoding: "utf8" });
  if (git.status === 1) problems.push(`.env 未被 git 忽略（${o.repoRoot}）`);
  else if (git.status !== 0) problems.push(`无法用 git 检查 .env 是否被忽略（${o.repoRoot}）：${git.error?.message ?? git.stderr.trim()}`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let names: string[] = [];
  let paths: string[] = [];
  try {
    const { values, positionals } = parseArgs({ options: { env: { type: "string", multiple: true } }, allowPositionals: true });
    [names, paths] = [values.env ?? [], positionals];
  } catch {}
  if (!names.length || !paths.length) {
    process.stderr.write("check-secrets: usage: --env <NAME> [--env <NAME>...] <file-or-dir>...\n");
    process.exit(2);
  }
  const problems = checkSecrets({ names, paths, env: process.env, repoRoot: join(import.meta.dirname, "..") });
  for (const p of problems) process.stderr.write(`check-secrets: ${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write(`check-secrets: ok (${names.join(", ")} not found in ${paths.length} path(s); .env ignored)\n`);
}
