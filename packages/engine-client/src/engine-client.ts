import {
  parseClientMessage,
  parseRunnerMessage,
  type ClientMessage,
  type ConfirmRequest,
  type Confirmation,
  type Decision,
  type ProtocolError,
  type SequencedEvent,
  type StartTask,
  type ToolRequest,
} from "@forgepilot/engine-protocol";
import { WebSocket } from "ws";

const TERMINAL = new Set(["run.settled", "run.failed", "run.cancelled"]);
// 拒绝理由必须非空，否则兜底拒绝本身也会是非法消息
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim() || "handler failed without a message";

/**
 * runner 协议（engine.md）的调用方客户端：一个连接对应一个 runner、一次任务。
 * requestId 由客户端按消息生成；runner 的 error 回显它，据此把启动拒绝交给对应的 start()，其余交给 onError。
 */
export class EngineClient {
  private nextId = 0;
  private readonly starts = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private accepted = false;
  private closedError?: Error;
  private end!: Promise<SequencedEvent>;
  private settleEnd?: (r: SequencedEvent | Error) => void; // 结算后置空：之后的终止/断线不覆盖结果
  private eventCb?: (e: SequencedEvent) => void;
  private errorCb?: (e: ProtocolError) => void;
  private interceptCb?: (req: ToolRequest) => Promise<Decision>;
  private confirmCb?: (req: ConfirmRequest) => Promise<Confirmation>;

  private constructor(private readonly ws: WebSocket) {
    this.newEnd();
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("error", () => {}); // 随后的 close 事件负责结算
    ws.on("close", (code) => this.fail(new Error(`runner connection closed (code ${code})`)));
  }

  /** 不带 Origin 头（ws 的 Node 客户端默认不带）：runner 会拒绝带 Origin 的握手 */
  static async connect(url: string): Promise<EngineClient> {
    const ws = new WebSocket(url);
    const client = new EngineClient(ws); // 先挂监听，不漏掉 open 之后立刻到达的消息
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return client;
  }

  onEvent(cb: (e: SequencedEvent) => void): void {
    this.eventCb = cb;
  }
  onError(cb: (e: ProtocolError) => void): void {
    this.errorCb = cb;
  }
  onIntercept(cb: (req: ToolRequest) => Promise<Decision>): void {
    this.interceptCb = cb;
  }
  onConfirm(cb: (req: ConfirmRequest) => Promise<Confirmation>): void {
    this.confirmCb = cb;
  }

  /** accepted 后 resolve；启动拒绝时 reject，尚未有任务被接受时 waitForEnd 同样 reject */
  start(task: Omit<StartTask, "type" | "requestId">): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (!this.settleEnd && !this.accepted) this.newEnd(); // 启动前被拒绝后可修正重试（engine.md §2.1）
    const requestId = this.id();
    return new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        reject(e);
        if (!this.accepted) this.settleEnd?.(e);
      };
      this.starts.set(requestId, { resolve, reject: fail });
      try {
        this.send({ ...task, type: "start_task", requestId });
      } catch (e) {
        this.starts.delete(requestId);
        fail(e as Error);
      }
    });
  }

  cancel(): void {
    this.send({ type: "cancel", requestId: this.id() });
  }

  /** 唯一终止事件；终止前断线或连接失败时 reject（不伪造 run.cancelled） */
  waitForEnd(): Promise<SequencedEvent> {
    return this.end;
  }

  async close(): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => this.ws.once("close", r));
      this.ws.close(1000);
      await closed;
    }
    this.ws.removeAllListeners();
    this.eventCb = this.errorCb = this.interceptCb = this.confirmCb = undefined;
  }

  private id(): string {
    return `r${++this.nextId}`;
  }

  private newEnd(): void {
    this.end = new Promise((resolve, reject) => {
      this.settleEnd = (r) => {
        this.settleEnd = undefined;
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
    });
    this.end.catch(() => {}); // 没人等待时不算未处理的 rejection
  }

  /** 发送前按协议校验（双向校验），非法时抛错且不发送；发送解析后的消息，去掉未知字段 */
  private send(m: ClientMessage): void {
    const parsed = parseClientMessage(JSON.stringify(m));
    if (!parsed.ok) throw new Error(`invalid ${m.type}: ${parsed.error}`);
    this.ws.send(JSON.stringify(parsed.message));
  }

  /** 连接失败或关闭：结算所有等待项；先到的原因为准 */
  private fail(err: Error): void {
    this.closedError ??= err;
    for (const p of this.starts.values()) p.reject(err);
    this.starts.clear();
    this.settleEnd?.(err);
  }

  private onMessage(raw: string): void {
    const parsed = parseRunnerMessage(raw);
    if (!parsed.ok) {
      this.fail(new Error(`invalid runner message: ${parsed.error}`));
      return this.ws.terminate();
    }
    const m = parsed.message;
    switch (m.type) {
      case "accepted":
        this.accepted = true;
        this.starts.get(m.requestId)?.resolve();
        this.starts.delete(m.requestId);
        return;
      case "event":
        if (TERMINAL.has(m.event.type)) this.settleEnd?.(m.event);
        return this.eventCb?.(m.event);
      case "intercept_request": {
        const { type: _, ...req } = m;
        const reply = (d: Decision): ClientMessage => ({ ...d, type: "intercept_decision", requestId: this.id(), callId: req.callId });
        return void this.reply(
          async () => {
            if (!this.interceptCb) throw new Error("no onIntercept handler registered");
            return reply(await this.interceptCb(req));
          },
          (why) => reply({ decision: "block", reason: `engine-client: ${why}` }),
        );
      }
      case "confirm_request": {
        const { type: _, ...req } = m;
        const reply = (c: Confirmation): ClientMessage => ({ ...c, type: "confirm_response", requestId: this.id(), confirmId: req.confirmId });
        return void this.reply(
          async () => {
            if (!this.confirmCb) throw new Error("no onConfirm handler registered");
            return reply(await this.confirmCb(req));
          },
          (why) => reply({ approved: false, by: "engine-client", reason: why }),
        );
      }
      case "error": {
        const p = m.requestId === undefined ? undefined : this.starts.get(m.requestId);
        if (!p) return this.errorCb?.(m);
        this.starts.delete(m.requestId!);
        return p.reject(new Error(`${m.code}: ${m.message}`, { cause: m }));
      }
    }
  }

  /** 处理器缺失、抛错或返回非法应答时，改发带原因的拒绝（fail closed） */
  private async reply(build: () => Promise<ClientMessage>, refuse: (why: string) => ClientMessage): Promise<void> {
    try {
      this.send(await build());
    } catch (e) {
      this.send(refuse(reasonOf(e)));
    }
  }
}
