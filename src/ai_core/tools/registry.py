"""
工具注册表。

设计：
- ToolRegistry 是普通实例，可以创建多个。每个 SourceProvider 持有自己的 registry。
- registry.tool(...) 是注册装饰器；不再有全局副作用。
- registry.extend(other) 用来把共享工具（例如 analyzer）合并进 provider 的工具集。
- 工具拿到 ToolContext（运行时依赖容器：db / session / extras）。
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class ToolContext:
    db: Any = None
    session: Dict[str, Any] = field(default_factory=dict)
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    description: str
    parameters: Dict[str, Any]
    func: Callable[..., Any]
    needs_db: bool = False
    tags: List[str] = field(default_factory=list)

    def to_openai_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters or {"type": "object", "properties": {}},
            },
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: Dict[str, Tool] = {}

    def register(self, t: Tool) -> None:
        if t.name in self._tools:
            logger.warning(f"Tool {t.name} re-registered, overwriting")
        self._tools[t.name] = t

    def extend(self, other: "ToolRegistry") -> None:
        for t in other.all():
            self.register(t)

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def all(self) -> List[Tool]:
        return list(self._tools.values())

    def openai_tools(self) -> List[Dict[str, Any]]:
        return [t.to_openai_schema() for t in self.all()]

    def render_for_prompt(self) -> str:
        lines = []
        for t in self.all():
            params = t.parameters.get("properties", {}) if t.parameters else {}
            param_str = ", ".join(params.keys()) if params else ""
            lines.append(f"- {t.name}({param_str}): {t.description}")
        return "\n".join(lines)

    def tool(
        self,
        *,
        name: str,
        description: str,
        parameters: Optional[Dict[str, Any]] = None,
        needs_db: bool = False,
        tags: Optional[List[str]] = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """注册装饰器：将函数注册到本 registry。"""

        def deco(func: Callable[..., Any]) -> Callable[..., Any]:
            self.register(
                Tool(
                    name=name,
                    description=description,
                    parameters=parameters or {"type": "object", "properties": {}},
                    func=func,
                    needs_db=needs_db,
                    tags=tags or [],
                )
            )
            return func

        return deco

    async def invoke(
        self,
        name: str,
        arguments: Dict[str, Any],
        ctx: ToolContext,
    ) -> Dict[str, Any]:
        t = self.get(name)
        if not t:
            return {"success": False, "error": f"未知工具: {name}"}

        if t.needs_db and ctx.db is None:
            return {"success": False, "error": "当前未连接数据源"}

        sig = inspect.signature(t.func)
        injected: Dict[str, Any] = dict(arguments)
        for ctx_key in ("ctx", "context", "db", "session"):
            if ctx_key in sig.parameters and ctx_key not in injected:
                if ctx_key in ("ctx", "context"):
                    injected[ctx_key] = ctx
                elif ctx_key == "db":
                    injected[ctx_key] = ctx.db
                elif ctx_key == "session":
                    injected[ctx_key] = ctx.session

        try:
            if asyncio.iscoroutinefunction(t.func):
                result = await t.func(**injected)
            else:
                result = t.func(**injected)
        except TypeError as e:
            logger.error(f"Tool {name} bad args: {e}")
            return {"success": False, "error": f"参数错误: {e}"}
        except Exception as e:
            logger.error(f"Tool {name} crashed: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

        if not isinstance(result, dict):
            result = {"success": True, "result": result}
        return result


def serialize_result(result: Dict[str, Any], limit: int = 4000) -> str:
    """把工具结果序列化成给 LLM 看的 JSON 字符串，超长时截断 data。"""
    try:
        s = json.dumps(result, ensure_ascii=False)
    except Exception:
        s = json.dumps({"success": False, "error": "结果不可序列化"}, ensure_ascii=False)
    if len(s) <= limit:
        return s
    trimmed = dict(result)
    if isinstance(trimmed.get("data"), list):
        trimmed["data"] = trimmed["data"][:20]
        trimmed["_truncated"] = True
    return json.dumps(trimmed, ensure_ascii=False)[:limit]
