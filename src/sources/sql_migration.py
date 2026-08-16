"""Migration helpers for SQL-family data source clients."""
from __future__ import annotations

import logging
from typing import Any, Dict

from sqlalchemy import text

logger = logging.getLogger(__name__)


def supports_sql_migration(client: Any) -> bool:
    return hasattr(client, "engine") and callable(getattr(client, "execute", None))


def _quote_identifier(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def _table_ddl(client: Any, table_name: str) -> str | None:
    get_ddl = getattr(client, "get_ddl", None)
    if callable(get_ddl):
        return get_ddl(table_name)

    engine = getattr(client, "engine", None)
    if engine is None:
        return None

    with engine.connect() as conn:
        if engine.name == "sqlite":
            row = conn.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name=:name"),
                {"name": table_name},
            ).fetchone()
            return row[0] if row else None

        row = conn.execute(
            text(f"SHOW CREATE TABLE {_quote_identifier(table_name)}")
        ).fetchone()
        return row[1] if row else None


def _ensure_create_if_not_exists(create_sql: str, table_name: str) -> str:
    if "CREATE TABLE IF NOT EXISTS" in create_sql.upper():
        return create_sql
    quoted = _quote_identifier(table_name)
    return (
        create_sql
        .replace(f"CREATE TABLE {quoted}", f"CREATE TABLE IF NOT EXISTS {quoted}")
        .replace(f"CREATE TABLE {table_name}", f"CREATE TABLE IF NOT EXISTS {quoted}")
    )


def migrate_table(src: Any, dest: Any, table_name: str) -> Dict[str, Any]:
    """Migrate one table between SQL-family clients that expose SQLAlchemy engines."""
    try:
        if not supports_sql_migration(src) or not supports_sql_migration(dest):
            return {"success": False, "error": "源和目标都必须是 SQL-family 数据源"}

        create_sql = _table_ddl(src, table_name)
        if not create_sql:
            return {"success": False, "error": f"无法获取源表 {table_name} 的 DDL"}

        with dest.engine.connect() as dest_conn:
            dest_conn.execute(text(_ensure_create_if_not_exists(create_sql, table_name)))
            dest_conn.commit()

        quoted_table = _quote_identifier(table_name)
        src_result = src.execute(f"SELECT * FROM {quoted_table}")
        if not src_result.get("success"):
            return src_result

        data = src_result.get("data") or []
        if not data:
            return {
                "success": True,
                "message": f"Table {table_name} is empty, schema created.",
            }

        columns = src_result.get("columns") or []
        placeholders = ", ".join([f":{col}" for col in columns])
        insert_sql = (
            f"INSERT INTO {quoted_table} "
            f"({', '.join([_quote_identifier(c) for c in columns])}) VALUES ({placeholders})"
        )
        with dest.engine.connect() as conn:
            params = [dict(zip(columns, row)) for row in data]
            conn.execute(text(insert_sql), params)
            conn.commit()

        return {
            "success": True,
            "message": f"Successfully migrated {len(data)} rows for table {table_name}",
        }
    except Exception as e:
        logger.error("Migration error for %s: %s", table_name, e, exc_info=True)
        return {"success": False, "error": str(e)}
