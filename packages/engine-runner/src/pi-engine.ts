import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SequencedEvent, StartTask, TerminalEvent } from "@forgepilot/engine-protocol";
import type { createInterceptCoordinator } from "./intercept-coordinator.js";
import { convertPiEvent } from "./pi-event-converter.js";
import { createPiSession } from "./pi-session.js";
import { createRawEventRecorder } from "./raw-event-recorder.js";
import { createRunEvents } from "./run-events.js";

export const CLEANUP_LIMIT_MS = 5000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 一个引擎只跑一次任务。终止结果取第一个观察到的原因（pi 的 agent_settled、取消、启动失败），之后不覆盖；
 * run.settled / run.cancelled 只在清理成功后发布，清理失败或超时改发带原因的 run.failed 并让 run/cancel 拒绝。
 */
export class PiEngine {
  #disposed = false;
  #outcome: TerminalEvent | undefined;
  #run: Promise<void> | undefined;
  #stop: Promise<void> | undefined; // 已开始清理：之后不再发布进度事件
  #startStop: (() => Promise<void>) | undefined; // 会话建好后才可由 cancel 触发；之前的取消由 run 在建好后处理

  constructor(
    private readonly opts: {
      modelsPath: string;
      workDir: string;
      sessionsRoot: string;
      coordinator: ReturnType<typeof createInterceptCoordinator>;
      emit: (event: SequencedEvent) => void;
      recordPiEventsPath?: string;
    },
  ) {}

  get disposed(): boolean {
    return this.#disposed;
  }

  run(task: StartTask): Promise<void> {
    if (this.#run) return Promise.reject(new Error("PiEngine runs only one task"));
    return (this.#run = this.#execute(task));
  }

  async cancel(): Promise<void> {
    if (!this.#run) return; // idle：无操作
    this.#outcome ??= { type: "run.cancelled" };
    this.#startStop?.().catch(() => {}); // 失败经 this.#run 报告
    await this.#run;
  }

  async #execute(task: StartTask): Promise<void> {
    const { coordinator } = this.opts;
    const events = createRunEvents(task.sessionId, this.opts.emit);
    const recorder = this.opts.recordPiEventsPath ? createRawEventRecorder(this.opts.recordPiEventsPath) : undefined;
    const abort = new AbortController(); // 拦截扩展的信号：中止后新的 decide 立即按 block 返回，不会挂起
    let scratchDir: string | undefined;
    let session: AgentSession | undefined;
    let lastAssistant: { stopReason?: string; errorMessage?: string } | undefined;
    let stopBegun!: () => void;
    const stopping = new Promise<void>((r) => (stopBegun = r)); // pi 的 prompt 可能永不返回：一旦开始清理，run 就跟随清理结果

    const stop = () =>
      (this.#stop ??= (stopBegun(), (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            (async () => {
              // 按顺序逐步尽力执行：某步失败也继续后面的步骤（scratchDir 里有 pi 的状态文件，必须删除），最后抛出第一个错误
              let first: { e: unknown } | undefined;
              for (const step of [
                () => coordinator.cancelAll("cancelled"),
                () => abort.abort(),
                () => session?.abort(), // 0B：不先 abort 就 dispose，收不到 settled、工具也不停
                () => session?.dispose(),
                () => recorder?.close(),
                () => scratchDir && rm(scratchDir, { recursive: true, force: true }),
              ])
                try {
                  await step();
                } catch (e) {
                  first ??= { e };
                }
              if (first) throw first.e;
            })(),
            new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${CLEANUP_LIMIT_MS} ms`)), CLEANUP_LIMIT_MS))),
          ]);
        } catch (e) {
          const original = this.#outcome?.type === "run.failed" ? `; run failed: ${this.#outcome.reason}` : "";
          const reason = `cleanup failed: ${message(e)}${original}`;
          events.finish({ type: "run.failed", reason });
          throw new Error(reason);
        } finally {
          clearTimeout(timer);
        }
        this.#disposed = true;
        events.finish(this.#outcome ?? { type: "run.failed", reason: "pi finished without agent_settled" });
      })()));

    const onPiEvent = (raw: AgentSessionEvent) => {
      recorder?.record(raw);
      if (raw.type === "agent_end") lastAssistant = raw.messages.findLast((m) => m.role === "assistant") as typeof lastAssistant;
      // 0B.2：agent_settled 是唯一的最终静止信号；agent_end 与单次模型错误都可能被重试
      // 自然结束后不会再来一个 agent_settled{aborted} 翻转结果：_startRun 的 finally 先 await _emitAgentSettled，prompt() 才 resolve（0B.2），之后才进入 stop
      if (raw.type === "agent_settled")
        this.#outcome ??= raw.aborted
          ? { type: "run.cancelled" }
          : lastAssistant?.stopReason === "error"
            ? { type: "run.failed", reason: lastAssistant.errorMessage ?? "model error" }
            : { type: "run.settled" };
      if (!this.#stop) for (const e of convertPiEvent(raw)) events.publish(e);
    };

    try {
      scratchDir = await mkdtemp(join(tmpdir(), "fp-run-")); // 每次运行独占，pi 的 auth/models-store 写在这里
      const created = await createPiSession({
        task, modelsPath: this.opts.modelsPath, workDir: this.opts.workDir, scratchDir,
        sessionsRoot: this.opts.sessionsRoot, decide: coordinator.decide, signal: abort.signal,
      });
      session = created.session;
      session.subscribe(onPiEvent);
      events.publish({ type: "run.started", snapshot: created.snapshot });
    } catch (e) {
      this.#outcome = { type: "run.failed", reason: message(e) }; // 启动失败优先于更早的取消：首事件只能是 run.started 或 run.failed
      return stop();
    }

    this.#startStop = stop;
    if (!this.#outcome) {
      try {
        await Promise.race([session.prompt(task.prompt), stopping]); // 模型最终失败也 resolve；reject 只发生在运行没有开始时
      } catch (e) {
        this.#outcome ??= { type: "run.failed", reason: message(e) };
      }
    }
    return stop();
  }
}
