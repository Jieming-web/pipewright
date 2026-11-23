import { describe, expect, it } from "vitest";
import {
  SequencedEventSchema,
  parseClientMessage,
  parseRunnerMessage,
} from "../../packages/engine-protocol/src/index.js";

const file = (repo: string, path: string) => ({ repo, path, content: "x", sourceCommit: "abc123" });
const start = (over: Record<string, unknown> = {}) => ({
  type: "start_task",
  requestId: "A",
  sessionId: "s1",
  prompt: "do it",
  model: { provider: "fake", id: "m" },
  contextFiles: [file("r1", "AGENTS.md")],
  interceptMode: "callback",
  ...over,
});
const j = JSON.stringify;
const okClient = (m: unknown) => parseClientMessage(j(m)).ok;
const okRunner = (m: unknown) => parseRunnerMessage(j(m)).ok;

describe("start_task", () => {
  it("接受完整消息、空 contextFiles、可选 resume/sessionDir", () => {
    expect(okClient(start())).toBe(true);
    expect(okClient(start({ contextFiles: [] }))).toBe(true);
    expect(okClient(start({ resume: { sessionFileRef: "f" }, sessionDir: "/tmp/x", interceptMode: "policy" }))).toBe(true);
  });
  it("多仓库同名文件合法", () => {
    expect(okClient(start({ contextFiles: [file("r1", "AGENTS.md"), file("r2", "AGENTS.md")] }))).toBe(true);
  });
  it("同 repo 同 path 重复被拒", () => {
    const r = parseClientMessage(j(start({ contextFiles: [file("r1", "a.md"), file("r1", "a.md")] })));
    expect(r.ok).toBe(false);
  });
  it.each([
    ["缺 contextFiles", { contextFiles: undefined }],
    ["缺 prompt", { prompt: undefined }],
    ["空 prompt", { prompt: "" }],
    ["空 requestId", { requestId: "" }],
    ["空 sessionId", { sessionId: "" }],
    ["缺 model.id", { model: { provider: "p" } }],
    ["空 model.provider", { model: { provider: "", id: "m" } }],
    ["非法 interceptMode", { interceptMode: "x" }],
    ["空 sessionFileRef", { resume: { sessionFileRef: "" } }],
    ["repo 含 /", { contextFiles: [file("a/b", "p")] }],
    ["空 repo", { contextFiles: [file("", "p")] }],
    ["空 sourceCommit", { contextFiles: [{ ...file("r", "p"), sourceCommit: "" }] }],
    ["绝对路径", { contextFiles: [file("r", "/etc/passwd")] }],
    ["含 .. 段", { contextFiles: [file("r", "a/../../b")] }],
    ["以 .. 开头", { contextFiles: [file("r", "../b")] }],
    ["反斜杠", { contextFiles: [file("r", "a\\b")] }],
    ["空 path", { contextFiles: [file("r", "")] }],
    ["./ 开头", { contextFiles: [file("r", "./a")] }],
    ["// 空段", { contextFiles: [file("r", "a//b")] }],
    ["尾部 /", { contextFiles: [file("r", "a/")] }],
    ["单独 .", { contextFiles: [file("r", "a/./b")] }],
    ["NUL", { contextFiles: [file("r", "a\u0000b")] }],
    ["Windows 盘符", { contextFiles: [file("r", "C:foo")] }],
    ["Windows 盘符斜杠", { contextFiles: [file("r", "C:/foo")] }],
    ["纯空白 prompt", { prompt: "   " }],
    ["纯空白 sourceCommit", { contextFiles: [{ ...file("r", "p"), sourceCommit: " " }] }],
  ])("拒绝：%s", (_n, over) => {
    expect(okClient(start(over))).toBe(false);
  });
  it("文件名含 .. 子串但不是段则合法", () => {
    expect(okClient(start({ contextFiles: [file("r", "a..b/c.md")] }))).toBe(true);
  });
});

describe("补充规则", () => {
  it("content 允许空串", () => {
    expect(okClient(start({ contextFiles: [{ ...file("r", "p"), content: "" }] }))).toBe(true);
  });
  it("未知字段被忽略，不出现在结果中", () => {
    const r = parseClientMessage(j({ type: "cancel", requestId: "A", extra: 1 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual({ type: "cancel", requestId: "A" });
  });
  it("纯空白的 reason / by 被拒", () => {
    expect(okClient({ type: "intercept_decision", requestId: "A", callId: "c", decision: "block", reason: "  " })).toBe(false);
    expect(okClient({ type: "confirm_response", requestId: "A", confirmId: "k", approved: true, by: " " })).toBe(false);
    expect(okClient({ type: "confirm_response", requestId: "A", confirmId: "k", approved: false, by: "t", reason: " " })).toBe(false);
  });
  it("input 键必须存在（null 可以）", () => {
    expect(okRunner({ type: "intercept_request", callId: "c", toolName: "bash" })).toBe(false);
    expect(okRunner({ type: "intercept_request", callId: "c", toolName: "bash", input: null })).toBe(true);
    expect(okRunner({ type: "confirm_request", confirmId: "k", callId: "c", toolName: "b", reason: "r" })).toBe(false);
    const ev = { sessionId: "s", seq: 1, at: "2026-11-09T00:00:00Z" };
    expect(SequencedEventSchema.safeParse({ ...ev, type: "tool.started", callId: "c", toolName: "t" }).success).toBe(false);
    expect(SequencedEventSchema.safeParse({ ...ev, type: "tool.started", callId: "c", toolName: "t", input: null }).success).toBe(true);
  });
  it("(repo,path) 重复被拒，包括同名不同写法已被路径规则拒绝", () => {
    expect(okClient(start({ contextFiles: [file("r", "a.md"), file("r", "./a.md")] }))).toBe(false);
  });
  it("错误信息指出失败字段", () => {
    const r = parseClientMessage(j(start({ sessionId: undefined })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sessionId");
  });
});

describe("非法输入不抛异常", () => {
  it.each(["not json", "", "null", "[]", "42", '{"type":"nope"}', "{}"])("%j", (raw) => {
    for (const p of [parseClientMessage, parseRunnerMessage]) {
      const r = p(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe("intercept_decision / confirm_response / cancel", () => {
  const dec = (d: Record<string, unknown>) => ({ type: "intercept_decision", requestId: "A", callId: "c1", ...d });
  it("allow 无需 reason；block/confirm 需非空 reason", () => {
    expect(okClient(dec({ decision: "allow" }))).toBe(true);
    expect(okClient(dec({ decision: "block", reason: "no" }))).toBe(true);
    expect(okClient(dec({ decision: "confirm", reason: "rm -rf" }))).toBe(true);
    expect(okClient(dec({ decision: "block" }))).toBe(false);
    expect(okClient(dec({ decision: "block", reason: "" }))).toBe(false);
    expect(okClient(dec({ decision: "confirm" }))).toBe(false);
    expect(okClient(dec({ decision: "maybe" }))).toBe(false);
    expect(okClient(dec({ decision: "allow", callId: "" }))).toBe(false);
  });
  const conf = (d: Record<string, unknown>) => ({ type: "confirm_response", requestId: "A", confirmId: "k1", ...d });
  it("确认：批准可无 reason；拒绝必须有 reason；by 必填", () => {
    expect(okClient(conf({ approved: true, by: "tester" }))).toBe(true);
    expect(okClient(conf({ approved: false, by: "tester", reason: "unsafe" }))).toBe(true);
    expect(okClient(conf({ approved: false, by: "tester" }))).toBe(false);
    expect(okClient(conf({ approved: false, by: "tester", reason: "" }))).toBe(false);
    expect(okClient(conf({ approved: true }))).toBe(false);
    expect(okClient(conf({ approved: true, by: "" }))).toBe(false);
    expect(okClient(conf({ by: "t" }))).toBe(false);
  });
  it("cancel", () => {
    expect(okClient({ type: "cancel", requestId: "A" })).toBe(true);
    expect(okClient({ type: "cancel" })).toBe(false);
    expect(okClient({ type: "cancel", requestId: "" })).toBe(false);
  });
});

describe("runner 消息", () => {
  const ev = { type: "run.settled", sessionId: "s1", seq: 1, at: "2026-11-09T00:00:00.000Z" };
  it("accepted / event / intercept_request / confirm_request / error", () => {
    expect(okRunner({ type: "accepted", requestId: "A", sessionId: "s1" })).toBe(true);
    expect(okRunner({ type: "accepted", requestId: "A" })).toBe(false);
    expect(okRunner({ type: "event", event: ev })).toBe(true);
    expect(okRunner({ type: "event", event: { ...ev, seq: 0 } })).toBe(false);
    expect(okRunner({ type: "event", event: { ...ev, sessionId: "" } })).toBe(false);
    expect(okRunner({ type: "event", event: { ...ev, at: "yesterday" } })).toBe(false);
    expect(okRunner({ type: "event", event: { ...ev, at: "2026-11-09T08:00:00+08:00" } })).toBe(false);
    expect(okRunner({ type: "event", event: { type: "run.settled" } })).toBe(false);
    expect(okRunner({ type: "intercept_request", callId: "c", toolName: "bash", input: { command: "ls" } })).toBe(true);
    expect(okRunner({ type: "intercept_request", callId: "c", toolName: "" })).toBe(false);
    expect(okRunner({ type: "confirm_request", confirmId: "k", callId: "c", toolName: "bash", reason: "r", input: 1 })).toBe(true);
    expect(okRunner({ type: "confirm_request", confirmId: "k", callId: "c", toolName: "bash", input: 1 })).toBe(false);
  });
  it("error：requestId 可选，code 受限", () => {
    expect(okRunner({ type: "error", code: "invalid_message", message: "bad" })).toBe(true);
    expect(okRunner({ type: "error", requestId: "A", code: "stale_response", message: "late" })).toBe(true);
    expect(okRunner({ type: "error", code: "boom", message: "x" })).toBe(false);
    expect(okRunner({ type: "error", code: "internal", message: "" })).toBe(false);
  });
  it("SequencedEventSchema 直接可用", () => {
    expect(SequencedEventSchema.safeParse(ev).success).toBe(true);
    expect(SequencedEventSchema.safeParse({ ...ev, seq: 1.5 }).success).toBe(false);
  });
});

describe("双向校验", () => {
  const client = [
    start(),
    { type: "intercept_decision", requestId: "A", callId: "c", decision: "allow" },
    { type: "confirm_response", requestId: "A", confirmId: "k", approved: true, by: "t" },
    { type: "cancel", requestId: "A" },
  ];
  const runner = [
    { type: "accepted", requestId: "A", sessionId: "s" },
    { type: "event", event: { type: "run.settled", sessionId: "s", seq: 1, at: "2026-11-09T00:00:00Z" } },
    { type: "intercept_request", callId: "c", toolName: "bash", input: {} },
    { type: "confirm_request", confirmId: "k", callId: "c", toolName: "bash", reason: "r", input: {} },
    { type: "error", code: "internal", message: "m" },
  ];
  it("每个方向的消息只被本方向解析器接受", () => {
    for (const m of client) {
      expect(okClient(m)).toBe(true);
      expect(okRunner(m)).toBe(false);
    }
    for (const m of runner) {
      expect(okRunner(m)).toBe(true);
      expect(okClient(m)).toBe(false);
    }
  });
});

describe("requestId 形状", () => {
  // 仅校验形状：第二次 start_task 有自己的 requestId，error{already_running} 回显同一个 id，二者都能解析。
  // 真实的关联行为（runner 回显）在 T1-9A 测试。
  it("start_task(B) 与 error{requestId:B, already_running} 均可解析且 id 一致，不同于首次 A", () => {
    const first = parseClientMessage(j(start({ requestId: "A" })));
    const second = parseClientMessage(j(start({ requestId: "B" })));
    const err = parseRunnerMessage(j({ type: "error", requestId: "B", code: "already_running", message: "task running" }));
    expect(first.ok && second.ok && err.ok).toBe(true);
    if (first.ok && second.ok && err.ok && err.message.type === "error" && second.message.type === "start_task" && first.message.type === "start_task") {
      expect(err.message.requestId).toBe(second.message.requestId);
      expect(err.message.requestId).not.toBe(first.message.requestId);
    }
  });
});
