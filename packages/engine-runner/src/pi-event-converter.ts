import type { ProgressEvent } from "@forgepilot/engine-protocol";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 把 pi 原始事件转成进度事件。只读 text_delta 的 delta 与 message_end 的消息内容，
 * 不读会继续变化的 partial。不产生终止事件；未知或畸形事件返回 []。
 */
export function convertPiEvent(raw: unknown): ProgressEvent[] {
  if (!isObj(raw)) return [];
  switch (raw.type) {
    case "message_update": {
      const a = raw.assistantMessageEvent;
      if (isObj(a) && a.type === "text_delta" && typeof a.delta === "string") return [{ type: "text.delta", text: a.delta }];
      return [];
    }
    case "message_end": {
      const m = raw.message;
      if (!isObj(m) || m.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") return [];
      if (!Array.isArray(m.content)) return [];
      const text = m.content
        .flatMap((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : []))
        .join("");
      return text === "" ? [] : [{ type: "message.completed", role: "assistant", text }];
    }
    case "tool_execution_start":
      if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string") return [];
      return [{ type: "tool.started", callId: raw.toolCallId, toolName: raw.toolName, input: raw.args ?? null }];
    case "tool_execution_end":
      if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string") return [];
      return [{ type: "tool.finished", callId: raw.toolCallId, toolName: raw.toolName, isError: raw.isError === true, output: raw.result ?? null }];
    default:
      return [];
  }
}
