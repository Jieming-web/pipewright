import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFile, summarizeDir } from "../../scripts/t1-usage.js";

const FIX = join(import.meta.dirname, "../fixtures/pi-events");
const count = (name: string) => countFile(name, readFileSync(join(FIX, `${name}.jsonl`), "utf8"));
const end = (stopReason: string, usage?: object, errorMessage?: string) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason, ...(usage ? { usage } : {}), ...(errorMessage ? { errorMessage } : {}) } });
const req = (input: number, cacheRead: number, output: number, stopReason = "toolUse", cacheWrite = 0) =>
  end(stopReason, { input, cacheRead, cacheWrite, output, totalTokens: input + cacheRead + cacheWrite + output });
const toolResult = (chars: number) => JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(chars) }] } });
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
// pi 1.5.1 对 Ollama HTTP 400 的真实记录（10C 返修 1 经 pi 实测）：stopReason error、用量全 0
const EXCEEDED = '400: {"message":"request (18988 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"invalid_request_error","param":null,"code":null}';

describe("countFile: one request = one assistant message_end", () => {
  it("text-only: one request, usage summed", () => {
    expect(count("text-only")).toMatchObject({ requests: 1, aborted: 0, errored: 0, usage: { input: 1, output: 1, total: 2 } });
  });
  it("tool-call-then-text: each tool round plus the final answer is a request; updates/turn_end/agent_end are not", () => {
    expect(count("tool-call-then-text").requests).toBe(2);
    expect(count("real-qwen-api-send-notice")).toMatchObject({
      requests: 5,
      usage: { input: 1904 + 2029 + 2110 + 2666 + 2770, output: 97 + 24 + 175 + 24 + 11, total: 2001 + 2053 + 2285 + 2690 + 2781 },
    });
  });
  it("retry: the failed attempt and the retry each count; the failed one is errored with zero usage", () => {
    expect(count("retry")).toMatchObject({ requests: 2, errored: 1, aborted: 0 });
    expect(count("retry-drop")).toMatchObject({ requests: 2, errored: 1 });
  });
  it("aborted: counted as aborted, usage added when present, otherwise reported as missing", () => {
    const r = countFile("x", [end("aborted", { input: 5, output: 2, totalTokens: 7 }), end("aborted")].join("\n"));
    expect(r).toMatchObject({ requests: 2, aborted: 2, usageMissing: 1, usage: { input: 5, output: 2, total: 7 } });
  });
  it("stop reasons: counted per value (length = output limit hit) and the file's last request's stop reason is reported", () => {
    const r = countFile("x", [end("toolUse"), end("length"), end("toolUse"), end("stop")].join("\n"));
    expect(r.stopReasons).toEqual({ toolUse: 2, length: 1, stop: 1 });
    expect(r.lastStopReason).toBe("stop");
    expect(countFile("y", [end("toolUse"), end("length")].join("\n")).lastStopReason).toBe("length");
  });
  it("stop reasons: a missing stopReason is counted as \"missing\"; no requests means lastStopReason null", () => {
    const noReason = JSON.stringify({ type: "message_end", message: { role: "assistant" } });
    expect(countFile("x", noReason)).toMatchObject({ stopReasons: { missing: 1 }, lastStopReason: "missing" });
    expect(countFile("x", "")).toMatchObject({ requests: 0, stopReasons: {}, lastStopReason: null });
  });
  it("ignores non-assistant message_end and tolerates blank lines", () => {
    const tr = JSON.stringify({ type: "message_end", message: { role: "toolResult" } });
    expect(countFile("x", `${tr}\n\n${end("stop")}\n`).requests).toBe(1);
  });
  it("valid JSON that is not an object (null, 5, string): throws with file name and line number", () => {
    for (const bad of ["null", "5", '"x"']) expect(() => countFile("bad", `${end("stop")}\n${bad}`)).toThrow(/bad.*line 2/);
  });
  it("corrupted line: throws with file name and line number", () => {
    expect(() => countFile("bad", `${end("stop")}\n{oops`)).toThrow(/bad.*line 2/);
  });
});

describe("countFile: context overflow (10C)", () => {
  it("normal multi-request real files are not flagged (prompt grows, cache prefix chain intact)", () => {
    for (const n of ["real-ollama-audit-event", "real-qwen-api-send-notice", "real-qwen-api-run2-normalize-name", "real-qwen-api-run3-thinking-send-notice"])
      expect(countFile(n, readFileSync(join(FIX, `${n}.jsonl`), "utf8"), 16384).overflow).toEqual({ exceededError: [], promptDecrease: [], cacheReadDrop: [], outputOverWindow: [], possibleOverflowUnverified: [] });
  });
  it("silent drop: a request whose input + cacheRead is lower than the previous one is flagged; cacheRead collapse is the supporting signal", () => {
    const r = countFile("x", [req(1408, 0, 47), req(57, 1410, 43), req(600, 12, 30, "stop")].join("\n"));
    expect(r.overflow).toMatchObject({ promptDecrease: [3], cacheReadDrop: [3] });
  });
  it("cacheRead collapse alone (prompt still grew) is reported only as the supporting signal", () => {
    const r = countFile("x", [req(34, 0, 2), req(6633, 12, 4, "stop")].join("\n"));
    expect(r.overflow).toMatchObject({ promptDecrease: [], cacheReadDrop: [2] });
  });
  it("real pre-check (b) numbers: prompt 1,391 → cacheRead 1,250 with prompt total 12,770 is caught by the auxiliary (main criterion masked by the new tool result)", () => {
    const r = countFile("x", [req(722, 669, 42), req(11520, 1250, 20, "stop")].join("\n"));
    expect(r.overflow).toMatchObject({ promptDecrease: [], cacheReadDrop: [2] });
  });
  it("normal Ollama sequence 1408→1410 and 1467→1509 (pre-check (a)) is not flagged", () => {
    const r = countFile("x", [req(1408, 0, 47), req(57, 1410, 43), req(69, 1509, 31, "stop")].join("\n"), 16384);
    expect(r.overflow).toEqual({ exceededError: [], promptDecrease: [], cacheReadDrop: [], outputOverWindow: [], possibleOverflowUnverified: [] });
  });
  it("prompt total includes cacheWrite: a cache-miss rewrite is not a false promptDecrease", () => {
    const r = countFile("x", [req(100, 1400, 40), req(50, 0, 30, "stop", 1600)].join("\n"));
    expect(r.overflow.promptDecrease).toEqual([]); // input+cacheRead 50 < 1500 would have looked like a drop
  });
  it("an all-zero usage request (server did not report) is skipped: not a decrease, and the chain continues", () => {
    const r = countFile("x", [req(1400, 0, 40), end("stop", ZERO), req(10, 1440, 5, "stop")].join("\n"), 16384);
    expect(r.overflow).toEqual({ exceededError: [], promptDecrease: [], cacheReadDrop: [], outputOverWindow: [], possibleOverflowUnverified: [] });
  });
  it("pre-check (b) aborted request (numbers from the recording): estimate 1,391 + 42 + 76,046/3 > 16,384 → possible overflow, unverified", () => {
    const text = [req(722, 669, 42), toolResult(38024), toolResult(38022), end("aborted", ZERO)].join("\n");
    expect(countFile("x", text, 16384)).toMatchObject({ aborted: 1, overflow: { possibleOverflowUnverified: [2], promptDecrease: [], cacheReadDrop: [], outputOverWindow: [] } });
    expect(countFile("x", text).overflow.possibleOverflowUnverified).toBeNull();
    const missing = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    expect(countFile("y", [req(722, 669, 42), toolResult(38024), toolResult(38022), missing].join("\n"), 16384).overflow.possibleOverflowUnverified).toEqual([2]);
    expect(countFile("z", [req(722, 669, 42), toolResult(300), end("aborted", ZERO)].join("\n"), 16384).overflow.possibleOverflowUnverified).toEqual([]);
  });
  it("cacheRead check is skipped for providers that never report cache (all cacheRead 0)", () => {
    expect(countFile("x", [req(1900, 0, 30), req(2000, 0, 20, "stop")].join("\n")).overflow.cacheReadDrop).toEqual([]);
  });
  it("HTTP 400 exceeds the available context size: own category, not counted as errored, zero usage does not break the chain", () => {
    const r = countFile("x", [req(1400, 0, 40), end("error", { input: 0, cacheRead: 0, output: 0, totalTokens: 0 }, EXCEEDED), req(10, 1440, 5, "stop")].join("\n"));
    expect(r).toMatchObject({ requests: 3, errored: 0, overflow: { exceededError: [2], promptDecrease: [] } });
    expect(countFile("y", end("error", undefined, "500: boom")).errored).toBe(1);
  });
  it("output crossing the window: input + cacheRead + output > --context-window; skipped (null) without a window", () => {
    const text = [req(15478, 12, 2330, "stop")].join("\n");
    expect(countFile("x", text, 16384).overflow.outputOverWindow).toEqual([1]);
    expect(countFile("x", text).overflow.outputOverWindow).toBeNull();
  });
  it("a compaction between requests resets the prompt chain (a legitimate decrease is not flagged)", () => {
    const r = countFile("x", [req(9000, 0, 40), JSON.stringify({ type: "compaction_end" }), req(2000, 0, 30, "stop")].join("\n"));
    expect(r.overflow.promptDecrease).toEqual([]);
  });
});

describe("summarizeDir", () => {
  it("totals overflow counts per category; without a window the output says the crossing check was skipped", () => {
    const d = mkdtempSync(join(tmpdir(), "t1-usage-"));
    writeFileSync(join(d, "a.jsonl"), end("error", undefined, EXCEEDED));
    writeFileSync(join(d, "b.jsonl"), [req(1408, 0, 47), req(600, 12, 30, "stop")].join("\n"));
    const s = summarizeDir(d);
    expect(s.total.overflow).toEqual({ exceededError: 1, promptDecrease: 1, cacheReadDrop: 1, outputOverWindow: null, possibleOverflowUnverified: null });
    expect(s.contextWindow).toBeNull();
    expect(s.note).toMatch(/--context-window/);
    expect(summarizeDir(d, 16384)).toMatchObject({ contextWindow: 16384, total: { overflow: { outputOverWindow: 0, possibleOverflowUnverified: 0 } } });
  });
  it("throws when the directory holds no .jsonl files (typo'd path must not look like 0 requests)", () => {
    const d = mkdtempSync(join(tmpdir(), "t1-usage-"));
    writeFileSync(join(d, "note.txt"), "x");
    expect(() => summarizeDir(d)).toThrow(/no \.jsonl/);
  });
  it("reports per file (sorted) plus totals, without any message text", () => {
    const d = mkdtempSync(join(tmpdir(), "t1-usage-"));
    writeFileSync(join(d, "b.jsonl"), end("stop", { input: 1, output: 1, totalTokens: 2 }));
    writeFileSync(join(d, "a.jsonl"), end("error"));
    writeFileSync(join(d, "note.txt"), "ignored");
    const s = summarizeDir(d);
    expect(s.files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(s.total).toMatchObject({ requests: 2, errored: 1, usage: { input: 1, output: 1, total: 2 } });
    expect(s.total.stopReasons).toEqual({ error: 1, stop: 1 });
    expect(s.files.map((f) => f.lastStopReason)).toEqual(["error", "stop"]);
  });
});
