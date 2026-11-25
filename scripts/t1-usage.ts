// 离线统计 runner 录下的 pi 原始事件（--record-pi-events）：逐题模型请求数、中止数、错误数、结束原因与用量。
// 用法：pnpm tsx scripts/t1-usage.ts --record-dir <目录> [--context-window <n>] [--output <json>]；只读文件，不读 key、不联网、不输出正文。
// 口径：一次模型请求 = 一条 role=assistant 的 message_end（pi-agent-core 在流结束、错误、中止时都会发出）。
// message_update 是同一消息的增量，turn_end/agent_end 带同一消息的副本，均不计；重试时失败尝试自己有一条 message_end（stopReason error），各算一次。
// 结束原因取 pi 的 stopReason（stop/toolUse/length/error/aborted）；length 即输出上限用完被截断，lastStopReason 为该题最后一次请求的结束原因。
// 上下文溢出（10C，依据 Ollama 0.40.15 实测，见实现说明 Task 10C）逐题列出请求序号（从 1 起）。输入总量 = input + cacheRead + cacheWrite：
// - exceededError：stopReason error 且 errorMessage 含 "exceeds the available context size"（显式 HTTP 400），单列，不计入 errored；
// - promptDecrease（主判据）：同一题内输入总量比上一次有用量的请求低。上下文只增不减，下降说明服务端静默丢弃了早先的消息。
//   失败/中止、缺用量、用量全为 0（服务端未回报）的请求不参与比较；compaction_end 之后重新起算；
// - cacheReadDrop（辅助）：cacheRead < 上一次输入总量 − 16，即前缀缓存链断开；文件中从无 cacheRead（服务端不报缓存）时不检查。
//   依赖按 token 缓存前缀的服务；按块缓存的服务或缓存被清掉（如模型重新加载）会误报，届时按服务调整容差；
// - outputOverWindow：输入总量 + output 超过 --context-window（Ollama 静默 context shift）；
// - possibleOverflowUnverified：被中止或缺用量的请求，按 上一次输入总量 + 上一次 output + 其后追加的工具结果字符数 / 3 估算超过窗口。
//   只是可能溢出、无法核实，不算已确认的溢出，也不算答错；“3 个字符约 1 个 token”偏向英文与代码，中文会低估。
// 后两项未给 --context-window 时为 null，表示未检查。
// 盲区：静默丢弃可能被新追加的工具结果盖住，使输入总量不降（10C 预检 (b) 的真实静默丢弃，主判据就没有触发），所以两个判据须一起看；
// 统计干净不等于没有溢出。根本办法在 T3：发送前估算长度，快到窗口就主动停止。
// shortcut: 进程被杀等导致没有 message_end 的请求无法统计，协议已有 model.request.finished（T2-3），评测框架改用它后再替换。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
export type Overflow = {
  exceededError: number[]; promptDecrease: number[]; cacheReadDrop: number[];
  outputOverWindow: number[] | null; possibleOverflowUnverified: number[] | null;
};
export type FileStats = {
  id: string; requests: number; aborted: number; errored: number; usageMissing: number; usage: Usage;
  stopReasons: Record<string, number>; lastStopReason: string | null; overflow: Overflow;
};

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
const KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const EXCEEDED = /exceeds the available context size/i;
const CACHE_TOLERANCE = 16;

export function countFile(id: string, text: string, contextWindow?: number): FileStats {
  const o: Overflow = {
    exceededError: [], promptDecrease: [], cacheReadDrop: [],
    outputOverWindow: contextWindow ? [] : null, possibleOverflowUnverified: contextWindow ? [] : null,
  };
  const s: FileStats = { id, requests: 0, aborted: 0, errored: 0, usageMissing: 0, usage: zero(), stopReasons: {}, lastStopReason: null, overflow: o };
  let prev: { prompt: number; output: number } | null = null;
  let charsSince = 0; // 上一次有用量的请求之后追加的工具结果字符数
  let anyCache = false;
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error(`${id}: line ${i + 1}: not valid JSON`);
    }
    if (typeof e !== "object" || e === null) throw new Error(`${id}: line ${i + 1}: not a JSON object`);
    if (e.type === "compaction_end") prev = null;
    if (e.type === "message_end" && e.message?.role === "toolResult" && Array.isArray(e.message.content))
      for (const c of e.message.content) if (typeof c?.text === "string") charsSince += c.text.length;
    if (e.type !== "message_end" || e.message?.role !== "assistant") return;
    s.requests++;
    const reason = typeof e.message.stopReason === "string" ? e.message.stopReason : "missing";
    s.stopReasons[reason] = (s.stopReasons[reason] ?? 0) + 1;
    s.lastStopReason = reason;
    if (e.message.stopReason === "aborted") s.aborted++;
    if (e.message.stopReason === "error") {
      if (EXCEEDED.test(String(e.message.errorMessage ?? ""))) o.exceededError.push(s.requests);
      else s.errored++;
    }
    const u = e.message.usage;
    const hasUsage = typeof u === "object" && u !== null;
    const estimate = () => {
      if (contextWindow && prev && prev.prompt + prev.output + charsSince / 3 > contextWindow) o.possibleOverflowUnverified!.push(s.requests);
    };
    if (!hasUsage) {
      s.usageMissing++;
      return estimate();
    }
    for (const k of KEYS) s.usage[k] += num(u[k]);
    s.usage.total += num(u.totalTokens);
    if (reason === "aborted") return estimate(); // 中止的用量为 0 或不完整
    if (reason === "error") return; // 失败的用量为 0，不参与溢出判据
    const prompt = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    if (prompt + num(u.output) === 0) return; // 服务端未回报用量：不算下降，链从上一次继续
    if (num(u.cacheRead) > 0) anyCache = true;
    if (prev && prompt < prev.prompt) o.promptDecrease.push(s.requests);
    if (prev && num(u.cacheRead) < prev.prompt - CACHE_TOLERANCE) o.cacheReadDrop.push(s.requests);
    if (contextWindow && prompt + num(u.output) > contextWindow) o.outputOverWindow!.push(s.requests);
    prev = { prompt, output: num(u.output) };
    charsSince = 0;
  });
  if (!anyCache) o.cacheReadDrop = [];
  return s;
}

export function summarizeDir(dir: string, contextWindow?: number) {
  const names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (!names.length) throw new Error(`no .jsonl files in ${dir}`);
  const files = names.map((f) => countFile(f.slice(0, -".jsonl".length), readFileSync(join(dir, f), "utf8"), contextWindow));
  const windowed = contextWindow ? 0 : (null as number | null);
  const overflow = { exceededError: 0, promptDecrease: 0, cacheReadDrop: 0, outputOverWindow: windowed, possibleOverflowUnverified: windowed };
  const total = { requests: 0, aborted: 0, errored: 0, usageMissing: 0, usage: zero(), stopReasons: {} as Record<string, number>, overflow };
  for (const f of files) {
    for (const k of ["requests", "aborted", "errored", "usageMissing"] as const) total[k] += f[k];
    for (const k of Object.keys(total.usage) as (keyof Usage)[]) total.usage[k] += f.usage[k];
    for (const [r, n] of Object.entries(f.stopReasons)) total.stopReasons[r] = (total.stopReasons[r] ?? 0) + n;
    for (const k of ["exceededError", "promptDecrease", "cacheReadDrop"] as const) overflow[k] += f.overflow[k].length;
    if (overflow.outputOverWindow !== null) overflow.outputOverWindow += f.overflow.outputOverWindow!.length;
    if (overflow.possibleOverflowUnverified !== null) overflow.possibleOverflowUnverified += f.overflow.possibleOverflowUnverified!.length;
  }
  return { contextWindow: contextWindow ?? null, ...(!contextWindow && { note: "未给 --context-window，未检查输出越过窗口与中止请求的可能溢出（outputOverWindow、possibleOverflowUnverified 为 null）" }), files, total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values: v } = parseArgs({ options: { "record-dir": { type: "string" }, "context-window": { type: "string" }, output: { type: "string" } } });
    if (!v["record-dir"]) throw new Error("required --record-dir <目录> [--context-window <n>] [--output <json>]");
    const cw = v["context-window"];
    if (cw !== undefined && !/^[1-9]\d*$/.test(cw)) throw new Error(`--context-window must be a positive integer, got ${cw}`);
    const json = JSON.stringify(summarizeDir(v["record-dir"], cw === undefined ? undefined : Number(cw)), null, 2) + "\n";
    if (v.output) writeFileSync(v.output, json);
    else process.stdout.write(json);
  } catch (e) {
    process.stderr.write(`t1-usage: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
