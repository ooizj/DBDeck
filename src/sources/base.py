"""
数据源 Provider 抽象层。

每种数据源（MySQL / SQLite / MongoDB / 未来的文件等）实现一个 SourceProvider：
- create_client：拿到运行时连接对象
- tools：暴露给当前数据源的 LLM 工具集（每个 provider 自己一份 ToolRegistry）
- system_prompt：当前数据源的系统提示词
- capabilities：声明能力（是否支持 DDL / 迁移 / EXPLAIN / 是否有 schema 等）

routes.py 与 agent.py 不再 isinstance 检查；通过 provider + capabilities 决策。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from src.ai_core.tools.registry import ToolRegistry


@dataclass
class Capabilities:
    supports_ddl: bool = False
    supports_migrate: bool = False
    supports_explain: bool = False
    supports_backup: bool = False
    has_schema: bool = True
    query_language: str = "sql"
    engine_family: str = "relational"
    metadata_label: str = "table"


class DataSourceClient(ABC):
    """运行时连接对象。子类负责具体的 execute / get_schema 实现。"""

    @abstractmethod
    def execute(self, query: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        ...

    @abstractmethod
    def get_schema(self) -> Dict[str, Any]:
        ...

    def close(self) -> None:
        pass


class SourceProvider(ABC):
    id: str = ""
    display_name: str = ""
    capabilities: Capabilities = field(default_factory=Capabilities)

    @abstractmethod
    def create_client(self, config: Dict[str, Any]) -> DataSourceClient:
        ...

    def list_server_databases(self, config: Dict[str, Any]) -> List[str]:
        return []

    def classify_operation(self, query: str):
        from src.sources.operation_policy import classify_operation

        return classify_operation(
            query,
            query_language=self.capabilities.query_language,
            dialect=self.id if self.capabilities.query_language == "sql" else None,
        )

    @abstractmethod
    def tools(self) -> ToolRegistry:
        ...

    @abstractmethod
    def system_prompt(self, *, session_ctx: str) -> str:
        ...
