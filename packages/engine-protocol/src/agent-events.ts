import { z } from "zod";

export const RunSnapshotSchema = z.object({
  engine: z.object({ name: z.string(), version: z.string() }),
  model: z.object({ provider: z.string(), id: z.string() }),
  contextFiles: z.array(
    z.object({
      repo: z.string(),
      path: z.string(),
      sourceCommit: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

// JSON 可序列化的任意值（工具入参/结果不假定是字符串）
// 键必须存在（任意 JSON 值，含 null）；JSON 解析不会产生 undefined
const json: z.ZodType<unknown> = z.unknown().refine((v) => v !== undefined, "required");

export const ProgressEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), snapshot: RunSnapshotSchema }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  z.object({ type: z.literal("message.completed"), role: z.literal("assistant"), text: z.string() }),
  z.object({ type: z.literal("tool.started"), callId: z.string(), toolName: z.string(), input: json }),
  z.object({ type: z.literal("tool.finished"), callId: z.string(), toolName: z.string(), isError: z.boolean(), output: json }),
]);
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const TerminalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.settled") }),
  z.object({ type: z.literal("run.failed"), reason: z.string() }),
  z.object({ type: z.literal("run.cancelled") }),
]);
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

export const AgentEventSchema = z.union([ProgressEventSchema, TerminalEventSchema]);
export type AgentEvent = ProgressEvent | TerminalEvent;

export type SequencedEvent = AgentEvent & { sessionId: string; seq: number; at: string };

export const SequencedEventSchema = z.intersection(
  AgentEventSchema,
  z.object({ sessionId: z.string().min(1), seq: z.number().int().positive(), at: z.string().datetime() }),
);
