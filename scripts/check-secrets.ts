// 跑真实 API 后查密钥泄露：在报告、录制等文件里找环境变量的原文，并确认 .env 被 git 忽略。输出只写变量名与文件，不写值。
// --local-paths 另查本机路径（家目录、不在家目录内时的仓库/工作树绝对路径、作为路径段的用户名），只报类别与 文件:行:列，不写命中内容；用于要提交的录制样本
// （.tmp 下的原始录制含 pi 系统提示里的本机路径，只做 key 检查）。
// 用法：node --env-file=<.env> --import tsx scripts/check-secrets.ts [--env <变量名>...] [--local-paths] <文件或目录>...（--env 与 --local-paths 至少一个）
// 退出码：0 无问题；1 有问题（命中、变量未设置、文件读不了、目录内软链接、.env 未被忽略或无法检查）；2 参数错误
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type LocalPaths = { home: string; repo: string; username: string };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inside = (root: string, p: string) => { const r = relative(root, p); return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)); };

/** 本机路径的检查项：仓库在家目录内时已被家目录覆盖，不重复报告；用户名只按路径段匹配（短用户名如 me、ci 作普通词时不算） */
function localChecks(lp: LocalPaths, problems: string[]): [label: string, re: RegExp][] {
  const checks: [string, RegExp][] = [];
  for (const [label, v] of [["家目录", lp.home], ["仓库路径", lp.repo], ["用户名", lp.username]]) if (!v) problems.push(`本机路径（${label}）为空，无法检查`);
  if (lp.home) checks.push(["家目录", new RegExp(escape(lp.home), "g")]);
  if (lp.repo && !(lp.home && inside(lp.home, lp.repo))) checks.push(["仓库路径", new RegExp(escape(lp.repo), "g")]);
  if (lp.username) checks.push(["用户名", new RegExp(`(?<=[/\\\\])${escape(lp.username)}(?![\\w.-])`, "g")]);
  return checks;
}

/** 返回问题列表，空表示通过 */
export function checkSecrets(o: { names: string[]; paths: string[]; env: NodeJS.ProcessEnv; repoRoot: string; localPaths?: LocalPaths }): string[] {
  const problems: string[] = [];
  const cantRead = (f: string, e: unknown) => problems.push(`无法读取 ${f}：${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  const values = o.names.flatMap((name) => {
    if (o.env[name]) return [[name, o.env[name]] as const];
    problems.push(`环境变量 ${name} 未设置或为空，无法检查`);
    return [];
  });
  const locals = o.localPaths ? localChecks(o.localPaths, problems) : [];
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
      // 只能发现整段出现的路径：依赖录制写出完整的 partial/message_end 行，只在单个增量里被拆开的路径会漏掉
      if (locals.length)
        buf.toString("utf8").split("\n").forEach((line, i) => {
          for (const [label, re] of locals) for (const m of line.matchAll(re)) problems.push(`本机路径（${label}）出现在 ${f}:${i + 1}:${m.index + 1}`);
        });
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
  let local = false;
  try {
    const { values, positionals } = parseArgs({ options: { env: { type: "string", multiple: true }, "local-paths": { type: "boolean" } }, allowPositionals: true });
    [names, paths, local] = [values.env ?? [], positionals, values["local-paths"] ?? false];
  } catch {}
  if ((!names.length && !local) || !paths.length) {
    process.stderr.write("check-secrets: usage: [--env <NAME>...] [--local-paths] <file-or-dir>... (at least one of --env, --local-paths)\n");
    process.exit(2);
  }
  const repoRoot = join(import.meta.dirname, "..");
  const localPaths = local ? { home: homedir(), repo: realpathSync(repoRoot), username: userInfo().username } : undefined;
  const problems = checkSecrets({ names, paths, env: process.env, repoRoot, localPaths });
  for (const p of problems) process.stderr.write(`check-secrets: ${p}\n`);
  if (problems.length) process.exit(1);
  const checked = [...(names.length ? [`${names.join(", ")} not found`] : []), ...(local ? ["no 本机路径"] : [])].join("; ");
  process.stdout.write(`check-secrets: ok (${checked} in ${paths.length} path(s); .env ignored)\n`);
}
