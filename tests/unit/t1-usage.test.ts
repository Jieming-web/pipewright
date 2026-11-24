import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFile, summarizeDir } from "../../scripts/t1-usage.js";

const FIX = join(import.meta.dirname, "../fixtures/pi-events");
const count = (name: string) => countFile(name, readFileSync(join(FIX, `${name}.jsonl`), "utf8"));
const end = (stopReason: string, usage?: object) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason, ...(usage ? { usage } : {}) } });

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

describe("summarizeDir", () => {
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
