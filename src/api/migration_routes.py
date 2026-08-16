from __future__ import annotations

from fastapi import APIRouter

from src.api.schemas import MigrateRequest
from src.services import migration_service

router = APIRouter()


@router.post("/migrate")
async def migrate(request: MigrateRequest):
    return migration_service.migrate_tables(
        request.src_id,
        request.dest_id,
        request.tables,
    )
