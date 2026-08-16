from __future__ import annotations

import csv
import io
import json
import logging
from typing import Any, Dict, List, Optional

from src.common.db_utils import (
    get_primary_key as inspect_primary_key,
    get_table_columns as inspect_table_columns,
    mongo_collection_expr,
    quote_identifier,
    quote_qualified_identifier,
)
from src.common.errors import redact_sensitive
from src.services.source_service import resolve_source

logger = logging.getLogger(__name__)

try:
    from bson import ObjectId
except ImportError:
    ObjectId = None


def _param_name(prefix: str, index: int) -> str:
    return f"{prefix}_{index}"


def _sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _terminate_sql_statement(statement: str) -> str:
    statement = statement.rstrip()
    return statement if statement.endswith(";") else statement + ";"


def _normalize_mongo_filter(where: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    normalized = dict(where or {})
    if ObjectId and isinstance(normalized.get("_id"), str) and ObjectId.is_valid(normalized["_id"]):
        normalized["_id"] = ObjectId(normalized["_id"])
    return normalized


def edit_row(source_id: int, table: str, operation: str, data: Dict[str, Any], where: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """执行单行数据编辑操作"""
    db = None
    try:
        provider, db = resolve_source(source_id)

        if provider.id == "mongodb":
            return _edit_mongo_row(db, table, operation, data, where)

        if provider.id not in ("mysql", "postgresql", "sqlite"):
            return {"success": False, "error": f"不支持的数据库类型: {provider.id}"}

        quoted_table = quote_qualified_identifier(provider.id, table)
        params: Dict[str, Any] = {}
        
        # SQL 数据库
        if operation == "insert":
            if not data:
                return {"success": False, "error": "INSERT 操作需要数据"}
            column_sql = []
            placeholder_sql = []
            for idx, (key, value) in enumerate(data.items()):
                name = _param_name("v", idx)
                column_sql.append(quote_identifier(provider.id, key))
                placeholder_sql.append(f":{name}")
                params[name] = value
            query = f"INSERT INTO {quoted_table} ({', '.join(column_sql)}) VALUES ({', '.join(placeholder_sql)})"
            
        elif operation == "update":
            if not where:
                return {"success": False, "error": "UPDATE 操作需要 WHERE 条件"}
            if not data:
                return {"success": False, "error": "UPDATE 操作需要数据"}
            set_parts = []
            where_parts = []
            for idx, (key, value) in enumerate(data.items()):
                name = _param_name("v", idx)
                set_parts.append(f"{quote_identifier(provider.id, key)} = :{name}")
                params[name] = value
            for idx, (key, value) in enumerate(where.items()):
                name = _param_name("w", idx)
                where_parts.append(f"{quote_identifier(provider.id, key)} = :{name}")
                params[name] = value
            query = f"UPDATE {quoted_table} SET {', '.join(set_parts)} WHERE {' AND '.join(where_parts)}"
            
        elif operation == "delete":
            if not where:
                return {"success": False, "error": "DELETE 操作需要 WHERE 条件"}
            where_parts = []
            for idx, (key, value) in enumerate(where.items()):
                name = _param_name("w", idx)
                where_parts.append(f"{quote_identifier(provider.id, key)} = :{name}")
                params[name] = value
            query = f"DELETE FROM {quoted_table} WHERE {' AND '.join(where_parts)}"
            
        else:
            return {"success": False, "error": f"不支持的操作: {operation}"}

        result = db.execute(query, params)
        if result.get("success") is False:
            return {"success": False, "error": result.get("error_msg") or result.get("error") or "操作失败"}
        return {"success": True, "affected_rows": result.get('affected_rows', 1)}
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def _edit_mongo_row(db, collection: str, operation: str, data: Dict[str, Any], where: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """MongoDB 数据编辑"""
    try:
        where = _normalize_mongo_filter(where)
        mongo_collection = db.db[collection]
        if operation == "insert":
            result = mongo_collection.insert_one(data)
            return {"success": True, "inserted_id": str(result.inserted_id)}
            
        elif operation == "update":
            if not where:
                return {"success": False, "error": "UPDATE 操作需要过滤条件"}
            result = mongo_collection.update_one(where, {"$set": data})
            return {"success": True, "matched_count": result.matched_count, "modified_count": result.modified_count}
            
        elif operation == "delete":
            if not where:
                return {"success": False, "error": "DELETE 操作需要过滤条件"}
            result = mongo_collection.delete_one(where)
            return {"success": True, "deleted_count": result.deleted_count}
            
        return {"success": False, "error": f"不支持的操作: {operation}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def export_data(
    source_id: int,
    table: str,
    format: str = 'csv',
    where: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """导出数据为指定格式"""
    db = None
    try:
        provider, db = resolve_source(source_id)
        
        # 构建查询
        if provider.id == "mongodb":
            filter_value = where or {}
            query = (
                f'{mongo_collection_expr(table)}.find('
                f'{json.dumps(filter_value, ensure_ascii=False)})'
            )
            if limit is not None:
                query += f'.limit({max(1, min(int(limit), 100_000))})'
            params = None
        else:
            quoted_table = quote_qualified_identifier(provider.id, table)
            query = f"SELECT * FROM {quoted_table}"
            params = {}
            if where:
                predicates = []
                for index, (column, value) in enumerate(where.items()):
                    name = _param_name("filter", index)
                    predicates.append(f"{quote_identifier(provider.id, column)} = :{name}")
                    params[name] = value
                query += " WHERE " + " AND ".join(predicates)
            if limit is not None:
                query += f" LIMIT {max(1, min(int(limit), 100_000))}"
        
        result = db.execute(query, params) if params is not None else db.execute(query)
        
        if not result:
            return {"success": False, "error": "查询无结果"}
        
        # 获取数据
        if provider.id == "mongodb":
            data = result if isinstance(result, list) else []
            columns = list(data[0].keys()) if data else []
        else:
            columns = result.get('columns', [])
            data = result.get('data', [])
        
        # 根据格式导出
        if format == 'csv':
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(columns)
            for row in data:
                writer.writerow([row.get(col, '') if isinstance(row, dict) else row[i] for i, col in enumerate(columns)])
            content = output.getvalue()
            
        elif format == 'json':
            if isinstance(data, list) and data and isinstance(data[0], dict):
                content = json.dumps(data, ensure_ascii=False, indent=2, default=str)
            else:
                records = []
                for row in data:
                    if isinstance(row, dict):
                        records.append(row)
                    else:
                        records.append({col: row[i] for i, col in enumerate(columns)})
                content = json.dumps(records, ensure_ascii=False, indent=2, default=str)
                
        elif format == 'sql':
            lines = []
            for row in data:
                if isinstance(row, dict):
                    values = [_sql_literal(row.get(column)) for column in columns]
                else:
                    values = [_sql_literal(v) for v in row]
                quoted_columns = ", ".join(
                    quote_identifier(provider.id, column) for column in columns
                )
                lines.append(
                    f"INSERT INTO {quote_qualified_identifier(provider.id, table)} "
                    f"({quoted_columns}) VALUES ({', '.join(values)});"
                )
            content = '\n'.join(lines)
            
        elif format == 'markdown':
            lines = []
            lines.append('| ' + ' | '.join(columns) + ' |')
            lines.append('| ' + ' | '.join(['---'] * len(columns)) + ' |')
            for row in data:
                if isinstance(row, dict):
                    values = [str(row.get(col, '')) for col in columns]
                else:
                    values = [str(v) for v in row]
                lines.append('| ' + ' | '.join(values) + ' |')
            content = '\n'.join(lines)
            
        else:
            return {"success": False, "error": f"不支持的格式: {format}"}
        
        return {
            "success": True,
            "content": content,
            "format": format,
            "row_count": len(data),
            "columns": columns
        }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def backup_database(source_id: int, tables: Optional[List[str]] = None, include_structure: bool = True, include_data: bool = True) -> Dict[str, Any]:
    """备份数据库"""
    db = None
    try:
        provider, db = resolve_source(source_id)

        if not getattr(provider.capabilities, "supports_backup", False):
            return {
                "success": False,
                "error": f"{provider.id} 暂不支持可恢复备份",
            }

        if not include_structure and not include_data:
            return {"success": False, "error": "请至少选择表结构或数据中的一项"}
        
        if not tables:
            schema = db.get_schema()
            tables = list(schema.keys())
        
        backup_sql = []
        
        for table in tables:
            quoted_table = quote_qualified_identifier(provider.id, table)
            if include_structure:
                # 获取建表语句
                get_ddl = getattr(db, "get_ddl", None)
                if callable(get_ddl):
                    ddl = get_ddl(table)
                    if ddl:
                        backup_sql.append(f"-- 表结构: {table}")
                        backup_sql.append(_terminate_sql_statement(ddl))
                        backup_sql.append("")
            
            if include_data:
                # 获取数据
                result = db.execute(f"SELECT * FROM {quoted_table}")
                if result and result.get("success") is False:
                    return {
                        "success": False,
                        "error": result.get("error_msg") or result.get("error") or f"读取表 {table} 失败",
                    }
                if result and 'data' in result:
                    columns = result.get('columns', [])
                    backup_sql.append(f"-- 数据: {table}")
                    for row in result['data']:
                        values = [
                            _sql_literal(row.get(column)) for column in columns
                        ] if isinstance(row, dict) else [_sql_literal(v) for v in row]
                        quoted_columns = ", ".join(
                            quote_identifier(provider.id, column) for column in columns
                        )
                        backup_sql.append(
                            f"INSERT INTO {quoted_table} ({quoted_columns}) "
                            f"VALUES ({', '.join(values)});"
                        )
                    backup_sql.append("")
        
        content = '\n'.join(backup_sql)
        
        return {
            "success": True,
            "content": content,
            "tables": tables,
            "size": len(content.encode("utf-8")),
        }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def get_columns(source_id: int, table: str) -> Dict[str, Any]:
    """获取表的列信息"""
    db = None
    try:
        provider, db = resolve_source(source_id)
        return {
            "success": True,
            "columns": inspect_table_columns(db, provider, table),
        }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()


def get_primary_key(source_id: int, table: str) -> Dict[str, Any]:
    """获取表的主键信息"""
    db = None
    try:
        provider, db = resolve_source(source_id)
        return {
            "success": True,
            "primary_key": inspect_primary_key(db, provider, table),
        }
        
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
    finally:
        if db:
            db.close()
