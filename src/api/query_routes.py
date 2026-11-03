from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter

from src.api.schemas import ExportQueryRequest, SQLRequest
from src.services import query_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/metadata")
async def get_metadata(source_id: int, key_pattern: Optional[str] = None):
    return query_service.get_metadata(source_id, key_pattern)


@router.get("/metadata/databases")
async def get_databases(source_id: int):
    return query_service.get_databases(source_id)


@router.get("/metadata/server-version")
async def get_server_version(source_id: int):
    return query_service.get_server_version(source_id)


@router.get("/metadata/database-schema")
async def get_database_schema(source_id: int, database: str):
    return query_service.get_database_schema(source_id, database)


@router.post("/execute-sql")
async def execute_sql(request: SQLRequest):
    return query_service.execute_query(
        request.query,
        request.source_id,
        page=request.page,
        page_size=request.page_size,
    )


@router.post("/export-query")
def export_query(request: ExportQueryRequest):
    return query_service.export_query(request.query, request.source_id)


@router.get("/metadata/ddl")
async def get_table_ddl(table_name: str, source_id: int):
    return query_service.get_table_ddl(table_name, source_id)
