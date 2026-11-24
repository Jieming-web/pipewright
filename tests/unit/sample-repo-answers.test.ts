import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fx = join(import.meta.dirname, "../fixtures");
const repo = join(fx, "sample-repo");
const qs = JSON.parse(readFileSync(join(fx, "sample-repo-questions.json"), "utf8"));
const audit = readFileSync(join(fx, "sample-repo-audit.md"), "utf8");
const files = readdirSync(repo).sort();
const lines = (p: string) => readFileSync(join(repo, p), "utf8").split("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// name\0content\0 in sorted order; changing any file forces re-audit + version bump.
const repoHash = sha(files.map((f) => `${f}\0${readFileSync(join(repo, f), "utf8")}\0`).join(""));
const questionsHash = sha(JSON.stringify(qs.questions));

type Entry = { target: string; key: string; kind: string; note: string };
const entries: Entry[] = [...audit.matchAll(/^- (\w+) \| (\S+:\d+) \| (DEF|IMPORT|CALL|NOT) \| (.*)$/gm)].map(
  (m) => ({ target: m[1], key: m[2], kind: m[3], note: m[4] }),
);
const keyOf = (a: { path: string; line: number }) => `${a.path}:${a.line}`;

describe("sample repo versions", () => {
  it("content hashes match the recorded versions", () => {
    expect(qs.sampleRepoHash).toBe(repoHash);
    expect(qs.questionsHash).toBe(questionsHash);
  });
  it("README contains no answers", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    for (const q of qs.questions) {
      expect(readme).not.toContain(q.target.name);
    }
  });
});

describe("questions", () => {
  it("has 5 questions over 6-8 modules, each with 1-3 call sites", () => {
    expect(qs.questions).toHaveLength(5);
    expect(files.filter((f) => f.endsWith(".py")).length).toBeGreaterThanOrEqual(6);
    expect(files.filter((f) => f.endsWith(".py")).length).toBeLessThanOrEqual(8);
    for (const q of qs.questions) expect(q.answers.length).toBeGreaterThanOrEqual(1), expect(q.answers.length).toBeLessThanOrEqual(3);
  });

  for (const q of qs.questions) {
    describe(q.target.name, () => {
      const name: string = q.target.name;
      const word = new RegExp(`\\b${name}\\b`);
      const mine = entries.filter((e) => e.target === name);

      it("definition location is a def line", () => {
        expect(lines(q.target.path)[q.target.line - 1]).toMatch(new RegExp(`^def ${name}\\(`));
      });
      it("every answer line really calls it (directly, via module, or alias)", () => {
        for (const a of q.answers) {
          const text = lines(a.path)[a.line - 1] ?? "";
          const alias = mine.find((e) => e.key === keyOf(a))?.note.match(/alias (\w+)/)?.[1];
          expect(text, keyOf(a)).toMatch(new RegExp(`\\b${alias ?? name}\\(`));
          expect(text, keyOf(a)).not.toMatch(/^\s*(def|from|import|#)/);
        }
      });
      it("answers equal the audit's CALL entries", () => {
        const calls = mine.filter((e) => e.kind === "CALL").map((e) => e.key).sort();
        expect(q.answers.map(keyOf).sort()).toEqual(calls);
      });
      it("audit accounts for every occurrence of the name in the repo", () => {
        const found: string[] = [];
        for (const f of files.filter((x) => x.endsWith(".py")))
          lines(f).forEach((t, i) => word.test(t) && found.push(`${f}:${i + 1}`));
        const aliasLines = mine.filter((e) => /alias \w+/.test(e.note)).map((e) => e.key);
        expect([...found, ...aliasLines].sort()).toEqual([...new Set(mine.map((e) => e.key))].sort());
      });
      it("distractors are not in the answer set", () => {
        const ans = new Set(q.answers.map(keyOf));
        for (const e of mine.filter((x) => x.kind === "NOT")) expect(ans.has(e.key)).toBe(false);
      });
    });
  }
});
