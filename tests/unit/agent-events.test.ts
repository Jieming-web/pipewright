import { describe, expect, it } from "vitest";
import { AgentEventSchema, RunSnapshotSchema } from "../../packages/engine-protocol/src/index.js";

const sha = "a".repeat(64);
const snapshot = {
  engine: { name: "pi", version: "1.5.1" },
  model: { provider: "fake", id: "fake-model" },
  contextFiles: [{ repo: "r", path: "AGENTS.md", sourceCommit: "abc123", sha256: sha }],
};

describe("run.started snapshot 校验", () => {
  it("接受完整 snapshot", () => {
    expect(AgentEventSchema.safeParse({ type: "run.started", snapshot }).success).toBe(true);
    expect(RunSnapshotSchema.safeParse({ ...snapshot, contextFiles: [] }).success).toBe(true);
  });
  it.each([
    ["缺 engine", { ...snapshot, engine: undefined }],
    ["缺 model.id", { ...snapshot, model: { provider: "fake" } }],
    ["缺 contextFiles", { ...snapshot, contextFiles: undefined }],
    ["contextFile 缺 sourceCommit", { ...snapshot, contextFiles: [{ repo: "r", path: "p", sha256: sha }] }],
    ["sha256 太短", { ...snapshot, contextFiles: [{ ...snapshot.contextFiles[0], sha256: "abc" }] }],
    ["sha256 非十六进制", { ...snapshot, contextFiles: [{ ...snapshot.contextFiles[0], sha256: "z".repeat(64) }] }],
    ["sha256 大写", { ...snapshot, contextFiles: [{ ...snapshot.contextFiles[0], sha256: "A".repeat(64) }] }],
  ])("拒绝：%s", (_n, s) => {
    expect(AgentEventSchema.safeParse({ type: "run.started", snapshot: s }).success).toBe(false);
  });
});

describe("其他事件", () => {
  it("接受合法的进度与终止事件", () => {
    for (const e of [
      { type: "text.delta", text: "x" },
      { type: "message.completed", role: "assistant", text: "x" },
      { type: "tool.started", callId: "c", toolName: "read", input: { path: "a" } },
      { type: "tool.finished", callId: "c", toolName: "read", isError: false, output: { content: [] } },
      { type: "run.settled" },
      { type: "run.failed", reason: "boom" },
      { type: "run.cancelled" },
    ]) expect(AgentEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });
  it("拒绝未知类型与缺字段", () => {
    expect(AgentEventSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: "run.failed" }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: "message.completed", role: "user", text: "x" }).success).toBe(false);
  });
});

describe("model.request.finished", () => {
  const ok = { type: "model.request.finished", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
  it("接受合法事件（usage 可为 null，error 可带 errorMessage）", () => {
    expect(AgentEventSchema.safeParse(ok).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...ok, stopReason: "error", usage: null, errorMessage: "x" }).success).toBe(true);
  });
  it("拒绝未知 stopReason 与缺 usage", () => {
    expect(AgentEventSchema.safeParse({ ...ok, stopReason: "weird" }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...ok, usage: undefined }).success).toBe(false);
  });
});

