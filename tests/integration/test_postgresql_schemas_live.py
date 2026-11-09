"""PostgreSQL 多模式元数据集成测试。

需要一个可写的空库，通过环境变量指定，例如：
    DBDECK_TEST_POSTGRES="host=127.0.0.1 port=5432 user=postgres password=xxx dbname=app"
未设置时跳过。测试会创建并删除 dbdeck_test_schema 模式以及 public 下的同名表。
"""
import os

import pytest

from src.common import db_utils
from src.sources.registry import get_provider

DSN = os.environ.get("DBDECK_TEST_POSTGRES")
pytestmark = pytest.mark.skipif(not DSN, reason="未设置 DBDECK_TEST_POSTGRES")

SCHEMA = "dbdeck_test_schema"


def _config():
    parts = dict(item.split("=", 1) for item in DSN.split())
    return {
        "host": parts.get("host", "127.0.0.1"),
        "port": int(parts.get("port", 5432)),
        "user": parts.get("user", "postgres"),
        "password": parts.get("password", ""),
        "database": parts["dbname"],
    }


@pytest.fixture()
def client():
    from src.sources.postgresql.client import PostgreSQLClient

    pg = PostgreSQLClient(_config())
    setup = f"""
        DROP SCHEMA IF EXISTS {SCHEMA} CASCADE;
        DROP TABLE IF EXISTS public.dbdeck_same_name;
        CREATE SCHEMA {SCHEMA};
        CREATE TABLE public.dbdeck_same_name (id int PRIMARY KEY, title text);
        CREATE TABLE {SCHEMA}.dbdeck_same_name (id bigint PRIMARY KEY, status text);
        COMMENT ON TABLE {SCHEMA}.dbdeck_same_name IS 'schema table';
        CREATE TABLE {SCHEMA}.child (id int PRIMARY KEY, parent_id bigint REFERENCES {SCHEMA}.dbdeck_same_name(id));
        CREATE VIEW {SCHEMA}.v_parent AS SELECT * FROM {SCHEMA}.dbdeck_same_name;
        CREATE FUNCTION {SCHEMA}.calc(x int) RETURNS int LANGUAGE sql AS 'SELECT x * 2';
    """
    assert pg.execute(setup)["success"]
    try:
        yield pg
    finally:
        pg.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE; DROP TABLE IF EXISTS public.dbdeck_same_name;")
        pg.close()


def test_metadata_includes_non_default_schemas(client):
    qualified = f"{SCHEMA}.dbdeck_same_name"
    schema = client.get_schema()
    assert [c["name"] for c in schema["dbdeck_same_name"]] == ["id", "title"]
    assert [c["name"] for c in schema[qualified]] == ["id", "status"]

    types = client.get_object_types()
    assert types[qualified] == "table"
    assert types[f"{SCHEMA}.v_parent"] == "view"
    assert types[f"{SCHEMA}.calc"] == "function"

    assert client.get_table_comments()[qualified] == "schema table"
    assert {
        "table": f"{SCHEMA}.child",
        "column": "parent_id",
        "ref_table": qualified,
        "ref_column": "id",
    } in client.get_foreign_keys()


def test_table_helpers_do_not_mix_same_named_tables(client):
    provider = get_provider("postgresql")
    qualified = f"{SCHEMA}.dbdeck_same_name"
    assert [c["name"] for c in db_utils.get_table_columns(client, provider, "dbdeck_same_name")] == ["id", "title"]
    assert [c["name"] for c in db_utils.get_table_columns(client, provider, qualified)] == ["id", "status"]
    assert len(db_utils.get_table_indexes(client, provider, "dbdeck_same_name")) == 1
    assert db_utils.get_primary_key(client, provider, qualified) == "id"
    assert client.get_ddl(qualified).startswith(f'CREATE TABLE "{SCHEMA}"."dbdeck_same_name"')


def test_result_column_metadata_keeps_schema(client):
    result = client.execute(f"SELECT t.id, t.status FROM {SCHEMA}.dbdeck_same_name t")
    assert result["success"]
    meta = result["statements"][-1]["column_metadata"]
    assert meta["id"]["table"] == f"{SCHEMA}.dbdeck_same_name"
    assert meta["id"]["primary_key"] is True
