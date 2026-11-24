export type CallSite = { path: string; line: number };
export type GradeResult = { passed: boolean; missing: string[]; extra: string[]; error?: string };

const fail = (error: string): GradeResult => ({ passed: false, missing: [], extra: [], error });

const validPath = (p: unknown): p is string =>
  typeof p === "string" && p !== "" && !p.startsWith("/") && !p.includes("\\") &&
  !p.split("/").some((s) => s === "" || s === "." || s === "..");

// Strict on purpose: no fence stripping, no fuzzy matching; a bad format is a wrong answer.
export function gradeAnswer(answer: unknown, expected: CallSite[]): GradeResult {
  let value = answer;
  if (typeof answer === "string") {
    try {
      value = JSON.parse(answer.trim());
    } catch {
      return fail("answer is not valid JSON");
    }
  }
  if (!Array.isArray(value)) return fail("answer must be a JSON array");
  const got = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return fail("item must be an object");
    const { path, line } = item as Record<string, unknown>;
    if (!validPath(path)) return fail(`invalid path: ${JSON.stringify(path)}`);
    if (!Number.isInteger(line) || (line as number) < 1) return fail(`invalid line: ${JSON.stringify(line)}`);
    got.add(`${path}:${line}`); // extra keys on items are ignored
  }
  const want = new Set(expected.map((e) => `${e.path}:${e.line}`));
  const missing = [...want].filter((k) => !got.has(k)).sort();
  const extra = [...got].filter((k) => !want.has(k)).sort();
  return { passed: !missing.length && !extra.length, missing, extra };
}
