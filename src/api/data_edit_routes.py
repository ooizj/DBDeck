from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter

from src.api.schemas import DataEditRequest, BatchEditRequest, ExportRequest, BackupRequest
from src.services import data_edit_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/data/edit")
def edit_data(request: DataEditRequest):
    """执行单行数据编辑操作（INSERT/UPDATE/DELETE）"""
    return data_edit_service.edit_row(
        source_id=request.source_id,
        table=request.table,
        operation=request.operation,
        data=request.data,
        where=request.where
    )


@router.post("/data/batch-edit")
def batch_edit_data(request: BatchEditRequest):
    """批量数据编辑操作"""
    results = []
    for op in request.operations:
        result = data_edit_service.edit_row(
            source_id=request.source_id,
            table=request.table,
            operation=op.operation,
            data=op.data,
            where=op.where
        )
        results.append(result)
    return {"success": True, "results": results}


@router.post("/data/export")
def export_data(request: ExportRequest):
    """导出数据为指定格式"""
    return data_edit_service.export_data(
        source_id=request.source_id,
        table=request.table,
        format=request.format,
        where=request.where,
        limit=request.limit
    )


@router.post("/data/backup")
def backup_database(request: BackupRequest):
    """备份数据库"""
    return data_edit_service.backup_database(
        source_id=request.source_id,
        tables=request.tables,
        include_structure=request.include_structure,
        include_data=request.include_data
    )


@router.get("/data/columns")
def get_table_columns(source_id: int, table: str):
    """获取表的列信息（用于编辑时的类型验证）"""
    return data_edit_service.get_columns(source_id, table)


@router.get("/data/primary-key")
def get_primary_key(source_id: int, table: str):
    """获取表的主键信息"""
    return data_edit_service.get_primary_key(source_id, table)
