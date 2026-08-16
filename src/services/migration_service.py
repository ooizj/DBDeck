from __future__ import annotations

from fastapi import HTTPException

from src.services.source_service import resolve_source
from src.sources.sql_migration import migrate_table, supports_sql_migration


def migrate_tables(src_id: int, dest_id: int, tables: list[str]) -> dict:
    src_db = None
    dest_db = None
    try:
        src_provider, src_db = resolve_source(src_id)
        dest_provider, dest_db = resolve_source(dest_id)
        if not (
            src_provider.capabilities.supports_migrate
            and dest_provider.capabilities.supports_migrate
        ):
            return {
                "success": False,
                "error": "Migration is only supported between SQL-family sources",
            }
        if not (supports_sql_migration(src_db) and supports_sql_migration(dest_db)):
            return {"success": False, "error": "迁移仅支持 SQL-family 数据源间进行"}

        details = []
        for table in tables:
            details.append({"table": table, "result": migrate_table(src_db, dest_db, table)})
        return {"success": True, "details": details}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if src_db:
            src_db.close()
        if dest_db:
            dest_db.close()
