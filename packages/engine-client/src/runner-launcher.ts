import { spawn } from "node:child_process";
import { EngineClient } from "./engine-client.js";

/** engine.md 进程退出：须明显长于 runner 内部收尾上限（清理 5 + 兜底 1 + 等关闭 1 = 7 秒） */
export const STOP_TIMEOUT_MS = 10_000;

/** at：退出时刻，performance.now() */
export type RunnerExit = { code: number | null; signal: NodeJS.Signals | null; at: number };

// macOS 上组内只剩未回收的僵尸时 kill(-pgid) 报 EPERM：视同没有存活进程
const gone = (e: unknown) => ["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code!);
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (e) {
    if (!gone(e)) throw e;
  }
}
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    if (gone(e)) return false;
    throw e;
  }
}

export interface RunnerProcess {
  /** 也是进程组号（detached） */
  readonly pid: number;
  /** stdout 的 RUNNER_LISTENING 端口；runner 先退出则 reject */
  readonly listening: Promise<number>;
  readonly exit: Promise<RunnerExit>;
  stderr(): string;
  /** 连接 runner；终止事件或连接关闭即记为退出信号 */
  connect(): Promise<EngineClient>;
  /** 发出取消（已连接时）并记为退出信号 */
  cancel(): void;
  /** 发 SIGTERM 并记为退出信号 */
  terminate(): void;
  /** 等 runner 退出，最迟到“最早退出信号 + 停止时限”，到时强杀整个进程组；未有信号时以此刻为信号 */
  stop(): Promise<RunnerExit & { forced: boolean; stopWaitMs: number }>;
}

/**
 * 启动者（9A）：runner CLI 放进独立进程组（detached）。停止时限从最早的退出信号起用单调时钟计时（engine.md 进程退出）：
 * 发出取消或 SIGTERM、收到终止事件、连接关闭。runner 的空闲超时启动者感知不到，不覆盖。
 * 已知限制：pi 的 bash 工具在自己的会话里，不在 runner 组内；强杀 runner 时正在运行的工具可能残留（engine.md 工具进程）。
 */
export function spawnRunner(opts: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stopTimeoutMs?: number }): RunnerProcess {
  const stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const child = spawn(process.execPath, opts.args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exit = new Promise<RunnerExit>((ok) => child.on("exit", (code, signal) => ok({ code, signal, at: performance.now() })));
  const listening = new Promise<number>((ok, fail) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = /^RUNNER_LISTENING (\d+)\n/.exec(out);
      if (m) ok(Number(m[1]));
    });
    void exit.then(({ code, signal }) => fail(new Error(`runner exited with code ${code} (signal ${signal}) before listening`)));
  });
  listening.catch(() => {});
  let stopAt: number | undefined;
  const signalled = () => void (stopAt ??= performance.now());
  let client: EngineClient | undefined;

  return {
    pid: child.pid!,
    listening,
    exit,
    stderr: () => err,
    async connect() {
      client = await EngineClient.connect(`ws://127.0.0.1:${await listening}`);
      client.waitForEnd().then(signalled, signalled);
      return client;
    },
    cancel() {
      signalled();
      try {
        client?.cancel();
      } catch {} // 连接已断：断线本身就让 runner 取消并退出
    },
    terminate() {
      signalled();
      child.kill("SIGTERM");
    },
    async stop() {
      signalled();
      let timer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([exit, new Promise<undefined>((ok) => (timer = setTimeout(() => ok(undefined), Math.max(0, stopAt! + stopTimeoutMs - performance.now()))))]);
      clearTimeout(timer);
      if (!exited) killGroup(child.pid!);
      const e = await exit;
      return { ...e, forced: !exited, stopWaitMs: Math.max(0, Math.round(e.at - stopAt!)) };
    },
  };
}
