"""评测拦截策略（D7/D8）：未激活的工具拒绝；bash 命令在命令位置命中危险清单就拒绝；超过工具调用上限拒绝。"""
import re
from dataclasses import dataclass

# 命令位置：行首，或 ;、&&、||、|、$(、反引号之后（D8）；命令词之后不能紧跟词字符、. 或 -（curl 不命中 curlie、ssh-keygen）
_START = r"(?:^|;|&&|\|\||\||\$\(|`)\s*"
_END = r"(?![\w.-])"


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
        self._danger = [(p, re.compile(_START + f"(?:{p})" + _END, re.M)) for p in cfg.danger_patterns]

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
            for p, rx in self._danger:
                if rx.search(cmd):
                    return _block(f"dangerous command (matches {p!r})")
        return {"decision": "allow"}


def _block(reason: str) -> dict:
    return {"decision": "block", "reason": reason}
