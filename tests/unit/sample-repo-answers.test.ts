import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fx = join(import.meta.dirname, "../fixtures");
const repo = join(fx, "sample-repo");
const qs = JSON.parse(readFileSync(join(fx, "sample-repo-questions.json"), "utf8"));
const audit = readFileSync(join(fx, "sample-repo-audit.md"), "utf8");
// Only the sample's own sources: .DS_Store / __pycache__ must not change the version.
const files = readdirSync(repo).filter((f) => /\.(py|md)$/.test(f)).sort();
const lines = (p: string) => readFileSync(join(repo, p), "utf8").split("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// name\0content\0 in sorted order; changing any file forces re-audit + version bump.
const repoHash = sha(files.map((f) => `${f}\0${readFileSync(join(repo, f), "utf8")}\0`).join(""));
const questionsHash = sha(JSON.stringify(qs.questions));

type Entry = { target: string; key: string; kind: string; note: string };
const entries: Entry[] = [...audit.matchAll(/^- (\w+) \| (\S+:\d+) \| (DEF|IMPORT|CALL|NOT) \| (.*)$/gm)].map(
  (m) => ({ target: m[1], key: m[2], kind: m[3], note: m[4] }),
);
const SCOPE_NOTE = "包括经导入别名或模块名限定的调用；不含定义行和 import 行。";
const keyOf = (a: { path: string; line: number }) => `${a.path}:${a.line}`;

describe("sample repo versions", () => {
  it("content hashes match the recorded versions", () => {
    expect(qs.sampleRepoHash).toBe(repoHash);
    expect(qs.questionsHash).toBe(questionsHash);
  });
  it("README contains no answers", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    for (const q of qs.questions) {
      expect(readme).not.toContain(q.id);
    }
  });
});

describe("questions", () => {
  it("has 5 questions over 6-8 modules, each with 1-3 call sites", () => {
    expect(qs.questions).toHaveLength(5);
    expect(files.filter((f) => f.endsWith(".py")).length).toBeGreaterThanOrEqual(6);
    expect(files.filter((f) => f.endsWith(".py")).length).toBeLessThanOrEqual(8);
    for (const q of qs.questions) {
      expect(q.answers.length).toBeGreaterThanOrEqual(1);
      expect(q.answers.length).toBeLessThanOrEqual(3);
    }
  });

  for (const q of qs.questions) {
    describe(q.id, () => {
      const name: string = q.id;
      const word = new RegExp(`\\b${name}\\b`);
      const mine = entries.filter((e) => e.target === name);

      it("question names the defining file and the uniform scope note", () => {
        expect(q.question).toContain(`${q.target.path} 中定义的函数 ${name}`);
        expect(q.question).toContain(SCOPE_NOTE);
      });
      it("alias calls are found mechanically, not only via the audit", () => {
        // Qualified calls (cfg.load_config) already contain the name, so the occurrence scan below covers them.
        const aliases = [...new Set(mine.map((e) => e.note.match(/alias (\w+)/)?.[1]).filter(Boolean))];
        for (const al of aliases)
          for (const f of files.filter((x) => x.endsWith(".py")))
            lines(f).forEach((t, i) => {
              if (new RegExp(`\\b${al}\\(`).test(t)) expect(q.answers.map(keyOf)).toContain(`${f}:${i + 1}`);
            });
      });
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
