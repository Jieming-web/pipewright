import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupAlive } from "../../packages/engine-client/src/index.js";
import { runAll, runQuestion, type Report } from "../../scripts/t1-real-run.js";
import { fakeModelsJson, startFakeOpenAIServer, type FakeOpenAIServer, type ScriptedTurn } from "../helpers/fake-openai-server.js";
import { fifoReader, fillFifo, writerOpened } from "../helpers/fifo.js";

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

async function fake(turns: ScriptedTurn[], samplingParams?: object) {
  server = await startFakeOpenAIServer(turns);
  const config = fakeModelsJson(server.baseUrl) as { providers: { fake: { models: object[] } } };
  if (samplingParams) Object.assign(config.providers.fake.models[0]!, { samplingParams });
  writeFileSync(p("model/models.json"), JSON.stringify(config));
}
const opts = (o: Partial<Parameters<typeof runAll>[0]> = {}) => ({ modelsPath: p("model/models.json"), model: MODEL, recordDir: p("records"), ...o });
/** 模型实际看到的全部文本：各条消息的内容（含工具结果）拼接 */
const seen = (req: unknown) =>
  (req as { messages: { content: string | { text?: string }[] | null }[] }).messages
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join("\n")))
    .join("\n");
const toolNames = (req: unknown) => (req as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name);
/** 工具结果消息（不含模型自己的调用参数） */
const toolMessages = (req: unknown) => (req as { messages: { role: string; content: unknown }[] }).messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const STEPS = "先用工具查看需要的文件，确认后再作答；最终回答只输出 JSON 数组，不要用代码块包裹，不要加任何解释文字。";
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
    // 模型条目带 samplingParams（pi 并入每个请求体）：报告须如实写出
    await fake(Qs.flatMap((q) => readThenAnswer(q, JSON.stringify(q.answers))), { temperature: 0.2 });

    const report: Report = await runAll(opts({ sampleDir: p("sample") }));

    expect(report.summary).toEqual({ allCorrect: true, passed: Qs.map((q) => q.id), formatErrors: [], contentErrors: [], serviceFailures: [], limitExceeded: [] });
    expect(server!.errors).toEqual([]);
    expect(server!.requests).toHaveLength(10);
    const files = readdirSync(p("sample")).sort();
    Qs.forEach((q, i) => {
      const r = report.questions[i]!;
      const [first, second] = [server!.requests[2 * i], server!.requests[2 * i + 1]];
      // 只声明 read 与 grep；提示词里的“可用工具”与请求中的工具定义一致
      expect(toolNames(first)).toEqual(["read", "grep"]);
      expect(/可用工具：(.+)。/.exec(seen(first))?.[1]?.split("、")).toEqual(toolNames(first));
      // 新内存会话：首个请求只有系统提示与本题提示
      expect((first as { messages: unknown[] }).messages).toHaveLength(2);
      const prompt = seen(first);
      expect(prompt).toContain(q.question);
      expect(prompt).toContain(INSTRUCTION);
      expect(prompt).toContain(STEPS);
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
      expect(r.undeclaredCalls).toEqual([]);
      expect(r.modelRequests).toEqual({ count: null, aborted: null, usage: null, note: expect.stringMatching(/统一运行事件.*不含/) });
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
    // 10A3 运行条件
    const c = report.conditions;
    expect(new Date(c.startedAt).toISOString()).toBe(c.startedAt);
    expect(Date.parse(c.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(c.source).toEqual({
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }) !== "",
    });
    const cfg = JSON.parse(readFileSync(p("model/models.json"), "utf8")).providers.fake;
    expect(c.modelEntry).toEqual({
      provider: { baseUrl: cfg.baseUrl, api: cfg.api, apiKey: "<omitted>", compat: cfg.compat },
      model: cfg.models[0],
    });
    expect(JSON.stringify(report)).not.toContain(cfg.apiKey);
    expect(c.maxToolCalls).toBe(30);
    expect(c.tools).toEqual(["read", "grep"]);
    expect(c.thinking).toBe("off"); // 未给 --thinking：默认关闭
    expect(c.rg).toMatch(/^ripgrep \d+\.\d+\.\d+/);
    expect(c.questionTimeoutMs).toBe(120_000);
    // 报告写的采样参数与假服务收到的请求体一致：未设置的字段请求里确实没有
    expect(c.sampling).toMatchObject({ temperature: 0.2, top_p: null, maxTokens: cfg.models[0].maxTokens });
    for (const req of server!.requests as Record<string, unknown>[]) {
      expect(Object.keys(req).sort()).toEqual(["max_completion_tokens", "messages", "model", "stream", "stream_options", "temperature", "tools"]);
      expect(req.temperature).toBe(c.sampling.temperature);
      expect(req.max_completion_tokens).toBe(c.sampling.maxTokens);
    }
    expect(report.modelsConfigSha256).toBe(sha(readFileSync(p("model/models.json"))));
    expect(report.versions.questionsHash).toBe(qs.questionsHash);
    expect(report.versions.recorded).toEqual({ sampleRepoHash: qs.sampleRepoHash, questionsHash: qs.questionsHash });
    for (const f of ["scripts/t1-real-run.ts", "scripts/t1-grade.ts", "packages/engine-runner/src/main.ts", "packages/engine-client/src/engine-client.ts", "packages/engine-protocol/src/engine-messages.ts"])
      expect(report.versions.sources[f], f).toBe(sha(readFileSync(join(REPO, f))));
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe.sequential("t1-real-run：CLI、判分分类与只读拦截", () => {
  it("格式错误（带原因）与内容答错分开列出；未声明的 write 与 bash 得到 not found 且无副作用；越界 read 被拦截拒绝；未全对时退出非零", async () => {
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
      limitExceeded: [],
    });
    expect(report.versions.sampleRepoHash).toBe(qs.sampleRepoHash);
    expect(server!.errors).toEqual([]);
    expect(server!.requests).toHaveLength(8);
    // 未声明的工具由 pi 直接回 not found，不经过拦截；报告分两栏记录
    expect(report.questions[2]!.undeclaredCalls).toEqual([
      { toolName: "write", input: { path: p("written.txt"), content: "x" } },
      { toolName: "bash", input: { command: `touch ${p("bash.marker")}` } },
    ]);
    expect(report.questions[2]!.denials).toEqual([{ toolName: "read", input: { path: join(FX, "sample-repo-questions.json") } }]);
    expect(toolMessages(server!.requests[5])).toEqual([
      "Tool write not found",
      "Tool bash not found",
      expect.stringMatching(/仓库副本内.*read.*grep/),
    ]);
    // 副本外的标准答案文件没有被读到
    expect(seen(server!.requests[5])).not.toContain(qs.sampleRepoHash);
    expect(existsSync(p("written.txt"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300)); // detached 的 bash 若逃过拦截，touch 毫秒级完成
    expect(existsSync(p("bash.marker"))).toBe(false);
    expect(readdirSync(p("records")).sort()).toEqual(Qs.map((q) => `${q.id}.jsonl`).sort());
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("--max-tool-calls：越限的题单列为超出上限（不判分、不算服务故障），其余照常，退出 1", async () => {
    const rest = Qs.slice(0, -1);
    const q5 = Qs.at(-1)!;
    const bash = (id: string): ScriptedTurn => ({ kind: "toolCall", name: "bash", args: { command: "ls" }, id });
    // 越限的是未声明的 bash：pi 不经拦截就回 not found 并发出下一个请求；假服务挂住它，直到取消把它中止
    await fake([...rest.map((q): ScriptedTurn => ({ kind: "text", chunks: [JSON.stringify(q.answers)] })), bash("b1"), bash("b2"), { kind: "hang" }]);
    const { code, err } = await cli(["--models", p("model/models.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json"), "--max-tool-calls", "1"]);
    expect(code, err).toBe(1);
    const report: Report = JSON.parse(readFileSync(p("report.json"), "utf8"));
    expect(report.summary).toEqual({
      allCorrect: false,
      passed: rest.map((q) => q.id),
      formatErrors: [],
      contentErrors: [],
      serviceFailures: [],
      limitExceeded: [{ id: q5.id, reason: "tool calls exceeded --max-tool-calls 1" }],
    });
    expect(report.conditions.maxToolCalls).toBe(1);
    expect(server!.errors).toEqual([]);
    // 未声明工具：上限 1 + 2 = 3 个请求，最后一个（全局第 7 个）被中止
    expect(server!.requests).toHaveLength(4 + 3);
    expect(server!.aborted).toEqual([6]);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("参数缺失或 --max-tool-calls 非正整数：退出 2，不跑题", async () => {
    const { code, err } = await cli([]);
    expect(code).toBe(2);
    expect(err).toMatch(/required/);
    for (const n of ["0", "-1", "1.5", "abc"]) {
      const r = await cli(["--models", p("no-such.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json"), "--max-tool-calls", n]);
      expect(r.code, n).toBe(2);
      expect(r.err).toMatch(/max-tool-calls/);
    }
  }, 30_000);

  it("运行前出错（模型配置不存在）：stderr 说明原因，退出 3，与答错区分，不写报告", async () => {
    const { code, err } = await cli(["--models", p("no-such.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json")]);
    expect(code).toBe(3);
    expect(err).toMatch(/no-such\.json/);
    expect(existsSync(p("report.json"))).toBe(false);
  }, 20_000);
});

describe.sequential("t1-real-run：思考开启（--thinking）时判卷只读最终回答", () => {
  it("思考内容只在原始录制里：交给判卷的回答只有最终回答，报告不含思考；报告记录思考级别；请求开启思考", async () => {
    const MARK = "THINK-MARK-10a6";
    await fake(Qs.flatMap((q): ScriptedTurn[] => [
      { kind: "toolCall", name: "read", args: { path: q.target.path }, id: `c-${q.id}`, reasoning: [`${MARK} 先读 `, q.target.path] },
      { kind: "text", reasoning: [`${MARK} 推理：`, "调用位置在第几行"], chunks: [JSON.stringify(q.answers)] },
    ]));
    // 思考要生效，模型条目须 reasoning:true 加 qwen compat（否则 pi 把级别降为 off）
    const cfg = JSON.parse(readFileSync(p("model/models.json"), "utf8"));
    Object.assign(cfg.providers.fake.compat, { thinkingFormat: "qwen" });
    Object.assign(cfg.providers.fake.models[0], { reasoning: true });
    writeFileSync(p("model/models.json"), JSON.stringify(cfg));

    const { code, err } = await cli(["--models", p("model/models.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json"), "--thinking", "low"]);
    expect(code, err).toBe(0);
    const raw = readFileSync(p("report.json"), "utf8");
    const report: Report = JSON.parse(raw);
    expect(report.conditions.thinking).toBe("low");
    expect(report.summary.passed).toEqual(Qs.map((q) => q.id));
    Qs.forEach((q, i) => expect(report.questions[i]!.answer).toBe(JSON.stringify(q.answers)));
    expect(raw).not.toContain(MARK);
    expect(server!.errors).toEqual([]);
    for (const req of server!.requests) expect(req).toMatchObject({ enable_thinking: true });
    // 防空转：pi 确实把 reasoning_content 解析成了思考内容（录制里有 thinking 增量与带标记的 thinking 内容项）
    for (const q of Qs) {
      const rec = readFileSync(p("records", `${q.id}.jsonl`), "utf8");
      expect(rec).toContain('"type":"thinking_delta"');
      expect(rec).toMatch(new RegExp(`"type":"thinking","thinking":"${MARK}`));
    }
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("--thinking 非法值：runner 拒绝启动，各题记为服务故障，不发模型请求", async () => {
    await fake([]);
    const { code } = await cli(["--models", p("model/models.json"), "--model", "fake/fake-model", "--record-dir", p("records"), "--output", p("report.json"), "--thinking", "LOW"]);
    expect(code).toBe(1);
    const report: Report = JSON.parse(readFileSync(p("report.json"), "utf8"));
    expect(report.summary.serviceFailures.map((f) => f.id)).toEqual(Qs.map((q) => q.id));
    expect(report.questions[0]!.runner.stderr).toMatch(/^runner: --thinking /m);
    expect(server!.requests).toEqual([]);
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe.sequential("t1-real-run：每题工具调用刹车（tool.started 与拦截共用计数，按 callId 去重）", () => {
  it("已声明工具：一次 read 只计一次（上限 1 时放行）；越限的下一次 read 先取消再由拦截拒绝，请求数恰为上限 + 1，记为超出上限、不判分", async () => {
    const [q] = Qs as [Q];
    await fake([
      { kind: "toolCall", name: "read", args: { path: q.target.path }, id: "r0" },
      { kind: "toolCall", name: "read", args: { path: "notify.py" }, id: "r1" },
      { kind: "hang" }, // 若拒绝之后 pi 还发请求，会被挂住并记为中止
    ]);
    const r = await runQuestion(q, opts({ maxToolCalls: 1 }));
    expect(r.limitExceeded).toBe("tool calls exceeded --max-tool-calls 1");
    expect(r.serviceFailure).toBeUndefined();
    expect(r.grade).toBeUndefined();
    expect(r.terminal).toBe("run.cancelled");
    // r0 若被事件与拦截各计一次，会在上限 1 时就被拒
    expect(r.denials).toEqual([{ toolName: "read", input: { path: "notify.py" } }]);
    expect(toolMessages(server!.requests[1])[0]).toContain(readFileSync(join(FX, "sample-repo", q.target.path), "utf8").split("\n")[0]);
    expect(server!.requests).toHaveLength(1 + 1);
    expect(server!.aborted).toEqual([]);
    expect(server!.errors).toEqual([]);
    expect(r.runner).toMatchObject({ exitCode: 0, forced: false });
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it("反复调用未声明的 bash：每次都计数；越限后 pi 已发出的下一个请求被取消中止，请求数恰为上限 + 2，越限后没有工具执行，记为超出上限而不是服务故障", async () => {
    const bash = (i: number): ScriptedTurn => ({ kind: "toolCall", name: "bash", args: { command: `echo ${i}` }, id: `b${i}` });
    await fake([bash(1), bash(2), bash(3), { kind: "hang" }]);
    const r = await runQuestion(Qs[0]!, opts({ maxToolCalls: 2 }));
    expect(r.limitExceeded).toBe("tool calls exceeded --max-tool-calls 2");
    expect(r.serviceFailure).toBeUndefined();
    expect(r.grade).toBeUndefined();
    expect(r.terminal).toBe("run.cancelled");
    expect(r.denials).toEqual([]);
    expect(r.undeclaredCalls.map((c) => c.input)).toEqual([1, 2, 3].map((i) => ({ command: `echo ${i}` })));
    expect(server!.requests).toHaveLength(2 + 2);
    expect(server!.aborted).toEqual([3]);
    expect(server!.errors).toEqual([]);
    expect(r.runner).toMatchObject({ exitCode: 0, forced: false });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});

describe.sequential("t1-real-run：grep 接入（真实 pi grep 与 PATH 上的 rg）", () => {
  it("副本内 grep 带行号；工作目录没有可搜到的 git 元数据；glob 不扩大范围；越界 path 被拦截拒绝", async () => {
    const [q] = Qs as [Q];
    const grep = (args: object, id: string): ScriptedTurn => ({ kind: "toolCall", name: "grep", args, id });
    await fake([
      grep({ pattern: "def " }, "g1"),
      // .git/config 的固定键名：工作目录里若有 .git，rg --hidden 会搜到
      grep({ pattern: "repositoryformatversion" }, "g2"),
      // 基准仓库就在工作目录的兄弟目录 ../git 下
      grep({ pattern: "repositoryformatversion", glob: "../**" }, "g3"),
      grep({ pattern: "def ", path: "../git" }, "g4"),
      { kind: "text", chunks: [JSON.stringify(q.answers)] },
    ]);
    const r = await runQuestion(q, opts());
    expect(r.grade).toEqual({ passed: true, missing: [], extra: [] });
    expect(server!.errors).toEqual([]);
    const [g1, g2, g3, g4] = toolMessages(server!.requests[4]);
    expect(g1).toMatch(/^\w+\.py:\d+: def /m);
    expect(g2).toBe("No matches found");
    expect(g3).toBe("No matches found");
    expect(g4).toMatch(/仓库副本内.*read.*grep/);
    expect(r.denials).toEqual([{ toolName: "grep", input: { pattern: "def ", path: "../git" } }]);
    expect(r.undeclaredCalls).toEqual([]);
    expect(leftovers()).toEqual([]);
  }, 30_000);
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

  // 诊断文件是读端不读、已写满的 FIFO：runner 的录制写入与清理卡住、无法自行退出（与 runner-process 测试同一故障注入）
  it("runner 卡在退出：从最早的退出信号（超时取消）起按单调时钟计停止时限，到时强杀整个进程组并记为服务故障", async () => {
    const reader = fifoReader(p("records", `${Qs[0]!.id}.jsonl`));
    fillFifo(p("records", `${Qs[0]!.id}.jsonl`));
    await fake([{ kind: "text", chunks: ["[]"] }]);
    const r = await runQuestion(Qs[0]!, opts({ questionTimeoutMs: 3000, stopTimeoutMs: 1000 })).finally(() => closeSync(reader));
    expect(r.serviceFailure).toMatch(/^timed out after 3000 ms; runner force-killed/);
    expect(r.runner.forced).toBe(true);
    expect(r.runner.signal).toBe("SIGKILL");
    expect(r.runner.stopWaitMs).toBeGreaterThanOrEqual(1000);
    expect(r.runner.stopWaitMs).toBeLessThan(3000);
    expect(groupAlive(r.runner.pid!)).toBe(false);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  // 诊断文件是 FIFO，runner 打开写端后测试关闭读端：之后的录制写入得到 EPIPE，runner 清理失败，发 run.failed 并以 1 退出（9A 退出码契约）。
  // 模型回答分块慢发，写端打开（先于会话创建）到最后一次写入之间留出数百毫秒
  it("runner 非零退出（未超时）：记为服务故障并写明退出码，不判分", async () => {
    const reader = fifoReader(p("records", `${Qs[0]!.id}.jsonl`));
    await fake([{ kind: "text", chunks: ["[", "]"], chunkDelayMs: 300 }]);
    const run = runQuestion(Qs[0]!, opts());
    await writerOpened(reader);
    closeSync(reader);
    const r = await run;
    expect(r.serviceFailure).toMatch(/^run\.failed: cleanup failed: .*EPIPE.*; runner exited with code 1/);
    expect(r.grade).toBeUndefined();
    expect(r.runner).toMatchObject({ exitCode: 1, forced: false });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});
