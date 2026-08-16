from __future__ import annotations

import logging
import json
from contextlib import contextmanager
from typing import Any, Dict, Generator, Optional, Tuple

from src.common.errors import redact_sensitive
from src.common.sql_identifiers import (
    quote_identifier,
    quote_qualified_identifier,
    split_qualified_identifier,
)
from src.sources.base import DataSourceClient, SourceProvider
from src.services.source_service import resolve_source

logger = logging.getLogger(__name__)


def mongo_collection_expr(collection: str) -> str:
    """Return a Mongo shell collection expression without executable interpolation."""
    if not isinstance(collection, str) or not collection or "\x00" in collection:
        raise ValueError("Collection must be a non-empty string")
    return f"db.getCollection({json.dumps(collection, ensure_ascii=False)})"


@contextmanager
def managed_source(source_id: int) -> Generator[Tuple[SourceProvider, DataSourceClient], None, None]:
    """上下文管理器：自动管理数据库连接的生命周期
    
    使用方式：
        with managed_source(source_id) as (provider, db):
            result = db.execute("SELECT * FROM table")
            return {"success": True, "data": result}
    """
    db = None
    try:
        provider, db = resolve_source(source_id)
        yield provider, db
    except Exception as e:
        raise
    finally:
        if db:
            try:
                db.close()
            except Exception as e:
                logger.warning(f"关闭数据库连接失败: {e}")


def safe_execute(source_id: int, func, *args, **kwargs) -> Dict[str, Any]:
    """安全执行数据库操作的包装函数
    
    使用方式：
        def _get_data(provider, db):
            return db.execute("SELECT * FROM table")
        
        return safe_execute(source_id, _get_data)
    """
    try:
        with managed_source(source_id) as (provider, db):
            result = func(provider, db, *args, **kwargs)
            if isinstance(result, dict) and 'success' in result:
                return result
            return {"success": True, **result} if isinstance(result, dict) else {"success": True, "data": result}
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def get_table_columns(db: DataSourceClient, provider: SourceProvider, table: str) -> list:
    """获取表的列信息（统一接口）
    
    返回格式：
        [
            {"name": "id", "type": "int", "nullable": False, "key": "PRI", "default": None},
            {"name": "name", "type": "varchar(255)", "nullable": True, "key": "", "default": None},
            ...
        ]
    """
    try:
        if provider.id == "mysql":
            result = db.execute(f"SHOW FULL COLUMNS FROM {quote_qualified_identifier(provider.id, table)}")
            if result and 'data' in result:
                columns = []
                for row in result['data']:
                    if len(row) > 5:
                        columns.append({
                            'name': row[0],
                            'type': row[1],
                            'nullable': row[3] == 'YES',
                            'key': row[4],
                            'default': row[5],
                            'comment': row[8] if len(row) > 8 else ''
                        })
                    else:
                        columns.append({
                            'name': row[0],
                            'type': row[1],
                            'nullable': row[2] == 'YES',
                            'key': row[3],
                            'default': row[4],
                            'comment': ''
                        })
                return columns
                
        elif provider.id == "postgresql":
            schema, table_name = split_qualified_identifier(table)
            result = db.execute(f"""
                SELECT c.column_name,
                       c.data_type,
                       c.is_nullable,
                       c.column_default,
                       COALESCE(pgd.description, '') AS comment
                FROM information_schema.columns c
                LEFT JOIN pg_catalog.pg_statio_all_tables st
                  ON st.relname = c.table_name AND st.schemaname = c.table_schema
                LEFT JOIN pg_catalog.pg_description pgd
                  ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
                WHERE c.table_name = :table_name
                  AND (:schema_name IS NULL OR c.table_schema = :schema_name)
                ORDER BY c.ordinal_position
            """, {"table_name": table_name, "schema_name": schema})
            if result and 'data' in result:
                columns = []
                for row in result['data']:
                    columns.append({
                        'name': row[0],
                        'type': row[1],
                        'nullable': row[2] == 'YES',
                        'key': '',
                        'default': row[3],
                        'comment': row[4] if len(row) > 4 else ''
                    })
                return columns
                
        elif provider.id == "sqlite":
            result = db.execute(f"PRAGMA table_info({quote_qualified_identifier(provider.id, table)})")
            if result and 'data' in result:
                columns = []
                for row in result['data']:
                    columns.append({
                        'name': row[1],
                        'type': row[2],
                        'nullable': row[3] == 0,
                        'key': 'PRI' if row[5] else '',
                        'default': row[4],
                        'comment': ''
                    })
                return columns
                
        elif provider.id == "mongodb":
            # MongoDB 采样一个文档获取字段
            result = db.execute(f'{mongo_collection_expr(table)}.findOne()')
            if result:
                columns = []
                for key, value in result.items():
                    columns.append({
                        'name': key,
                        'type': type(value).__name__,
                        'nullable': True,
                        'key': '_id' if key == '_id' else '',
                        'default': None,
                        'comment': ''
                    })
                return columns
                
    except Exception as e:
        logger.warning(f"获取表 {table} 的列信息失败: {e}")
    
    return []


def get_table_indexes(db: DataSourceClient, provider: SourceProvider, table: str) -> list:
    """获取表的索引信息（统一接口）"""
    try:
        if provider.id == "mysql":
            result = db.execute(f"SHOW INDEX FROM {quote_qualified_identifier(provider.id, table)}")
            if result and 'data' in result:
                indexes = []
                for row in result['data']:
                    indexes.append({
                        'name': row[2],
                        'column': row[4],
                        'unique': not row[1],
                        'type': row[10]
                    })
                return indexes
                
        elif provider.id == "postgresql":
            schema, table_name = split_qualified_identifier(table)
            result = db.execute(f"""
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE tablename = :table_name
                  AND (:schema_name IS NULL OR schemaname = :schema_name)
            """, {"table_name": table_name, "schema_name": schema})
            if result and 'data' in result:
                return [{'name': row[0], 'definition': row[1]} for row in result['data']]
                
        elif provider.id == "sqlite":
            result = db.execute(f"PRAGMA index_list({quote_qualified_identifier(provider.id, table)})")
            if result and 'data' in result:
                indexes = []
                for row in result['data']:
                    idx_result = db.execute(
                        f"PRAGMA index_info({quote_identifier(provider.id, row[1])})"
                    )
                    if idx_result and 'data' in idx_result:
                        for idx_row in idx_result['data']:
                            indexes.append({
                                'name': row[1],
                                'column': idx_row[2],
                                'unique': row[2]
                            })
                return indexes
                
    except Exception as e:
        logger.warning(f"获取表 {table} 的索引信息失败: {e}")
    
    return []


def get_primary_key(db: DataSourceClient, provider: SourceProvider, table: str) -> Optional[str | list]:
    """获取表的主键信息"""
    try:
        if provider.id == "mongodb":
            return "_id"
            
        if provider.id == "mysql":
            result = db.execute(
                f"SHOW KEYS FROM {quote_qualified_identifier(provider.id, table)} "
                "WHERE Key_name = 'PRIMARY'"
            )
            if result and 'data' in result and result['data']:
                pk_columns = [row[4] for row in result['data']]
                return pk_columns[0] if len(pk_columns) == 1 else pk_columns
                
        elif provider.id == "postgresql":
            schema, table_name = split_qualified_identifier(table)
            regclass_name = f"{schema}.{table_name}" if schema else table_name
            result = db.execute(f"""
                SELECT a.attname
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = CAST(:regclass_name AS regclass) AND i.indisprimary
            """, {"regclass_name": regclass_name})
            if result and 'data' in result and result['data']:
                pk_columns = [row[0] for row in result['data']]
                return pk_columns[0] if len(pk_columns) == 1 else pk_columns
                
        elif provider.id == "sqlite":
            result = db.execute(f"PRAGMA table_info({quote_qualified_identifier(provider.id, table)})")
            if result and 'data' in result:
                for row in result['data']:
                    if row[5]:  # pk column
                        return row[1]
                        
    except Exception as e:
        logger.warning(f"获取表 {table} 的主键信息失败: {e}")
    
    return None
