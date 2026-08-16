from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from src.ai_core.tools.registry import ToolRegistry
from src.sources.base import Capabilities, DataSourceClient, SourceProvider

from .client import RedisClient, list_redis_databases
from .tools import redis_tools

_SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(
    encoding="utf-8"
)


class RedisProvider(SourceProvider):
    id = "redis"
    display_name = "Redis"
    capabilities = Capabilities(
        supports_ddl=False,
        supports_migrate=False,
        supports_explain=False,
        has_schema=True,
        query_language="redis",
        engine_family="key_value",
        metadata_label="key",
    )

    def create_client(self, config_dict: Dict[str, Any]) -> DataSourceClient:
        return RedisClient(config_dict)

    def list_server_databases(self, config_dict: Dict[str, Any]) -> List[str]:
        return list_redis_databases(config_dict)

    def tools(self) -> ToolRegistry:
        return redis_tools

    def system_prompt(self, *, session_ctx: str) -> str:
        return _SYSTEM_PROMPT.format(
            tools_list=redis_tools.render_for_prompt(),
            session_context=session_ctx or "（暂无历史查询）",
        )
