import { z } from "zod";
import { SequencedEventSchema, type SequencedEvent } from "./agent-events.js";

const nes = z.string().refine((s) => s.trim().length > 0, "must be non-empty");
const json: z.ZodType<unknown> = z.unknown().refine((v) => v !== undefined, "required");

// 规范相对路径：不绝对、无反斜杠/NUL/盘符，且没有 ""、"."、".." 段（不做 URL 解码）
const RelPath = nes.refine(
  (p) => !p.includes("\\") && !p.includes("\0") && !/^[a-zA-Z]:/.test(p) && !p.split("/").some((s) => s === "" || s === "." || s === ".."),
  "path must be a normalized relative path using '/'",
);

export const ContextFileSchema = z.object({
  repo: nes.refine((r) => !r.includes("/"), "repo must not contain '/'"),
  path: RelPath,
  content: z.string(),
  sourceCommit: nes,
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

export const DecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allow") }),
  z.object({ decision: z.literal("block"), reason: nes }),
  z.object({ decision: z.literal("confirm"), reason: nes }),
]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ConfirmationSchema = z
  .object({ approved: z.boolean(), by: nes, reason: z.string().optional() })
  .refine((c) => c.approved || (c.reason !== undefined && c.reason.trim().length > 0), {
    message: "reason is required when approved is false",
    path: ["reason"],
  });
export type Confirmation = z.infer<typeof ConfirmationSchema>;

const StartTaskBase = z.object({
  type: z.literal("start_task"),
  requestId: nes,
  sessionId: nes,
  prompt: nes,
  model: z.object({ provider: nes, id: nes }),
  contextFiles: z.array(ContextFileSchema),
  interceptMode: z.enum(["callback", "policy"]),
  resume: z.object({ sessionFileRef: nes }).optional(),
  sessionDir: nes.optional(),
});
export const StartTaskSchema = StartTaskBase.superRefine((m, ctx) => {
  const seen = new Set<string>();
  m.contextFiles.forEach((f, i) => {
    const key = JSON.stringify([f.repo, f.path]);
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", message: `duplicate contextFile ${f.repo}:${f.path}`, path: ["contextFiles", i] });
    }
    seen.add(key);
  });
});
export type StartTask = z.infer<typeof StartTaskSchema>;

export const InterceptDecisionSchema = z.intersection(
  z.object({ type: z.literal("intercept_decision"), requestId: nes, callId: nes }),
  DecisionSchema,
);
export type InterceptDecision = z.infer<typeof InterceptDecisionSchema>;

export const ConfirmResponseSchema = z.intersection(
  z.object({ type: z.literal("confirm_response"), requestId: nes, confirmId: nes }),
  ConfirmationSchema,
);
export type ConfirmResponse = z.infer<typeof ConfirmResponseSchema>;

export const CancelSchema = z.object({ type: z.literal("cancel"), requestId: nes });
export type Cancel = z.infer<typeof CancelSchema>;

// 载荷（无消息 type）
export const ToolRequestSchema = z.object({ callId: nes, toolName: nes, input: json });
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export const ConfirmRequestSchema = z.object({
  confirmId: nes,
  callId: nes,
  toolName: nes,
  reason: nes,
  input: json,
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

export const AcceptedSchema = z.object({ type: z.literal("accepted"), requestId: nes, sessionId: nes });
export type Accepted = z.infer<typeof AcceptedSchema>;
export const EventMessageSchema = z.object({ type: z.literal("event"), event: SequencedEventSchema });
export type EventMessage = { type: "event"; event: SequencedEvent };
export const InterceptRequestSchema = ToolRequestSchema.extend({ type: z.literal("intercept_request") });
export type InterceptRequest = ToolRequest & { type: "intercept_request" };
export const ConfirmRequestMessageSchema = ConfirmRequestSchema.extend({ type: z.literal("confirm_request") });
export type ConfirmRequestMessage = ConfirmRequest & { type: "confirm_request" };

export const ProtocolErrorCodeSchema = z.enum([
  "invalid_message",
  "already_running",
  "run_finished",
  "not_implemented",
  "stale_response",
  "internal",
]);
export const ProtocolErrorSchema = z.object({
  type: z.literal("error"),
  requestId: nes.optional(),
  code: ProtocolErrorCodeSchema,
  message: nes,
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const ClientMessageSchema = z.union([StartTaskSchema, InterceptDecisionSchema, ConfirmResponseSchema, CancelSchema]);
export type ClientMessage = StartTask | InterceptDecision | ConfirmResponse | Cancel;
export const RunnerMessageSchema = z.union([
  AcceptedSchema,
  EventMessageSchema,
  InterceptRequestSchema,
  ConfirmRequestMessageSchema,
  ProtocolErrorSchema,
]);
export type RunnerMessage = Accepted | EventMessage | InterceptRequest | ConfirmRequestMessage | ProtocolError;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

// 按 type 分派到各消息 schema，使错误信息指向失败字段
function parse<T>(schemas: Record<string, z.ZodTypeAny>, raw: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const t = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
  const schema = typeof t === "string" && Object.hasOwn(schemas, t) ? schemas[t] : undefined;
  if (!schema) return { ok: false, error: `unknown or missing type: ${JSON.stringify(t)}` };
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, message: r.data as T };
  const issues = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, error: issues.join("; ") };
}

const clientSchemas = {
  start_task: StartTaskSchema,
  intercept_decision: InterceptDecisionSchema,
  confirm_response: ConfirmResponseSchema,
  cancel: CancelSchema,
};
const runnerSchemas = {
  accepted: AcceptedSchema,
  event: EventMessageSchema,
  intercept_request: InterceptRequestSchema,
  confirm_request: ConfirmRequestMessageSchema,
  error: ProtocolErrorSchema,
};

export const parseClientMessage = (raw: string): ParseResult<ClientMessage> => parse(clientSchemas, raw);
export const parseRunnerMessage = (raw: string): ParseResult<RunnerMessage> => parse(runnerSchemas, raw);
