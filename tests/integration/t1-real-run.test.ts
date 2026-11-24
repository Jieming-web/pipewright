import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupAlive } from "../../packages/engine-client/src/index.js";
import { runAll, runQuestion, type Report } from "../../scripts/t1-real-run.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";

// 10A2：只用假模型跑通只读验收脚本；10B/10C 换真实模型时原样运行
const REPO = join(import.meta.dirname, "../..");
const SCRIPT = join(REPO, "scripts/t1-real-run.ts");
const FX = join(REPO, "tests/fixtures");
const qs = JSON.parse(readFileSync(join(FX, "sample-repo-questions.json"), "utf8"));
type Q = { id: string; question: string; target: { path: string; line: number }; answers: { path: string; line: number }[] };
const Qs: Q[] = qs.questions;
const audit = readFileSync(join(FX, "sample-repo-audit.md"), "utf8");
const INSTRUCTION = "只输出 JSON 数组，不要用代码块包裹，不要加任何解释文字";
const MODEL = { provider: "fake", id: "fake-model" };
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let root: string;
let server: FakeOpenAIServer | undefined;
let savedTmp: string | undefined;
const p = (...s: string[]) => join(root, ...s);
// 只看本项目的临时目录：CLI 进程的 tsx 编译缓存（tsx-<uid>）也落在 TMPDIR
const leftovers = () => readdirSync(p("tmp")).filter((n) => n.startsWith("fp-"));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-t1t-")));
  for (const d of ["model", "records", "tmp"]) mkdirSync(p(d));
  // 脚本与 runner 的临时目录都建在这里，便于断言全部清理
  savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = p("tmp");
});
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  try {
    await server?.close();
  } finally {
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

async function fake(turns: ScriptedTurn[]) {
  server = await startFakeOpenAIServer(turns);
  writeFileSync(p("model/models.json"), JSON.stringify(fakeModelsJson(server.baseUrl)));
}
const opts = (o: Partial<Parameters<typeof runAll>[0]> = {}) => ({ modelsPath: p("model/models.json"), model: MODEL, recordDir: p("records"), ...o });
/** 模型实际看到的全部文本：各条消息的内容（含工具结果）拼接 */
const seen = (req: unknown) =>
  (req as { messages: { content: string | { text?: string }[] | null }[] }).messages
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join("\n")))
    .join("\n");
const toolNames = (req: unknown) => (req as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name);
/** 启动脚本 CLI 子进程，返回退出码与 stderr */
async function cli(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: p("tmp") } });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((ok) => child.on("exit", ok));
  return { code, err };
}
const readThenAnswer = (q: Q, answer: string): ScriptedTurn[] => [
  { kind: "toolCall", name: "read", args: { path: q.target.path }, id: `c-${q.id}` },
  { kind: "text", chunks: [answer] },
];

describe.sequential("t1-real-run：五题隔离与证据", () => {
  it("五题各用新 runner、内存会话与临时 git 副本；规则取自 main；引擎看不到答案、核对记录与其他题；报告可核对版本", async () => {
    // 样例副本加一份 AGENTS.md，验证规则经 main 引用进入引擎（正式样例没有规则文件）
    mkdirSync(p("sample"));
    for (const f of readdirSync(join(FX, "sample-repo")).filter((f) => /\.(py|md)$/.test(f))) copyFileSync(join(FX, "sample-repo", f), p("sample", f));
    const rules = "RULE-MARKER-7f3a: answer precisely.\n";
    writeFileSync(p("sample/AGENTS.md"), rules);
    await fake(Qs.flatMap((q) => readThenAnswer(q, JSON.stringify(q.answers))));

    const report: Report = await runAll(opts({ sampleDir: p("sample") }));

    expect(report.summary).toEqual({ allCorrect: true, passed: Qs.map((q) => q.id), formatErrors: [], contentErrors: [], serviceFailures: [] });
    expect(server!.errors).toEqual([]);
    expect(server!.requests).toHaveLength(10);
    const files = readdirSync(p("sample")).sort();
    Qs.forEach((q, i) => {
      const r = report.questions[i]!;
      const [first, second] = [server!.requests[2 * i], server!.requests[2 * i + 1]];
      // 会话里实际有的工具：read/grep/find/ls 中只有 read
      expect(toolNames(first)).toEqual(["read", "bash", "edit", "write"]);
      // 新内存会话：首个请求只有系统提示与本题提示
      expect((first as { messages: unknown[] }).messages).toHaveLength(2);
      const prompt = seen(first);
      expect(prompt).toContain(q.question);
      expect(prompt).toContain(INSTRUCTION);
      expect(prompt).toContain('[{"path":"example.py","line":12}]');
      expect(files).not.toContain("example.py"); // 示例不含真实答案
      for (const f of files) expect(prompt).toContain(f);
      expect(prompt).toContain(rules.trim());
      for (const req of [first, second]) {
        const text = seen(req);
        for (const other of Qs) {
          if (other !== q) expect(text).not.toContain(other.question);
          expect(text).not.toContain(JSON.stringify(other.answers));
        }
        for (const line of audit.split("\n").filter((l) => l.includes(" | "))) expect(text).not.toContain(line);
        expect(text).not.toContain(qs.sampleRepoHash);
      }
      // 第二个请求带回 read 的结果：工具被放行且在副本里执行
      expect(seen(second)).toContain(readFileSync(p("sample", q.target.path), "utf8").split("\n")[0]);

      expect(r.id).toBe(q.id);
      expect(r.grade).toEqual({ passed: true, missing: [], extra: [] });
      expect(r.answer).toBe(JSON.stringify(q.answers));
      expect(r.denials).toEqual([]);
      expect(r.serviceFailure).toBeUndefined();
      expect(r.terminal).toBe("run.settled");
      expect(r.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(r.engine).toEqual({ name: "pi", version: "1.5.1" });
      expect(r.contextFiles).toEqual([{ repo: "sample", path: "AGENTS.md", sourceCommit: r.baseCommit, sha256: sha(rules) }]);
      expect(r.workDir.startsWith(p("tmp") + "/")).toBe(true);
      expect(existsSync(r.workDir)).toBe(false);
      expect(r.recordFile).toBe(p("records", `${q.id}.jsonl`));
      expect(statSync(r.recordFile).size).toBeGreaterThan(0);
      expect(r.runner).toMatchObject({ exitCode: 0, forced: false });
      expect(r.durationMs).toBeGreaterThan(0);
    });
    expect(new Set(report.questions.map((r) => r.workDir)).size).toBe(5);
    expect(new Set(report.questions.map((r) => r.runner.pid)).size).toBe(5);
    // 同一内容、固定提交时间：基准 commit 可复现
    expect(new Set(report.questions.map((r) => r.baseCommit)).size).toBe(1);

    expect(report.model).toEqual(MODEL);
    expect(report.modelsConfigSha256).toBe(sha(readFileSync(p("model/models.json"))));
    expect(report.versions.questionsHash).toBe(qs.questionsHash);
    expect(report.versions.recorded).toEqual({ sampleRepoHash: qs.sampleRepoHash, questionsHash: qs.questionsHash });
    for (const f of ["scripts/t1-real-run.ts", "scripts/t1-grade.ts", "packages/engine-runner/src/main.ts", "packages/engine-client/src/engine-client.ts", "packages/engine-protocol/src/engine-messages.ts"])
      expect(report.versions.sources[f], f).toBe(sha(readFileSync(join(REPO, f))));
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe.sequential("t1-real-run：CLI、判分分类与只读拦截", () => {
  it("格式错误（带原因）与内容答错分开列出；写与 bash 被拒且无副作用；未全对时退出非零", async () => {
    const [q1, q2, q3, q4, q5] = Qs as [Q, Q, Q, Q, Q];
    await fake([
      { kind: "text", chunks: ["```json\n" + JSON.stringify(q1.answers) + "\n```"] },
      { kind: "text", chunks: [JSON.stringify([q2.answers[0], { path: "billing.py", line: 14 }])] },
      { kind: "toolCall", name: "write", args: { path: p("written.txt"), content: "x" }, id: "w1" },
      { kind: "toolCall", name: "bash", args: { command: `touch ${p("bash.marker")}` }, id: "b1" },
      { kind: "toolCall", name: "read", args: { path: join(FX, "sample-repo-questions.json") }, id: "r1" },
      { kind: "text", chunks: [JSON.stringify(q3.answers)] },
      { kind: "text", chunks: ["答案是：" + JSON.stringify(q4.answers)] },
      { kind: "text", chunks: [JSON.stringify(q5.answers)] },
    ]);
    const { code, err } = await cli(["--models", p("model/models.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json")]);
    expect(code, err).toBe(1);

    const report: Report = JSON.parse(readFileSync(p("report.json"), "utf8"));
    expect(report.summary).toEqual({
      allCorrect: false,
      passed: [q3.id, q5.id],
      formatErrors: [
        { id: q1.id, reason: expect.stringMatching(/code fence/) },
        { id: q4.id, reason: "answer is not valid JSON" },
      ],
      contentErrors: [{ id: q2.id, missing: ["orders.py:7"], extra: ["billing.py:14"] }],
      serviceFailures: [],
    });
    expect(report.versions.sampleRepoHash).toBe(qs.sampleRepoHash);
    expect(server!.errors).toEqual([]);
    expect(server!.requests).toHaveLength(8);
    expect(report.questions[2]!.denials).toEqual([
      { toolName: "write", input: { path: p("written.txt"), content: "x" } },
      { toolName: "bash", input: { command: `touch ${p("bash.marker")}` } },
      { toolName: "read", input: { path: join(FX, "sample-repo-questions.json") } },
    ]);
    // 拒绝理由回给模型并写明改用什么；副本外的标准答案文件没有被读到
    const afterDenials = seen(server!.requests[5]);
    expect(afterDenials).toContain("此任务不提供 write，请使用 read 读取文件");
    expect(afterDenials).toContain("此任务不提供 bash，请使用 read 读取文件");
    expect(afterDenials).toContain("仓库副本内");
    expect(afterDenials).not.toContain(qs.sampleRepoHash);
    expect(existsSync(p("written.txt"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300)); // detached 的 bash 若逃过拦截，touch 毫秒级完成
    expect(existsSync(p("bash.marker"))).toBe(false);
    expect(readdirSync(p("records")).sort()).toEqual(Qs.map((q) => `${q.id}.jsonl`).sort());
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("参数缺失：退出 2，不跑题", async () => {
    const { code, err } = await cli([]);
    expect(code).toBe(2);
    expect(err).toMatch(/required/);
  }, 20_000);

  it("运行前出错（模型配置不存在）：stderr 说明原因，退出 3，与答错区分，不写报告", async () => {
    const { code, err } = await cli(["--models", p("no-such.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json")]);
    expect(code).toBe(3);
    expect(err).toMatch(/no-such\.json/);
    expect(existsSync(p("report.json"))).toBe(false);
  }, 20_000);
});

describe.sequential("t1-real-run：超时与停止时限", () => {
  it("单题超时：取消并记为服务故障，runner 正常收尾以 0 退出", async () => {
    await fake([{ kind: "text", chunks: Array.from({ length: 20 }, (_, i) => `t${i} `), chunkDelayMs: 200 }]);
    const r = await runQuestion(Qs[0]!, opts({ questionTimeoutMs: 2500 }));
    expect(r.serviceFailure).toBe("timed out after 2500 ms");
    expect(r.grade).toBeUndefined();
    expect(r.terminal).toBe("run.cancelled");
    expect(r.runner).toMatchObject({ exitCode: 0, forced: false });
    expect(leftovers()).toEqual([]);
  }, 30_000);

  // 诊断文件指向没有读端的 FIFO：runner 的清理卡住、无法自行退出（与 runner-process 测试同一故障注入）
  it("runner 卡在退出：从最早的退出信号（超时取消）起按单调时钟计停止时限，到时强杀整个进程组并记为服务故障", async () => {
    execFileSync("mkfifo", [p("records", `${Qs[0]!.id}.jsonl`)]);
    await fake([{ kind: "text", chunks: ["[]"] }]);
    const r = await runQuestion(Qs[0]!, opts({ questionTimeoutMs: 3000, stopTimeoutMs: 1000 }));
    expect(r.serviceFailure).toMatch(/^timed out after 3000 ms; runner force-killed/);
    expect(r.runner.forced).toBe(true);
    expect(r.runner.signal).toBe("SIGKILL");
    expect(r.runner.stopWaitMs).toBeGreaterThanOrEqual(1000);
    expect(r.runner.stopWaitMs).toBeLessThan(3000);
    expect(groupAlive(r.runner.pid!)).toBe(false);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  // 录制目录不存在：runner 清理失败，发 run.failed 并以 1 退出（9A 退出码契约）
  it("runner 非零退出（未超时）：记为服务故障并写明退出码，不判分", async () => {
    await fake([{ kind: "text", chunks: ["[]"] }]);
    const r = await runQuestion(Qs[0]!, opts({ recordDir: p("no-such-dir") }));
    expect(r.serviceFailure).toMatch(/^run\.failed: cleanup failed.*; runner exited with code 1/);
    expect(r.grade).toBeUndefined();
    expect(r.runner).toMatchObject({ exitCode: 1, forced: false });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});
