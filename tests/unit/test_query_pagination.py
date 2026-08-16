from types import SimpleNamespace

from src.services import query_service


class _PagedDatabase:
    def __init__(self):
        self.queries = []
        self.closed = False

    def execute(self, sql):
        self.queries.append(sql)
        if "COUNT(*)" in sql.upper():
            return {
                "success": True,
                "columns": ["total"],
                "data": [[250]],
                "row_count": 1,
            }
        return {
            "success": True,
            "columns": ["id"],
            "data": [[101], [102]],
            "row_count": 2,
        }

    def close(self):
        self.closed = True


def test_execute_query_paginates_a_single_select(monkeypatch):
    database = _PagedDatabase()
    provider = SimpleNamespace(
        id="mysql",
        capabilities=SimpleNamespace(query_language="sql"),
        classify_operation=lambda _query: SimpleNamespace(kind="read"),
    )
    monkeypatch.setattr(query_service, "resolve_source", lambda _source_id: (provider, database))
    monkeypatch.setattr(query_service, "add_history", lambda **_kwargs: None)

    result = query_service.execute_query(
        "SELECT id FROM users ORDER BY id",
        7,
        page=2,
        page_size=100,
    )

    assert len(database.queries) == 2
    assert "COUNT(*)" in database.queries[0].upper()
    assert "LIMIT 100 OFFSET 100" in database.queries[1].upper()
    assert result["data"] == [[101], [102]]
    assert result["pagination"] == {
        "page": 2,
        "page_size": 100,
        "total": 250,
        "total_pages": 3,
        "start": 101,
        "end": 102,
    }
    assert database.closed is True


def test_execute_query_does_not_paginate_multiple_statements(monkeypatch):
    database = _PagedDatabase()
    provider = SimpleNamespace(
        id="mysql",
        capabilities=SimpleNamespace(query_language="sql"),
        classify_operation=lambda _query: SimpleNamespace(kind="read"),
    )
    monkeypatch.setattr(query_service, "resolve_source", lambda _source_id: (provider, database))
    monkeypatch.setattr(query_service, "add_history", lambda **_kwargs: None)

    result = query_service.execute_query(
        "SELECT 1; SELECT 2",
        7,
        page=1,
        page_size=100,
    )

    assert len(database.queries) == 1
    assert result.get("pagination") is None
