"""MySQL 数据库客户端（基于 SQLAlchemy）。"""
from __future__ import annotations

import logging
import time
import warnings
from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import SAWarning, SQLAlchemyError

from src.common.config import config
from src.common.sql_utils import serialize_row, split_sql_by_tokens
from src.sources.base import DataSourceClient
from src.sources.ssh_tunnel import clean_str, close_ssh_tunnel, open_ssh_tunnel

warnings.filterwarnings(
    "ignore", category=SAWarning, message=".*Did not recognize type.*"
)

logger = logging.getLogger(__name__)


class MySQLClient(DataSourceClient):
    def __init__(self, config_dict: Optional[Dict[str, Any]] = None) -> None:
        self._ssh_tunnel = None
        if config_dict:
            host = clean_str(config_dict.get("host")) or "localhost"
            port = int(config_dict.get("port") or 3306)
            host, port, self._ssh_tunnel = open_ssh_tunnel(
                config_dict, host, port, label="MySQL"
            )
            url = URL.create(
                "mysql+pymysql",
                username=config_dict.get("user") or "",
                password=config_dict.get("password") or "",
                host=host,
                port=port,
                database=clean_str(config_dict.get("database")),
            )
            self.engine = create_engine(url)
        else:
            self.engine = create_engine(config.sqlalchemy_url)

    def execute(
        self, sql: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        statement_results: List[Dict[str, Any]] = []
        total_start = time.perf_counter()
        try:
            statements = split_sql_by_tokens(sql, dialect="mysql")
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
                        column_metadata = self._collect_column_metadata(stmt, columns)
                        last_payload = {
                            "success": True,
                            "statement_index": index,
                            "sql": stmt,
                            "columns": columns,
                            "column_metadata": column_metadata,
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
            logger.error(f"MySQL error: {e}", exc_info=True)
            error_detail = str(e)
            error_code = None
            try:
                if isinstance(e, SQLAlchemyError) and getattr(e, "orig", None):
                    orig = e.orig
                    if hasattr(orig, "args") and len(orig.args) >= 2:
                        error_code = orig.args[0]
                        error_detail = orig.args[1]
                    else:
                        error_detail = str(orig)
            except Exception:
                pass
            return {
                "success": False,
                "error": str(e),
                "error_msg": error_detail,
                "error_code": error_code,
                "statements": statement_results,
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }

    def _collect_column_metadata(
        self, sql: str, columns: List[str]
    ) -> Dict[str, Dict[str, Any]]:
        """通过 sqlglot AST 把结果列映射到源表字段的元数据（类型、注释）。"""
        metadata: Dict[str, Dict[str, Any]] = {}
        try:
            import sqlglot
            from sqlglot import exp

            expression = sqlglot.parse_one(sql, read="mysql")

            alias_to_table: Dict[str, str] = {}
            involved_tables: set[str] = set()
            for tbl in expression.find_all(exp.Table):
                actual = tbl.name
                alias_to_table[tbl.alias or actual] = actual
                involved_tables.add(actual)

            inspector = inspect(self.engine)
            all_tables_meta: Dict[str, Dict[str, Any]] = {}
            table_pk_columns: Dict[str, set[str]] = {}
            for t_name in involved_tables:
                try:
                    all_tables_meta[t_name] = {
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
                        t_name = alias_to_table.get(col.table)
                        if t_name:
                            star_tables.add(t_name)
                    else:
                        star_tables.update(involved_tables)
                elif col.table:
                    t_name = alias_to_table.get(col.table)
                    if t_name:
                        col_to_table[col.name] = t_name
                        col_to_source[col.name] = col.name

            for col_name in columns:
                t_name = col_to_table.get(col_name)
                source_col = col_to_source.get(col_name, col_name)
                if not t_name:
                    for s_table in star_tables:
                        if source_col in all_tables_meta.get(s_table, {}):
                            t_name = s_table
                            break

                if t_name and source_col in all_tables_meta.get(t_name, {}):
                    meta = all_tables_meta[t_name][source_col]
                    metadata[col_name] = {
                        "type": str(meta["type"]),
                        "comment": meta.get("comment") or "",
                        "table": t_name,
                        "source_column": source_col,
                        "primary_key": source_col in table_pk_columns.get(t_name, set()),
                    }
                    continue

                matches = []
                for tn, tmeta in all_tables_meta.items():
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
        if not self.engine.url.database:
            raise ValueError("MySQL 数据库名称不能为空，请先选择或填写数据库名称")
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
        if not self.engine.url.database:
            return {}
        inspector = inspect(self.engine)
        object_types: Dict[str, str] = {}
        for table_name in inspector.get_table_names():
            object_types[table_name] = "table"
        for view_name in inspector.get_view_names():
            object_types[view_name] = "view"
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT ROUTINE_NAME, ROUTINE_TYPE
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = :schema
            """), {"schema": self.engine.url.database}).fetchall()
        for name, routine_type in rows:
            object_types[name] = "function" if str(routine_type).upper() == "FUNCTION" else "procedure"
        return object_types

    def get_table_comments(self) -> Dict[str, str]:
        inspector = inspect(self.engine)
        comments: Dict[str, str] = {}
        relation_names = [
            *inspector.get_table_names(),
            *inspector.get_view_names(),
        ]
        for table_name in relation_names:
            try:
                table_comment = inspector.get_table_comment(table_name) or {}
                comments[table_name] = table_comment.get("text") or ""
            except Exception:
                comments[table_name] = ""
        return comments

    def get_ddl(self, table_name: str) -> Optional[str]:
        quoted_table = table_name.replace("`", "``")
        with self.engine.connect() as conn:
            row = conn.execute(
                text(f"SHOW CREATE TABLE `{quoted_table}`")
            ).fetchone()
        return row[1] if row else None

    def get_foreign_keys(self) -> List[Dict[str, Any]]:
        if not self.engine.url.database:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME,
                       kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
                FROM information_schema.KEY_COLUMN_USAGE kcu
                WHERE kcu.TABLE_SCHEMA = :schema
                  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
            """), {"schema": self.engine.url.database}).fetchall()
        return [{"table": r[0], "column": r[1], "ref_table": r[2], "ref_column": r[3]} for r in rows]

    def close(self) -> None:
        try:
            self.engine.dispose()
        finally:
            close_ssh_tunnel(self._ssh_tunnel)
            self._ssh_tunnel = None


def list_mysql_databases(config_dict: Dict[str, Any]) -> List[str]:
    temp = dict(config_dict)
    temp["database"] = "mysql"
    client = MySQLClient(temp)
    try:
        result = client.execute("SHOW DATABASES")
        if result.get("success"):
            return [row[0] for row in result["data"]]
        return []
    finally:
        client.close()


def migrate_table(src, dest, table_name: str) -> Dict[str, Any]:
    """Backward-compatible wrapper for the shared SQL migration implementation."""
    from src.sources.sql_migration import migrate_table as shared_migrate_table

    return shared_migrate_table(src, dest, table_name)
