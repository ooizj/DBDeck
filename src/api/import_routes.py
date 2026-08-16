from __future__ import annotations

import csv
import io
import logging
from typing import Optional

from fastapi import APIRouter, File, Form, UploadFile

from src.services.import_service import import_file

logger = logging.getLogger(__name__)
router = APIRouter(tags=["import"])


@router.post("/import")
async def import_data(
    file: UploadFile = File(...),
    source_id: int = Form(...),
    table_name: str = Form(""),
    mode: str = Form("create"),
):
    content = await file.read()
    filename = file.filename or "data.csv"
    try:
        result = import_file(content, filename, source_id, table_name, mode)
        return result
    except Exception as e:
        logger.error(f"Import failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
