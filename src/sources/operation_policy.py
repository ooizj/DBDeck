"""Operation classification shared by database providers and AI tool policy."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable

from src.common.sql_utils import split_sql_by_tokens


@dataclass(frozen=True)
class OperationClassification:
    kind: str
    reason: str = ""

    @property
    def needs_confirmation(self) -> bool:
        return self.kind in {"write", "destructive", "unknown"}


_SQL_READ_RE = re.compile(r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH|PRAGMA)\b", re.I)
_SQL_WRITE_RE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE)\b", re.I)
_SQL_DESTRUCTIVE_RE = re.compile(r"^\s*(DROP|TRUNCATE|ALTER|RENAME)\b", re.I)

_MONGO_READ = {"find", "count", "countdocuments", "count_documents", "distinct", "aggregate"}
_MONGO_WRITE = {"insert", "insertone", "insert_one", "updateone", "update_one", "updatemany", "update_many"}
_MONGO_DESTRUCTIVE = {"deleteone", "delete_one", "deletemany", "delete_many", "drop"}
_MONGO_CHAIN_HELPERS = {"getcollection", "sort", "limit", "skip"}

_REDIS_READ = {
    "GET", "MGET", "HGET", "HGETALL", "HMGET", "LRANGE", "ZRANGE", "ZRANGEBYSCORE",
    "SMEMBERS", "SCAN", "SSCAN", "HSCAN", "ZSCAN", "KEYS", "TYPE", "TTL", "PTTL",
    "EXISTS", "DBSIZE", "INFO", "XRANGE", "XREVRANGE",
}
_REDIS_WRITE = {
    "SET", "MSET", "HSET", "HMSET", "LPUSH", "RPUSH", "SADD", "ZADD", "EXPIRE",
    "PEXPIRE", "PERSIST", "INCR", "INCRBY", "DECR", "DECRBY", "XADD",
}
_REDIS_DESTRUCTIVE = {"DEL", "UNLINK", "FLUSHDB", "FLUSHALL", "RENAME", "RENAMENX"}


def _highest_risk(classifications: Iterable[OperationClassification]) -> OperationClassification:
    priority = {"read": 0, "write": 1, "unknown": 2, "destructive": 3}
    best = OperationClassification("read", "no statements")
    for item in classifications:
        if priority.get(item.kind, 2) > priority.get(best.kind, 0):
            best = item
    return best


def classify_sql(sql: str, *, dialect: str = "mysql") -> OperationClassification:
    statements = split_sql_by_tokens(sql, dialect=dialect) or [sql]

    def classify_one(stmt: str) -> OperationClassification:
        if _SQL_READ_RE.match(stmt):
            return OperationClassification("read", "SQL read statement")
        if _SQL_DESTRUCTIVE_RE.match(stmt):
            return OperationClassification("destructive", "SQL destructive DDL")
        if _SQL_WRITE_RE.match(stmt):
            return OperationClassification("write", "SQL write statement")
        return OperationClassification("unknown", "Unrecognized SQL statement")

    return _highest_risk(classify_one(stmt) for stmt in statements)


def _normalize_action(action: Any) -> str:
    return str(action or "find").replace(".", "").lower()


def _next_mongo_statement(query: str, index: int) -> bool:
    while index < len(query) and query[index].isspace():
        index += 1
    return query.startswith("db.", index) or query.startswith("{", index)


def _split_mongo_statements(query: str) -> list[str]:
    statements: list[str] = []
    start = 0
    brace_count = 0
    bracket_count = 0
    paren_count = 0
    in_string = None
    escape = False

    def push(end: int) -> None:
        text = query[start:end].strip()
        if text:
            statements.append(text)

    idx = 0
    while idx < len(query):
        char = query[idx]
        if escape:
            escape = False
            idx += 1
            continue
        if char == "\\":
            escape = True
            idx += 1
            continue

        if in_string:
            if char == in_string:
                in_string = None
        else:
            if char in ("'", '"'):
                in_string = char
            elif char == "{":
                brace_count += 1
            elif char == "}":
                brace_count = max(brace_count - 1, 0)
            elif char == "[":
                bracket_count += 1
            elif char == "]":
                bracket_count = max(bracket_count - 1, 0)
            elif char == "(":
                paren_count += 1
            elif char == ")":
                paren_count = max(paren_count - 1, 0)
            elif brace_count == 0 and bracket_count == 0 and paren_count == 0:
                if char == ";" or (
                    char in ("\n", "\r") and _next_mongo_statement(query, idx + 1)
                ):
                    push(idx)
                    start = idx + 1
        idx += 1

    push(len(query))
    return statements


def _classify_mongo_statement(query_str: str) -> OperationClassification:
    query_str = (query_str or "").strip()
    action = None
    try:
        payload = json.loads(query_str)
        if isinstance(payload, dict):
            action = payload.get("action", "find")
    except json.JSONDecodeError:
        for method in re.findall(r"\.(\w+)\s*\(", query_str):
            normalized_method = _normalize_action(method)
            if normalized_method not in _MONGO_CHAIN_HELPERS:
                action = method
                break

    normalized = _normalize_action(action)
    if normalized in _MONGO_READ:
        return OperationClassification("read", "MongoDB read operation")
    if normalized in _MONGO_DESTRUCTIVE:
        return OperationClassification("destructive", "MongoDB destructive operation")
    if normalized in _MONGO_WRITE:
        return OperationClassification("write", "MongoDB write operation")
    return OperationClassification("unknown", "Unrecognized MongoDB operation")


def classify_mongo(query: str) -> OperationClassification:
    query_str = (query or "").strip()
    if not query_str:
        return OperationClassification("unknown", "Empty MongoDB operation")

    try:
        payload = json.loads(query_str)
        if isinstance(payload, list):
            return _highest_risk(
                _classify_mongo_statement(json.dumps(item, ensure_ascii=False))
                for item in payload
            )
    except json.JSONDecodeError:
        pass

    statements = _split_mongo_statements(query_str) or [query_str]
    return _highest_risk(_classify_mongo_statement(stmt) for stmt in statements)


def classify_redis(command: str) -> OperationClassification:
    statements = _split_redis_commands(command)
    if not statements:
        return OperationClassification("unknown", "Empty Redis command")

    def classify_one(statement: str) -> OperationClassification:
        name = (statement or "").strip().split(maxsplit=1)[0].upper()
        if not name:
            return OperationClassification("unknown", "Empty Redis command")
        if name in _REDIS_READ:
            return OperationClassification("read", "Redis read command")
        if name in _REDIS_DESTRUCTIVE:
            return OperationClassification("destructive", "Redis destructive command")
        if name in _REDIS_WRITE:
            return OperationClassification("write", "Redis write command")
        return OperationClassification("unknown", "Unrecognized Redis command")

    return _highest_risk(classify_one(statement) for statement in statements)


def _split_redis_commands(command: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    quote = None
    escape = False
    for char in command or "":
        if escape:
            current.append(char)
            escape = False
            continue
        if char == "\\":
            current.append(char)
            escape = True
            continue
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            current.append(char)
            quote = char
            continue
        if char in {";", "\n", "\r"}:
            text = "".join(current).strip()
            if text and not text.startswith("#"):
                statements.append(text)
            current = []
            continue
        current.append(char)
    text = "".join(current).strip()
    if text and not text.startswith("#"):
        statements.append(text)
    return statements


def classify_operation(query: str, *, query_language: str, dialect: str | None = None) -> OperationClassification:
    language = (query_language or "").lower()
    if language == "sql":
        return classify_sql(query, dialect=dialect or "mysql")
    if language == "mongo":
        return classify_mongo(query)
    if language == "redis":
        return classify_redis(query)
    return OperationClassification("unknown", f"Unrecognized query language: {query_language}")


def classify_tool_call(tool_name: str, args: Dict[str, Any] | None = None) -> OperationClassification:
    args = args or {}
    if tool_name == "execute_sql":
        return classify_sql(str(args.get("sql") or args.get("query") or ""))
    if tool_name == "execute_mongo_query":
        return classify_mongo(str(args.get("query") or ""))
    if tool_name in {"execute_redis_command", "redis_command"}:
        return classify_redis(str(args.get("command") or args.get("query") or ""))
    return OperationClassification("read", "Tool has no database operation classifier")
