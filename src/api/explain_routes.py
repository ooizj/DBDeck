from __future__ import annotations

from fastapi import APIRouter

from src.services import explain_service

router = APIRouter()


@router.get("/explain/visualize")
def visualize_execution_plan(source_id: int, query: str):
    """获取可视化的执行计划（树形结构）"""
    return explain_service.visualize_execution_plan(source_id, query)
