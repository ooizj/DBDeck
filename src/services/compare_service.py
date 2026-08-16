"""表/数据对比业务逻辑（从 compare_routes 下沉而来）。

路由层只做 HTTP 编排；本模块负责结构对比、数据对比、跨库对比。
连接生命周期由 managed_source 管理。
"""
from __future__ import annotations

import logging
import re

from src.common.db_utils import (
    get_table_columns,
    get_table_indexes,
    managed_source,
    quote_qualified_identifier,
)
from src.common.errors import redact_sensitive

logger = logging.getLogger(__name__)


def compare_table_structure(source_id: int, table1: str, table2: str) -> dict:
    """比较两个表的结构差异。"""
    try:
        with managed_source(source_id) as (provider, db):
            columns1 = get_table_columns(db, provider, table1)
            columns2 = get_table_columns(db, provider, table2)

            if not columns1 or not columns2:
                return {"success": False, "error": "无法获取表结构"}

            cols1_dict = {col['name']: col for col in columns1}
            cols2_dict = {col['name']: col for col in columns2}

            only_in_table1 = []
            only_in_table2 = []
            different = []
            identical = []

            for col_name, col1 in cols1_dict.items():
                if col_name not in cols2_dict:
                    only_in_table1.append(col1)
                else:
                    col2 = cols2_dict[col_name]
                    if _columns_different(col1, col2):
                        different.append({
                            'name': col_name,
                            'table1': col1,
                            'table2': col2,
                            'differences': _get_column_differences(col1, col2)
                        })
                    else:
                        identical.append(col1)

            for col_name in cols2_dict:
                if col_name not in cols1_dict:
                    only_in_table2.append(cols2_dict[col_name])

            indexes1 = get_table_indexes(db, provider, table1)
            indexes2 = get_table_indexes(db, provider, table2)

            return {
                "success": True,
                "provider": provider.id,
                "table1": table1,
                "table2": table2,
                "columns": {
                    "only_in_table1": only_in_table1,
                    "only_in_table2": only_in_table2,
                    "different": different,
                    "identical": identical
                },
                "indexes": {
                    "table1": indexes1,
                    "table2": indexes2
                },
                "summary": {
                    "total_columns_table1": len(columns1),
                    "total_columns_table2": len(columns2),
                    "identical_count": len(identical),
                    "different_count": len(different),
                    "only_in_table1_count": len(only_in_table1),
                    "only_in_table2_count": len(only_in_table2)
                }
            }

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def compare_table_data(source_id: int, table1: str, table2: str, key_column: str, limit: int = 1000) -> dict:
    """比较两个表的数据差异。"""
    try:
        with managed_source(source_id) as (provider, db):
            safe_limit = max(1, min(int(limit), 10_000))
            query1 = (
                f"SELECT * FROM {quote_qualified_identifier(provider.id, table1)} "
                f"LIMIT {safe_limit}"
            )
            query2 = (
                f"SELECT * FROM {quote_qualified_identifier(provider.id, table2)} "
                f"LIMIT {safe_limit}"
            )

            result1 = db.execute(query1)
            result2 = db.execute(query2)

            if not result1 or not result2:
                return {"success": False, "error": "无法获取表数据"}

            columns1 = result1.get('columns', [])
            columns2 = result2.get('columns', [])
            rows1 = result1.get('data', [])
            rows2 = result2.get('data', [])

            data1_dict = {}
            data2_dict = {}

            key_idx1 = columns1.index(key_column) if key_column in columns1 else -1
            key_idx2 = columns2.index(key_column) if key_column in columns2 else -1

            if key_idx1 == -1 or key_idx2 == -1:
                return {"success": False, "error": f"找不到主键列: {key_column}"}

            for row in rows1:
                key = row[key_idx1]
                data1_dict[key] = row

            for row in rows2:
                key = row[key_idx2]
                data2_dict[key] = row

            only_in_table1 = []
            only_in_table2 = []
            different = []
            identical = []

            for key, row1 in data1_dict.items():
                if key not in data2_dict:
                    only_in_table1.append(dict(zip(columns1, row1)))
                else:
                    row2 = data2_dict[key]
                    if list(row1) != list(row2):
                        diff_rows = []
                        for i, (v1, v2) in enumerate(zip(row1, row2)):
                            if v1 != v2:
                                diff_rows.append({
                                    'column': columns1[i] if i < len(columns1) else f'col_{i}',
                                    'table1_value': v1,
                                    'table2_value': v2
                                })
                        different.append({
                            'key': key,
                            'differences': diff_rows
                        })
                    else:
                        identical.append(dict(zip(columns1, row1)))

            for key in data2_dict:
                if key not in data1_dict:
                    only_in_table2.append(dict(zip(columns2, data2_dict[key])))

            return {
                "success": True,
                "provider": provider.id,
                "table1": table1,
                "table2": table2,
                "key_column": key_column,
                "data": {
                    "only_in_table1": only_in_table1[:100],
                    "only_in_table2": only_in_table2[:100],
                    "different": different[:100],
                    "identical_count": len(identical)
                },
                "summary": {
                    "total_rows_table1": len(rows1),
                    "total_rows_table2": len(rows2),
                    "identical_count": len(identical),
                    "different_count": len(different),
                    "only_in_table1_count": len(only_in_table1),
                    "only_in_table2_count": len(only_in_table2)
                }
            }

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def compare_cross_database(source_id1: int, table1: str, source_id2: int, table2: str) -> dict:
    """跨数据库比较表结构。"""
    try:
        with managed_source(source_id1) as (provider1, db1):
            with managed_source(source_id2) as (provider2, db2):
                columns1 = get_table_columns(db1, provider1, table1)
                columns2 = get_table_columns(db2, provider2, table2)

                if not columns1 or not columns2:
                    return {"success": False, "error": "无法获取表结构"}

                cols1_dict = {col['name']: col for col in columns1}
                cols2_dict = {col['name']: col for col in columns2}

                only_in_table1 = []
                only_in_table2 = []
                different = []
                identical = []

                for col_name, col1 in cols1_dict.items():
                    if col_name not in cols2_dict:
                        only_in_table1.append(col1)
                    else:
                        col2 = cols2_dict[col_name]
                        if _columns_different(col1, col2):
                            different.append({
                                'name': col_name,
                                'table1': col1,
                                'table2': col2,
                                'differences': _get_column_differences(col1, col2),
                                'compatible': _types_compatible(
                                    col1.get('type', '').lower(),
                                    col2.get('type', '').lower(),
                                )
                            })
                        else:
                            identical.append(col1)

                for col_name in cols2_dict:
                    if col_name not in cols1_dict:
                        only_in_table2.append(cols2_dict[col_name])

                return {
                    "success": True,
                    "source1": {"id": source_id1, "provider": provider1.id, "table": table1},
                    "source2": {"id": source_id2, "provider": provider2.id, "table": table2},
                    "columns": {
                        "only_in_table1": only_in_table1,
                        "only_in_table2": only_in_table2,
                        "different": different,
                        "identical": identical
                    },
                    "summary": {
                        "total_columns_table1": len(columns1),
                        "total_columns_table2": len(columns2),
                        "identical_count": len(identical),
                        "different_count": len(different),
                        "only_in_table1_count": len(only_in_table1),
                        "only_in_table2_count": len(only_in_table2)
                    }
                }

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def _columns_different(col1: dict, col2: dict) -> bool:
    """判断两个列是否不同"""
    type1 = col1.get('type', '').lower()
    type2 = col2.get('type', '').lower()
    nullable1 = col1.get('nullable', True)
    nullable2 = col2.get('nullable', True)
    comment1 = (col1.get('comment') or '').strip()
    comment2 = (col2.get('comment') or '').strip()
    return type1 != type2 or nullable1 != nullable2 or comment1 != comment2


def _get_column_differences(col1: dict, col2: dict) -> list:
    """获取列的差异详情"""
    differences = []

    type1 = col1.get('type', '').lower()
    type2 = col2.get('type', '').lower()
    if type1 != type2:
        differences.append({'property': 'type', 'table1': type1, 'table2': type2})

    nullable1 = col1.get('nullable', True)
    nullable2 = col2.get('nullable', True)
    if nullable1 != nullable2:
        differences.append({'property': 'nullable', 'table1': nullable1, 'table2': nullable2})

    comment1 = (col1.get('comment') or '').strip()
    comment2 = (col2.get('comment') or '').strip()
    if comment1 != comment2:
        differences.append({'property': 'comment', 'table1': comment1, 'table2': comment2})

    return differences


def _types_compatible(type1: str, type2: str) -> bool:
    """判断两个类型是否兼容"""
    t1 = re.sub(r'\(.*\)', '', type1).strip()
    t2 = re.sub(r'\(.*\)', '', type2).strip()

    type_aliases = {
        'int': ['integer', 'int4', 'int8', 'int2', 'serial', 'bigserial', 'smallint', 'bigint'],
        'varchar': ['character varying', 'nvarchar'],
        'char': ['character', 'nchar'],
        'text': ['longtext', 'mediumtext', 'tinytext', 'clob'],
        'float': ['float4', 'float8', 'real', 'double precision', 'double'],
        'decimal': ['numeric', 'number'],
        'bool': ['boolean'],
        'timestamp': ['datetime', 'timestamp without time zone', 'timestamp with time zone'],
        'blob': ['bytea', 'longblob', 'mediumblob', 'tinyblob', 'binary', 'varbinary']
    }

    if t1 == t2:
        return True

    for base_type, aliases in type_aliases.items():
        all_types = [base_type] + aliases
        if t1 in all_types and t2 in all_types:
            return True

    return False
