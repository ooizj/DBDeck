"""执行计划转换与安全性的回归测试。"""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from src.services import explain_service
from src.services.explain_service import (
    ExplainError,
    convert_pg_plan,
    convert_sqlite_plan,
    single_statement,
)


class _RecordingDb:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append(sql)
        return self.results.pop(0)


def _patch_source(monkeypatch, provider_id, db):
    provider = SimpleNamespace(id=provider_id, display_name=provider_id)

    @contextmanager
    def managed_source(_source_id):
        yield provider, db

    monkeypatch.setattr(explain_service, "managed_source", managed_source)


def test_single_statement_strips_trailing_semicolon():
    assert single_statement("  SELECT * FROM t;  ", "mysql") == "SELECT * FROM t"


def test_single_statement_rejects_multiple_statements():
    with pytest.raises(ExplainError):
        single_statement("SELECT 1; DROP TABLE audit", "mysql")


def test_multiple_statements_are_never_sent_to_database(monkeypatch):
    db = _RecordingDb([])
    _patch_source(monkeypatch, "mysql", db)

    result = explain_service.visualize_execution_plan(1, "SELECT 1; DROP TABLE audit;")

    assert result["success"] is False
    assert db.calls == []


def test_mysql_error_is_reported_instead_of_empty_plan(monkeypatch):
    db = _RecordingDb([{"success": False, "error": "Table 'shop.nope' doesn't exist"}])
    _patch_source(monkeypatch, "mysql", db)

    result = explain_service.visualize_execution_plan(1, "SELECT * FROM nope")

    assert result == {"success": False, "error": "Table 'shop.nope' doesn't exist"}


def test_mysql_returns_tabular_explain_and_raw_json(monkeypatch):
    columns = ["id", "select_type", "table", "partitions", "type", "possible_keys",
               "key", "key_len", "ref", "rows", "filtered", "Extra"]
    row = [1, "SIMPLE", "orders", None, "ALL", None, None, None, None, 120, 33.33, "Using where"]
    db = _RecordingDb([
        {"success": True, "columns": columns, "data": [row]},
        {"success": True, "columns": ["EXPLAIN"], "data": [['{"query_block": {"select_id": 1}}']]},
    ])
    _patch_source(monkeypatch, "mysql", db)

    result = explain_service.visualize_execution_plan(1, "SELECT * FROM orders WHERE amount > 10;")

    assert db.calls == [
        "EXPLAIN SELECT * FROM orders WHERE amount > 10",
        "EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE amount > 10",
    ]
    assert result["success"] is True
    assert result["tree"] is None
    assert result["table"] == {"columns": columns, "rows": [row]}
    assert result["raw"] == {"query_block": {"select_id": 1}}


def test_postgresql_plan_keeps_every_level_of_nesting(monkeypatch):
    plan = [{
        "Plan": {
            "Node Type": "Hash Join", "Join Type": "Inner", "Startup Cost": 1.5, "Total Cost": 40.2,
            "Plan Rows": 10, "Plan Width": 8, "Hash Cond": "(o.customer_id = c.id)",
            "Plans": [
                {"Node Type": "Seq Scan", "Relation Name": "orders", "Alias": "o",
                 "Startup Cost": 0, "Total Cost": 20, "Plan Rows": 100, "Plan Width": 8},
                {"Node Type": "Hash", "Startup Cost": 1, "Total Cost": 1, "Plan Rows": 5, "Plan Width": 4,
                 "Plans": [{"Node Type": "Index Scan", "Relation Name": "customers", "Alias": "customers",
                            "Index Name": "customers_pkey", "Startup Cost": 0, "Total Cost": 1,
                            "Plan Rows": 5, "Plan Width": 4}]},
            ],
        },
        "Planning Time": 0.12,
    }]
    db = _RecordingDb([{"success": True, "columns": ["QUERY PLAN"], "data": [[plan]]}])
    _patch_source(monkeypatch, "postgresql", db)

    result = explain_service.visualize_execution_plan(1, "SELECT 1")

    tree = result["tree"]
    assert tree["label"] == "Hash Join"
    assert {"key": "Hash Cond", "value": "(o.customer_id = c.id)"} in tree["metrics"]
    assert tree["children"][0]["detail"] == "orders o"
    index_scan = tree["children"][1]["children"][0]
    assert index_scan["label"] == "Index Scan"
    assert index_scan["detail"] == "索引 customers_pkey customers"
    assert [row[0].strip() for row in result["table"]["rows"]] == ["Hash Join", "Seq Scan", "Hash", "Index Scan"]
    assert result["planning_time"] == 0.12


def test_pg_plan_accepts_json_text():
    tree = convert_pg_plan({"Node Type": "Result", "Plans": "not-a-list"})
    assert tree["label"] == "Result"
    assert tree["children"] == []


def test_sqlite_plan_is_nested_by_parent_id():
    rows = [
        [2, 0, 0, "SCAN o"],
        [5, 0, 0, "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"],
        [9, 0, 0, "USE TEMP B-TREE FOR ORDER BY"],
        [12, 5, 0, "CORRELATED SCALAR SUBQUERY 1"],
    ]
    tree = convert_sqlite_plan(rows)

    assert [child["label"] for child in tree["children"]] == [
        "SCAN o",
        "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)",
        "USE TEMP B-TREE FOR ORDER BY",
    ]
    assert tree["children"][1]["children"][0]["label"] == "CORRELATED SCALAR SUBQUERY 1"


def test_unsupported_provider_is_rejected(monkeypatch):
    _patch_source(monkeypatch, "redis", _RecordingDb([]))
    result = explain_service.visualize_execution_plan(1, "GET key")
    assert result["success"] is False
