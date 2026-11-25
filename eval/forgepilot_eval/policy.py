"""评测拦截策略（D7/D8）：未激活的工具拒绝；bash 命令在命令位置命中危险清单就拒绝；超过工具调用上限拒绝。"""
import re
from dataclasses import dataclass

# 命令词之后不能紧跟词字符、. 或 -（curl 不命中 curlie、ssh-keygen）
_END = r"(?![\w.-])"


# shortcut: 已知不拦前缀命令（sudo/env/time/nohup/xargs）、bash -c '…'、子 shell ( … )、命令组 { …; }、
# 绝对路径（/usr/bin/curl）、双引号里 $(…) 内分隔符之后的命令（见计划 D8）；T3 起由策略服务替换时升级。
def command_positions(cmd: str) -> list[int]:
    """D8 的命令位置：开头，或 ;、&、|、换行、$(、开反引号之后（&&、|| 由单字符覆盖）。
    单引号里都不算；双引号里只有 $( 与开反引号算（与 bash 一致）。"""
    positions, quote, ticks, i = [0], None, 0, 0
    while i < len(cmd):
        c = cmd[i]
        if quote == "'":
            quote = None if c == "'" else quote
        elif c == "\\":
            i += 1  # 转义的下一个字符不是分隔符也不是引号
        elif c == "`":
            ticks += 1
            if ticks % 2:
                positions.append(i + 1)
        elif cmd.startswith("$(", i):
            positions.append(i + 2)
        elif quote == '"':
            quote = None if c == '"' else quote
        elif c in "'\"":
            quote = c
        elif c in ";&|\n":
            positions.append(i + 1)
        i += 1
    return positions


@dataclass(frozen=True)
class PolicyConfig:
    tools: list[str]
    danger_patterns: list[str]  # 只写命令本身，不写锚定
    max_tool_calls: int


class Policy:
    def __init__(self, cfg: PolicyConfig):
        self.cfg = cfg
        self.calls = 0
        self.exhausted = False  # 超限后为 True，由调用方取消任务
        self._danger = [(p, re.compile(rf"\s*(?:{p}){_END}")) for p in cfg.danger_patterns]

    def decide(self, req: dict) -> dict:
        self.calls += 1
        if self.calls > self.cfg.max_tool_calls:
            self.exhausted = True
            return _block(f"tool call limit reached ({self.cfg.max_tool_calls})")
        tool = req.get("toolName")
        if tool not in self.cfg.tools:
            return _block(f"tool not enabled: {tool}")
        if tool == "bash":
            inp = req.get("input")
            cmd = inp.get("command") if isinstance(inp, dict) else None
            if not isinstance(cmd, str):
                return _block("bash input has no command string")
            for pos in command_positions(cmd):
                for p, rx in self._danger:
                    if rx.match(cmd, pos):
                        return _block(f"dangerous command (matches {p!r})")
        return {"decision": "allow"}


def _block(reason: str) -> dict:
    return {"decision": "block", "reason": reason}
