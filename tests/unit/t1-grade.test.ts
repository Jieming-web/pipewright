import { describe, expect, it } from "vitest";
import { gradeAnswer } from "../../scripts/t1-grade.js";

const exp = [
  { path: "a.py", line: 3 },
  { path: "b/c.py", line: 10 },
];

describe("gradeAnswer", () => {
  it("passes on exact match, parsed or as JSON string", () => {
    expect(gradeAnswer(exp, exp).passed).toBe(true);
    expect(gradeAnswer(`  ${JSON.stringify(exp)}\n`, exp)).toEqual({ passed: true, missing: [], extra: [] });
  });
  it("tolerates surrounding whitespace and newlines", () => {
    expect(gradeAnswer(`\n  ${JSON.stringify(exp)} \t\n\n`, exp).passed).toBe(true);
  });
  it.each(["```json\n[]\n```", "```\n" + JSON.stringify(exp) + "\n```", "\n  ```json\n[]\n```\n"])(
    "fenced answer fails with an explicit code-fence error: %j",
    (input) => {
      const r = gradeAnswer(input, exp);
      expect(r.passed).toBe(false);
      expect(r.error).toBe("answer is wrapped in a markdown code fence; output a bare JSON array");
    },
  );
  it("ignores order and duplicates", () => {
    expect(gradeAnswer([exp[1], exp[0], exp[1]], exp).passed).toBe(true);
  });
  it("reports missing", () => {
    expect(gradeAnswer([exp[0]], exp)).toEqual({ passed: false, missing: ["b/c.py:10"], extra: [] });
  });
  it("reports extra, including same-name distractors", () => {
    const r = gradeAnswer([...exp, { path: "legacy.py", line: 16 }], exp);
    expect(r).toEqual({ passed: false, missing: [], extra: ["legacy.py:16"] });
  });
  it("wrong line is both missing and extra", () => {
    const r = gradeAnswer([exp[0], { path: "b/c.py", line: 11 }], exp);
    expect(r.missing).toEqual(["b/c.py:10"]);
    expect(r.extra).toEqual(["b/c.py:11"]);
  });
  it("ignores extra keys on items", () => {
    expect(gradeAnswer(exp.map((e) => ({ ...e, note: "x" })), exp).passed).toBe(true);
  });
  it.each([
    ["markdown fence", "```json\n[]\n```"],
    ["not json", "a.py:3"],
    ["not an array", { path: "a.py", line: 3 }],
    ["null item", [null]],
    ["missing line", [{ path: "a.py" }]],
    ["line 0", [{ path: "a.py", line: 0 }]],
    ["float line", [{ path: "a.py", line: 1.5 }]],
    ["string line", [{ path: "a.py", line: "3" }]],
    ["leading ./", [{ path: "./a.py", line: 3 }]],
    ["absolute", [{ path: "/a.py", line: 3 }]],
    ["dotdot", [{ path: "../a.py", line: 3 }]],
    ["backslash", [{ path: "b\\c.py", line: 10 }]],
    ["negative line", [{ path: "a.py", line: -1 }]],
    ["nested array", [[{ path: "a.py", line: 3 }]]],
    ["double-encoded JSON", JSON.stringify(JSON.stringify(exp))],
    ["empty segment", [{ path: "a//b.py", line: 3 }]],
    ["missing path", [{ line: 3 }]],
    ["non-string path", [{ path: 5, line: 3 }]],
    ["empty path", [{ path: "", line: 3 }]],
  ])("format error fails: %s", (_n, input) => {
    const r = gradeAnswer(input, exp);
    expect(r.passed).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it("empty array is a valid but wrong answer", () => {
    const r = gradeAnswer([], exp);
    expect(r.error).toBeUndefined();
    expect(r.missing).toHaveLength(2);
  });
});
