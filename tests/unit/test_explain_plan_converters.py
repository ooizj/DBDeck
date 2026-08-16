"""EXPLAIN 执行计划树形转换器的健壮性回归测试。

背景：data/rows 键名修复后，/explain/visualize 首次真正调用 plan 转换器。
转换器原本用链式 .get('query_block', {}).get('table', {}).get(...) 假设
EXPLAIN JSON 只有单一形状，但真实结构因 join / ordering_operation / 子查询等
而异，某些字段可能是 int/list，导致 "'int' object has no attribute 'get'"。
这些测试钉死：转换器对各种畸形/非预期结构都不应抛 AttributeError。
"""
from src.services.explain_service import _convert_mysql_plan_to_tree, _convert_pg_plan_to_tree


def test_mysql_converter_handles_int_where_dict_expected():
    # query_block/table/cost_info 任一本应是 dict 的字段若为 int，不得崩溃
    plan = {"query_block": {"table": 123, "cost_info": 456}}
    tree = _convert_mysql_plan_to_tree(plan)
    assert tree["operation"] == "Unknown"
    assert tree["cost"] == 0
    assert tree["children"] == []


def test_mysql_converter_handles_normal_plan():
    plan = {
        "query_block": {
            "select_id": 1,
            "table": {
                "table_name": "users",
                "access_type": "ALL",
                "rows_examined_per_scan": 100,
                "filtered": 100,
                "cost_info": {"read_cost": 10.5},
            },
        }
    }
    tree = _convert_mysql_plan_to_tree(plan)
    assert tree["table"] == "users"
    assert tree["operation"] == "ALL"
    assert tree["rows"] == 100
    assert tree["cost"] == 10.5


def test_mysql_converter_type_is_always_string():
    # 前端 getOperationIcon(type) 会调用 type.toLowerCase()，type 必须是字符串。
    # 历史 bug：曾用 select_id(整数) 当 type，导致前端 "type.toLowerCase is not a function"。
    plan = {"query_block": {"select_id": 1, "table": {"table_name": "u", "access_type": "ref"}}}
    tree = _convert_mysql_plan_to_tree(plan)
    assert isinstance(tree["type"], str)
    assert tree["type"] == "ref"
    # 无 table（仅 query_block）时也必须是字符串
    tree2 = _convert_mysql_plan_to_tree({"query_block": {"select_id": 2}})
    assert isinstance(tree2["type"], str)


def test_mysql_converter_handles_nested_loop_with_non_dict_items():
    # nested_loop 里混入非 dict 元素，不得崩溃
    plan = {"query_block": {"nested_loop": [{"table": {"table_name": "t1"}}, 99, None]}}
    tree = _convert_mysql_plan_to_tree(plan)
    # 只有第一个 dict 元素被解析为子节点
    assert len(tree["children"]) == 1
    assert tree["children"][0]["table"] == "t1"


def test_mysql_converter_handles_non_dict_root():
    assert _convert_mysql_plan_to_tree(123)["children"] == []
    assert _convert_mysql_plan_to_tree(None)["children"] == []
    assert _convert_mysql_plan_to_tree("not a plan")["children"] == []


def test_pg_converter_handles_int_fields():
    plan = {"Node Type": "Seq Scan", "Plans": 42}  # Plans 本应是 list，这里给 int
    tree = _convert_pg_plan_to_tree(plan)
    assert tree["type"] == "Seq Scan"
    assert tree["children"] == []


def test_pg_converter_handles_nested_plans():
    plan = {
        "Node Type": "Nested Loop",
        "Startup Cost": 0.0,
        "Total Cost": 10.0,
        "Plans": [
            {"Node Type": "Seq Scan", "Relation Name": "a"},
            {"Node Type": "Index Scan", "Relation Name": "b"},
        ],
    }
    tree = _convert_pg_plan_to_tree(plan)
    assert tree["type"] == "Nested Loop"
    assert len(tree["children"]) == 2
    assert tree["children"][0]["relation"] == "a"
