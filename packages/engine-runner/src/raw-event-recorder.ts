import { createWriteStream } from "node:fs";

/** 把 pi 原始事件逐行写成 JSONL 诊断文件；close() 成功才算录制完整，任何写入错误都在 close() 时抛出。 */
export function createRawEventRecorder(path: string): { record(raw: unknown): void; close(): Promise<void> } {
  const out = createWriteStream(path, { mode: 0o600 });
  let error: unknown;
  out.on("error", (e) => (error ??= e));
  return {
    record(raw) {
      if (error) return;
      try {
        out.write(JSON.stringify(raw) + "\n"); // 收到即序列化：pi 的部分字段是会继续变化的共享对象
      } catch (e) {
        error ??= e;
      }
    },
    // 先报最早的错误（如打开时的 ENOENT），而不是随后的 end-after-destroy
    close: () => new Promise<void>((ok, fail) => out.end((e?: Error | null) => ((error ?? e) ? fail(error ?? e) : ok()))),
  };
}
