// T1 只读验收：五道题各起一个新 runner（独立进程组）、新内存会话与样例的临时 git 副本，逐题判分并写报告。
// 用法：pnpm tsx scripts/t1-real-run.ts --models <配置> --model <provider/id> --record-dir <目录> --output <报告>
// 密钥等 env 由外层 Node 进程注入，本脚本不读 .env；也不解析 runner 录制的 pi 原始事件。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readGitContextFiles, spawnRunner, STOP_TIMEOUT_MS, type EngineClient, type RunnerProcess } from "../packages/engine-client/src/index.js";
import type { ContextFile, Decision, RunSnapshot, SequencedEvent, ToolRequest } from "../packages/engine-protocol/src/index.js";
import { gradeAnswer, type CallSite, type GradeResult } from "./t1-grade.js";

export const QUESTION_TIMEOUT_MS = 120_000;
const ROOT = join(import.meta.dirname, "..");
const MAIN = join(ROOT, "packages/engine-runner/src/main.ts");
const FIXTURES = join(ROOT, "tests/fixtures");
const INSTRUCTION = "只输出 JSON 数组，不要用代码块包裹，不要加任何解释文字";
const EXAMPLE = '[{"path":"example.py","line":12}]'; // 样例中没有 example.py：示例不含真实答案

type Question = { id: string; question: string; answers: CallSite[] };
export type RunOptions = {
  modelsPath: string;
  model: { provider: string; id: string };
  recordDir: string;
  sampleDir?: string;
  questionTimeoutMs?: number;
  stopTimeoutMs?: number;
};
export type QuestionResult = {
  id: string;
  workDir: string;
  recordFile: string;
  baseCommit?: string;
  engine?: RunSnapshot["engine"];
  contextFiles?: RunSnapshot["contextFiles"];
  terminal?: string;
  answer: string | null;
  /** 只在 run.settled 后判分；服务故障不判分 */
  grade?: GradeResult;
  serviceFailure?: string;
  denials: { toolName: string; input: unknown }[];
  durationMs: number;
  runner: { pid?: number; exitCode: number | null; signal: string | null; forced: boolean; stopWaitMs?: number; stderr: string };
};
export type Report = {
  model: RunOptions["model"];
  modelsConfigSha256: string;
  versions: {
    sampleRepoHash: string;
    questionsHash: string;
    recorded: { sampleRepoHash: string; questionsHash: string };
    sources: Record<string, string>;
  };
  questions: QuestionResult[];
  summary: {
    allCorrect: boolean;
    passed: string[];
    formatErrors: { id: string; reason: string }[];
    contentErrors: { id: string; missing: string[]; extra: string[] }[];
    serviceFailures: { id: string; reason: string }[];
  };
};

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sampleFiles = (dir: string) => readdirSync(dir).filter((f) => /\.(py|md)$/.test(f)).sort();
// 与 tests/unit/sample-repo-answers.test.ts 相同：只算 .py/.md，name\0content\0 按名排序拼接
const sampleHash = (dir: string) => sha(sampleFiles(dir).map((f) => `${f}\0${readFileSync(join(dir, f), "utf8")}\0`).join(""));

function sourceHashes(): Record<string, string> {
  const files = ["scripts/t1-real-run.ts", "scripts/t1-grade.ts"];
  for (const pkg of ["engine-protocol", "engine-runner", "engine-client"]) {
    const src = join(ROOT, "packages", pkg, "src");
    for (const e of readdirSync(src, { recursive: true, withFileTypes: true }))
      if (e.isFile()) files.push(relative(ROOT, join(e.parentPath, e.name)).split(sep).join("/"));
  }
  return Object.fromEntries(files.sort().map((f) => [f, sha(readFileSync(join(ROOT, f)))]));
}

/** 样例 .py/.md 的临时 git 副本，提交到 main；固定身份与时间，同一内容得到同一基准 commit。files 由副本的 git ls-files 生成 */
export function makeRepo(sampleDir: string, dir: string): { files: string[]; baseCommit: string } {
  mkdirSync(dir);
  const files = sampleFiles(sampleDir);
  for (const f of files) copyFileSync(join(sampleDir, f), join(dir, f));
  const when = "2026-01-01T00:00:00Z";
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), // 继承的 GIT_DIR 等会指向别的仓库
    GIT_AUTHOR_NAME: "t1", GIT_AUTHOR_EMAIL: "t1@localhost", GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: "t1", GIT_COMMITTER_EMAIL: "t1@localhost", GIT_COMMITTER_DATE: when,
  };
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "--", ...files);
  git("commit", "-q", "--no-verify", "-m", "sample");
  return { files: git("ls-files", "-z").split("\0").filter(Boolean), baseCommit: git("rev-parse", "HEAD").trim() };
}

/** 规则只取副本 main 引用上的 AGENTS.md，不读工作区 */
export const readRules = (dir: string): Promise<ContextFile[]> =>
  readGitContextFiles([{ repo: "sample", repoDir: dir, baseRef: "refs/heads/main", paths: ["AGENTS.md"] }]);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** 照 pi 1.5.1 read 的解析（utils/paths.js resolvePath）：统一空白、去掉开头 @、展开 ~、file:// 转路径，再相对 cwd 解析 */
function piResolve(input: string, cwd: string): string {
  let s = input.replace(UNICODE_SPACES, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  if (/^file:\/\//.test(s)) s = fileURLToPath(s);
  return resolve(cwd, s);
}

/**
 * 调用方拦截（作者 2026-11-24 决定）：会话激活的内置工具是 read/bash/edit/write，只放行 read；
 * read 只放行解析软链接后落在副本内的已存在路径（不存在的一律拒绝：pi 对不存在的路径还会试 NFD 等变体，不去猜）。
 */
export function toolDecision({ toolName, input }: Pick<ToolRequest, "toolName" | "input">, copyDir: string): Decision {
  if (toolName !== "read") return { decision: "block", reason: `此任务不提供 ${toolName}，请使用 read 读取文件` };
  const path = (input as { path?: unknown } | null)?.path;
  try {
    if (typeof path !== "string") throw new Error("no path");
    const root = realpathSync(copyDir);
    const rel = relative(root, realpathSync(piResolve(path, root)));
    if (rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))) return { decision: "allow" };
  } catch {} // 不存在或无法解析：拒绝
  return { decision: "block", reason: "只能读取仓库副本内已存在的文件，请用相对路径 read 提示中列出的文件" };
}

function buildPrompt(q: Question, files: string[]): string {
  return [
    q.question,
    "",
    "仓库中的文件（可用 read 工具读取）：",
    ...files.map((f) => `- ${f}`),
    "",
    `${INSTRUCTION}。每个调用位置写成 {"path": 相对路径, "line": 行号}，格式示例：`,
    EXAMPLE,
  ].join("\n");
}

export async function runQuestion(q: Question, o: RunOptions): Promise<QuestionResult> {
  const timeoutMs = o.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
  const t0 = performance.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fp-t1-")));
  const r: QuestionResult = {
    id: q.id, workDir: join(root, "repo"), recordFile: join(resolve(o.recordDir), `${q.id}.jsonl`),
    answer: null, denials: [], durationMs: 0, runner: { exitCode: null, signal: null, forced: false, stderr: "" },
  };
  const failures: string[] = [];
  const TIMEOUT = new Error(`timed out after ${timeoutMs} ms`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(TIMEOUT), timeoutMs)));
  timeout.catch(() => {});
  const within = <T>(p: Promise<T>) => Promise.race([p, timeout]);
  let runner: RunnerProcess | undefined;
  let client: EngineClient | undefined;
  let started = false;
  const events: SequencedEvent[] = [];

  try {
    const { files, baseCommit } = makeRepo(o.sampleDir ?? join(FIXTURES, "sample-repo"), r.workDir);
    r.baseCommit = baseCommit;
    const contextFiles = await readRules(r.workDir);
    for (const d of ["sessions", "tmp"]) mkdirSync(join(root, d));
    runner = spawnRunner({
      args: ["--import", "tsx", MAIN, "--port", "0", "--models", resolve(o.modelsPath), "--workdir", r.workDir, "--sessions-root", join(root, "sessions"), "--record-pi-events", r.recordFile],
      cwd: ROOT,
      // runner 的 scratchDir 建在 TMPDIR 下：指向本题临时目录，强杀后也由下面的 finally 一并删除
      env: { ...process.env, TMPDIR: join(root, "tmp") },
      stopTimeoutMs: o.stopTimeoutMs,
    });
    r.runner.pid = runner.pid;
    client = await within(runner.connect());
    client.onEvent((e) => events.push(e));
    client.onIntercept(async (req) => {
      const d = toolDecision(req, r.workDir);
      if (d.decision !== "allow") r.denials.push({ toolName: req.toolName, input: req.input });
      return d;
    });
    await within(client.start({ sessionId: q.id, prompt: buildPrompt(q, files), model: o.model, contextFiles, interceptMode: "callback" }));
    started = true;
    const end = await within(client.waitForEnd());
    if (end.type === "run.failed") failures.push(`run.failed: ${end.reason}`);
    else if (end.type === "run.cancelled") failures.push("run.cancelled");
  } catch (e) {
    failures.push(message(e));
    if (e === TIMEOUT && started) runner?.cancel();
    else runner?.terminate();
  } finally {
    clearTimeout(timer);
    if (runner) {
      const x = await runner.stop();
      r.runner = { pid: runner.pid, exitCode: x.code, signal: x.signal, forced: x.forced, stopWaitMs: x.stopWaitMs, stderr: runner.stderr() };
    }
    await client?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }

  const startedEvent = events.find((e) => e.type === "run.started");
  if (startedEvent?.type === "run.started") ({ engine: r.engine, contextFiles: r.contextFiles } = startedEvent.snapshot);
  r.terminal = events.find((e) => ["run.settled", "run.failed", "run.cancelled"].includes(e.type))?.type;
  const last = events.findLast((e) => e.type === "message.completed");
  r.answer = last?.type === "message.completed" ? last.text : null;
  if (r.runner.forced) failures.push(`runner force-killed after ${o.stopTimeoutMs ?? STOP_TIMEOUT_MS} ms stop timeout`);
  else if (r.runner.exitCode !== 0) failures.push(`runner exited with code ${r.runner.exitCode} (signal ${r.runner.signal})`);
  if (failures.length) r.serviceFailure = failures.join("; ");
  else if (r.terminal === "run.settled") r.grade = gradeAnswer(r.answer ?? "", q.answers);
  r.durationMs = Math.round(performance.now() - t0);
  return r;
}

export async function runAll(o: RunOptions): Promise<Report> {
  const qs = JSON.parse(readFileSync(join(FIXTURES, "sample-repo-questions.json"), "utf8"));
  const questions: Question[] = qs.questions;
  mkdirSync(o.recordDir, { recursive: true });
  const report: Report = {
    model: o.model,
    modelsConfigSha256: sha(readFileSync(o.modelsPath)),
    versions: {
      sampleRepoHash: sampleHash(o.sampleDir ?? join(FIXTURES, "sample-repo")),
      questionsHash: sha(JSON.stringify(questions)),
      recorded: { sampleRepoHash: qs.sampleRepoHash, questionsHash: qs.questionsHash },
      sources: sourceHashes(),
    },
    questions: [],
    summary: { allCorrect: false, passed: [], formatErrors: [], contentErrors: [], serviceFailures: [] },
  };
  const s = report.summary;
  for (const q of questions) {
    const r = await runQuestion(q, o);
    report.questions.push(r);
    if (r.serviceFailure) s.serviceFailures.push({ id: r.id, reason: r.serviceFailure });
    else if (r.grade?.error) s.formatErrors.push({ id: r.id, reason: r.grade.error });
    else if (r.grade?.passed) s.passed.push(r.id);
    else s.contentErrors.push({ id: r.id, missing: r.grade!.missing, extra: r.grade!.extra });
  }
  s.allCorrect = s.passed.length === questions.length;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let v: Record<string, string | undefined>;
  try {
    ({ values: v } = parseArgs({ options: Object.fromEntries(["models", "model", "record-dir", "output"].map((k) => [k, { type: "string" as const }])) }));
  } catch (e) {
    process.stderr.write(`t1-real-run: ${message(e)}\n`);
    process.exit(2);
  }
  const missing = ["models", "model", "record-dir", "output"].filter((k) => !v[k]);
  const slash = v.model?.indexOf("/") ?? -1;
  if (missing.length || slash <= 0 || slash === v.model!.length - 1) {
    process.stderr.write(`t1-real-run: required --models --model <provider/id> --record-dir --output${missing.length ? `; missing ${missing.join(", ")}` : ""}\n`);
    process.exit(2);
  }
  let report: Report;
  try {
    report = await runAll({ modelsPath: v.models!, model: { provider: v.model!.slice(0, slash), id: v.model!.slice(slash + 1) }, recordDir: v["record-dir"]! });
    writeFileSync(v.output!, JSON.stringify(report, null, 2) + "\n");
  } catch (e) {
    // 跑题之前或写报告时出错：与答错（1）、参数错（2）区分
    process.stderr.write(`t1-real-run: ${message(e)}\n`);
    process.exit(3);
  }
  process.stdout.write(JSON.stringify(report.summary) + "\n");
  process.exit(report.summary.allCorrect ? 0 : 1);
}
