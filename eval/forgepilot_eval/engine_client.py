"""经 stdio 桥驱动一次任务：stdin 写协议行，stdout 读协议行（engine.md「传输：stdio 桥」）。

同步实现：读线程把 stdout 的行放进队列，主循环带超时取出，所以桥一直不输出也不会卡住。
"""
import itertools
import json
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

TERMINAL = {"run.settled", "run.failed", "run.cancelled"}
DENY_CONFIRM = {"approved": False, "by": "eval", "reason": "eval does not confirm"}


@dataclass
class RunResult:
    terminal: dict | None
    failure: str | None
    timed_out: bool


def run_task(
    cmd: list[str],
    start: dict,
    decide: Callable[[dict], dict],
    on_event: Callable[[dict], None],
    timeout_s: float,
    kill: Callable[[], None],
    grace_s: float = 15,
) -> RunResult:
    """kill 由调用方提供（如删除容器）；收尾超过 grace_s 时调用，随后杀掉桥子进程。"""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8", errors="replace")
    lines: queue.Queue[str | None] = queue.Queue()

    def pump():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)  # EOF

    threading.Thread(target=pump, daemon=True).start()
    ids = itertools.count(1)
    terminal = failure = None
    timed_out = False
    deadline = time.monotonic() + timeout_s
    kill_at = None  # 开始收尾后的强杀时刻

    def send(msg: dict):
        try:
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError):
            pass  # 桥已退出或 stdin 已关：由 stdout EOF 记录失败

    def shut_down(cancel: bool):
        nonlocal kill_at
        if kill_at is None:
            kill_at = time.monotonic() + grace_s
            if cancel:
                send({"type": "cancel", "requestId": f"py-{next(ids)}"})

    try:
        send(start)
        while True:
            now = time.monotonic()
            if kill_at is None and now >= deadline:
                timed_out = True
                shut_down(cancel=True)
            if kill_at is not None and now >= kill_at:
                kill()
                proc.kill()
                break
            try:
                line = lines.get(timeout=max(0, (deadline if kill_at is None else kill_at) - now))
            except queue.Empty:
                continue
            if line is None:
                try:
                    proc.wait(timeout=max(0, (now + grace_s if kill_at is None else kill_at) - time.monotonic()))
                except subprocess.TimeoutExpired:
                    kill()
                    proc.kill()
                    break
                if terminal is None and failure is None:
                    failure = f"bridge exited: code {proc.returncode}"
                break

            problem = None
            try:
                msg = json.loads(line)
            except ValueError:
                msg, problem = None, "non-JSON line"
            if problem is None and not (isinstance(msg, dict) and isinstance(msg.get("type"), str)):
                problem = "message without type"
            if problem is None and msg["type"] == "event":
                ev = msg.get("event")
                if not (isinstance(ev, dict) and isinstance(ev.get("type"), str) and isinstance(ev.get("seq"), int)):
                    problem = "event without type/seq"
            if problem:
                failure = failure or f"protocol: {problem}: {line.rstrip()[:200]}"
                shut_down(cancel=True)
                continue

            if msg["type"] == "event":
                on_event(ev)
                if ev["type"] in TERMINAL and terminal is None:
                    terminal = ev
                    shut_down(cancel=False)
                    proc.stdin.close()  # 桥关闭 WebSocket，runner 收尾退出
            elif msg["type"] == "intercept_request":
                send({"type": "intercept_decision", "requestId": f"py-{next(ids)}", "callId": msg["callId"], **decide(msg)})
            elif msg["type"] == "confirm_request":
                send({"type": "confirm_response", "requestId": f"py-{next(ids)}", "confirmId": msg["confirmId"], **DENY_CONFIRM})
            # accepted、error（如 stale_response）不影响结果
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        try:
            proc.stdin.close()
        except OSError:
            pass
    return RunResult(terminal, failure, timed_out)
