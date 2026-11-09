"""PostgreSQL 数据库客户端（基于 SQLAlchemy + psycopg2）。"""
from __future__ import annotations

import logging
import time
import warnings
from typing import Any, Dict, List, Optional

import psycopg2.extensions
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.engine.reflection import ObjectKind
from sqlalchemy.exc import SAWarning, SQLAlchemyError

from src.common.config import config
from src.common.sql_identifiers import (
    quote_identifier,
    quote_qualified_identifier,
    split_qualified_identifier,
)
from src.common.sql_utils import serialize_row, split_sql_by_tokens
from src.sources.base import DataSourceClient
from src.sources.ssh_tunnel import clean_str, close_ssh_tunnel, open_ssh_tunnel
from src.common.i18n import msg

warnings.filterwarnings(
    "ignore", category=SAWarning, message=".*Did not recognize type.*"
)

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 10

# 系统模式不在导航树中展示
SYSTEM_SCHEMAS = {"pg_catalog", "information_schema"}
SYSTEM_SCHEMA_PREFIXES = ("pg_toast", "pg_temp")


# psycopg2 默认把 interval 转成 timedelta（丢失月份、JSON 中变成秒数），
# 把范围类型转成 Range 对象（JSON 中变成 {}）。这些类型直接保留 PostgreSQL 原生文本。
# (类型 OID, 数组类型 OID, 名称)
_TEXT_RESULT_TYPES = (
    (1186, 1187, "INTERVAL"),
    (3904, 3905, "INT4RANGE"),
    (3926, 3927, "INT8RANGE"),
    (3906, 3907, "NUMRANGE"),
    (3908, 3909, "TSRANGE"),
    (3910, 3911, "TSTZRANGE"),
    (3912, 3913, "DATERANGE"),
)


def _register_text_result_types(dbapi_connection, _connection_record=None) -> None:
    for oid, array_oid, name in _TEXT_RESULT_TYPES:
        caster = psycopg2.extensions.new_type((oid,), f"DBDECK_{name}", lambda value, _cur: value)
        array_caster = psycopg2.extensions.new_array_type(
            (array_oid,), f"DBDECK_{name}_ARRAY", caster
        )
        psycopg2.extensions.register_type(caster, dbapi_connection)
        psycopg2.extensions.register_type(array_caster, dbapi_connection)


def is_system_schema(schema: str) -> bool:
    lowered = (schema or "").lower()
    return lowered in SYSTEM_SCHEMAS or lowered.startswith(SYSTEM_SCHEMA_PREFIXES)


def qualify_name(schema: Optional[str], name: str, default_schema: Optional[str]) -> str:
    """默认模式下的对象用原名，其他模式用「模式.名称」，与 SQL 中的写法一致。"""
    if not schema or schema == default_schema:
        return name
    return f"{schema}.{name}"


class PostgreSQLClient(DataSourceClient):
    def __init__(self, config_dict: Optional[Dict[str, Any]] = None) -> None:
        self._ssh_tunnel = None
        if config_dict:
            host = clean_str(config_dict.get("host")) or "localhost"
            port = int(config_dict.get("port") or 5432)
            host, port, self._ssh_tunnel = open_ssh_tunnel(
                config_dict, host, port, label="PostgreSQL"
            )
            url = URL.create(
                "postgresql+psycopg2",
                username=config_dict.get("user") or "",
                password=config_dict.get("password") or "",
                host=host,
                port=port,
                database=clean_str(config_dict.get("database")),
            )
            # 未设置时驱动会无限期等待握手，代理/网络异常下会卡死整个请求
            self.engine = create_engine(url, connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS})
        else:
            self.engine = create_engine(config.sqlalchemy_url)
        if self.engine.dialect.driver == "psycopg2":
            event.listen(self.engine, "connect", _register_text_result_types)

    def execute(
        self, sql: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        statement_results: List[Dict[str, Any]] = []
        total_start = time.perf_counter()
        try:
            statements = split_sql_by_tokens(sql, dialect="postgres")
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
            logger.error(f"PostgreSQL error: {e}", exc_info=True)
            error_detail = str(e)
            error_code = None
            try:
                if isinstance(e, SQLAlchemyError) and getattr(e, "orig", None):
                    orig = e.orig
                    if hasattr(orig, "pgcode"):
                        error_code = orig.pgcode
                    if hasattr(orig, "args") and orig.args:
                        error_detail = str(orig.args[0]) if orig.args else str(orig)
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
        metadata: Dict[str, Dict[str, Any]] = {}
        try:
            import sqlglot
            from sqlglot import exp

            expression = sqlglot.parse_one(sql, read="postgres")

            inspector = inspect(self.engine)
            default_schema = inspector.default_schema_name
            alias_to_table: Dict[str, str] = {}
            # 限定名（如 xapp_review.review）-> (模式, 表名)
            involved_tables: Dict[str, tuple] = {}
            for tbl in expression.find_all(exp.Table):
                schema_name = tbl.db or None
                actual = qualify_name(schema_name, tbl.name, default_schema)
                # 别名、裸表名、限定名都能定位到同一张表
                alias_to_table[tbl.alias or tbl.name] = actual
                alias_to_table[actual] = actual
                involved_tables[actual] = (schema_name, tbl.name)

            all_tables_meta: Dict[str, Dict[str, Any]] = {}
            table_pk_columns: Dict[str, set[str]] = {}
            for t_name, (schema_name, bare_name) in involved_tables.items():
                try:
                    all_tables_meta[t_name] = {
                        col["name"]: col
                        for col in inspector.get_columns(bare_name, schema=schema_name)
                    }
                    pk = inspector.get_pk_constraint(bare_name, schema=schema_name) or {}
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

    def _user_schemas(self, inspector) -> List[str]:
        return [name for name in inspector.get_schema_names() if not is_system_schema(name)]

    def get_schema(self) -> Dict[str, Any]:
        if not self.engine.url.database:
            raise ValueError(msg("PostgreSQL 数据库名称不能为空，请先选择或填写数据库名称", "The PostgreSQL database name is empty; select or enter a database name"))
        # get_multi_* 在 PostgreSQL 方言里是按模式批量查询，避免逐表反射
        inspector = inspect(self.engine)
        default_schema = inspector.default_schema_name
        schema: Dict[str, Any] = {}
        for schema_name in self._user_schemas(inspector):
            columns_by_table = inspector.get_multi_columns(
                schema=schema_name, kind=ObjectKind.TABLE | ObjectKind.VIEW
            )
            pk_by_table = inspector.get_multi_pk_constraint(schema=schema_name, kind=ObjectKind.TABLE)
            for table_key, columns in columns_by_table.items():
                pk_columns = set((pk_by_table.get(table_key) or {}).get("constrained_columns") or [])
                schema[qualify_name(schema_name, table_key[1], default_schema)] = [
                    {
                        "name": c["name"],
                        "type": str(c["type"]),
                        "nullable": c["nullable"],
                        "comment": c.get("comment") or "",
                        "primary_key": c["name"] in pk_columns,
                    }
                    for c in columns
                ]
        return schema

    def get_object_types(self) -> Dict[str, str]:
        inspector = inspect(self.engine)
        default_schema = inspector.default_schema_name
        schemas = self._user_schemas(inspector)
        object_types: Dict[str, str] = {}
        for schema_name in schemas:
            for table_name in inspector.get_table_names(schema=schema_name):
                object_types[qualify_name(schema_name, table_name, default_schema)] = "table"
            for view_name in inspector.get_view_names(schema=schema_name):
                object_types[qualify_name(schema_name, view_name, default_schema)] = "view"
        if not schemas:
            return object_types
        with self.engine.connect() as conn:
            rows = conn.execute(
                text("""
                    SELECT routine_schema, routine_name, routine_type
                    FROM information_schema.routines
                    WHERE routine_schema = ANY(:schemas)
                """),
                {"schemas": schemas},
            ).fetchall()
        for schema_name, name, routine_type in rows:
            key = qualify_name(schema_name, name, default_schema)
            object_types[key] = "function" if str(routine_type).upper() == "FUNCTION" else "procedure"
        return object_types

    def get_table_comments(self) -> Dict[str, str]:
        inspector = inspect(self.engine)
        default_schema = inspector.default_schema_name
        result: Dict[str, str] = {}
        for schema_name in self._user_schemas(inspector):
            comments = inspector.get_multi_table_comment(
                schema=schema_name, kind=ObjectKind.TABLE | ObjectKind.VIEW
            )
            for table_key, comment in comments.items():
                result[qualify_name(schema_name, table_key[1], default_schema)] = (
                    (comment or {}).get("text") or ""
                )
        return result

    def get_ddl(self, table_name: str) -> Optional[str]:
        inspector = inspect(self.engine)
        schema_name, bare_name = split_qualified_identifier(table_name)
        columns = inspector.get_columns(bare_name, schema=schema_name)
        if not columns:
            return None
        pk = inspector.get_pk_constraint(bare_name, schema=schema_name)
        pk_cols = pk.get("constrained_columns", []) if pk else []
        lines = []
        for col in columns:
            nullable = "" if col["nullable"] else " NOT NULL"
            default = ""
            if col.get("server_default"):
                default = f" DEFAULT {col['server_default'].arg}"
            pk_str = " PRIMARY KEY" if col["name"] in pk_cols else ""
            column_name = quote_identifier("postgresql", col["name"])
            lines.append(f"    {column_name} {col['type']}{nullable}{default}{pk_str}")
        quoted_table = quote_qualified_identifier("postgresql", table_name)
        return f"CREATE TABLE {quoted_table} (\n" + ",\n".join(lines) + "\n);"

    def get_foreign_keys(self) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    nsp.nspname AS table_schema,
                    rel.relname AS table_name,
                    att.attname AS column_name,
                    nsp_ref.nspname AS ref_table_schema,
                    rel_ref.relname AS ref_table_name,
                    att_ref.attname AS ref_column_name,
                    current_schema() AS default_schema
                FROM pg_catalog.pg_constraint con
                JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
                JOIN pg_catalog.pg_namespace nsp ON nsp.oid = rel.relnamespace
                JOIN pg_catalog.pg_class rel_ref ON rel_ref.oid = con.confrelid
                JOIN pg_catalog.pg_namespace nsp_ref ON nsp_ref.oid = rel_ref.relnamespace
                JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
                JOIN pg_catalog.pg_attribute att_ref ON att_ref.attrelid = con.confrelid AND att_ref.attnum = ANY(con.confkey)
                WHERE con.contype = 'f'
                  AND nsp.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND nsp.nspname !~ '^pg_(toast|temp)'
            """)).fetchall()
        return [
            {
                "table": qualify_name(r[0], r[1], r[6]),
                "column": r[2],
                "ref_table": qualify_name(r[3], r[4], r[6]),
                "ref_column": r[5],
            }
            for r in rows
        ]

    def close(self) -> None:
        try:
            self.engine.dispose()
        finally:
            close_ssh_tunnel(self._ssh_tunnel)
            self._ssh_tunnel = None


def list_postgresql_databases(config_dict: Dict[str, Any]) -> List[str]:
    temp = dict(config_dict)
    temp["database"] = "postgres"
    client = PostgreSQLClient(temp)
    try:
        result = client.execute(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
        )
        if result.get("success"):
            return [row[0] for row in result["data"]]
        return []
    finally:
        client.close()


def migrate_table(src, dest, table_name: str) -> Dict[str, Any]:
    from src.sources.sql_migration import migrate_table as shared_migrate_table

    return shared_migrate_table(src, dest, table_name)
