// T1 只读验收：五道题各起一个新 runner（独立进程组）、新内存会话与样例的临时 git 副本，逐题判分并写报告。
// 用法：pnpm tsx scripts/t1-real-run.ts --models <配置> --model <provider/id> --record-dir <目录> --output <报告>
// 密钥等 env 由外层 Node 进程注入，本脚本不读 .env；也不解析 runner 录制的 pi 原始事件。
import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { EngineClient, readGitContextFiles } from "../packages/engine-client/src/index.js";
import type { RunSnapshot, SequencedEvent } from "../packages/engine-protocol/src/index.js";
import { gradeAnswer, type CallSite, type GradeResult } from "./t1-grade.js";

export const QUESTION_TIMEOUT_MS = 120_000;
export const STOP_TIMEOUT_MS = 10_000; // engine.md 进程退出：须明显长于 runner 内部收尾上限 7 秒
const ROOT = join(import.meta.dirname, "..");
const MAIN = join(ROOT, "packages/engine-runner/src/main.ts");
const FIXTURES = join(ROOT, "tests/fixtures");
// 会话里实际激活的内置工具是 read/bash/edit/write（测试断言模型请求的工具声明），read/grep/find/ls 中只有 read
const READ_ONLY = new Set(["read"]);
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
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms)));
const sampleFiles = (dir: string) => readdirSync(dir).filter((f) => /\.(py|md)$/.test(f)).sort();
// 与 tests/unit/sample-repo-answers.test.ts 相同：只算 .py/.md，name\0content\0 按名排序拼接
const sampleHash = (dir: string) => sha(sampleFiles(dir).map((f) => `${f}\0${readFileSync(join(dir, f), "utf8")}\0`).join(""));

function sourceHashes(): Record<string, string> {
  const files = ["scripts/t1-real-run.ts", "scripts/t1-grade.ts"];
  for (const pkg of ["engine-protocol", "engine-runner", "engine-client"])
    for (const f of readdirSync(join(ROOT, "packages", pkg, "src")).sort()) files.push(`packages/${pkg}/src/${f}`);
  return Object.fromEntries(files.map((f) => [f, sha(readFileSync(join(ROOT, f)))]));
}

/** 样例 .py/.md 的临时 git 副本，提交到 main；固定身份与时间，同一内容得到同一基准 commit */
function makeRepo(sampleDir: string, dir: string): { files: string[]; baseCommit: string } {
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
  return { files, baseCommit: git("rev-parse", "HEAD").trim() };
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

// macOS 上组内只剩未回收的僵尸时 kill(-pgid) 报 EPERM：视同没有存活进程
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    if (!["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code!)) throw e;
  }
}

export async function runQuestion(q: Question, o: RunOptions): Promise<QuestionResult> {
  const timeoutMs = o.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
  const stopTimeoutMs = o.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const t0 = performance.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fp-t1-")));
  const r: QuestionResult = {
    id: q.id, workDir: join(root, "repo"), recordFile: join(resolve(o.recordDir), `${q.id}.jsonl`),
    answer: null, denials: [], durationMs: 0, runner: { exitCode: null, signal: null, forced: false, stderr: "" },
  };
  const TIMEOUT = new Error(`timed out after ${timeoutMs} ms`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(TIMEOUT), timeoutMs)));
  timeout.catch(() => {});
  const within = <T>(p: Promise<T>) => Promise.race([p, timeout]);
  // 停止时限从最早的退出信号起算（engine.md 进程退出）：发出取消/SIGTERM、收到终止事件或连接关闭
  let stopAt: number | undefined;
  const stopSignal = () => void (stopAt ??= performance.now());
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let exit: Promise<{ code: number | null; signal: string | null }> | undefined;
  let client: EngineClient | undefined;
  let started = false;
  const events: SequencedEvent[] = [];

  try {
    const { files, baseCommit } = makeRepo(o.sampleDir ?? join(FIXTURES, "sample-repo"), r.workDir);
    r.baseCommit = baseCommit;
    const contextFiles = await readGitContextFiles([{ repo: "sample", repoDir: r.workDir, baseRef: "refs/heads/main", paths: ["AGENTS.md"] }]);
    for (const d of ["sessions", "tmp"]) mkdirSync(join(root, d));
    const c = (child = spawn(
      process.execPath,
      ["--import", "tsx", MAIN, "--port", "0", "--models", resolve(o.modelsPath), "--workdir", r.workDir, "--sessions-root", join(root, "sessions"), "--record-pi-events", r.recordFile],
      // runner 的 scratchDir 建在 TMPDIR 下：指向本题临时目录，强杀后也由下面的 finally 一并删除
      { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: join(root, "tmp") } },
    ));
    r.runner.pid = c.pid;
    c.stderr.on("data", (d) => (r.runner.stderr += d));
    exit = new Promise((ok) => c.on("exit", (code, signal) => ok({ code, signal })));
    const port = await within(
      new Promise<number>((ok, fail) => {
        let out = "";
        c.stdout.on("data", (d) => {
          out += d;
          const m = /^RUNNER_LISTENING (\d+)\n/.exec(out);
          if (m) ok(Number(m[1]));
        });
        c.on("exit", (code) => fail(new Error(`runner exited with code ${code} before listening`)));
      }),
    );
    client = await within(EngineClient.connect(`ws://127.0.0.1:${port}`));
    client.waitForEnd().then(stopSignal, stopSignal);
    client.onEvent((e) => events.push(e));
    client.onIntercept(async ({ toolName, input }) => {
      if (READ_ONLY.has(toolName)) return { decision: "allow" };
      r.denials.push({ toolName, input });
      return { decision: "block", reason: `read-only run: only ${[...READ_ONLY].join(", ")} is allowed` };
    });
    await within(client.start({ sessionId: q.id, prompt: buildPrompt(q, files), model: o.model, contextFiles, interceptMode: "callback" }));
    started = true;
    const end = await within(client.waitForEnd());
    if (end.type === "run.failed") r.serviceFailure = `run.failed: ${end.reason}`;
    else if (end.type === "run.cancelled") r.serviceFailure = "run.cancelled";
  } catch (e) {
    r.serviceFailure = message(e);
    if (e === TIMEOUT && started) {
      try {
        client!.cancel();
      } catch {} // 连接已断：断线本身就让 runner 取消并退出
    } else child?.kill("SIGTERM");
    stopSignal();
  } finally {
    clearTimeout(timer);
    if (child && exit) {
      stopSignal(); // 本地异常路径：此刻起计时
      const exited = await Promise.race([exit, sleep(stopAt! + stopTimeoutMs - performance.now())]);
      if (!exited) {
        killGroup(child.pid!);
        r.runner.forced = true;
      }
      const { code, signal } = await exit;
      Object.assign(r.runner, { exitCode: code, signal, stopWaitMs: Math.round(performance.now() - stopAt!) });
    }
    await client?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }

  const startedEvent = events.find((e) => e.type === "run.started");
  if (startedEvent?.type === "run.started") ({ engine: r.engine, contextFiles: r.contextFiles } = startedEvent.snapshot);
  r.terminal = events.find((e) => ["run.settled", "run.failed", "run.cancelled"].includes(e.type))?.type;
  const last = events.findLast((e) => e.type === "message.completed");
  r.answer = last?.type === "message.completed" ? last.text : null;
  if (r.terminal === "run.settled" && !r.serviceFailure) r.grade = gradeAnswer(r.answer ?? "", q.answers);
  if (r.runner.forced) r.serviceFailure ??= `runner force-killed after ${stopTimeoutMs} ms stop timeout`;
  else if (r.runner.exitCode !== 0) r.serviceFailure ??= `runner exited with code ${r.runner.exitCode} (signal ${r.runner.signal})`;
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
  const report = await runAll({ modelsPath: v.models!, model: { provider: v.model!.slice(0, slash), id: v.model!.slice(slash + 1) }, recordDir: v["record-dir"]! });
  writeFileSync(v.output!, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report.summary) + "\n");
  process.exit(report.summary.allCorrect ? 0 : 1);
}
