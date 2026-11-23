import { describe, expect, it } from "vitest";
import { createRunEvents } from "../../packages/engine-runner/src/run-events.js";
import type { SequencedEvent } from "../../packages/engine-protocol/src/index.js";

const snapshot = { engine: { name: "pi", version: "1" }, model: { provider: "p", id: "m" }, contextFiles: [] };
function setup() {
  const out: SequencedEvent[] = [];
  const r = createRunEvents("s1", (e) => out.push(e), () => new Date("2026-01-01T00:00:00.000Z"));
  return { out, ...r };
}

describe("createRunEvents", () => {
  it("started/文本/工具/终止共享一个序号，从 1 连续递增，带 sessionId 与 ISO at", () => {
    const { out, publish, finish } = setup();
    publish({ type: "run.started", snapshot });
    publish({ type: "text.delta", text: "a" });
    publish({ type: "tool.started", callId: "c", toolName: "read", input: {} });
    publish({ type: "tool.finished", callId: "c", toolName: "read", isError: false, output: "ok" });
    finish({ type: "run.settled" });
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(out.map((e) => e.type)).toEqual(["run.started", "text.delta", "tool.started", "tool.finished", "run.settled"]);
    expect(out.every((e) => e.sessionId === "s1" && e.at === "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("只发一次终止，重复 finish 被忽略", () => {
    const { out, finish } = setup();
    finish({ type: "run.failed", reason: "x" });
    finish({ type: "run.settled" });
    finish({ type: "run.cancelled" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "run.failed", reason: "x", seq: 1 });
  });

  it("终止后 publish 无效", () => {
    const { out, publish, finish } = setup();
    publish({ type: "text.delta", text: "a" });
    finish({ type: "run.cancelled" });
    publish({ type: "text.delta", text: "late" });
    expect(out.map((e) => e.type)).toEqual(["text.delta", "run.cancelled"]);
  });

  it("默认时钟产生 ISO 时间", () => {
    const out: SequencedEvent[] = [];
    createRunEvents("s", (e) => out.push(e)).publish({ type: "text.delta", text: "a" });
    expect(new Date(out[0].at).toISOString()).toBe(out[0].at);
  });
});
