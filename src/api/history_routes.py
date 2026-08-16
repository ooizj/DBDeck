from __future__ import annotations

from fastapi import APIRouter, Query

from src.services.history_service import clear_history, list_history

router = APIRouter(prefix="/history", tags=["history"])


@router.get("")
def get_history(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    source_id: int | None = Query(None),
    search: str | None = Query(None),
):
    return {"success": True, "items": list_history(limit, offset, source_id, search)}


@router.delete("")
def delete_history(source_id: int | None = Query(None)):
    clear_history(source_id)
    return {"success": True}
