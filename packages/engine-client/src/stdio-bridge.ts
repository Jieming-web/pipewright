import { createInterface } from "node:readline";
import WebSocket from "ws";
import { spawnRunner } from "./runner-launcher.js";

// 命令行：node stdio-bridge.js --runner <runner main.js> -- <runner 参数…>（engine.md 传输：stdio 桥）。
// 只搬运：stdin 一行 ↔ 一个文本帧，不校验、不改写；stdout 只写协议行。
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const runnerMain = argv[argv.indexOf("--runner") + 1];
if (argv[0] !== "--runner" || !runnerMain || sep < 0) {
  console.error("usage: stdio-bridge --runner <runner main.js> -- <runner args...>");
  process.exit(2);
}

const runner = spawnRunner({ args: [runnerMain, ...argv.slice(sep + 1)] });

/** 等 stdout 写完再退出，避免丢最后几行 */
const quit = (code: number) => process.stdout.write("", () => process.exit(code));

/** 停 runner 并按其退出结果退出；runner 被强杀（信号或到停止时限）为 137 */
async function finish(forcedCode?: number): Promise<never> {
  const e = await runner.stop();
  process.stderr.write(runner.stderr());
  return quit(forcedCode ?? (e.forced || e.signal === "SIGKILL" ? 137 : (e.code ?? 1))) as never;
}

let port: number;
try {
  port = await runner.listening;
} catch {
  const e = await runner.exit;
  process.stderr.write(runner.stderr());
  quit(e.code ?? 1);
  await new Promise(() => {});
}

const ws = new WebSocket(`ws://127.0.0.1:${port!}`);
ws.on("error", (e) => process.stderr.write(`stdio-bridge: ${e.message}\n`));
ws.on("message", (data) => {
  const line = data.toString();
  if (line.includes("\n")) {
    process.stderr.write("stdio-bridge: received a frame containing a newline\n");
    ws.terminate();
    void finish(2);
    return;
  }
  process.stdout.write(line + "\n");
});
ws.on("close", () => void finish());
ws.on("open", () => {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (l) => ws.readyState === WebSocket.OPEN && ws.send(l));
  rl.on("close", () => ws.close()); // stdin EOF：runner 按断线取消并退出
});
