"""执行计划（EXPLAIN）业务逻辑（从 explain_routes 下沉而来）。

路由层只做 HTTP 编排；本模块负责按 provider 方言获取执行计划并转换为树形/表格结构。
连接生命周期由 managed_source 管理。
"""
from __future__ import annotations

import logging

from src.common.db_utils import managed_source
from src.common.errors import redact_sensitive

logger = logging.getLogger(__name__)


def visualize_execution_plan(source_id: int, query: str) -> dict:
    """获取可视化的执行计划（树形结构）。"""
    try:
        with managed_source(source_id) as (provider, db):
            if provider.id == "mysql":
                explain_query = f"EXPLAIN FORMAT=JSON {query}"
                result = db.execute(explain_query)

                if result and 'data' in result and result['data']:
                    import json
                    plan_json = result['data'][0][0]
                    plan = json.loads(plan_json) if isinstance(plan_json, str) else plan_json
                    tree = _convert_mysql_plan_to_tree(plan)
                    return {
                        "success": True,
                        "provider": "mysql",
                        "tree": tree,
                        "raw": plan,
                        "query": query
                    }

                # 回退到文本格式
                explain_query = f"EXPLAIN {query}"
                result = db.execute(explain_query)
                return {
                    "success": True,
                    "provider": "mysql",
                    "columns": result.get('columns', []),
                    "rows": result.get('data', []),
                    "query": query,
                    "format": "table"
                }

            elif provider.id == "postgresql":
                explain_query = f"EXPLAIN (FORMAT JSON) {query}"
                result = db.execute(explain_query)

                if result and 'data' in result and result['data']:
                    plan = result['data'][0][0]
                    if isinstance(plan, list) and plan:
                        plan = plan[0]
                    tree = _convert_pg_plan_to_tree(plan.get('Plan', {}))
                    return {
                        "success": True,
                        "provider": "postgresql",
                        "tree": tree,
                        "raw": plan,
                        "query": query,
                        "planning_time": plan.get('Planning Time'),
                        "execution_time": plan.get('Execution Time')
                    }

                return {"success": False, "error": "无法获取执行计划"}

            elif provider.id == "sqlite":
                explain_query = f"EXPLAIN QUERY PLAN {query}"
                result = db.execute(explain_query)

                nodes = []
                if result and 'data' in result:
                    for row in result['data']:
                        nodes.append({
                            'id': row[0],
                            'parent': row[1],
                            'detail': row[3] if len(row) > 3 else '',
                            'selectid': row[0],
                            'order': row[1],
                            'from': row[2] if len(row) > 2 else ''
                        })

                return {"success": True, "provider": "sqlite", "nodes": nodes, "query": query}

            return {"success": False, "error": f"不支持的数据库类型: {provider.id}"}

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def _as_dict(obj) -> dict:
    """只把 dict 视为可继续取值；其余（int/list/str/None）一律降级为空 dict。

    EXPLAIN 的 JSON 结构因数据库版本与语句而异（join / ordering_operation /
    子查询等），某些字段可能是非 dict。链式 .get 在遇到非 dict 中间值时会抛
    "'int' object has no attribute 'get'"，这里统一兜底，保证解析不会崩溃。
    """
    return obj if isinstance(obj, dict) else {}


def _convert_mysql_plan_to_tree(plan: dict) -> dict:
    """将MySQL JSON执行计划转换为树形结构"""
    def build_node(item: dict) -> dict:
        item = _as_dict(item)
        qb = _as_dict(item.get('query_block'))
        table = _as_dict(qb.get('table'))
        cost_info = _as_dict(table.get('cost_info'))
        # type 用于前端展示与图标推断，必须是字符串。MySQL 这里取访问类型
        # (ALL/ref/index/const...)；无表时退回 query_block 标签。
        # 注意：不能用 select_id（整数），否则前端 type.toLowerCase() 会崩。
        access_type = table.get('access_type')
        node = {
            'id': item.get('id', 0),
            'type': str(access_type) if access_type else 'query_block',
            'operation': access_type or 'Unknown',
            'table': table.get('table_name', ''),
            'cost': cost_info.get('read_cost', 0),
            'rows': table.get('rows_examined_per_scan', 0),
            'filtered': table.get('filtered', 100),
            'children': []
        }

        nested = qb.get('nested_loop', [])
        if isinstance(nested, list):
            for loop_item in nested:
                if isinstance(loop_item, dict):
                    child = build_node({'query_block': loop_item})
                    node['children'].append(child)

        return node

    return build_node(_as_dict(plan))


def _convert_pg_plan_to_tree(plan: dict) -> dict:
    """将PostgreSQL执行计划转换为树形结构"""
    def build_node(item: dict) -> dict:
        item = _as_dict(item)
        node = {
            'type': item.get('Node Type', 'Unknown'),
            'startup_cost': item.get('Startup Cost', 0),
            'total_cost': item.get('Total Cost', 0),
            'rows': item.get('Plan Rows', 0),
            'width': item.get('Plan Width', 0),
            'actual_rows': item.get('Actual Rows'),
            'actual_time': item.get('Actual Total Time'),
            'loops': item.get('Actual Loops', 1),
            'relation': item.get('Relation Name', ''),
            'alias': item.get('Alias', ''),
            'index': item.get('Index Name', ''),
            'children': []
        }

        plans = item.get('Plans', [])
        if isinstance(plans, list):
            for child_plan in plans:
                node['children'].append(build_node(child_plan))

        return node

    return build_node(_as_dict(plan))
