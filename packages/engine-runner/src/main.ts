import { parseArgs } from "node:util";
import { startRunnerServer } from "./runner-server.js";

// stdout 只给启动者一行 RUNNER_LISTENING <port>；其余诊断一律写 stderr
function fail(message: string, code = 2): never {
  process.stderr.write(`runner: ${message}\n`);
  process.exit(code);
}

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    options: Object.fromEntries(
      ["port", "models", "workdir", "sessions-root", "intercept-timeout-ms", "confirm-timeout-ms", "idle-timeout-ms", "record-pi-events"].map((k) => [k, { type: "string" as const }]),
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

const opts = {
  port: int("port") ?? 0,
  modelsPath: required("models"),
  workDir: required("workdir"),
  sessionsRoot: required("sessions-root"),
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
