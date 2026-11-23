import { z } from "zod";
import { SequencedEventSchema, type SequencedEvent } from "./agent-events.js";

const nes = z.string().min(1);
const json: z.ZodType<unknown> = z.unknown();

// 相对路径：不能是绝对路径、不含反斜杠、不含 ".." 段
const RelPath = nes.refine(
  (p) => !p.startsWith("/") && !p.includes("\\") && !/^[a-zA-Z]:/.test(p) && !p.split("/").includes(".."),
  "path must be relative, use '/', and not contain '..'",
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
  .refine((c) => c.approved || (c.reason !== undefined && c.reason.length > 0), {
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
export const InterceptRequestSchema = ToolRequestSchema.extend({ type: z.literal("intercept_request"), requestId: nes });
export type InterceptRequest = ToolRequest & { type: "intercept_request"; requestId: string };
export const ConfirmRequestMessageSchema = ConfirmRequestSchema.extend({ type: z.literal("confirm_request"), requestId: nes });
export type ConfirmRequestMessage = ConfirmRequest & { type: "confirm_request"; requestId: string };

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

function parse<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, message: r.data };
  const issues = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, error: issues.join("; ") };
}

export const parseClientMessage = (raw: string): ParseResult<ClientMessage> => parse(ClientMessageSchema, raw);
export const parseRunnerMessage = (raw: string): ParseResult<RunnerMessage> => parse(RunnerMessageSchema, raw);
