from __future__ import annotations

from fastapi import APIRouter

from src.services import compare_service

router = APIRouter()


@router.get("/compare/structure")
def compare_table_structure(source_id: int, table1: str, table2: str):
    """比较两个表的结构差异"""
    return compare_service.compare_table_structure(source_id, table1, table2)


@router.get("/compare/data")
def compare_table_data(source_id: int, table1: str, table2: str, key_column: str, limit: int = 1000):
    """比较两个表的数据差异"""
    return compare_service.compare_table_data(source_id, table1, table2, key_column, limit)


@router.get("/compare/cross-database")
def compare_cross_database(source_id1: int, table1: str, source_id2: int, table2: str):
    """跨数据库比较表结构"""
    return compare_service.compare_cross_database(source_id1, table1, source_id2, table2)
