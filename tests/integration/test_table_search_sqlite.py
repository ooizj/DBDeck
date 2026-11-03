from contextlib import contextmanager

import pytest

from src.services import table_search_service
from src.sources.registry import get_provider
from src.sources.sqlite.client import SQLiteClient


@pytest.fixture
def sqlite_source(tmp_path, monkeypatch):
    client = SQLiteClient({"database": str(tmp_path / "search.db")})
    setup = client.execute(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT, amount DECIMAL(10,2), created_at DATETIME, note VARCHAR(50));"
        "INSERT INTO orders VALUES (1, 'apple pie', 12.5, '2024-01-15 10:30:00', 'paid 2024/01/15');"
        "INSERT INTO orders VALUES (2, 'banana', 8, '2024-02-01T09:00:00', NULL);"
        "INSERT INTO orders VALUES (3, '50% off', 2024, '2023-12-31 23:59:59', '20240115');"
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, birthday DATE);"
        "INSERT INTO users VALUES (1, 'Apple Lee', '2024-01-15');"
        "CREATE VIEW v_orders AS SELECT * FROM orders;"
    )
    assert setup["success"], setup

    @contextmanager
    def fake_managed_source(source_id):
        yield get_provider("sqlite"), client

    monkeypatch.setattr(table_search_service, "managed_source", fake_managed_source)
    yield client
    client.close()


def search_all(**kwargs):
    plan = table_search_service.plan_search(1, **kwargs)
    assert plan["success"], plan
    results = {}
    for target in plan["targets"]:
        result = table_search_service.search_table(1, target["database"], target["table"], **kwargs)
        assert result["success"], result
        results[target["table"]] = result
    return plan, results


def test_plan_skips_views_and_filters_columns(sqlite_source):
    plan = table_search_service.plan_search(1, keyword="apple", column_name="name")
    assert plan["table_count"] == 2  # orders, users; view excluded
    assert [(t["database"], t["table"], [c["name"] for c in t["columns"]]) for t in plan["targets"]] == [
        ("main", "users", ["name"]),
    ]


def test_table_include_exclude(sqlite_source):
    tables = lambda **kw: [t["table"] for t in table_search_service.list_tables(1, **kw)["tables"]]
    assert tables() == ["orders", "users"]
    assert tables(table_include="ORD") == ["orders"]
    assert tables(table_include="u*") == ["users"]
    assert tables(table_include="main.orders, users", table_exclude="user") == ["orders"]


def test_string_search_is_case_insensitive_and_reports_matched_columns(sqlite_source):
    _, results = search_all(keyword="APPLE", column_types=["string"])
    assert [row[0] for row in results["orders"]["rows"]] == [1]
    assert results["orders"]["matched"] == [["title"]]
    assert results["users"]["rows"] == [[1, "Apple Lee", "2024-01-15"]]


def test_like_wildcards_in_keyword_are_literal(sqlite_source):
    _, results = search_all(keyword="0%", column_types=["string"])
    assert [row[0] for row in results["orders"]["rows"]] == [3]


def test_date_keyword_matches_datetime_date_and_string_columns(sqlite_source):
    _, results = search_all(keyword="2024-01-15")
    orders = results["orders"]
    assert [row[0] for row in orders["rows"]] == [1, 3]
    assert orders["matched"][0] == ["created_at", "note"]
    assert orders["matched"][1] == ["note"]
    assert results["users"]["matched"] == [["birthday"]]


def test_month_keyword_matches_iso_t_separator(sqlite_source):
    _, results = search_all(keyword="2024-02", column_types=["datetime"])
    assert [row[0] for row in results["orders"]["rows"]] == [2]


def test_number_keyword(sqlite_source):
    _, results = search_all(keyword="12.5", column_types=["number"])
    assert [row[0] for row in results["orders"]["rows"]] == [1]
    _, results = search_all(keyword="2024", column_types=["number"])
    assert [row[0] for row in results["orders"]["rows"]] == [3]


def test_limit_and_has_more(sqlite_source):
    result = table_search_service.search_table(1, "main", "orders", keyword="a", column_types=["string"], limit=1)
    assert len(result["rows"]) == 1 and result["has_more"] is True
    unlimited = table_search_service.search_table(1, "main", "orders", keyword="a", column_types=["string"], limit=-1)
    assert len(unlimited["rows"]) == 2 and unlimited["has_more"] is False


def test_record_ids_use_primary_key(sqlite_source):
    result = table_search_service.search_table(1, "main", "orders", keyword="banana")
    assert result["record_ids"] == ["2"]
    assert result["column_comments"]["title"] == ""


def test_where_filter_and_tables_missing_filter_columns(sqlite_source):
    plan, results = search_all(keyword="2024-01-15", where="amount > 100")
    assert [t["table"] for t in plan["targets"]] == ["orders"]
    assert plan["skipped_by_filter"] == [{"database": "main", "table": "users", "missing": ["amount"]}]
    assert [row[0] for row in results["orders"]["rows"]] == [3]
    assert "AND (amount > 100)" in results["orders"]["sql"]
    assert [row[0] for row in sqlite_source.execute(results["orders"]["sql"])["data"]] == [3]
    # 字符串里的冒号不能被当成绑定参数
    _, results = search_all(keyword="apple", where="title <> ':x'")
    assert [row[0] for row in results["orders"]["rows"]] == [1]


def test_copy_sql_runs_and_returns_same_rows(sqlite_source):
    result = table_search_service.search_table(1, "main", "orders", keyword="2024-01-15")
    executed = sqlite_source.execute(result["sql"])
    assert executed["success"], executed
    assert [row[0] for row in executed["data"]] == [1, 3]


def test_errors_are_reported(sqlite_source):
    assert table_search_service.search_table(1, "main", "missing", keyword="x")["success"] is False
    assert table_search_service.search_table(1, "other", "orders", keyword="x")["success"] is False
    assert table_search_service.plan_search(1, keyword="  ")["success"] is False
    assert table_search_service.plan_search(1, keyword="x", databases=["other"])["success"] is False
    assert table_search_service.plan_search(1, keyword="x", where="1=1; DROP TABLE orders")["success"] is False
