from __future__ import annotations

from fastapi import APIRouter

from src.api.schemas import TableSearchPlanRequest, TableSearchRequest, TableSearchTablesRequest
from src.services import table_search_service

router = APIRouter()


@router.get("/table-search/databases")
def list_search_databases(source_id: int):
    return table_search_service.list_databases(source_id)


@router.post("/table-search/tables")
def list_search_tables(request: TableSearchTablesRequest):
    return table_search_service.list_tables(
        request.source_id,
        databases=request.databases,
        table_include=request.table_include,
        table_exclude=request.table_exclude,
    )


@router.post("/table-search/plan")
def plan_table_search(request: TableSearchPlanRequest):
    return table_search_service.plan_search(
        request.source_id,
        request.keyword,
        databases=request.databases,
        table_include=request.table_include,
        table_exclude=request.table_exclude,
        column_types=request.column_types,
        column_name=request.column_name,
        match_mode=request.match_mode,
        where=request.where,
    )


@router.post("/table-search/table")
def search_one_table(request: TableSearchRequest):
    return table_search_service.search_table(
        request.source_id,
        request.database,
        request.table,
        request.keyword,
        column_types=request.column_types,
        column_name=request.column_name,
        match_mode=request.match_mode,
        where=request.where,
        limit=request.limit,
    )
