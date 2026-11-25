import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRawEventRecorder } from "../../packages/engine-runner/src/raw-event-recorder.js";

let finishDestroy = () => {};
// 模拟 fs.WriteStream：写入失败即 destroy；_destroy 像关闭 fd 一样异步完成，'error' 事件要等它完成后才发出
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  createWriteStream: () =>
    new Writable({
      write: (_chunk, _enc, cb) => cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      destroy: (err, cb) => void (finishDestroy = () => cb(err)),
    }),
}));

describe("createRawEventRecorder", () => {
  it("写入失败、流已销毁但 'error' 事件尚未发出时关闭：close 报原始写入错误，而不是 end-after-destroy", async () => {
    const recorder = createRawEventRecorder("unused.jsonl");
    recorder.record({ type: "agent_start" });
    await new Promise((r) => setImmediate(r)); // 写入失败已处理、流已销毁；_destroy 未完成，'error' 事件未发
    const closing = recorder.close();
    finishDestroy();
    await expect(closing).rejects.toThrow(/EPIPE/);
  });
});
