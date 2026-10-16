"""导出全部结果：只读限制、行数上限与截断。"""
import pytest

from src.services import query_service
from src.sources import get_provider


class _RecordingDb:
    def __init__(self, rows=None, result=None):
        self.calls = []
        self._rows = rows or []
        self._result = result

    def execute(self, sql, params=None):
        self.calls.append(sql)
        if self._result is not None:
            return self._result
        return {"success": True, "columns": ["id"], "data": self._rows, "row_count": len(self._rows)}

    def close(self):
        pass


@pytest.fixture
def use_db(monkeypatch):
    def install(db, provider_id="sqlite"):
        monkeypatch.setattr(query_service, "resolve_source", lambda _sid: (get_provider(provider_id), db))
        return db
    return install


def test_export_appends_limit_and_reports_truncation(use_db):
    db = use_db(_RecordingDb(rows=[[i] for i in range(4)]))

    result = query_service.export_query("SELECT id FROM t ORDER BY id;", 1, max_rows=3)

    assert db.calls == ["SELECT id FROM t ORDER BY id LIMIT 4"]
    assert result["success"] is True
    assert result["data"] == [[0], [1], [2]]
    assert result["truncated"] is True
    assert result["max_rows"] == 3


def test_export_keeps_users_own_limit(use_db):
    db = use_db(_RecordingDb(rows=[[1], [2]]))

    result = query_service.export_query("SELECT id FROM t LIMIT 2", 1, max_rows=10)

    assert db.calls == ["SELECT id FROM t LIMIT 2"]
    assert result["truncated"] is False
    assert result["row_count"] == 2


@pytest.mark.parametrize("query", [
    "DELETE FROM t",
    "UPDATE t SET a = 1",
    "DROP TABLE t",
])
def test_export_rejects_non_read_statements_without_executing(use_db, query):
    db = use_db(_RecordingDb())

    result = query_service.export_query(query, 1)

    assert result["success"] is False
    assert db.calls == []


def test_export_rejects_multiple_statements(use_db):
    db = use_db(_RecordingDb())

    result = query_service.export_query("SELECT 1; SELECT 2", 1)

    assert result["success"] is False
    assert db.calls == []


def test_export_rejects_non_sql_sources(use_db):
    db = use_db(_RecordingDb(), provider_id="redis")

    result = query_service.export_query("GET key", 1)

    assert result["success"] is False
    assert db.calls == []


def test_export_reports_database_errors(use_db):
    use_db(_RecordingDb(result={"success": False, "error": "no such table: t"}))

    result = query_service.export_query("SELECT * FROM t", 1)

    assert result == {"success": False, "error": "no such table: t"}
