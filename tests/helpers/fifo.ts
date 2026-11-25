import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";

// 诊断文件故障注入，不加产品开关（engine.md 进程退出）：读端由测试持有，runner 打开写端不会卡住

/** 建 FIFO 并以非阻塞方式打开读端（不读），返回读端 fd。之后关闭它，runner 的写入得到 EPIPE（清理失败） */
export function fifoReader(path: string): number {
  execFileSync("mkfifo", [path]);
  return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
}

/** 写满管道缓冲区（读端须已打开且不读）：runner 的阻塞写入卡在线程池里，录制的 close 永不完成（清理超时）。逐级到 1 字节，不依赖 macOS/Linux 的缓冲区大小 */
export function fillFifo(path: string): void {
  const w = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    for (const size of [65536, 4096, 1]) {
      const b = Buffer.alloc(size);
      for (;;) {
        try {
          writeSync(w, b);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EAGAIN") break;
          throw e;
        }
      }
    }
  } finally {
    closeSync(w);
  }
}

/** 等 runner 打开写端：非阻塞读在没有写端时返回 0（EOF），有写端时返回 EAGAIN 或读到数据 */
export async function writerOpened(fd: number, timeoutMs = 8000): Promise<void> {
  const buf = Buffer.alloc(65536);
  for (const t0 = performance.now(); performance.now() - t0 < timeoutMs; await new Promise((r) => setTimeout(r, 5))) {
    try {
      if (readSync(fd, buf) > 0) return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") return;
      throw e;
    }
  }
  throw new Error(`FIFO writer not opened within ${timeoutMs} ms`);
}
