import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { createInterceptCoordinator } from "./intercept-coordinator.js";

// pi 的 tool_call 钩子：返回 undefined 放行，{block, reason} 阻止；确认在 decide 内等待，不用 pi 的 ui.confirm
export function createInterceptExtension(
  decide: ReturnType<typeof createInterceptCoordinator>["decide"],
  signal: AbortSignal,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (e) => {
      const r = await decide({ callId: e.toolCallId, toolName: e.toolName, input: e.input }, signal);
      return r.decision === "allow" ? undefined : { block: true, reason: r.reason };
    });
  };
}
