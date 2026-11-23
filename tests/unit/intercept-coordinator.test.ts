import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterceptCoordinator } from "../../packages/engine-runner/src/intercept-coordinator.js";
import { createInterceptExtension } from "../../packages/engine-runner/src/intercept-extension.js";
import type { ConfirmResponse, InterceptDecision, RunnerMessage } from "../../packages/engine-protocol/src/index.js";

const req = { callId: "c1", toolName: "bash", input: { command: "ls" } };
const dec = (d: object, callId = "c1"): InterceptDecision =>
  ({ type: "intercept_decision", requestId: "r", callId, ...d }) as InterceptDecision;
const conf = (confirmId: string, d: object): ConfirmResponse =>
  ({ type: "confirm_response", requestId: "r", confirmId, ...d }) as ConfirmResponse;

let co: ReturnType<typeof createInterceptCoordinator>;
function setup(send?: (m: RunnerMessage) => void) {
  const sent: RunnerMessage[] = [];
  co = createInterceptCoordinator({
    send: (m) => {
      sent.push(m);
      send?.(m);
    },
    interceptTimeoutMs: 200,
    confirmTimeoutMs: 200,
  });
  return sent;
}
afterEach(() => {
  vi.useRealTimers();
  expect(co.pendingCount).toBe(0);
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createInterceptCoordinator", () => {
  it("allow", async () => {
    const sent = setup((m) => m.type === "intercept_request" && queueMicrotask(() => co.respond(dec({ decision: "allow" }))));
    expect(await co.decide(req, new AbortController().signal)).toEqual({ decision: "allow" });
    expect(sent[0]).toMatchObject({ type: "intercept_request", callId: "c1", toolName: "bash" });
  });

  it("block 带原因", async () => {
    setup((m) => m.type === "intercept_request" && queueMicrotask(() => co.respond(dec({ decision: "block", reason: "no" }))));
    expect(await co.decide(req, new AbortController().signal)).toEqual({ decision: "block", reason: "no" });
  });

  it("confirm 同意 -> allow", async () => {
    const sent = setup((m) => {
      if (m.type === "intercept_request") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "risky" })));
      if (m.type === "confirm_request") queueMicrotask(() => co.respond(conf(m.confirmId, { approved: true, by: "alice" })));
    });
    expect(await co.decide(req, new AbortController().signal)).toEqual({ decision: "allow" });
    expect(sent[1]).toMatchObject({ type: "confirm_request", callId: "c1", toolName: "bash", reason: "risky", input: { command: "ls" } });
  });

  it("confirm 拒绝 -> block，原因含拒绝理由与 by", async () => {
    setup((m) => {
      if (m.type === "intercept_request") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "risky" })));
      if (m.type === "confirm_request") queueMicrotask(() => co.respond(conf(m.confirmId, { approved: false, by: "bob", reason: "too dangerous" })));
    });
    const r = await co.decide(req, new AbortController().signal);
    expect(r.decision).toBe("block");
    expect(r).toMatchObject({ reason: expect.stringContaining("too dangerous") });
    expect(r).toMatchObject({ reason: expect.stringContaining("bob") });
  });

  it("拦截超时 -> block", async () => {
    setup();
    const r = await co.decide(req, new AbortController().signal);
    expect(r).toMatchObject({ decision: "block", reason: expect.stringContaining("intercept") });
  });

  it("确认超时单独计时 -> block，迟到同意 stale 且不放行", async () => {
    let confirmId = "";
    const sent = setup((m) => {
      if (m.type === "intercept_request") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "risky" })));
      if (m.type === "confirm_request") confirmId = m.confirmId;
    });
    const r = await co.decide(req, new AbortController().signal);
    expect(r).toMatchObject({ decision: "block", reason: expect.stringContaining("confirm") });
    expect(sent.some((m) => m.type === "confirm_request")).toBe(true);
    expect(co.respond(conf(confirmId, { approved: true, by: "alice" }))).toEqual({ ok: false, code: "stale_response" });
    expect(r.decision).toBe("block");
  });

  it("迟到的拦截决定 -> stale_response", async () => {
    setup();
    await co.decide(req, new AbortController().signal);
    expect(co.respond(dec({ decision: "allow" }))).toEqual({ ok: false, code: "stale_response" });
  });

  it("send 抛错 -> block", async () => {
    setup(() => {
      throw new Error("ws closed");
    });
    const r = await co.decide(req, new AbortController().signal);
    expect(r).toEqual({ decision: "block", reason: "send failed" });
  });

  it("abort -> block 并清理", async () => {
    setup();
    const ac = new AbortController();
    const p = co.decide(req, ac.signal);
    await tick();
    expect(co.pendingCount).toBe(1);
    ac.abort();
    expect(await p).toEqual({ decision: "block", reason: "aborted" });
  });

  it("已 abort 的 signal -> 直接 block，不发请求", async () => {
    const sent = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await co.decide(req, ac.signal)).toMatchObject({ decision: "block" });
    expect(sent).toHaveLength(0);
  });

  it("cancelAll 自行结算等待（拦截与确认阶段）并带原因", async () => {
    setup((m) => {
      if (m.type === "intercept_request" && m.callId === "c2") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "x" }, "c2")));
    });
    const p1 = co.decide(req, new AbortController().signal);
    await tick();
    expect(co.pendingCount).toBe(1);
    co.cancelAll("run cancelled");
    expect(await p1).toEqual({ decision: "block", reason: "run cancelled" });
    const p2 = co.decide({ ...req, callId: "c2" }, new AbortController().signal);
    await tick();
    expect(co.pendingCount).toBe(1);
    co.cancelAll("run cancelled");
    expect(await p2).toEqual({ decision: "block", reason: "run cancelled" });
  });

  it("重复或错误 ID -> stale_response，不改变决定", async () => {
    setup();
    const p = co.decide(req, new AbortController().signal);
    await tick();
    expect(co.respond(dec({ decision: "allow" }, "other"))).toEqual({ ok: false, code: "stale_response" });
    expect(co.respond(conf("nope", { approved: true, by: "a" }))).toEqual({ ok: false, code: "stale_response" });
    expect(co.respond(dec({ decision: "block", reason: "no" }))).toEqual({ ok: true });
    expect(co.respond(dec({ decision: "allow" }))).toEqual({ ok: false, code: "stale_response" });
    expect(await p).toEqual({ decision: "block", reason: "no" });
  });
});

describe("清理、独立计时与重复 callId", () => {
  const confirmFlow = (m: RunnerMessage) => {
    if (m.type === "intercept_request") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "risky" })));
  };

  it("respond 结算后计时器与 abort 监听均已清理（长寿 signal）", async () => {
    vi.useFakeTimers();
    setup((m) => m.type === "intercept_request" && queueMicrotask(() => co.respond(dec({ decision: "allow" }))));
    const ac = new AbortController();
    await co.decide(req, ac.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("cancelAll 结算后计时器已清理", async () => {
    vi.useFakeTimers();
    setup();
    const p = co.decide(req, new AbortController().signal);
    expect(vi.getTimerCount()).toBe(1);
    co.cancelAll("x");
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort 结算后计时器已清理", async () => {
    vi.useFakeTimers();
    setup();
    const ac = new AbortController();
    const p = co.decide(req, ac.signal);
    ac.abort();
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("send 抛错结算后计时器与监听已清理", async () => {
    vi.useFakeTimers();
    setup(() => {
      throw new Error("boom");
    });
    const ac = new AbortController();
    await co.decide(req, ac.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("确认超时从确认请求发出时重新计时，不与拦截共用截止时间", async () => {
    vi.useFakeTimers();
    const sent = setup();
    const p = co.decide(req, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(150);
    expect(co.respond(dec({ decision: "confirm", reason: "risky" }))).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.map((m) => m.type)).toEqual(["intercept_request", "confirm_request"]);
    expect(co.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    const r = await p;
    expect(r).toMatchObject({ decision: "block", reason: expect.stringMatching(/confirm.*timed out/) });
  });

  it("重复 callId：第二个立即 block 且不发送，第一个仍可正常结算", async () => {
    const sent = setup();
    const p1 = co.decide(req, new AbortController().signal);
    const r2 = await co.decide(req, new AbortController().signal);
    expect(r2).toEqual({ decision: "block", reason: "duplicate callId" });
    expect(sent).toHaveLength(1);
    expect(co.pendingCount).toBe(1);
    expect(co.respond(dec({ decision: "allow" }))).toEqual({ ok: true });
    expect(await p1).toEqual({ decision: "allow" });
  });

  it("发送 confirm_request 时 send 抛错 -> block", async () => {
    setup((m) => {
      if (m.type === "intercept_request") queueMicrotask(() => co.respond(dec({ decision: "confirm", reason: "risky" })));
      if (m.type === "confirm_request") throw new Error("ws closed");
    });
    const res = await co.decide(req, new AbortController().signal);
    expect(res).toEqual({ decision: "block", reason: "send failed" });
    expect(JSON.stringify(res)).not.toContain("ws closed");
  });

  it("确认阶段 abort -> block aborted", async () => {
    setup(confirmFlow);
    const ac = new AbortController();
    const p = co.decide(req, ac.signal);
    await tick();
    await tick();
    expect(co.pendingCount).toBe(1);
    ac.abort();
    expect(await p).toEqual({ decision: "block", reason: "aborted" });
  });
});

describe("createInterceptExtension", () => {
  function handler(decide: Parameters<typeof createInterceptExtension>[0]) {
    let h: ((e: unknown) => Promise<unknown>) | undefined;
    createInterceptExtension(decide, new AbortController().signal)({ on: (n: string, f: never) => n === "tool_call" && (h = f) } as never);
    return h!;
  }
  const ev = { toolCallId: "c1", toolName: "bash", input: { a: 1 } };

  it("allow 返回 undefined，并传递 callId/toolName/input", async () => {
    let got: unknown;
    const h = handler(async (r) => ((got = r), { decision: "allow" }));
    expect(await h(ev)).toBeUndefined();
    expect(got).toEqual({ callId: "c1", toolName: "bash", input: { a: 1 } });
  });

  it("block 返回 {block:true, reason}", async () => {
    const h = handler(async () => ({ decision: "block", reason: "no" }));
    expect(await h(ev)).toEqual({ block: true, reason: "no" });
  });
});
