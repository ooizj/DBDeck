"""MySQL provider 暴露给 LLM 的工具集。"""
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
from src.common.sql_identifiers import quote_identifier
from src.common.sql_utils import add_limit_to_sql
from src.sources.operation_policy import classify_sql

logger = logging.getLogger(__name__)

mysql_tools = ToolRegistry()

_DDL_RE = re.compile(r"^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b", re.IGNORECASE)
_DML_RE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b", re.IGNORECASE)
_SELECT_RE = re.compile(r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b", re.IGNORECASE)


def _classify(sql: str) -> str:
    if _SELECT_RE.match(sql):
        return "read"
    if _DML_RE.match(sql):
        return "dml"
    if _DDL_RE.match(sql):
        return "ddl"
    return "other"


@mysql_tools.tool(
    name="list_tables",
    description="列出当前 MySQL 库的所有表名，并尽量返回表注释，方便根据业务中文名称匹配表。",
    parameters={"type": "object", "properties": {}},
    needs_db=True,
    tags=["schema"],
)
def list_tables(*, db) -> Dict[str, Any]:
    schema = db.get_schema()
    table_names = list(schema.keys())
    comments: Dict[str, str] = {}
    if hasattr(db, "get_table_comments"):
        comments = db.get_table_comments()
    return {
        "success": True,
        "tables": table_names,
        "table_info": [
            {"name": name, "comment": comments.get(name, "")}
            for name in table_names
        ],
        "count": len(schema),
    }


@mysql_tools.tool(
    name="describe_table",
    description="查看一张或多张表的字段详情（字段名、类型、可空、注释）。需要写 SQL 之前用它确认字段。",
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


@mysql_tools.tool(
    name="get_db_schema",
    description="获取整个数据库所有表+字段的完整结构。仅在用户要求总览或需要跨多表 JOIN 才调用，平时用 describe_table 更省 token。",
    parameters={"type": "object", "properties": {}},
    needs_db=True,
    tags=["schema"],
)
def get_db_schema(*, db) -> Dict[str, Any]:
    schema = db.get_schema()
    return {"success": True, "schema": schema, "table_count": len(schema)}


@mysql_tools.tool(
    name="execute_sql",
    description=(
        "执行一条 SQL（SELECT / SHOW / EXPLAIN / DML / DDL 都支持）并返回结果。"
        "查询数据、统计、修改数据、改表结构等都用它。"
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
    operation = classify_sql(sql, dialect="mysql")
    processed_sql = add_limit_to_sql(sql, dialect="mysql")
    result = db.execute(processed_sql)
    if not result.get("success"):
        return {
            "success": False,
            "kind": kind,
            "operation_kind": operation.kind,
            "query": sql,
            "executed_sql": processed_sql,
            "error": result.get("error_msg") or result.get("error"),
            "error_code": result.get("error_code"),
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


@mysql_tools.tool(
    name="show_create_table",
    description="查看一张表的建表 DDL。用户问 '这表怎么建的 / 索引有哪些 / 字段定义' 时调用。",
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
    with db.engine.connect() as conn:
        row = conn.execute(
            text(f"SHOW CREATE TABLE {quote_identifier('mysql', table)}")
        ).fetchone()
    if not row:
        return {"success": False, "error": f"表 {table} 不存在"}
    return {"success": True, "table": table, "ddl": row[1]}


@mysql_tools.tool(
    name="explain_sql",
    description="对一条 SELECT 语句执行 EXPLAIN，返回执行计划。用户问 '这条 SQL 怎么走的 / 慢在哪 / 用了哪个索引' 时调用。",
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
    explain_text = "EXPLAIN " + sql.lstrip()
    result = db.execute(explain_text)
    if not result.get("success"):
        return {
            "success": False,
            "error": result.get("error_msg") or result.get("error"),
        }
    return {
        "success": True,
        "query": sql,
        "plan_columns": result.get("columns", []),
        "plan": result.get("data", []),
    }


_SCHEMA_EXPERT_PROMPT = (Path(__file__).parent / "prompts" / "schema_expert.md").read_text(
    encoding="utf-8"
)


@mysql_tools.tool(
    name="call_schema_expert",
    description=(
        "把 SQL 库结构问题交给结构解读子 Agent。用户问 '这表干嘛的 / 字段含义 / 怎么 JOIN / 怎么建索引' 时调用。"
    ),
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
        "请基于下列 MySQL 表结构回答用户的问题：\n\n"
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


# 合并跨数据源共享工具
from src.ai_core.shared_tools import register_analyzer

register_analyzer(mysql_tools)
