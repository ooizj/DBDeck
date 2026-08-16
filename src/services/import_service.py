"""Import CSV/Excel data into database tables."""
from __future__ import annotations

import csv
import io
import logging
from typing import Any, Dict, List

from src.common.sql_identifiers import quote_identifier

logger = logging.getLogger(__name__)


def _parse_csv(content: bytes) -> List[Dict[str, Any]]:
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    return list(reader), reader.fieldnames or []


def _parse_excel(content: bytes) -> tuple[List[Dict[str, Any]], List[str]]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return [], []
    headers = [str(h or f"col{i}") for i, h in enumerate(rows[0])]
    data = []
    for row in rows[1:]:
        data.append({headers[i]: row[i] for i in range(len(headers))})
    return data, headers


def _infer_sql_type(values) -> str:
    sample = [v for v in values if v is not None and v != ""][:20]
    if not sample:
        return "TEXT"
    all_int = all(str(v).isdigit() or (str(v).startswith("-") and str(v)[1:].isdigit()) for v in sample)
    if all_int:
        return "INTEGER"
    all_float = True
    for v in sample:
        try:
            float(str(v))
        except (ValueError, TypeError):
            all_float = False
            break
    if all_float:
        return "REAL"
    return "TEXT"


def import_file(
    content: bytes,
    filename: str,
    source_id: int,
    table_name: str,
    mode: str,
) -> Dict[str, Any]:
    from src.services.source_service import resolve_source
    from sqlalchemy import text

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "csv"
    if ext in ("xlsx", "xls"):
        data, headers = _parse_excel(content)
    else:
        data, headers = _parse_csv(content)

    if not data or not headers:
        return {"success": False, "error": "文件为空或格式不正确"}

    if not table_name:
        table_name = filename.rsplit(".", 1)[0].replace(" ", "_").replace("-", "_")

    provider, db = resolve_source(source_id)
    try:
        inspector = __import__("sqlalchemy").inspect(db.engine)

        if mode == "create":
            existing_tables = inspector.get_table_names()
            if table_name in existing_tables:
                table_name = f"{table_name}_{len(data)}"

            col_types = {}
            for h in headers:
                values = [row.get(h) for row in data]
                col_types[h] = _infer_sql_type(values)

            col_defs = ", ".join(
                f"{quote_identifier(provider.id, header)} {col_types[header]}"
                for header in headers
            )
            create_sql = (
                f"CREATE TABLE {quote_identifier(provider.id, table_name)} "
                f"({col_defs})"
            )

            with db.engine.connect() as conn:
                conn.execute(text(create_sql))
                conn.commit()

        cols = ", ".join(quote_identifier(provider.id, header) for header in headers)
        placeholders = ", ".join([":p" + str(i) for i in range(len(headers))])
        insert_sql = (
            f"INSERT INTO {quote_identifier(provider.id, table_name)} "
            f"({cols}) VALUES ({placeholders})"
        )

        inserted = 0
        batch_size = 100
        with db.engine.connect() as conn:
            for i in range(0, len(data), batch_size):
                batch = data[i : i + batch_size]
                for row in batch:
                    params = {f"p{j}": row.get(h) for j, h in enumerate(headers)}
                    conn.execute(text(insert_sql), params)
                conn.commit()
                inserted += len(batch)

        return {
            "success": True,
            "table_name": table_name,
            "rows_imported": inserted,
            "columns": headers,
        }
    except Exception as e:
        logger.error(f"Import error: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
    finally:
        db.close()
