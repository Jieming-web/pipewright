import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertPiEvent } from "../../packages/engine-runner/src/pi-event-converter.js";
import { ProgressEventSchema, type ProgressEvent } from "../../packages/engine-protocol/src/index.js";

const FIX = join(import.meta.dirname, "../fixtures/pi-events");
const replay = (name: string): ProgressEvent[] =>
  readFileSync(join(FIX, `${name}.jsonl`), "utf8").trimEnd().split("\n")
    .flatMap((l) => convertPiEvent(JSON.parse(l)));
const deltas = (es: ProgressEvent[]) => es.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
const completed = (es: ProgressEvent[]) => es.flatMap((e) => (e.type === "message.completed" ? [e.text] : []));
const TERMINAL = ["run.settled", "run.failed", "run.cancelled"];
// 10B 真实 API 样本：前两个思考关闭，run3 思考开启（low）
const REAL_API_OFF = ["real-qwen-api-send-notice", "real-qwen-api-run2-normalize-name"];
const REAL_API = [...REAL_API_OFF, "real-qwen-api-run3-thinking-send-notice"];
const rawLines = (name: string): any[] =>
  readFileSync(join(FIX, `${name}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

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
    for (const n of ["text-only", "tool-call-then-text", "retry", "retry-drop", ...REAL_API])
      expect(replay(n).some((e) => TERMINAL.includes(e.type))).toBe(false);
  });
});

describe("convertPiEvent 重放 10B 真实 API 样本（qwen-api/qwen3.6-35b-a3b）", () => {
  it("send-notice：bash 被拒后改用 read，工具开始/结束按 callId 配对，完成消息与增量一致", () => {
    const es = replay("real-qwen-api-send-notice");
    const started = es.filter((e) => e.type === "tool.started");
    const finished = es.filter((e) => e.type === "tool.finished");
    expect(started.map((e) => e.toolName)).toEqual(["bash", ...Array(9).fill("read")]);
    expect(new Set(finished.map((e) => e.callId))).toEqual(new Set(started.map((e) => e.callId)));
    const denied = finished.find((e) => e.callId === started[0].callId) as any;
    expect(denied).toMatchObject({ toolName: "bash", isError: true });
    expect(denied.output.content[0].text).toBe("此任务不提供 bash，请使用 read 读取文件");
    expect(finished.filter((e) => e.toolName === "read").every((e) => !(e as any).isError)).toBe(true);
    expect(started[1]).toMatchObject({ toolName: "read", input: { path: "notify.py" } });
    for (const e of es) expect(ProgressEventSchema.safeParse(JSON.parse(JSON.stringify(e))).success).toBe(true);
    expect(completed(es)).toEqual(['[{"path":"orders.py","line":7}]']);
    expect(deltas(es)).toBe('[{"path":"orders.py","line":7}]');
  });

  it("run2-normalize-name：grep 结果带行号；文本与工具调用同在一条消息时也产生 message.completed", () => {
    const es = replay("real-qwen-api-run2-normalize-name");
    const started = es.filter((e) => e.type === "tool.started");
    const finished = es.filter((e) => e.type === "tool.finished") as any[];
    expect(started.map((e) => e.toolName)).toEqual(["grep", "read", "read", "read", "read"]);
    expect(started[0]).toMatchObject({ input: { pattern: "normalize_name" } });
    expect(new Set(finished.map((e) => e.callId))).toEqual(new Set(started.map((e) => e.callId)));
    expect(finished.every((e) => e.isError === false)).toBe(true);
    const grep = finished.find((e) => e.toolName === "grep");
    expect(grep.output.content[0].text.split("\n")).toContain("cli.py:7:     name = normalize_name(argv[2])");
    for (const e of es) expect(ProgressEventSchema.safeParse(JSON.parse(JSON.stringify(e))).success).toBe(true);
    const texts = completed(es);
    expect(texts).toHaveLength(3); // 两条“文本 + read”的中间消息，加最终回答
    expect(texts[2].endsWith('[{"path":"cli.py","line":7},{"path":"billing.py","line":9}]')).toBe(true);
    expect(deltas(es)).toBe(texts.join(""));
  });

  it("run3-thinking-send-notice：thinking 不进入 text.delta 与 message.completed，最终回答只有 JSON", () => {
    const n = "real-qwen-api-run3-thinking-send-notice";
    const es = replay(n);
    const started = es.filter((e) => e.type === "tool.started");
    expect(started.map((e) => e.toolName)).toEqual(["read", "grep", "read", "read"]);
    for (const e of es) expect(ProgressEventSchema.safeParse(JSON.parse(JSON.stringify(e))).success).toBe(true);
    // 样本内容：每次请求都有 thinking 内容项且 reasoning 用量 > 0
    const ends = rawLines(n).filter((e) => e.type === "message_end" && e.message.role === "assistant").map((e) => e.message);
    expect(ends).toHaveLength(3);
    const thoughts = ends.flatMap((m) => m.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking as string));
    expect(thoughts).toHaveLength(3);
    for (const m of ends) expect(m).toMatchObject({ thinkingLevel: "low", usage: { reasoning: expect.any(Number) } });
    expect(ends.every((m) => m.usage.reasoning > 0)).toBe(true);
    // 思考原文的任何部分都不进入文本事件：整段按 20 字符切片逐片检查（先于下面的精确比较，泄漏时由这里报出）
    const texts = es.flatMap((e) => (e.type === "text.delta" || e.type === "message.completed" ? [e.text] : [])).join("\n");
    for (const t of thoughts) {
      const pieces = [...Array(Math.ceil(t.length / 20)).keys()].map((i) => t.slice(i * 20, i * 20 + 20)).concat(t.slice(-20)); // 末尾不足 20 的片段另用最后 20 字符覆盖
      for (const piece of pieces)
        if (piece.trim().length >= 10) expect(texts, `thinking leaked: ${JSON.stringify(piece)}`).not.toContain(piece);
    }
    expect(completed(es)).toEqual(['[{"path": "orders.py", "line": 8}]']);
    expect(deltas(es)).toBe('[{"path": "orders.py", "line": 8}]');
  });

  it("样本内容核对（思考关闭的样本）：没有 thinking 流事件，助手消息只有 text/toolCall，reasoning 用量为 0，thinkingLevel 为 off", () => {
    for (const n of REAL_API_OFF) {
      const raws = rawLines(n);
      const updates = raws.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent.type);
      expect(updates.some((t: string) => /thinking/.test(t))).toBe(false);
      const ends = raws.filter((e) => e.type === "message_end" && e.message.role === "assistant").map((e) => e.message);
      expect(ends.length).toBeGreaterThan(0);
      for (const m of ends) {
        expect(m.content.every((c: any) => c.type === "text" || c.type === "toolCall")).toBe(true);
        expect(m.usage.reasoning).toBe(0);
        expect(m.thinkingLevel).toBe("off");
      }
    }
  });
});

describe("思考开启（engine.md 思考级别：思考内容不进入最终回答文本）", () => {
  it("thinking 增量不产生 text.delta；message.completed 只拼 text 内容项，不含 thinking", () => {
    const es = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "THINK-MARK 推理" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "THINK-MARK 推理" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "[]" } },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "THINK-MARK 推理" }, { type: "text", text: "[]" }] },
      },
    ].flatMap((e) => convertPiEvent(e));
    expect(es).toEqual([{ type: "text.delta", text: "[]" }, { type: "message.completed", role: "assistant", text: "[]" }]);
  });

  it("只有 thinking、没有 text 的助手消息（如思考后直接调用工具）不产生 message.completed", () => {
    expect(convertPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "x" }] } })).toEqual([]);
  });
});

describe("工具事件空值归一", () => {
  it("缺 args / result 时输出 null，且经 JSON 往返后仍通过 schema", () => {
    const es = [
      ...convertPiEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "t" } as never),
      ...convertPiEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "t", isError: false } as never),
    ];
    expect(es).toHaveLength(2);
    expect(es[0]).toMatchObject({ type: "tool.started", input: null });
    expect(es[1]).toMatchObject({ type: "tool.finished", output: null });
    for (const e of es) {
      expect(ProgressEventSchema.safeParse(JSON.parse(JSON.stringify(e))).success).toBe(true);
    }
  });
});
