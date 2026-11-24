// 离线统计 runner 录下的 pi 原始事件（--record-pi-events）：逐题模型请求数、中止数、错误数与用量。
// 用法：pnpm tsx scripts/t1-usage.ts --record-dir <目录> [--output <json>]；只读文件，不读 key、不联网、不输出正文。
// 口径：一次模型请求 = 一条 role=assistant 的 message_end（pi-agent-core 在流结束、错误、中止时都会发出）。
// message_update 是同一消息的增量，turn_end/agent_end 带同一消息的副本，均不计；重试时失败尝试自己有一条 message_end（stopReason error），各算一次。
// shortcut: 进程被杀等导致没有 message_end 的请求无法统计，T2 评测框架加请求结束事件后再替换。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
export type FileStats = { id: string; requests: number; aborted: number; errored: number; usageMissing: number; usage: Usage };

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
const KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function countFile(id: string, text: string): FileStats {
  const s: FileStats = { id, requests: 0, aborted: 0, errored: 0, usageMissing: 0, usage: zero() };
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error(`${id}: line ${i + 1}: not valid JSON`);
    }
    if (typeof e !== "object" || e === null) throw new Error(`${id}: line ${i + 1}: not a JSON object`);
    if (e.type !== "message_end" || e.message?.role !== "assistant") return;
    s.requests++;
    if (e.message.stopReason === "aborted") s.aborted++;
    if (e.message.stopReason === "error") s.errored++;
    const u = e.message.usage;
    if (typeof u !== "object" || u === null) return void s.usageMissing++;
    for (const k of KEYS) s.usage[k] += num(u[k]);
    s.usage.total += num(u.totalTokens);
  });
  return s;
}

export function summarizeDir(dir: string) {
  const names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (!names.length) throw new Error(`no .jsonl files in ${dir}`);
  const files = names.map((f) => countFile(f.slice(0, -".jsonl".length), readFileSync(join(dir, f), "utf8")));
  const total = { requests: 0, aborted: 0, errored: 0, usageMissing: 0, usage: zero() };
  for (const f of files) {
    for (const k of ["requests", "aborted", "errored", "usageMissing"] as const) total[k] += f[k];
    for (const k of Object.keys(total.usage) as (keyof Usage)[]) total.usage[k] += f.usage[k];
  }
  return { files, total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values: v } = parseArgs({ options: { "record-dir": { type: "string" }, output: { type: "string" } } });
    if (!v["record-dir"]) throw new Error("required --record-dir <目录> [--output <json>]");
    const json = JSON.stringify(summarizeDir(v["record-dir"]), null, 2) + "\n";
    if (v.output) writeFileSync(v.output, json);
    else process.stdout.write(json);
  } catch (e) {
    process.stderr.write(`t1-usage: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
