"""执行计划（EXPLAIN）业务逻辑。

路由层只做 HTTP 编排；本模块按 provider 方言获取执行计划，并统一转换为前端可直接渲染的结构：

- ``tree``：计划树，节点为 ``{"label", "detail", "metrics", "children"}``（MySQL 不提供）
- ``table``：表格视图 ``{"columns", "rows"}``
- ``raw``：数据库返回的原始计划（JSON 视图）

各方言的取数依据：
- MySQL：标准表格 ``EXPLAIN``（列名有官方文档定义）；``EXPLAIN FORMAT=JSON`` 只作为原始数据展示，
  不解析其内部嵌套结构（该结构随版本变化且无完整文档）。
- PostgreSQL：``EXPLAIN (FORMAT JSON)``，节点字段 ``Node Type`` / ``Plans`` 等。
- SQLite：``EXPLAIN QUERY PLAN``，四列 ``id, parent, notused, detail``。

``EXPLAIN`` 不加 ``ANALYZE`` 时不会真正执行语句；但为防止 ``SELECT 1; DROP TABLE t`` 这类输入中
后续语句被执行，这里只接受单条语句。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from src.common.db_utils import managed_source
from src.common.errors import redact_sensitive
from src.common.sql_utils import split_sql_by_tokens

_DIALECTS = {"mysql": "mysql", "postgresql": "postgres", "sqlite": "sqlite"}

# PostgreSQL 节点中已单独展示、不再重复放进 metrics 的字段
_PG_SUMMARY_KEYS = {
    "Node Type", "Plans", "Relation Name", "Alias", "Index Name", "Schema",
    "Startup Cost", "Total Cost", "Plan Rows", "Plan Width", "Parent Relationship",
}


class ExplainError(ValueError):
    pass


def single_statement(query: str, dialect: str) -> str:
    statements = [s.strip().rstrip(";").strip() for s in split_sql_by_tokens(query or "", dialect=dialect)]
    statements = [s for s in statements if s]
    if not statements:
        raise ExplainError("没有可分析的 SQL")
    if len(statements) > 1:
        raise ExplainError("执行计划一次只能分析一条语句，请选中要分析的语句")
    return statements[0]


def _execute(db, sql: str) -> Dict[str, Any]:
    result = db.execute(sql)
    if not isinstance(result, dict):
        raise ExplainError("数据库没有返回执行计划")
    if result.get("success") is False:
        raise ExplainError(result.get("error_msg") or result.get("error") or "获取执行计划失败")
    return result


def visualize_execution_plan(source_id: int, query: str) -> dict:
    """获取执行计划，返回树形 / 表格 / 原始三种视图的数据。"""
    try:
        with managed_source(source_id) as (provider, db):
            dialect = _DIALECTS.get(provider.id)
            if dialect is None:
                return {"success": False, "error": f"{provider.display_name} 不支持执行计划"}
            statement = single_statement(query, dialect)
            if provider.id == "mysql":
                plan = _mysql_plan(db, statement)
            elif provider.id == "postgresql":
                plan = _postgresql_plan(db, statement)
            else:
                plan = _sqlite_plan(db, statement)
            return {"success": True, "provider": provider.id, "query": statement, **plan}
    except ExplainError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


# ---------- MySQL ----------

def _mysql_plan(db, statement: str) -> Dict[str, Any]:
    result = _execute(db, f"EXPLAIN {statement}")
    raw: Any = None
    try:
        json_result = db.execute(f"EXPLAIN FORMAT=JSON {statement}")
        if json_result.get("success") is not False and json_result.get("data"):
            raw = _maybe_json(json_result["data"][0][0])
    except Exception:
        raw = None
    return {
        "tree": None,
        "table": {"columns": result.get("columns", []), "rows": result.get("data", [])},
        "raw": raw,
    }


# ---------- PostgreSQL ----------

def _postgresql_plan(db, statement: str) -> Dict[str, Any]:
    result = _execute(db, f"EXPLAIN (FORMAT JSON) {statement}")
    data = result.get("data") or []
    if not data or not data[0]:
        raise ExplainError("数据库没有返回执行计划")
    raw = _maybe_json(data[0][0])
    document = raw[0] if isinstance(raw, list) and raw else raw
    if not isinstance(document, dict) or not isinstance(document.get("Plan"), dict):
        raise ExplainError("无法解析 PostgreSQL 执行计划")
    tree = convert_pg_plan(document["Plan"])
    return {
        "tree": tree,
        "table": _flatten_tree(tree),
        "raw": raw,
        "planning_time": document.get("Planning Time"),
        "execution_time": document.get("Execution Time"),
    }


def convert_pg_plan(plan: Dict[str, Any]) -> Dict[str, Any]:
    label = str(plan.get("Node Type") or "Unknown")
    detail_parts = []
    if plan.get("Index Name"):
        detail_parts.append(f"索引 {plan['Index Name']}")
    if plan.get("Relation Name"):
        relation = plan["Relation Name"]
        if plan.get("Schema"):
            relation = f"{plan['Schema']}.{relation}"
        if plan.get("Alias") and plan["Alias"] != plan["Relation Name"]:
            relation = f"{relation} {plan['Alias']}"
        detail_parts.append(relation)
    metrics = []
    if plan.get("Startup Cost") is not None or plan.get("Total Cost") is not None:
        metrics.append({"key": "成本", "value": f"{plan.get('Startup Cost', 0)}..{plan.get('Total Cost', 0)}"})
    if plan.get("Plan Rows") is not None:
        metrics.append({"key": "估算行数", "value": plan["Plan Rows"]})
    if plan.get("Plan Width") is not None:
        metrics.append({"key": "行宽", "value": plan["Plan Width"]})
    for key, value in plan.items():
        if key in _PG_SUMMARY_KEYS or isinstance(value, (dict, list)) or value is None:
            continue
        metrics.append({"key": key, "value": value})
    children = [convert_pg_plan(child) for child in plan.get("Plans") or [] if isinstance(child, dict)]
    return {"label": label, "detail": " ".join(detail_parts), "metrics": metrics, "children": children}


# ---------- SQLite ----------

def _sqlite_plan(db, statement: str) -> Dict[str, Any]:
    result = _execute(db, f"EXPLAIN QUERY PLAN {statement}")
    rows = result.get("data") or []
    return {
        "tree": convert_sqlite_plan(rows),
        "table": {"columns": ["id", "parent", "detail"], "rows": [[r[0], r[1], r[3]] for r in rows if len(r) >= 4]},
        "raw": rows,
    }


def convert_sqlite_plan(rows: List[List[Any]]) -> Dict[str, Any]:
    """按 parent 组装树；parent 为 0 的节点挂在虚拟根 QUERY PLAN 下。"""
    root = {"label": "QUERY PLAN", "detail": "", "metrics": [], "children": []}
    nodes: Dict[Any, Dict[str, Any]] = {}
    for row in rows:
        if len(row) < 4:
            continue
        node_id, parent_id, _, detail = row[0], row[1], row[2], row[3]
        node = {"label": str(detail), "detail": "", "metrics": [], "children": []}
        nodes[node_id] = node
        (nodes.get(parent_id) or root)["children"].append(node)
    return root


# ---------- 通用 ----------

def _maybe_json(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _flatten_tree(tree: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    columns = ["节点", "对象", "成本", "估算行数"]
    rows: List[List[Any]] = []

    def walk(node: Dict[str, Any], depth: int) -> None:
        metrics = {m["key"]: m["value"] for m in node.get("metrics", [])}
        rows.append([
            "    " * depth + node["label"],
            node.get("detail", ""),
            metrics.get("成本", ""),
            metrics.get("估算行数", ""),
        ])
        for child in node.get("children", []):
            walk(child, depth + 1)

    if tree:
        walk(tree, 0)
    return {"columns": columns, "rows": rows}
