"""Redis provider 暴露给 LLM 的工具集。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from src.ai_core.tools.registry import ToolRegistry
from src.sources.operation_policy import classify_redis

redis_tools = ToolRegistry()


@redis_tools.tool(
    name="list_keys",
    description="按 pattern 列出当前 Redis DB 中的 key，默认最多返回 100 个。",
    parameters={
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Redis key pattern，默认 *"},
            "limit": {"type": "integer", "description": "最多返回数量，默认 100"},
        },
    },
    needs_db=True,
    tags=["schema"],
)
def list_keys(*, db, pattern: Optional[str] = "*", limit: Optional[int] = 100) -> Dict[str, Any]:
    safe_limit = max(1, min(int(limit or 100), 500))
    cursor = 0
    keys = []
    while True:
        cursor, batch = db.client.scan(cursor=cursor, match=pattern or "*", count=100)
        keys.extend(batch)
        if cursor == 0 or len(keys) >= safe_limit:
            break
    keys = keys[:safe_limit]
    return {
        "success": True,
        "pattern": pattern or "*",
        "keys": keys,
        "count": len(keys),
        "truncated": len(keys) >= safe_limit,
    }


@redis_tools.tool(
    name="describe_key",
    description="查看一个 Redis key 的类型、TTL、长度等元数据。",
    parameters={
        "type": "object",
        "properties": {"key": {"type": "string", "description": "Redis key"}},
        "required": ["key"],
    },
    needs_db=True,
    tags=["schema"],
)
def describe_key(*, key: str, db) -> Dict[str, Any]:
    key_type = db._safe_type(key)
    ttl = db._safe_ttl(key)
    length = db._safe_length(key, key_type)
    return {
        "success": True,
        "key": key,
        "type": key_type,
        "ttl": ttl,
        "ttl_label": "persistent" if ttl == -1 else ("missing" if ttl == -2 else f"{ttl}s"),
        "length": length,
    }


@redis_tools.tool(
    name="execute_redis_command",
    description=(
        "执行 Redis 命令。command 使用 redis-cli 风格文本，例如: GET user:1、"
        "HGETALL session:abc、LRANGE queue 0 99、SET key value。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "redis-cli 风格 Redis 命令"},
        },
        "required": ["command"],
    },
    needs_db=True,
    tags=["query"],
)
def execute_redis_command(*, command: str, db) -> Dict[str, Any]:
    operation = classify_redis(command)
    result = db.execute(command)
    if not result.get("success"):
        return {
            "success": False,
            "command": command,
            "operation_kind": operation.kind,
            "error": result.get("error"),
        }
    return {
        "success": True,
        "command": command,
        "query": command,
        "executed_sql": command,
        "operation_kind": operation.kind,
        "columns": result.get("columns", []),
        "column_metadata": result.get("column_metadata", {}),
        "data": result.get("data", []),
        "row_count": result.get("row_count", 0),
        "message": result.get("message"),
        "statements": result.get("statements", []),
        "active_statement_index": result.get("active_statement_index", 0),
        "duration_ms": result.get("duration_ms"),
        "kind": operation.kind,
    }


@redis_tools.tool(
    name="sample_key",
    description="按 key 类型读取一个 Redis key 的少量内容，避免一次拉取过多数据。",
    parameters={
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "Redis key"},
            "limit": {"type": "integer", "description": "采样数量，默认 20"},
        },
        "required": ["key"],
    },
    needs_db=True,
    tags=["schema"],
)
def sample_key(*, key: str, db, limit: Optional[int] = 20) -> Dict[str, Any]:
    safe_limit = max(1, min(int(limit or 20), 100))
    key_type = db._safe_type(key)
    if key_type == "string":
        command = f"GET {key}"
    elif key_type == "hash":
        command = f"HGETALL {key}"
    elif key_type == "list":
        command = f"LRANGE {key} 0 {safe_limit - 1}"
    elif key_type == "set":
        command = f"SSCAN {key} 0 COUNT {safe_limit}"
    elif key_type == "zset":
        command = f"ZRANGE {key} 0 {safe_limit - 1} WITHSCORES"
    elif key_type == "stream":
        command = f"XRANGE {key} - + COUNT {safe_limit}"
    else:
        command = f"TYPE {key}"
    result = db.execute(command)
    return {
        "success": result.get("success", False),
        "key": key,
        "type": key_type,
        "command": command,
        "columns": result.get("columns", []),
        "data": result.get("data", []),
        "row_count": result.get("row_count", 0),
        "error": result.get("error"),
    }


from src.ai_core.shared_tools import register_analyzer

register_analyzer(redis_tools)
