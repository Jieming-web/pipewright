import { randomUUID } from "node:crypto";
import type { ConfirmResponse, InterceptDecision, RunnerMessage, ToolRequest } from "@forgepilot/engine-protocol";

export type FinalDecision = { decision: "allow" } | { decision: "block"; reason: string };
type Answer = InterceptDecision | ConfirmResponse;
// 等待结果：收到应答，或以某个原因失败（超时/发送失败/中止/取消）
type Settled = { answer: Answer } | { failed: string };

export function createInterceptCoordinator(opts: {
  send: (message: RunnerMessage) => void;
  interceptTimeoutMs: number;
  confirmTimeoutMs: number;
}) {
  // key = "intercept:<callId>" | "confirm:<confirmId>"；任何结算都先从这里移除，之后的应答即为 stale
  const pending = new Map<string, (s: Settled) => void>();

  function wait(key: string, ms: number, label: string, signal: AbortSignal, message: RunnerMessage): Promise<Settled> {
    return new Promise<Settled>((resolve) => {
      const onAbort = () => settle({ failed: "aborted" });
      if (pending.has(key)) return resolve({ failed: "duplicate callId" });
      const timer = setTimeout(() => settle({ failed: `${label} timed out` }), ms);
      function settle(s: Settled) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (pending.get(key) === settle) pending.delete(key);
        resolve(s);
      }
      if (signal.aborted) return settle({ failed: "aborted" });
      pending.set(key, settle);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        opts.send(message);
      } catch (e) {
        settle({ failed: `send failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  const block = (reason: string): FinalDecision => ({ decision: "block", reason });

  async function decide(req: ToolRequest, signal: AbortSignal): Promise<FinalDecision> {
    const r1 = await wait(`intercept:${req.callId}`, opts.interceptTimeoutMs, "intercept", signal, { type: "intercept_request", ...req });
    if ("failed" in r1) return block(r1.failed);
    const d = r1.answer as InterceptDecision;
    if (d.decision === "allow") return { decision: "allow" };
    if (d.decision === "block") return block(d.reason);

    const confirmId = randomUUID();
    const r2 = await wait(`confirm:${confirmId}`, opts.confirmTimeoutMs, "confirm", signal, {
      type: "confirm_request",
      confirmId,
      callId: req.callId,
      toolName: req.toolName,
      reason: d.reason,
      input: req.input,
    });
    if ("failed" in r2) return block(r2.failed);
    const c = r2.answer as ConfirmResponse;
    return c.approved ? { decision: "allow" } : block(`rejected by ${c.by}: ${c.reason}`);
  }

  function respond(message: Answer): { ok: true } | { ok: false; code: "stale_response" } {
    const key = message.type === "intercept_decision" ? `intercept:${message.callId}` : `confirm:${message.confirmId}`;
    const settle = pending.get(key);
    if (!settle) return { ok: false, code: "stale_response" };
    settle({ answer: message });
    return { ok: true };
  }

  function cancelAll(reason: string): void {
    for (const settle of [...pending.values()]) settle({ failed: reason });
  }

  return { decide, respond, cancelAll, get pendingCount() { return pending.size; } };
}
