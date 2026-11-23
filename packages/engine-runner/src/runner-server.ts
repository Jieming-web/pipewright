import { parseClientMessage, type ProtocolError, type RunnerMessage } from "@forgepilot/engine-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { createInterceptCoordinator } from "./intercept-coordinator.js";
import { CLEANUP_LIMIT_MS, PiEngine } from "./pi-engine.js";

const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
// 引擎自身清理限时之外的兜底：run/cancel 永不返回时 done 也必须 resolve。从 finish() 起算，会话创建很慢时的取消可能超过它而记 ok:false；残留进程由启动者按进程组清理（契约）
const STOP_BACKSTOP_MS = CLEANUP_LIMIT_MS + 1000;
// 等客户端回 close 帧的上限；超时就强制断开，退出不受客户端拖延（ws 默认要等 30 秒）
const CLIENT_CLOSE_MS = 1000;
const log = (s: string) => process.stderr.write(`runner: ${s}\n`);

/** 非法消息若仍是带 requestId 的 JSON，就回显它（契约：无法解析时可缺） */
function requestIdOf(raw: string): string | undefined {
  try {
    const id = JSON.parse(raw)?.requestId;
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一个 runner 对应一个客户端、一次任务（engine.md §2）。终止事件只由引擎发布；
 * 终止、取消、断线、空闲超时或外部 close() 都走同一条收尾：等引擎结束（有兜底时限）→ 关闭连接与监听 → resolve done。
 */
export async function startRunnerServer(opts: {
  port: number;
  modelsPath: string;
  workDir: string;
  sessionsRoot: string;
  interceptTimeoutMs?: number;
  confirmTimeoutMs?: number;
  recordPiEventsPath?: string;
  idleTimeoutMs?: number;
}): Promise<{ port: number; close(): Promise<void>; done: Promise<{ ok: boolean }> }> {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: opts.port,
    // 浏览器页面一定带 Origin、启动者的进程客户端不带：握手时拒绝（403），不占唯一客户端位置（engine.md 连接来源）
    verifyClient: ({ req }, done) => done(req.headers.origin === undefined, 403),
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("error", (e) => log(`server error: ${e.message}`));

  let client: WebSocket | undefined;
  let state: "idle" | "running" | "stopping" | "finished" = "idle";
  let run: Promise<boolean> | undefined; // 引擎是否清理成功
  let finishing: Promise<void> | undefined;
  let resolveDone!: (r: { ok: boolean }) => void;
  const done = new Promise<{ ok: boolean }>((r) => (resolveDone = r));

  // 不抛错：发送失败说明客户端已断开，由 close 事件走取消路径（抛进 pi 的 _emit 会打断引擎）
  const send = (m: RunnerMessage) => {
    try {
      if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(m));
    } catch (e) {
      log(`send failed: ${(e as Error).message}`);
    }
  };
  const error = (requestId: string | undefined, code: ProtocolError["code"], message: string) =>
    send({ type: "error", ...(requestId && { requestId }), code, message });

  const coordinator = createInterceptCoordinator({
    send,
    interceptTimeoutMs: opts.interceptTimeoutMs ?? 30_000,
    confirmTimeoutMs: opts.confirmTimeoutMs ?? 600_000,
  });
  const engine = new PiEngine({
    modelsPath: opts.modelsPath,
    workDir: opts.workDir,
    sessionsRoot: opts.sessionsRoot,
    recordPiEventsPath: opts.recordPiEventsPath,
    coordinator,
    emit: (event) => {
      if (TERMINAL.has(event.type)) state = "finished";
      send({ type: "event", event });
    },
  });

  const finish = () =>
    (finishing ??= (async () => {
      clearTimeout(idle);
      let ok = true;
      if (run) {
        if (state === "running") {
          state = "stopping";
          engine.cancel().catch(() => {}); // 结果经 run 报告
        }
        let timer: NodeJS.Timeout | undefined;
        ok = await Promise.race([run, new Promise<boolean>((r) => (timer = setTimeout(() => r(false), STOP_BACKSTOP_MS)))]);
        clearTimeout(timer);
        if (!ok) log("engine cleanup failed or timed out");
      }
      state = "finished"; // 在等待关闭之前置位：此后到达的 start_task 走 run_finished，不会再启动引擎
      client?.close(1000);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([new Promise((r) => wss.close(r)), new Promise((r) => (timer = setTimeout(r, CLIENT_CLOSE_MS)))]);
      clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      resolveDone({ ok });
    })());

  const idle = setTimeout(finish, opts.idleTimeoutMs ?? 30_000);

  function onMessage(raw: string) {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return error(requestIdOf(raw), "invalid_message", parsed.error);
    const m = parsed.message;
    switch (m.type) {
      case "start_task":
        if (state === "finished") {
          error(m.requestId, "run_finished", "the task has finished; start a new runner");
          return void client?.close(1000);
        }
        if (state !== "idle") return error(m.requestId, "already_running", "a task is already running");
        if (m.interceptMode === "policy" || m.resume) return error(m.requestId, "not_implemented", "policy mode and resume are not supported in T1");
        state = "running";
        clearTimeout(idle);
        send({ type: "accepted", requestId: m.requestId, sessionId: m.sessionId });
        run = engine.run(m).then(
          () => true,
          (e) => (log(`engine: ${(e as Error).message}`), false),
        );
        void run.then(finish);
        return;
      case "cancel":
        if (state === "running") void finish(); // idle 时无操作；stopping/finished 时已在收尾
        return;
      default:
        if (!coordinator.respond(m).ok) error(m.requestId, "stale_response", "no pending request matches this response");
    }
  }

  wss.on("connection", (ws) => {
    ws.on("error", (e) => log(`client error: ${e.message}`));
    if (client || finishing) return ws.close(1008, "runner accepts a single client");
    client = ws;
    idle.refresh(); // 连接后重新计算未启动的空闲时间
    ws.on("message", (data) => onMessage(String(data)));
    ws.on("close", () => void finish()); // 断线：取消并退出，不等重连
  });

  return { port: (wss.address() as { port: number }).port, close: finish, done };
}
