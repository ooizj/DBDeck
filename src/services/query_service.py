from __future__ import annotations

from typing import Any, Optional

from src.common.errors import redact_sensitive
import sqlglot
from sqlglot import exp

from src.common.sql_utils import add_limit_to_sql, build_select_pagination, split_sql_by_tokens
from src.services.history_service import add_history
from src.services.result_standardizer import standardize_result
from src.services.source_service import resolve_source

_standardize_result = standardize_result


def get_metadata(source_id: int, key_pattern: Optional[str] = None) -> dict[str, Any]:
    db = None
    try:
        provider, db = resolve_source(source_id)
        if provider.id == "redis":
            return {"success": True, "tables": db.get_schema(key_pattern or "*")}
        get_table_comments = getattr(db, "get_table_comments", None)
        get_object_types = getattr(db, "get_object_types", None)
        try:
            table_comments = get_table_comments() if callable(get_table_comments) else {}
        except Exception:
            table_comments = {}
        try:
            object_types = get_object_types() if callable(get_object_types) else {}
        except Exception:
            object_types = {}
        return {
            "success": True,
            "tables": db.get_schema(),
            "table_comments": table_comments,
            "object_types": object_types,
        }
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def _result_total(result: dict[str, Any]) -> int | None:
    statements = result.get("statements") or []
    active = statements[-1] if statements else result
    rows = active.get("data") or result.get("data") or []
    if not rows:
        return 0 if result.get("success", True) else None
    first = rows[0]
    if isinstance(first, dict):
        raw_total = first.get("__codex_total", first.get("total"))
        if raw_total is None and first:
            raw_total = next(iter(first.values()))
    elif isinstance(first, (list, tuple)):
        raw_total = first[0] if first else None
    else:
        raw_total = first
    try:
        return max(int(raw_total), 0)
    except (TypeError, ValueError):
        return None


def execute_query(
    query: str,
    source_id: int,
    *,
    page: int | None = None,
    page_size: int = 100,
) -> dict[str, Any]:
    db = None
    try:
        provider, db = resolve_source(source_id)
        operation = provider.classify_operation(query)
        executed = query
        pagination = None
        if provider.capabilities.query_language == "sql":
            dialect = {"mysql": "mysql", "postgresql": "postgres"}.get(provider.id, "sqlite")
            pagination_queries = None
            if page is not None and operation.kind == "read":
                pagination_queries = build_select_pagination(
                    query,
                    page=page,
                    page_size=page_size,
                    dialect=dialect,
                )
            if pagination_queries:
                count_sql, executed = pagination_queries
                count_result = db.execute(count_sql)
                total = _result_total(count_result)
                if total is not None:
                    safe_page_size = min(max(int(page_size), 1), 500)
                    total_pages = max((total + safe_page_size - 1) // safe_page_size, 1)
                    safe_page = min(max(int(page), 1), total_pages)
                    if safe_page != page:
                        _, executed = build_select_pagination(
                            query,
                            page=safe_page,
                            page_size=safe_page_size,
                            dialect=dialect,
                        )
                    pagination = {
                        "page": safe_page,
                        "page_size": safe_page_size,
                        "total": total,
                        "total_pages": total_pages,
                    }
                else:
                    executed = add_limit_to_sql(query, dialect=dialect)
            else:
                executed = add_limit_to_sql(query, dialect=dialect)
        result = db.execute(executed)
        standardized = _standardize_result(
            result,
            provider_id=provider.id,
            source_id=source_id,
            requested_query=query,
            executed_query=executed,
            operation_kind=operation.kind,
        )
        if pagination is not None:
            row_count = len(standardized.get("data") or [])
            start = (pagination["page"] - 1) * pagination["page_size"] + 1 if row_count else 0
            standardized["pagination"] = {
                **pagination,
                "start": start,
                "end": start + row_count - 1 if row_count else 0,
            }
        source_name = ""
        if source_id:
            from src.common.storage import storage
            src = storage.get_source(source_id)
            source_name = src.get("name", "") if src else ""
        add_history(
            source_id=source_id,
            source_name=source_name,
            query=query,
            executed_query=executed,
            row_count=standardized.get("row_count", 0),
            duration_ms=standardized.get("duration_ms"),
            status="success" if standardized.get("success", True) else "error",
            error_msg=standardized.get("error_msg") if not standardized.get("success", True) else None,
        )
        return standardized
    except Exception as e:
        add_history(
            source_id=source_id,
            query=query,
            status="error",
            error_msg=str(e),
        )
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


# 导出全部结果时最多返回的行数，避免超大结果一次性读入内存
EXPORT_MAX_ROWS = 100_000

_EXPORT_DIALECTS = {"mysql": "mysql", "postgresql": "postgres", "sqlite": "sqlite"}


def _limit_for_export(statement: str, dialect: str, max_rows: int) -> str:
    """没有 LIMIT 的查询追加 LIMIT max_rows + 1（多取一行用来判断是否被截断）；自带 LIMIT 的保持原样。"""
    try:
        parsed = sqlglot.parse_one(statement, read=dialect)
    except Exception:
        return statement
    if not isinstance(parsed, exp.Query) or parsed.args.get("limit") is not None:
        return statement
    return parsed.limit(max_rows + 1).sql(dialect=dialect)


def export_query(query: str, source_id: int, *, max_rows: int = EXPORT_MAX_ROWS) -> dict[str, Any]:
    """不分页地重新执行一条只读查询，供"导出全部结果"使用。

    只接受 SQL 数据源上的单条只读语句；结果最多返回 max_rows 行，超出时 truncated=True。
    不写入查询历史（用户在控制台执行时已经记录过）。
    """
    db = None
    try:
        provider, db = resolve_source(source_id)
        dialect = _EXPORT_DIALECTS.get(provider.id)
        if dialect is None or provider.capabilities.query_language != "sql":
            return {"success": False, "error": f"{provider.display_name} 不支持导出全部结果"}
        statements = [s.strip().rstrip(";").strip() for s in split_sql_by_tokens(query or "", dialect=dialect)]
        statements = [s for s in statements if s]
        if len(statements) != 1:
            return {"success": False, "error": "导出全部结果只支持单条查询语句"}
        statement = statements[0]
        if provider.classify_operation(statement).kind != "read":
            return {"success": False, "error": "只能导出只读查询的结果"}

        result = db.execute(_limit_for_export(statement, dialect, max_rows))
        if not isinstance(result, dict) or result.get("success") is False:
            error = (result or {}).get("error_msg") or (result or {}).get("error") or "查询失败"
            return {"success": False, "error": error}
        raw_statements = result.get("statements") or []
        active = raw_statements[-1] if raw_statements else result
        columns = active.get("columns") or result.get("columns") or []
        rows = active.get("data") or result.get("data") or []
        truncated = len(rows) > max_rows
        if truncated:
            rows = rows[:max_rows]
        return {
            "success": True,
            "columns": columns,
            "data": rows,
            "row_count": len(rows),
            "truncated": truncated,
            "max_rows": max_rows,
        }
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def get_table_ddl(table_name: str, source_id: int) -> dict[str, Any]:
    db = None
    try:
        provider, db = resolve_source(source_id)
        if not provider.capabilities.supports_ddl:
            return {
                "success": False,
                "error": f"{provider.display_name} 不支持 DDL 查询",
            }
        get_ddl = getattr(db, "get_ddl", None)
        if not callable(get_ddl):
            return {"success": False, "error": "当前 provider 未实现 get_ddl"}
        ddl = get_ddl(table_name)
        if not ddl:
            return {"success": False, "error": "Table not found or DDL not available"}
        return {"success": True, "ddl": ddl}
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def get_er_data(source_id: int) -> dict[str, Any]:
    db = None
    try:
        provider, db = resolve_source(source_id)
        schema = db.get_schema()
        get_fks = getattr(db, "get_foreign_keys", None)
        foreign_keys = get_fks() if callable(get_fks) else []
        return {"success": True, "tables": schema, "foreign_keys": foreign_keys}
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()
