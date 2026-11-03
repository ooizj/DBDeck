"""SQL 补全的跨库元数据：列出服务器上的库、读取其他库的表结构。"""
import pytest

from src.services import query_service
from src.sources import get_provider


class _MySQLLikeDb:
    def __init__(self):
        self.schema_calls = []

    def server_version(self):
        return "8.0.36"

    def list_databases(self):
        return ["app", "crm"]

    def get_schema(self, database=None):
        self.schema_calls.append(database)
        return {"orders": [{"name": "order_id", "type": "bigint", "primary_key": True}]}

    def get_table_comments(self, database=None):
        return {"orders": "订单"}

    def close(self):
        pass


class _NoDatabasesDb:
    def close(self):
        pass


@pytest.fixture
def use_db(monkeypatch):
    def install(db, provider_id="mysql"):
        monkeypatch.setattr(query_service, "resolve_source", lambda _sid: (get_provider(provider_id), db))
        return db
    return install


def test_get_databases_lists_server_databases(use_db):
    use_db(_MySQLLikeDb())
    assert query_service.get_databases(1) == {"success": True, "databases": ["app", "crm"]}


def test_get_databases_is_empty_for_sources_without_databases(use_db):
    use_db(_NoDatabasesDb(), provider_id="sqlite")
    assert query_service.get_databases(1) == {"success": True, "databases": []}


def test_get_database_schema_reads_requested_database(use_db):
    db = use_db(_MySQLLikeDb())
    result = query_service.get_database_schema(1, "crm")
    assert result["success"] is True
    assert result["database"] == "crm"
    assert list(result["tables"]) == ["orders"]
    assert result["table_comments"] == {"orders": "订单"}
    assert db.schema_calls == ["crm"]


def test_get_database_schema_rejects_unknown_database(use_db):
    db = use_db(_MySQLLikeDb())
    result = query_service.get_database_schema(1, "missing")
    assert result["success"] is False
    assert db.schema_calls == []


def test_get_server_version_reads_version(use_db):
    use_db(_MySQLLikeDb())
    assert query_service.get_server_version(1) == {"success": True, "version": "8.0.36"}


def test_get_server_version_is_empty_for_sources_without_version(use_db):
    use_db(_NoDatabasesDb(), provider_id="sqlite")
    assert query_service.get_server_version(1) == {"success": True, "version": ""}
