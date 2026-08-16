"""SQLite provider 暴露给 LLM 的工具集。"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from openai import AsyncOpenAI
from sqlalchemy import text

from src.ai_core.tools.registry import ToolContext, ToolRegistry
from src.common.config import config
from src.common.sql_utils import add_limit_to_sql
from src.sources.operation_policy import classify_sql

logger = logging.getLogger(__name__)

sqlite_tools = ToolRegistry()

_DDL_RE = re.compile(r"^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b", re.IGNORECASE)
_DML_RE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE)\b", re.IGNORECASE)
_SELECT_RE = re.compile(r"^\s*(SELECT|EXPLAIN|WITH|PRAGMA)\b", re.IGNORECASE)


def _classify(sql: str) -> str:
    if _SELECT_RE.match(sql):
        return "read"
    if _DML_RE.match(sql):
        return "dml"
    if _DDL_RE.match(sql):
        return "ddl"
    return "other"


@sqlite_tools.tool(
    name="list_tables",
    description="列出当前 SQLite 数据库的所有表。",
    parameters={"type": "object", "properties": {}},
    needs_db=True,
    tags=["schema"],
)
def list_tables(*, db) -> Dict[str, Any]:
    schema = db.get_schema()
    return {"success": True, "tables": list(schema.keys()), "count": len(schema)}


@sqlite_tools.tool(
    name="describe_table",
    description="查看一张或多张 SQLite 表的字段详情。",
    parameters={
        "type": "object",
        "properties": {
            "tables": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要查看的表名列表",
            }
        },
        "required": ["tables"],
    },
    needs_db=True,
    tags=["schema"],
)
def describe_table(*, tables: List[str], db) -> Dict[str, Any]:
    schema = db.get_schema()
    out: Dict[str, Any] = {}
    missing: List[str] = []
    for t in tables:
        if t in schema:
            out[t] = schema[t]
        else:
            missing.append(t)
    return {"success": True, "tables": out, "missing": missing}


@sqlite_tools.tool(
    name="get_db_schema",
    description="获取整个 SQLite 数据库的完整结构。",
    parameters={"type": "object", "properties": {}},
    needs_db=True,
    tags=["schema"],
)
def get_db_schema(*, db) -> Dict[str, Any]:
    schema = db.get_schema()
    return {"success": True, "schema": schema, "table_count": len(schema)}


@sqlite_tools.tool(
    name="execute_sql",
    description=(
        "执行一条 SQLite SQL（SELECT / DML / DDL 都支持）。"
        "写操作（INSERT/UPDATE/DELETE/DDL）请先把完整 SQL 显示在回复里。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "sql": {"type": "string", "description": "要执行的 SQL 语句"},
        },
        "required": ["sql"],
    },
    needs_db=True,
    tags=["query"],
)
def execute_sql(*, sql: str, db) -> Dict[str, Any]:
    kind = _classify(sql)
    operation = classify_sql(sql, dialect="sqlite")
    processed_sql = add_limit_to_sql(sql, dialect="sqlite")
    result = db.execute(processed_sql)
    if not result.get("success"):
        return {
            "success": False,
            "kind": kind,
            "operation_kind": operation.kind,
            "query": sql,
            "executed_sql": processed_sql,
            "error": result.get("error_msg") or result.get("error"),
        }
    if "data" in result:
        return {
            "success": True,
            "kind": kind,
            "operation_kind": operation.kind,
            "query": sql,
            "executed_sql": processed_sql,
            "columns": result.get("columns", []),
            "column_metadata": result.get("column_metadata", {}),
            "data": result.get("data", []),
            "row_count": result.get("row_count", len(result.get("data", []))),
            "statements": result.get("statements", []),
        }
    return {
        "success": True,
        "kind": kind,
        "operation_kind": operation.kind,
        "query": sql,
        "executed_sql": processed_sql,
        "message": result.get("message", "执行成功"),
        "statements": result.get("statements", []),
    }


@sqlite_tools.tool(
    name="show_create_table",
    description="查看 SQLite 一张表的建表 DDL（从 sqlite_master 读取）。",
    parameters={
        "type": "object",
        "properties": {
            "table": {"type": "string", "description": "表名"},
        },
        "required": ["table"],
    },
    needs_db=True,
    tags=["meta"],
)
def show_create_table(*, table: str, db) -> Dict[str, Any]:
    ddl = db.get_ddl(table)
    if not ddl:
        return {"success": False, "error": f"表 {table} 不存在"}
    return {"success": True, "table": table, "ddl": ddl}


@sqlite_tools.tool(
    name="explain_sql",
    description="对一条 SELECT 语句执行 EXPLAIN QUERY PLAN，返回 SQLite 的查询计划。",
    parameters={
        "type": "object",
        "properties": {
            "sql": {"type": "string", "description": "要分析的 SELECT SQL"},
        },
        "required": ["sql"],
    },
    needs_db=True,
    tags=["meta"],
)
def explain_sql(*, sql: str, db) -> Dict[str, Any]:
    explain_text = "EXPLAIN QUERY PLAN " + sql.lstrip()
    result = db.execute(explain_text)
    if not result.get("success"):
        return {"success": False, "error": result.get("error_msg") or result.get("error")}
    return {
        "success": True,
        "query": sql,
        "plan_columns": result.get("columns", []),
        "plan": result.get("data", []),
    }


_SCHEMA_EXPERT_PROMPT = (
    Path(__file__).parent / "prompts" / "schema_expert.md"
).read_text(encoding="utf-8")


@sqlite_tools.tool(
    name="call_schema_expert",
    description="把 SQLite 结构问题交给结构解读子 Agent。",
    parameters={
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "用户原始问题"},
            "tables": {
                "type": "array",
                "items": {"type": "string"},
                "description": "相关表名列表",
            },
        },
        "required": ["question", "tables"],
    },
    needs_db=True,
    tags=["subagent"],
)
async def call_schema_expert(
    *, question: str, tables: List[str], ctx: ToolContext
) -> Dict[str, Any]:
    full_schema = ctx.db.get_schema()
    selected = {t: full_schema.get(t) for t in tables if t in full_schema}
    missing = [t for t in tables if t not in full_schema]
    payload = {
        "question": question,
        "tables": selected,
        "missing_tables": missing,
    }
    user_prompt = (
        "请基于下列 SQLite 表结构回答用户的问题：\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )
    client = AsyncOpenAI(api_key=config.llm_api_key, base_url=config.llm_api_base)
    resp = await client.chat.completions.create(
        model=config.llm_model,
        messages=[
            {"role": "system", "content": _SCHEMA_EXPERT_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.4,
    )
    answer = resp.choices[0].message.content or ""
    return {"success": True, "explanation": answer, "missing_tables": missing}


from src.ai_core.shared_tools import register_analyzer

register_analyzer(sqlite_tools)
