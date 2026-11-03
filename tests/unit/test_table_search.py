from datetime import datetime
from decimal import Decimal

import pytest

from src.services.table_search_service import (
    _check_database_name,
    _filter_tables,
    _record_id,
    build_search_sql,
    classify_column_type,
    date_text_variants,
    parse_keyword,
    parse_where_filter,
)


@pytest.mark.parametrize("keyword, start, end, precision", [
    ("2024-01", datetime(2024, 1, 1), datetime(2024, 2, 1), "month"),
    ("2024/12", datetime(2024, 12, 1), datetime(2025, 1, 1), "month"),
    ("2024-01-15", datetime(2024, 1, 15), datetime(2024, 1, 16), "day"),
    ("2024.1.5", datetime(2024, 1, 5), datetime(2024, 1, 6), "day"),
    ("20240115", datetime(2024, 1, 15), datetime(2024, 1, 16), "day"),
    ("2024年1月15日", datetime(2024, 1, 15), datetime(2024, 1, 16), "day"),
    ("2024-01-15 10:30", datetime(2024, 1, 15, 10, 30), datetime(2024, 1, 15, 10, 31), "minute"),
    ("2024-01-15T10:30:45", datetime(2024, 1, 15, 10, 30, 45), datetime(2024, 1, 15, 10, 30, 46), "second"),
    ("2024年1月15日 10时30分", datetime(2024, 1, 15, 10, 30), datetime(2024, 1, 15, 10, 31), "minute"),
])
def test_parse_keyword_recognizes_dates(keyword, start, end, precision):
    info = parse_keyword(keyword)
    assert info.date is not None
    assert (info.date.start, info.date.end, info.date.precision) == (start, end, precision)


@pytest.mark.parametrize("keyword", ["2024-13-01", "2024-02-30", "hello", "2024", "15/01/2024"])
def test_parse_keyword_rejects_non_dates(keyword):
    assert parse_keyword(keyword).date is None


def test_parse_keyword_number_and_time():
    assert parse_keyword("12.50").number == Decimal("12.50")
    assert parse_keyword("abc").number is None
    assert parse_keyword("20240115").number == Decimal("20240115")
    info = parse_keyword("10:30")
    assert (info.time.start, info.time.end) == ("10:30:00", "10:31:00")
    assert parse_keyword("25:00").time is None
    with pytest.raises(ValueError):
        parse_keyword("   ")


def test_date_text_variants():
    assert date_text_variants(parse_keyword("2024/1/5")) == ["2024/1/5", "2024-01-05", "2024/01/05", "20240105"]
    assert date_text_variants(parse_keyword("2024-01-05 08:30")) == ["2024-01-05 08:30", "2024/01/05 08:30"]
    assert date_text_variants(parse_keyword("plain")) == ["plain"]


@pytest.mark.parametrize("provider, type_name, expected", [
    ("mysql", "varchar", "string"),
    ("mysql", "json", "string"),
    ("mysql", "bigint", "number"),
    ("mysql", "decimal", "number"),
    ("mysql", "datetime", "datetime"),
    ("mysql", "blob", None),
    ("mysql", "point", None),
    ("postgresql", "character varying", "string"),
    ("postgresql", "timestamp with time zone", "datetime"),
    ("postgresql", "uuid", "string"),
    ("postgresql", "interval", None),
    ("sqlite", "VARCHAR(255)", "string"),
    ("sqlite", "INTEGER", "number"),
    ("sqlite", "BIGINT UNSIGNED", "number"),
    ("sqlite", "DATETIME", "datetime"),
    ("sqlite", "", "string"),
    ("sqlite", "BLOB", None),
])
def test_classify_column_type(provider, type_name, expected):
    assert classify_column_type(type_name, provider) == expected


def test_build_search_sql_binds_values_and_escapes_like():
    columns = [{"name": "title", "category": "string", "kind": "string"}]
    sql, params = build_search_sql("mysql", "shop", "orders", columns, parse_keyword("50%_off"), "contains", limit=11)
    assert "FROM `shop`.`orders`" in sql
    assert "LIKE :p0 ESCAPE '!'" in sql
    assert params == {"p0": "%50!%!_off%"}
    assert sql.rstrip().endswith("LIMIT 11")


def test_build_search_sql_literal_mode_for_copy():
    columns = [
        {"name": "note", "category": "string", "kind": "string"},
        {"name": "created_at", "category": "datetime", "kind": "datetime"},
        {"name": "birthday", "category": "datetime", "kind": "date"},
    ]
    sql, params = build_search_sql("postgresql", "public", "users", columns, parse_keyword("2024-01-15 10:30"), "contains", literal=True)
    assert params == {}
    assert 'FROM "public"."users"' in sql
    assert "CAST(\"note\" AS TEXT) ILIKE '%2024-01-15 10:30%' ESCAPE '!'" in sql
    assert "\"created_at\" >= '2024-01-15 10:30:00' AND \"created_at\" < '2024-01-15 10:31:00'" in sql
    assert "\"birthday\" >= '2024-01-15' AND \"birthday\" < '2024-01-16'" in sql
    assert "LIMIT" not in sql and "MAX_EXECUTION_TIME" not in sql


def test_build_search_sql_escapes_colons_for_text_clause():
    columns = [{"name": "a:b", "category": "string", "kind": "string"}]
    sql, _ = build_search_sql("sqlite", "main", "t", columns, parse_keyword("x"), "equals")
    assert '"a\\:b"' in sql


def test_parse_where_filter():
    assert parse_where_filter("mysql", "  ") == (None, [])
    assert parse_where_filter("mysql", "WHERE amount > 100 AND t.status = 'x'") == ("amount > 100 AND t.status = 'x'", ["amount", "status"])
    # 子查询里的字段不属于本表
    assert parse_where_filter("postgresql", "id IN (SELECT order_id FROM payments WHERE paid)")[1] == ["id"]
    for bad in ["1=1; DROP TABLE x", "a = 1 ORDER BY a", "a = 1 LIMIT 1", "a = 1 UNION SELECT 1", "a = 'x"]:
        with pytest.raises(ValueError):
            parse_where_filter("mysql", bad)


def test_filter_tables_include_exclude():
    keys = [("shop", "orders"), ("shop", "order_items"), ("crm", "users"), ("crm", "orders")]
    assert _filter_tables(keys, "", "") == keys
    assert _filter_tables(keys, "order", "items") == [("shop", "orders"), ("crm", "orders")]
    assert _filter_tables(keys, "crm.*", "") == [("crm", "users"), ("crm", "orders")]
    assert _filter_tables(keys, "", "shop.*，users") == [("crm", "orders")]


def test_record_id():
    cols = ["id", "tenant", "name"]
    assert _record_id(cols, [5, "a", "x"], ["id", "tenant"]) == "5, a"
    assert _record_id(cols, [5, "a", "x"], []) == "id: 5"
    assert _record_id(cols, [5, "a", "x"], ["missing"]) == "id: 5"


def test_check_database_name_blocks_system_schemas():
    _check_database_name("mysql", "shop")
    _check_database_name("postgresql", "public")
    _check_database_name("sqlite", "main")
    for provider, name in [("mysql", "MySQL"), ("mysql", "information_schema"), ("postgresql", "pg_catalog"),
                           ("postgresql", "pg_toast"), ("sqlite", "other"), ("mysql", "")]:
        with pytest.raises(ValueError):
            _check_database_name(provider, name)
