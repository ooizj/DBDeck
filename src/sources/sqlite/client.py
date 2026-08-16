"""SQLite 数据库客户端（基于 SQLAlchemy + sqlite3 驱动）。"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError

from src.common.sql_utils import serialize_row, split_sql_by_tokens
from src.sources.base import DataSourceClient

logger = logging.getLogger(__name__)


def _resolve_db_path(db_path: str) -> str:
    if not os.path.isabs(db_path):
        root_dir = Path(__file__).parent.parent.parent.parent
        db_path = str(root_dir / db_path)
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return db_path


class SQLiteClient(DataSourceClient):
    def __init__(self, config_dict: Dict[str, Any]) -> None:
        db_path = _resolve_db_path(config_dict.get("database", "test.db"))
        self.engine = create_engine(f"sqlite:///{db_path}")

    def execute(
        self, sql: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        statement_results: List[Dict[str, Any]] = []
        total_start = time.perf_counter()
        try:
            statements = split_sql_by_tokens(sql, dialect="sqlite")
            if not statements:
                statements = [sql]

            with self.engine.connect() as conn:
                last_payload: Dict[str, Any] = {
                    "success": True,
                    "columns": [],
                    "column_metadata": {},
                    "data": [],
                    "row_count": 0,
                }
                for index, stmt in enumerate(statements):
                    statement_start = time.perf_counter()
                    current_result = conn.execute(text(stmt), params or {})
                    if current_result.returns_rows:
                        columns = list(current_result.keys())
                        rows = [
                            serialize_row(list(row))
                            for row in current_result.fetchall()
                        ]
                        last_payload = {
                            "success": True,
                            "statement_index": index,
                            "sql": stmt,
                            "columns": columns,
                            "column_metadata": self._collect_column_metadata(stmt, columns),
                            "data": rows,
                            "row_count": len(rows),
                            "affected_rows": None,
                            "message": f"Returned {len(rows)} rows",
                            "duration_ms": round(
                                (time.perf_counter() - statement_start) * 1000, 2
                            ),
                        }
                    else:
                        rowcount = current_result.rowcount
                        display_rowcount = rowcount if rowcount >= 0 else 0
                        last_payload = {
                            "success": True,
                            "statement_index": index,
                            "sql": stmt,
                            "columns": [],
                            "column_metadata": {},
                            "data": [],
                            "row_count": display_rowcount,
                            "affected_rows": display_rowcount,
                            "message": f"Successfully executed. Affected rows: {display_rowcount}",
                            "duration_ms": round(
                                (time.perf_counter() - statement_start) * 1000, 2
                            ),
                        }
                    statement_results.append(dict(last_payload))

                conn.commit()
                return {
                    **last_payload,
                    "statements": statement_results,
                    "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
                }
        except Exception as e:
            logger.error(f"SQLite error: {e}", exc_info=True)
            error_detail = str(e)
            try:
                if isinstance(e, SQLAlchemyError) and getattr(e, "orig", None):
                    error_detail = str(e.orig)
            except Exception:
                pass
            return {
                "success": False,
                "error": str(e),
                "error_msg": error_detail,
                "error_code": None,
                "statements": statement_results,
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }

    def _collect_column_metadata(
        self, sql: str, columns: List[str]
    ) -> Dict[str, Dict[str, Any]]:
        metadata: Dict[str, Dict[str, Any]] = {}
        try:
            import sqlglot
            from sqlglot import exp

            expression = sqlglot.parse_one(sql, read="sqlite")
            alias_to_table: Dict[str, str] = {}
            involved: set[str] = set()
            for tbl in expression.find_all(exp.Table):
                actual = tbl.name
                alias_to_table[tbl.alias or actual] = actual
                involved.add(actual)

            inspector = inspect(self.engine)
            all_meta: Dict[str, Dict[str, Any]] = {}
            table_pk_columns: Dict[str, set[str]] = {}
            for t_name in involved:
                try:
                    all_meta[t_name] = {
                        col["name"]: col for col in inspector.get_columns(t_name)
                    }
                    pk = inspector.get_pk_constraint(t_name) or {}
                    table_pk_columns[t_name] = set(pk.get("constrained_columns") or [])
                except Exception:
                    pass

            col_to_table: Dict[str, str] = {}
            col_to_source: Dict[str, str] = {}
            star_tables: set[str] = set()
            for select_expr in expression.expressions:
                if isinstance(select_expr, exp.Alias) and isinstance(select_expr.this, exp.Column):
                    source_col = select_expr.this
                    t_name = alias_to_table.get(source_col.table) if source_col.table else None
                    if t_name:
                        col_to_table[select_expr.alias] = t_name
                        col_to_source[select_expr.alias] = source_col.name
            for col in expression.find_all(exp.Column):
                if col.name == "*":
                    if col.table:
                        t = alias_to_table.get(col.table)
                        if t:
                            star_tables.add(t)
                    else:
                        star_tables.update(involved)
                elif col.table:
                    t = alias_to_table.get(col.table)
                    if t:
                        col_to_table[col.name] = t
                        col_to_source[col.name] = col.name

            for col_name in columns:
                t_name = col_to_table.get(col_name)
                source_col = col_to_source.get(col_name, col_name)
                if not t_name:
                    for s in star_tables:
                        if source_col in all_meta.get(s, {}):
                            t_name = s
                            break
                if t_name and source_col in all_meta.get(t_name, {}):
                    meta = all_meta[t_name][source_col]
                    metadata[col_name] = {
                        "type": str(meta["type"]),
                        "comment": meta.get("comment") or "",
                        "table": t_name,
                        "source_column": source_col,
                        "primary_key": source_col in table_pk_columns.get(t_name, set()),
                    }
                    continue
                matches = []
                for tn, tmeta in all_meta.items():
                    if col_name in tmeta:
                        matches.append((tn, tmeta[col_name]))
                if len(matches) == 1:
                    tn, meta = matches[0]
                    metadata[col_name] = {
                        "type": str(meta["type"]),
                        "comment": meta.get("comment") or "",
                        "table": tn,
                        "source_column": col_name,
                        "primary_key": col_name in table_pk_columns.get(tn, set()),
                    }
        except Exception as e:
            logger.warning(f"Failed to fetch column metadata: {e}")
        return metadata

    def get_schema(self) -> Dict[str, Any]:
        inspector = inspect(self.engine)
        schema: Dict[str, Any] = {}
        relation_names = [
            *inspector.get_table_names(),
            *inspector.get_view_names(),
        ]
        for table_name in relation_names:
            columns = inspector.get_columns(table_name)
            schema[table_name] = [
                {
                    "name": c["name"],
                    "type": str(c["type"]),
                    "nullable": c["nullable"],
                    "comment": c.get("comment") or "",
                }
                for c in columns
            ]
        return schema

    def get_object_types(self) -> Dict[str, str]:
        inspector = inspect(self.engine)
        object_types: Dict[str, str] = {}
        for table_name in inspector.get_table_names():
            object_types[table_name] = "table"
        for view_name in inspector.get_view_names():
            object_types[view_name] = "view"
        return object_types

    def get_table_comments(self) -> Dict[str, str]:
        inspector = inspect(self.engine)
        return {
            table_name: ""
            for table_name in [*inspector.get_table_names(), *inspector.get_view_names()]
        }

    def get_ddl(self, table_name: str) -> Optional[str]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                text("""
                    SELECT sql
                    FROM sqlite_master
                    WHERE sql IS NOT NULL
                      AND (
                        (type = 'table' AND name = :name)
                        OR (tbl_name = :name AND type IN ('index', 'trigger'))
                      )
                    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,
                             name
                """),
                {"name": table_name},
            ).fetchall()
        return ";\n".join(row[0].rstrip(";") for row in rows) if rows else None

    def get_foreign_keys(self) -> List[Dict[str, Any]]:
        inspector = inspect(self.engine)
        result: List[Dict[str, Any]] = []
        for table_name in inspector.get_table_names():
            fks = inspector.get_foreign_keys(table_name)
            for fk in fks:
                for col, ref_col in zip(fk.get("constrained_columns", []), fk.get("referred_columns", [])):
                    result.append({
                        "table": table_name,
                        "column": col,
                        "ref_table": fk.get("referred_table", ""),
                        "ref_column": ref_col,
                    })
        return result
