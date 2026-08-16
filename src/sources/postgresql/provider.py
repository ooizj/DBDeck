from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from src.ai_core.tools.registry import ToolRegistry
from src.sources.base import Capabilities, DataSourceClient, SourceProvider

from .client import PostgreSQLClient, list_postgresql_databases
from .tools import postgresql_tools

_SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(
    encoding="utf-8"
)


class PostgreSQLProvider(SourceProvider):
    id = "postgresql"
    display_name = "PostgreSQL"
    capabilities = Capabilities(
        supports_ddl=True,
        # The shared migration pipeline currently supports MySQL and SQLite SQL.
        supports_migrate=False,
        supports_explain=True,
        has_schema=True,
        query_language="sql",
        engine_family="relational",
        metadata_label="table",
    )

    def create_client(self, config_dict: Dict[str, Any]) -> DataSourceClient:
        return PostgreSQLClient(config_dict)

    def list_server_databases(self, config_dict: Dict[str, Any]) -> List[str]:
        return list_postgresql_databases(config_dict)

    def tools(self) -> ToolRegistry:
        return postgresql_tools

    def system_prompt(self, *, session_ctx: str) -> str:
        return _SYSTEM_PROMPT.format(
            tools_list=postgresql_tools.render_for_prompt(),
            session_context=session_ctx or "（暂无历史查询）",
        )
