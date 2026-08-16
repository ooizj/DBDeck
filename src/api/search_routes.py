from __future__ import annotations

import logging
import json
from typing import Optional

from fastapi import APIRouter, Query

from src.common.db_utils import (
    get_table_columns,
    managed_source,
    mongo_collection_expr,
    quote_identifier,
    quote_qualified_identifier,
)
from src.common.errors import redact_sensitive

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/search/data")
async def search_data(
    source_id: int,
    table: str,
    query: str,
    columns: str = None,
    limit: int = Query(100, ge=1, le=500),
):
    """在表中搜索数据"""
    try:
        with managed_source(source_id) as (provider, db):
            # 解析列列表
            search_columns = None
            if columns:
                search_columns = [c.strip() for c in columns.split(',')]
            
            if provider.id == "mongodb":
                # MongoDB 文本搜索
                if search_columns:
                    conditions = [
                        {col: {"$regex": query, "$options": "i"}}
                        for col in search_columns
                    ]
                    filter_value = {"$or": conditions}
                else:
                    filter_value = {"$text": {"$search": query}}
                
                filter_str = json.dumps(filter_value, ensure_ascii=False)
                result = db.execute(
                    f'{mongo_collection_expr(table)}.find({filter_str}).limit({limit})'
                )
                return {
                    "success": True,
                    "results": result if isinstance(result, list) else [],
                    "count": len(result) if isinstance(result, list) else 0
                }
            
            # SQL 数据库
            columns_info = get_table_columns(db, provider, table)
            available_columns = {col["name"] for col in columns_info}
            if search_columns:
                # 在指定列中搜索
                unknown = sorted(set(search_columns) - available_columns)
                if unknown:
                    return {
                        "success": False,
                        "error": f"未知搜索列: {', '.join(unknown)}",
                    }
                text_columns = search_columns
            else:
                # 在所有文本列中搜索
                text_columns = [col['name'] for col in columns_info if _is_text_type(col.get('type', ''))]
                if not text_columns:
                    return {"success": True, "results": [], "count": 0, "message": "没有可搜索的文本列"}

            cast_type = "CHAR" if provider.id == "mysql" else "TEXT"
            conditions = [
                f"CAST({quote_identifier(provider.id, col)} AS {cast_type}) LIKE :search_value"
                for col in text_columns
            ]
            where_clause = " OR ".join(conditions)
            
            sql = (
                f"SELECT * FROM {quote_qualified_identifier(provider.id, table)} "
                f"WHERE {where_clause} LIMIT {limit}"
            )
            result = db.execute(sql, {"search_value": f"%{query}%"})
            
            return {
                "success": True,
                "results": result.get('data', []),
                "columns": result.get('columns', []),
                "count": len(result.get('data', [])),
                "sql": sql
            }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


@router.get("/search/metadata")
async def search_metadata(source_id: int, query: str, object_type: str = None):
    """搜索数据库元数据（表名、列名等）"""
    try:
        with managed_source(source_id) as (provider, db):
            results = []
            schema = db.get_schema()
            
            for table_name, columns in schema.items():
                # 搜索表名
                if query.lower() in table_name.lower():
                    results.append({
                        'type': 'table',
                        'name': table_name,
                        'match_type': 'table_name'
                    })
                
                # 搜索列名
                if isinstance(columns, list):
                    for col in columns:
                        col_name = col if isinstance(col, str) else col.get('name', '')
                        if query.lower() in col_name.lower():
                            results.append({
                                'type': 'column',
                                'table': table_name,
                                'name': col_name,
                                'match_type': 'column_name'
                            })
            
            return {
                "success": True,
                "results": results[:100],  # 限制返回数量
                "count": len(results)
            }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


@router.get("/search/full-text")
async def full_text_search(
    source_id: int,
    query: str,
    tables: str = None,
    limit: int = Query(50, ge=1, le=500),
):
    """全文搜索：在多个表中搜索数据"""
    try:
        with managed_source(source_id) as (provider, db):
            # 获取要搜索的表
            if tables:
                table_list = [t.strip() for t in tables.split(',')]
            else:
                schema = db.get_schema()
                table_list = list(schema.keys())[:10]  # 限制搜索前10个表
            
            all_results = []
            
            for table in table_list:
                try:
                    # 获取表的文本列
                    columns_info = get_table_columns(db, provider, table)
                    text_columns = [col['name'] for col in columns_info if _is_text_type(col.get('type', ''))]
                    
                    if not text_columns:
                        continue
                    
                    # 构建搜索条件
                    cast_type = "CHAR" if provider.id == "mysql" else "TEXT"
                    conditions = [
                        f"CAST({quote_identifier(provider.id, col)} AS {cast_type}) "
                        "LIKE :search_value"
                        for col in text_columns
                    ]
                    
                    where_clause = " OR ".join(conditions)
                    sql = (
                        f"SELECT *, :source_table AS _source_table "
                        f"FROM {quote_qualified_identifier(provider.id, table)} "
                        f"WHERE {where_clause} LIMIT {min(limit, 10)}"
                    )
                    
                    result = db.execute(
                        sql,
                        {"search_value": f"%{query}%", "source_table": table},
                    )
                    if result and 'data' in result:
                        for row in result['data']:
                            all_results.append({
                                'table': table,
                                'data': row if isinstance(row, dict) else dict(zip(result.get('columns', []), row))
                            })
                except Exception as e:
                    logger.warning(f"Search in table {table} failed: {e}")
                    continue
            
            return {
                "success": True,
                "results": all_results[:limit],
                "count": len(all_results),
                "tables_searched": len(table_list)
            }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def _is_text_type(type_str: str) -> bool:
    """判断是否为文本类型"""
    text_types = ['char', 'text', 'varchar', 'clob', 'longtext', 'mediumtext', 'tinytext', 'json', 'jsonb', 'xml']
    return any(t in type_str.lower() for t in text_types)
