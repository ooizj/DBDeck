from __future__ import annotations

from typing import Any


def standardize_result(
    result: dict[str, Any],
    *,
    provider_id: str,
    source_id: int,
    requested_query: str,
    executed_query: str,
    operation_kind: str,
) -> dict[str, Any]:
    standardized = dict(result)
    statements = []
    raw_statements = standardized.get("statements") or []
    if not raw_statements:
        raw_statements = [
            {
                "statement_index": 0,
                "sql": executed_query,
                "executed_query": executed_query,
                "operation_kind": operation_kind,
                "columns": standardized.get("columns", []),
                "column_metadata": standardized.get("column_metadata", {}),
                "data": standardized.get("data", []),
                "row_count": standardized.get(
                    "row_count", len(standardized.get("data") or [])
                ),
                "affected_rows": standardized.get("affected_rows"),
                "duration_ms": standardized.get("duration_ms"),
                "message": standardized.get("message"),
            }
        ]
    for index, statement in enumerate(raw_statements):
        item = dict(statement)
        item.setdefault("statement_index", index)
        item.setdefault("executed_query", item.get("sql") or executed_query)
        item.setdefault("operation_kind", operation_kind)
        item.setdefault("columns", [])
        item.setdefault("column_metadata", {})
        item.setdefault("data", [])
        item.setdefault("row_count", len(item.get("data") or []))
        item.setdefault("affected_rows", None)
        item.setdefault("duration_ms", None)
        statements.append(item)
    if statements:
        standardized["statements"] = statements
        if "statement_index" in standardized:
            active_index = standardized["statement_index"]
        else:
            readable_indexes = [
                idx for idx, item in enumerate(statements) if item.get("columns")
            ]
            active_index = readable_indexes[-1] if readable_indexes else len(statements) - 1
        standardized["active_statement_index"] = active_index
    standardized["source_id"] = source_id
    standardized["provider_id"] = provider_id
    standardized["query"] = standardized.get("query") or requested_query
    standardized["executed_query"] = executed_query
    standardized["executed_sql"] = executed_query
    standardized["operation_kind"] = operation_kind
    standardized["row_count"] = standardized.get(
        "row_count", len(standardized.get("data") or [])
    )
    if not standardized.get("success", True):
        standardized.setdefault("error_msg", standardized.get("error"))
    return standardized
