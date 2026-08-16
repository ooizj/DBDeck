"""
工具执行策略 —— 哪些工具调用需要用户先确认。

规则结构：每条 (regex, needs_confirm)，按顺序匹配工具名，首个命中规则决定结果。
默认全部放行；命中 needs_confirm=True 的规则时，agent 必须等用户确认才能执行。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Pattern

from src.sources.operation_policy import classify_tool_call


@dataclass
class Rule:
    pattern: Pattern[str]
    needs_confirm: bool
    description: str = ""


# 默认规则：写入/编辑/移动/删除类操作要求确认；纯读取放行。
# 顺序敏感：第一条命中即返回。
_DEFAULT_RULES: List[Rule] = [
    Rule(re.compile(r"^fs_(write|edit|move|create_directory|delete|remove|unlink|rm)"),
         True, "文件系统写/改/删操作"),
    Rule(re.compile(r".*"), False, "默认放行"),
]


def needs_confirmation(tool_name: str, args: Dict[str, Any] | None = None) -> bool:
    if tool_name in {"execute_sql", "execute_mongo_query", "execute_redis_command", "redis_command"}:
        return classify_tool_call(tool_name, args).needs_confirmation

    for rule in _DEFAULT_RULES:
        if rule.pattern.match(tool_name):
            return rule.needs_confirm
    return False
