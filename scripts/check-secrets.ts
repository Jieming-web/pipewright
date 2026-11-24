// 跑真实 API 后查密钥泄露：在报告、录制等文件里找环境变量的原文，并确认 .env 被 git 忽略。输出只写变量名与文件，不写值。
// 用法：node --env-file=<.env> --import tsx scripts/check-secrets.ts --env <变量名> [--env <变量名>...] <文件或目录>...
// 退出码：0 无问题；1 命中、变量未设置或 .env 未被忽略；2 参数错误或读文件失败
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** 返回问题列表，空表示通过 */
export function checkSecrets(o: { names: string[]; paths: string[]; env: NodeJS.ProcessEnv; repoRoot: string }): string[] {
  const problems: string[] = [];
  // shortcut: 不跟随软链接、整文件读入内存，适合报告与录制这类小目录；扫大目录时再改流式
  const files = o.paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
      : [p],
  );
  for (const name of o.names) {
    const value = o.env[name];
    if (!value) {
      problems.push(`环境变量 ${name} 未设置或为空，无法检查`);
      continue;
    }
    for (const f of files) if (readFileSync(f).includes(value)) problems.push(`${name} 的值出现在 ${f}`);
  }
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: o.repoRoot, stdio: "ignore" });
  } catch {
    problems.push(`.env 未被 git 忽略（${o.repoRoot}）`);
  }
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
  let problems: string[];
  try {
    problems = checkSecrets({ names, paths, env: process.env, repoRoot: join(import.meta.dirname, "..") });
  } catch (e) {
    process.stderr.write(`check-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  for (const p of problems) process.stderr.write(`check-secrets: ${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write(`check-secrets: ok (${names.join(", ")} not found in ${paths.length} path(s); .env ignored)\n`);
}
