import { parseArgs } from "node:util";
import { PI_BUILTIN_TOOLS, PI_THINKING_LEVELS, type ThinkingLevel } from "./pi-session.js";
import { startRunnerServer } from "./runner-server.js";

// engine.md 外部程序与离线：缺 rg 等工具时 pi 不得联网下载（否则写到 ~/.pi/agent/bin）
process.env.PI_OFFLINE = "1";

// stdout 只给启动者一行 RUNNER_LISTENING <port>；其余诊断一律写 stderr
function fail(message: string, code = 2): never {
  process.stderr.write(`runner: ${message}\n`);
  process.exit(code);
}

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    options: Object.fromEntries(
      ["port", "models", "workdir", "sessions-root", "intercept-timeout-ms", "confirm-timeout-ms", "idle-timeout-ms", "record-pi-events", "tools", "thinking"].map((k) => [k, { type: "string" as const }]),
    ),
  }));
} catch (e) {
  fail((e as Error).message);
}

const required = (name: string) => values[name] ?? fail(`--${name} is required`);
const int = (name: string) => {
  const v = values[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fail(`--${name} must be a non-negative integer`);
};

// 只接受内置工具的确切名字：通配、+/-、mcp__ 会改变 pi 的选择语义，未知名会被 pi 静默忽略
const tools = values.tools?.split(",");
if (tools?.some((t) => !PI_BUILTIN_TOOLS.includes(t))) fail(`--tools must be a comma-separated list of pi built-in tools (${PI_BUILTIN_TOOLS.join(", ")}), got ${JSON.stringify(values.tools)}`);

const thinking = values.thinking as ThinkingLevel | undefined;
if (thinking !== undefined && !PI_THINKING_LEVELS.includes(thinking)) fail(`--thinking must be one of ${PI_THINKING_LEVELS.join(", ")}, got ${JSON.stringify(thinking)}`);

const opts = {
  port: int("port") ?? 0,
  modelsPath: required("models"),
  workDir: required("workdir"),
  sessionsRoot: required("sessions-root"),
  tools,
  thinkingLevel: thinking,
  interceptTimeoutMs: int("intercept-timeout-ms"),
  confirmTimeoutMs: int("confirm-timeout-ms"),
  idleTimeoutMs: int("idle-timeout-ms"),
  recordPiEventsPath: values["record-pi-events"],
};

const server = await startRunnerServer(opts).catch((e: Error) => fail(`failed to listen: ${e.message}`, 1));
process.stdout.write(`RUNNER_LISTENING ${server.port}\n`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void server.close());
// 退出码只反映清理结果；直接 exit，不等 pi 可能仍挂着的 prompt 让事件循环自然排空
process.exit((await server.done).ok ? 0 : 1);
