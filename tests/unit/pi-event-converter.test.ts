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
// 10B 真实 API 样本：前两个思考关闭，run3 思考开启（low）；10C 本地 Ollama 样本思考关闭
const REAL_API_OFF = ["real-qwen-api-send-notice", "real-qwen-api-run2-normalize-name", "real-ollama-audit-event"];
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

  it("aborted 的助手消息不产生 message.completed（只有 model.request.finished）", () => {
    const ev = { type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "x" }] } };
    expect(convertPiEvent(ev).map((e) => e.type)).toEqual(["model.request.finished"]);
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
    // 思考原文的任何部分都不进入转换结果的任何事件、任何字段（先于下面的精确比较，泄漏时由这里报出）。
    // 思考里会引用文件原文，这些原文本来就在工具结果里：只查不出现在“去掉思考后的原始事件”中的片，它们若出现在输出里只能来自思考
    const strings = (v: unknown): string[] =>
      typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
    const withoutThinking = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(withoutThinking).filter((x) => x !== undefined)
      : v && typeof v === "object" ? (/^thinking/.test(String((v as any).type)) ? undefined : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutThinking(x)])))
      : v;
    const all = es.flatMap(strings).join("\0"); // \0 分隔，切片不会跨两个值匹配
    const legit = rawLines(n).map(withoutThinking).flatMap(strings).join("\0");
    let checked = 0;
    for (const t of thoughts) {
      expect(t.trim()).not.toBe("");
      // 全文切成不重叠的 20 字符片，末尾不足一片时另取最后 20 字符；更短的片（如 "."）会与正常输出撞上，不用
      const pieces = [...Array(Math.floor(t.length / 20)).keys()].map((i) => t.slice(i * 20, i * 20 + 20)).concat(t.slice(-20));
      for (const piece of pieces) {
        if (!piece.trim() || legit.includes(piece)) continue;
        checked++;
        expect(all, `thinking leaked: ${JSON.stringify(piece)}`).not.toContain(piece);
      }
    }
    expect(checked).toBeGreaterThan(50); // 三段思考共约 1.5k 字符、约 78 片，绝大多数是思考独有的
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

describe("convertPiEvent 重放 10C 本地 Ollama 样本（ollama/qwen3-4b-instruct-2507-ctx16k）", () => {
  it("audit-event：工具调用一次给全（单个 toolcall_delta），grep 开始/结束配对，完成消息与增量一致", () => {
    const n = "real-ollama-audit-event";
    const toolDeltas = rawLines(n).filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_delta");
    expect(toolDeltas).toHaveLength(1);
    const es = replay(n);
    const started = es.filter((e) => e.type === "tool.started");
    const finished = es.filter((e) => e.type === "tool.finished") as any[];
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ toolName: "grep", input: { pattern: "audit_event\\s*\\(", path: "." } });
    expect(finished.map((e) => [e.callId, e.isError])).toEqual([[started[0].callId, false]]);
    expect(finished[0].output.content[0].text.split("\n")).toContain('orders.py:9:     audit.audit_event("order", user)');
    for (const e of es) expect(ProgressEventSchema.safeParse(JSON.parse(JSON.stringify(e))).success).toBe(true);
    expect(completed(es)).toEqual(['[{"path":"notify.py","line":5},{"path":"orders.py","line":9}]']);
    expect(deltas(es)).toBe(completed(es)[0]);
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
    expect(es).toEqual([{ type: "text.delta", text: "[]" }, { type: "model.request.finished", stopReason: "stop", usage: null }, { type: "message.completed", role: "assistant", text: "[]" }]);
  });

  it("只有 thinking、没有 text 的助手消息（如思考后直接调用工具）不产生 message.completed", () => {
    expect(convertPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "x" }] } }).map((e) => e.type)).toEqual(["model.request.finished"]);
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

describe("model.request.finished", () => {
  const finished = (es: ProgressEvent[]) => es.filter((e): e is Extract<ProgressEvent, { type: "model.request.finished" }> => e.type === "model.request.finished");
  const U1 = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  it("retry：失败尝试 usage 为 null 且带 errorMessage，随后一条 stop", () => {
    const f = finished(replay("retry"));
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ stopReason: "error", usage: null });
    expect(f[0]!.errorMessage).toEqual(expect.any(String));
    expect(f[1]).toEqual({ type: "model.request.finished", stopReason: "stop", usage: U1 });
  });
  it("tool-call-then-text：toolUse 与 stop 各一条", () => {
    expect(finished(replay("tool-call-then-text")).map((e) => [e.stopReason, e.usage])).toEqual([["toolUse", U1], ["stop", U1]]);
  });
  const msg = (m: object) => convertPiEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", ...m } });
  it("用量全 0、缺失 → null；reasoning 缺失 → 0；errorMessage 截断 500 且只在 error 出现", () => {
    expect(msg({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })[0]).toMatchObject({ usage: null });
    expect(msg({})[0]).toMatchObject({ stopReason: "aborted", usage: null });
    expect(msg({ usage: { input: 0, output: 0, cacheRead: 3, cacheWrite: 0 } })[0]).toMatchObject({ usage: { cacheRead: 3, reasoning: 0 } });
    const e = msg({ stopReason: "error", errorMessage: "x".repeat(900) })[0] as any;
    expect(e.errorMessage).toHaveLength(500);
    expect("errorMessage" in (msg({ errorMessage: "ignored" })[0] as object)).toBe(false);
  });
  // 校验 pi/供应商的计费口径（reasoning 已含在 output 内、总量含缓存读取），不是转换器逻辑；作者要求保留
  it("真实录制 run3：reasoning 已含在 output 内，input+cacheRead+output = totalTokens", () => {
    const n = "real-qwen-api-run3-thinking-send-notice";
    const raws = rawLines(n).filter((r) => r.type === "message_end" && r.message.role === "assistant" && r.message.usage.totalTokens > 0);
    expect(raws.length).toBeGreaterThan(0);
    const f = finished(replay(n)).filter((e) => e.usage);
    expect(f).toHaveLength(raws.length);
    f.forEach((e, i) => {
      const u = e.usage!, t = raws[i].message.usage;
      expect(u.reasoning).toBeGreaterThan(0);
      expect(u.reasoning).toBeLessThanOrEqual(u.output);
      expect(t.input + t.cacheRead + t.output).toBe(t.totalTokens);
      expect(u).toEqual({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, reasoning: t.reasoning });
    });
  });
});

