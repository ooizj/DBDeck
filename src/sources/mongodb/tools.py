"""MongoDB provider 暴露给 LLM 的工具集。"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from src.ai_core.tools.registry import ToolContext, ToolRegistry
from src.common.config import config
from src.sources.operation_policy import classify_mongo

logger = logging.getLogger(__name__)

mongodb_tools = ToolRegistry()

_ACTION_DISPLAY = {
    "insert_one": "insertOne",
    "insertOne": "insertOne",
    "insert": "insertOne",
    "update_one": "updateOne",
    "updateOne": "updateOne",
    "update_many": "updateMany",
    "updateMany": "updateMany",
    "delete_one": "deleteOne",
    "deleteOne": "deleteOne",
    "delete_many": "deleteMany",
    "deleteMany": "deleteMany",
    "drop": "drop",
}


def _to_mongo_shell(query: str) -> str:
    """Convert the internal JSON command shape into a Mongo shell-like display query."""
    try:
        cmd = json.loads(query)
    except json.JSONDecodeError:
        return query

    collection = cmd.get("collection")
    if not collection:
        return query

    action = cmd.get("action", "find")
    collection_expr = f'db.getCollection({json.dumps(collection, ensure_ascii=False)})'

    if action == "find":
        filter_query = cmd.get("filter", {})
        shell = f"{collection_expr}.find({json.dumps(filter_query, ensure_ascii=False)})"
        limit = cmd.get("limit")
        if limit:
            shell += f".limit({limit})"
        return shell

    if action == "count":
        filter_query = cmd.get("filter", {})
        return f"{collection_expr}.count({json.dumps(filter_query, ensure_ascii=False)})"

    if action in ("insert", "insert_one", "insertOne"):
        doc = cmd.get("document", {})
        return f"{collection_expr}.insertOne({json.dumps(doc, ensure_ascii=False)})"

    if action in ("update_one", "updateOne", "update_many", "updateMany"):
        filter_query = cmd.get("filter", {})
        update_data = cmd.get("update", {})
        method = _ACTION_DISPLAY.get(action, action)
        return (
            f"{collection_expr}.{method}("
            f"{json.dumps(filter_query, ensure_ascii=False)}, "
            f"{json.dumps(update_data, ensure_ascii=False)})"
        )

    if action in ("delete_one", "deleteOne", "delete_many", "deleteMany"):
        filter_query = cmd.get("filter", {})
        method = _ACTION_DISPLAY.get(action, action)
        return f"{collection_expr}.{method}({json.dumps(filter_query, ensure_ascii=False)})"

    if action == "drop":
        return f"{collection_expr}.drop()"

    if action == "distinct":
        key = cmd.get("key", "")
        filter_query = cmd.get("filter", {})
        if filter_query:
            return f"{collection_expr}.distinct({json.dumps(key, ensure_ascii=False)}, {json.dumps(filter_query, ensure_ascii=False)})"
        return f"{collection_expr}.distinct({json.dumps(key, ensure_ascii=False)})"

    if action == "aggregate":
        pipeline = cmd.get("pipeline", [])
        options = cmd.get("options", {})
        if options:
            return f"{collection_expr}.aggregate({json.dumps(pipeline, ensure_ascii=False)}, {json.dumps(options, ensure_ascii=False)})"
        return f"{collection_expr}.aggregate({json.dumps(pipeline, ensure_ascii=False)})"

    return query


@mongodb_tools.tool(
    name="list_collections",
    description="列出当前 MongoDB 库里的所有集合（collection）。",
    parameters={"type": "object", "properties": {}},
    needs_db=True,
    tags=["schema"],
)
def list_collections(*, db) -> Dict[str, Any]:
    schema = db.get_schema()
    return {
        "success": True,
        "collections": list(schema.keys()),
        "count": len(schema),
    }


@mongodb_tools.tool(
    name="describe_collection",
    description="基于样本文档推测一个或多个集合的字段结构（MongoDB 是无 schema 的，这里返回的是采样推断）。",
    parameters={
        "type": "object",
        "properties": {
            "collections": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要查看的集合名列表",
            }
        },
        "required": ["collections"],
    },
    needs_db=True,
    tags=["schema"],
)
def describe_collection(*, collections: List[str], db) -> Dict[str, Any]:
    schema = db.get_schema()
    out: Dict[str, Any] = {}
    missing: List[str] = []
    for name in collections:
        if name in schema:
            out[name] = schema[name]
        else:
            missing.append(name)
    return {"success": True, "collections": out, "missing": missing}


@mongodb_tools.tool(
    name="execute_mongo_query",
    description=(
        "执行 MongoDB 查询。query 必须是 JSON 格式的指令对象：\n"
        "{ \"collection\": \"users\", \"action\": \"find\", \"filter\": {...}, \"limit\": 100 }\n"
        "action 支持: find / count / distinct / aggregate / insert_one / update_one / update_many / delete_one / delete_many / drop。\n"
        "- distinct: 查询去重值，参数格式: { \"collection\": \"...\", \"action\": \"distinct\", \"key\": \"字段名\", \"filter\": {...} }\n"
        "- aggregate: 聚合查询，参数格式: { \"collection\": \"...\", \"action\": \"aggregate\", \"pipeline\": [...] }"
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "JSON 格式的 MongoDB 查询指令"},
        },
        "required": ["query"],
    },
    needs_db=True,
    tags=["query"],
)
def execute_mongo_query(*, query: str, db) -> Dict[str, Any]:
    operation = classify_mongo(query)
    result = db.execute(query)
    display_query = _to_mongo_shell(query)
    if not result.get("success"):
        return {
            "success": False,
            "query": display_query,
            "operation_kind": operation.kind,
            "error": result.get("error"),
        }
    statements: List[Dict[str, Any]] = []
    for index, item in enumerate(result.get("statements") or []):
        statement = dict(item)
        display_statement = _to_mongo_shell(
            statement.get("executed_query") or statement.get("sql") or query
        )
        statement["statement_index"] = statement.get("statement_index", index)
        statement["sql"] = display_statement
        statement["executed_query"] = display_statement
        statement.setdefault("operation_kind", operation.kind)
        statements.append(statement)

    if not statements:
        row_count = result.get("row_count", 0)
        statements = [
            {
                "statement_index": 0,
                "sql": display_query,
                "executed_query": display_query,
                "operation_kind": operation.kind,
                "columns": result.get("columns", []),
                "column_metadata": result.get("column_metadata", {}),
                "data": result.get("data", []),
                "row_count": row_count,
                "affected_rows": result.get("affected_rows"),
                "duration_ms": result.get("duration_ms"),
                "message": result.get("message"),
            }
        ]
    active_index = result.get("active_statement_index", len(statements) - 1)
    active = statements[active_index] if 0 <= active_index < len(statements) else statements[-1]

    return {
        "success": True,
        "query": display_query,
        "executed_sql": display_query,
        "operation_kind": operation.kind,
        "columns": active.get("columns", []),
        "column_metadata": active.get("column_metadata", {}),
        "data": active.get("data", []),
        "row_count": active.get("row_count", 0),
        "message": active.get("message") or result.get("message"),
        "statements": statements,
        "active_statement_index": active_index,
        "duration_ms": result.get("duration_ms"),
        "kind": operation.kind,
    }


@mongodb_tools.tool(
    name="sample_documents",
    description="从一个集合里采样若干文档，用来直观看清字段值与结构。默认 5 条。",
    parameters={
        "type": "object",
        "properties": {
            "collection": {"type": "string", "description": "集合名"},
            "limit": {"type": "integer", "description": "采样数量，默认 5"},
        },
        "required": ["collection"],
    },
    needs_db=True,
    tags=["schema"],
)
def sample_documents(
    *, collection: str, db, limit: Optional[int] = 5
) -> Dict[str, Any]:
    query = json.dumps(
        {"collection": collection, "action": "find", "filter": {}, "limit": limit or 5}
    )
    display_query = _to_mongo_shell(query)
    result = db.execute(query)
    if not result.get("success"):
        return {"success": False, "query": display_query, "error": result.get("error")}
    return {
        "success": True,
        "query": display_query,
        "executed_sql": display_query,
        "collection": collection,
        "columns": result.get("columns", []),
        "data": result.get("data", []),
        "row_count": result.get("row_count", 0),
    }


_SCHEMA_EXPERT_PROMPT = (
    Path(__file__).parent / "prompts" / "schema_expert.md"
).read_text(encoding="utf-8")


@mongodb_tools.tool(
    name="call_schema_expert",
    description="把 MongoDB 集合结构问题交给结构解读子 Agent。",
    parameters={
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "用户原始问题"},
            "collections": {
                "type": "array",
                "items": {"type": "string"},
                "description": "相关集合名列表",
            },
        },
        "required": ["question", "collections"],
    },
    needs_db=True,
    tags=["subagent"],
)
async def call_schema_expert(
    *, question: str, collections: List[str], ctx: ToolContext
) -> Dict[str, Any]:
    full_schema = ctx.db.get_schema()
    selected = {c: full_schema.get(c) for c in collections if c in full_schema}
    missing = [c for c in collections if c not in full_schema]
    payload = {
        "question": question,
        "collections": selected,
        "missing_collections": missing,
    }
    user_prompt = (
        "请基于下列 MongoDB 集合的样本字段结构回答用户的问题：\n\n"
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
    return {
        "success": True,
        "explanation": answer,
        "missing_collections": missing,
    }


from src.ai_core.shared_tools import register_analyzer

register_analyzer(mongodb_tools)
