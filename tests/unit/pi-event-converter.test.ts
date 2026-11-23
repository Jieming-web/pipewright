import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertPiEvent } from "../../packages/engine-runner/src/pi-event-converter.js";
import type { ProgressEvent } from "../../packages/engine-protocol/src/index.js";

const FIX = join(import.meta.dirname, "../fixtures/pi-events");
const replay = (name: string): ProgressEvent[] =>
  readFileSync(join(FIX, `${name}.jsonl`), "utf8").trimEnd().split("\n")
    .flatMap((l) => convertPiEvent(JSON.parse(l)));
const deltas = (es: ProgressEvent[]) => es.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
const completed = (es: ProgressEvent[]) => es.flatMap((e) => (e.type === "message.completed" ? [e.text] : []));
const TERMINAL = ["run.settled", "run.failed", "run.cancelled"];

describe("convertPiEvent 重放 2B 样本", () => {
  it("text-only：增量拼接与完成消息一致", () => {
    const es = replay("text-only");
    expect(deltas(es)).toBe("Hello, world");
    expect(completed(es)).toEqual(["Hello, world"]);
  });

  it("tool-call-then-text：工具开始/结束按 callId 关联，output 保留结构", () => {
    const es = replay("tool-call-then-text");
    const started = es.find((e) => e.type === "tool.started");
    const finished = es.find((e) => e.type === "tool.finished");
    expect(started).toEqual({ type: "tool.started", callId: "call_fixture_1", toolName: "read", input: { path: "hello.txt" } });
    expect(finished).toMatchObject({ type: "tool.finished", callId: "call_fixture_1", toolName: "read", isError: false });
    expect((finished as any).output.content[0].text).toBe("hello from fixture\n");
    expect(JSON.parse(JSON.stringify(finished))).toEqual(finished);
    expect(deltas(es)).toBe("The file says hello.");
    // 只有工具调用没有文字的助手消息不产生 message.completed
    expect(completed(es)).toEqual(["The file says hello."]);
  });

  it("retry：中间失败不产生终止，最终文本只有 recovered", () => {
    const es = replay("retry");
    expect(es.some((e) => TERMINAL.includes(e.type))).toBe(false);
    expect(completed(es)).toEqual(["recovered"]);
    expect(deltas(es)).toBe("recovered");
  });

  it("retry-drop：失败尝试的 text.delta 不撤回，但 message.completed 只有 recovered", () => {
    const es = replay("retry-drop");
    expect(deltas(es)).toBe("partial-recovered");
    expect(completed(es)).toEqual(["recovered"]);
    expect(es.some((e) => TERMINAL.includes(e.type))).toBe(false);
  });

  it("不转换 user 消息的 message_end，也不依赖 partial", () => {
    expect(convertPiEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } })).toEqual([]);
    const ev = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab", partial: { content: [{ type: "text", text: "ZZZZ" }] } } };
    expect(convertPiEvent(ev)).toEqual([{ type: "text.delta", text: "ab" }]);
  });

  it("aborted 的助手消息不产生 message.completed", () => {
    const ev = { type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "x" }] } };
    expect(convertPiEvent(ev)).toEqual([]);
  });

  it("未知或畸形事件返回空数组，不抛错", () => {
    for (const raw of [null, undefined, 1, "x", [], {}, { type: "nope" }, { type: "agent_settled", aborted: false },
      { type: "agent_end", willRetry: true }, { type: "message_update" }, { type: "message_end" },
      { type: "tool_execution_start" }]) {
      expect(convertPiEvent(raw)).toEqual([]);
    }
  });

  it("全部样本都不产生终止事件", () => {
    for (const n of ["text-only", "tool-call-then-text", "retry", "retry-drop"])
      expect(replay(n).some((e) => TERMINAL.includes(e.type))).toBe(false);
  });
});
