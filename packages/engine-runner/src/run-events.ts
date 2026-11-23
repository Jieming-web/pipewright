import type { ProgressEvent, SequencedEvent, TerminalEvent } from "@forgepilot/engine-protocol";

/** 会话内唯一的序号分配方：seq 从 1 连续递增；finish 之后忽略一切发布。 */
export function createRunEvents(
  sessionId: string,
  emit: (event: SequencedEvent) => void,
  now: () => Date = () => new Date(),
): { publish(event: ProgressEvent): void; finish(event: TerminalEvent): void } {
  let seq = 0;
  let done = false;
  const send = (event: ProgressEvent | TerminalEvent) =>
    emit({ ...event, sessionId, seq: ++seq, at: now().toISOString() });
  return {
    publish(event) {
      if (!done) send(event);
    },
    finish(event) {
      if (done) return;
      done = true;
      send(event);
    },
  };
}
