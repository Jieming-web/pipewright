import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from forgepilot_eval import engine_client
from forgepilot_eval.engine_client import run_task
from forgepilot_eval.policy import Policy, PolicyConfig

# 本机用 node 跑桥 + runner（构建产物）+ 假模型（外部进程），不用 Docker；Python 侧只读写 JSON 行
ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "packages/engine-client/dist/stdio-bridge.js"
RUNNER = ROOT / "packages/engine-runner/dist/main.js"
FAKE_CLI = ROOT / "tests/helpers/fake-openai-cli.ts"

START = {
    "type": "start_task",
    "requestId": "A",
    "sessionId": "s1",
    "prompt": "go",
    "model": {"provider": "fake", "id": "fake-model"},
    "contextFiles": [],
    "interceptMode": "callback",
}
TOOL = lambda cmd: [  # noqa: E731
    {"kind": "toolCall", "name": "bash", "args": {"command": cmd}, "id": "c1"},
    {"kind": "text", "chunks": ["done"]},
]
ALLOW = lambda req: {"decision": "allow"}  # noqa: E731
_Popen = subprocess.Popen  # 假模型用原始 Popen，不计入 spawned


@pytest.fixture(autouse=True)
def spawned(monkeypatch):
    """记下 run_task 启动的每个桥子进程；每个测试结束时它们都必须已被 wait（returncode 不为 None）"""
    procs = []
    real = subprocess.Popen

    def popen(*a, **kw):
        p = real(*a, **kw)
        procs.append(p)
        return p

    monkeypatch.setattr(engine_client.subprocess, "Popen", popen)
    yield procs
    monkeypatch.undo()
    assert procs and all(p.returncode is not None for p in procs)


@pytest.fixture
def launch(tmp_path):
    """起假模型（外部 node 进程）并返回桥的命令行"""
    fakes = []

    def make(turns):
        (tmp_path / "turns.json").write_text(json.dumps(turns))
        fake = _Popen(
            ["node", "--import", "tsx", str(FAKE_CLI), str(tmp_path / "turns.json")],
            cwd=ROOT, stdout=subprocess.PIPE, text=True,
        )
        fakes.append(fake)
        line = fake.stdout.readline()
        assert line.startswith("FAKE_LISTENING "), line
        base_url = line.split()[1]
        models = {"providers": {"fake": {
            "baseUrl": base_url, "api": "openai-completions", "apiKey": "fake-key",
            "compat": {"supportsStore": False, "supportsDeveloperRole": False, "supportsReasoningEffort": False},
            "models": [{"id": "fake-model", "reasoning": False, "input": ["text"], "contextWindow": 32768, "maxTokens": 4096}],
        }}}
        (tmp_path / "models.json").write_text(json.dumps(models))
        for d in ("work", "sessions"):
            (tmp_path / d).mkdir(exist_ok=True)
        return ["node", str(BRIDGE), "--runner", str(RUNNER), "--",
                "--port", "0", "--models", str(tmp_path / "models.json"), "--workdir", str(tmp_path / "work"),
                "--sessions-root", str(tmp_path / "sessions"), "--idle-timeout-ms", "10000"]

    yield make
    for f in fakes:
        f.terminate()
        f.wait(10)
        f.stdout.close()


def fake_bridge(script):
    """忽略 stdin 的假桥：执行 script 后永不退出"""
    return [sys.executable, "-c", script + "\nimport time\nwhile True: time.sleep(60)"]


def collect():
    events = []
    return events, events.append


def test_settled_with_contiguous_seq_and_tool_runs_after_allow(launch, tmp_path):
    events, on_event = collect()
    r = run_task(launch(TOOL("touch ran.marker")), START, ALLOW, on_event, timeout_s=30, kill=lambda: None)
    assert r.failure is None and r.timed_out is False
    assert r.terminal["type"] == "run.settled"
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert events[-1] is r.terminal
    assert (tmp_path / "work/ran.marker").exists()


def test_blocked_tool_does_not_run(launch, tmp_path):
    requests = []

    def decide(req):
        requests.append(req)
        return {"decision": "block", "reason": "no"}

    events, on_event = collect()
    r = run_task(launch(TOOL("touch ran.marker")), START, decide, on_event, timeout_s=30, kill=lambda: None)
    assert r.terminal["type"] == "run.settled" and r.failure is None
    assert [q["toolName"] for q in requests] == ["bash"]
    assert not (tmp_path / "work/ran.marker").exists()


def test_confirm_request_is_always_denied(launch, tmp_path):
    # decide 返回 confirm：runner 发 confirm_request，客户端一律拒绝，工具不执行
    events, on_event = collect()
    r = run_task(launch(TOOL("touch ran.marker")), START, lambda q: {"decision": "confirm", "reason": "ask"},
                 on_event, timeout_s=30, kill=lambda: None)
    assert r.terminal["type"] == "run.settled"
    assert not (tmp_path / "work/ran.marker").exists()


def test_timeout_sends_cancel_and_gets_cancelled(launch):
    slow = [{"kind": "text", "chunks": ["x"] * 30, "chunkDelayMs": 500}]
    kills = []
    events, on_event = collect()
    r = run_task(launch(slow), START, ALLOW, on_event, timeout_s=1, kill=lambda: kills.append(1))
    assert r.timed_out is True
    assert r.terminal["type"] == "run.cancelled"
    assert r.failure is None and kills == []


def test_should_cancel_takes_the_cancel_path_without_timed_out(launch, spawned):
    # 第 2 次工具调用超限被拒，exhausted 变 True，随后经 should_cancel 取消
    turns = [{"kind": "toolCall", "name": "bash", "args": {"command": f"echo {i}"}, "id": f"c{i}"} for i in range(5)]
    policy = Policy(PolicyConfig(tools=["bash"], danger_patterns=[], max_tool_calls=1))
    kills = []
    r = run_task(launch(turns + [{"kind": "text", "chunks": ["done"]}]), START, policy.decide, lambda e: None,
                 timeout_s=30, kill=lambda: kills.append(1), should_cancel=lambda: policy.exhausted)
    assert policy.exhausted and policy.calls >= 2
    assert r.terminal["type"] == "run.cancelled"
    assert r.timed_out is False and r.failure is None and kills == []
    assert spawned[0].returncode is not None


def test_silent_bridge_returns_in_time_and_calls_kill():
    kills = []
    t0 = time.monotonic()
    r = run_task(fake_bridge(""), START, ALLOW, lambda e: None, timeout_s=1, kill=lambda: kills.append(1), grace_s=1)
    assert time.monotonic() - t0 < 1 + 1 + 2
    assert r.timed_out is True and r.terminal is None
    assert kills == [1]


@pytest.mark.parametrize("line", [
    "not json",
    '{"requestId": "A"}',
    '{"type": "event", "event": {"type": "text.delta", "text": "x"}}',
    '{"type": "event", "event": {"seq": 1}}',
    '{"type": "intercept_request", "toolName": "bash", "input": {}}',
    '{"type": "confirm_request", "callId": "c1", "toolName": "bash", "reason": "r", "input": {}}',
])
def test_protocol_error_fails_and_shuts_down(line):
    kills = []
    t0 = time.monotonic()
    r = run_task(fake_bridge(f"print({line!r}, flush=True)"), START, ALLOW, lambda e: None,
                 timeout_s=30, kill=lambda: kills.append(1), grace_s=1)
    assert time.monotonic() - t0 < 1 + 2
    assert r.failure.startswith("protocol: ")
    assert r.timed_out is False and r.terminal is None and kills == [1]


def test_bridge_eof_before_terminal_is_failure():
    r = run_task([sys.executable, "-c", "import sys; sys.exit(3)"], START, ALLOW, lambda e: None,
                 timeout_s=30, kill=lambda: None)
    assert r.failure == "bridge exited: code 3"
    assert r.terminal is None and r.timed_out is False


def test_bridge_closes_stdout_but_never_exits_is_failure(spawned):
    kills = []
    t0 = time.monotonic()
    r = run_task(fake_bridge("import os; os.close(1)"), START, ALLOW, lambda e: None,
                 timeout_s=30, kill=lambda: kills.append(1), grace_s=1)
    assert time.monotonic() - t0 < 30 + 1 + 2
    assert r.failure == "bridge exited: code -9"
    assert r.terminal is None and kills == [1]
    assert spawned[0].returncode is not None


def test_bridge_stdout_closed_after_run(spawned):
    """桥的 stdout 管道读到 EOF 就关掉，不留给 GC（否则 ResourceWarning；T2-13 全量测试的警告来源之一）。"""
    run_task([sys.executable, "-c", "pass"], START, ALLOW, lambda e: None, timeout_s=10, kill=lambda: None, grace_s=1)
    for _ in range(50):
        if spawned[0].stdout.closed:
            break
        time.sleep(0.1)
    assert spawned[0].stdout.closed


def test_grace_after_eof_counts_from_eof_not_from_last_read():
    # 静默 2 秒后关 stdout，再过 0.5 秒退出：grace=1 从 EOF 起算，应当等到正常退出、不强杀
    kills = []
    script = "import os, sys, time; time.sleep(2); os.close(1); time.sleep(0.5); os._exit(0)"
    r = run_task([sys.executable, "-c", script], START, ALLOW, lambda e: None,
                 timeout_s=30, kill=lambda: kills.append(1), grace_s=1)
    assert r.failure == "bridge exited: code 0"
    assert kills == []


def test_exception_in_decide_propagates_and_reaps_bridge(launch, spawned):
    def decide(req):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        run_task(launch(TOOL("touch ran.marker")), START, decide, lambda e: None, timeout_s=30, kill=lambda: None)
    assert spawned[0].returncode is not None


def test_killed_bridge_gives_failure_without_hanging(launch, spawned):
    def decide(req):
        spawned[0].kill()  # 等拦截时杀掉桥
        return {"decision": "allow"}

    t0 = time.monotonic()
    r = run_task(launch(TOOL("touch ran.marker")), START, decide, lambda e: None, timeout_s=30, kill=lambda: None)
    assert time.monotonic() - t0 < 15
    assert r.failure == "bridge exited: code -9"
    assert r.terminal is None
