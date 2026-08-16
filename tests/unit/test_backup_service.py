from types import SimpleNamespace

import pytest
from sqlalchemy import text

from src.services import data_edit_service
from src.sources import get_provider
from src.sources.sqlite.client import SQLiteClient


class BackupDatabase:
    def __init__(self, ddl, result):
        self.ddl = ddl
        self.result = result
        self.queries = []
        self.closed = False

    def get_ddl(self, _table):
        return self.ddl

    def execute(self, query):
        self.queries.append(query)
        return self.result

    def close(self):
        self.closed = True


@pytest.mark.parametrize(
    ("provider_id", "expected"),
    [
        ("mysql", True),
        ("postgresql", False),
        ("sqlite", True),
        ("mongodb", False),
        ("redis", False),
    ],
)
def test_provider_backup_capability_matrix(provider_id, expected):
    assert get_provider(provider_id).capabilities.supports_backup is expected


def test_sqlite_structure_backup_includes_indexes_and_triggers(tmp_path):
    database = SQLiteClient({"database": str(tmp_path / "backup.db")})
    try:
        with database.engine.begin() as connection:
            connection.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"))
            connection.execute(text("CREATE INDEX users_name_idx ON users (name)"))
            connection.execute(text("""
                CREATE TRIGGER users_after_insert AFTER INSERT ON users
                BEGIN
                    UPDATE users SET name = name WHERE id = NEW.id;
                END
            """))

        ddl = database.get_ddl("users")

        assert "CREATE TABLE users" in ddl
        assert "CREATE INDEX users_name_idx" in ddl
        assert "CREATE TRIGGER users_after_insert" in ddl
    finally:
        database.close()


@pytest.mark.parametrize(
    ("provider_id", "expected_table", "expected_columns"),
    [
        ("mysql", "`users`", "`id`, `name`"),
        ("sqlite", '"users"', '"id", "name"'),
    ],
)
def test_sql_backup_uses_provider_identifier_quoting(
    monkeypatch, provider_id, expected_table, expected_columns
):
    database = BackupDatabase(
        f"CREATE TABLE {expected_table} (id INTEGER, name TEXT)",
        {"columns": ["id", "name"], "data": [(1, "Ada")]},
    )
    provider = SimpleNamespace(
        id=provider_id,
        capabilities=SimpleNamespace(supports_backup=True),
    )
    monkeypatch.setattr(
        data_edit_service,
        "resolve_source",
        lambda _source_id: (provider, database),
    )

    result = data_edit_service.backup_database(1, ["users"])

    assert result["success"] is True
    assert database.queries == [f"SELECT * FROM {expected_table}"]
    assert (
        f"CREATE TABLE {expected_table} (id INTEGER, name TEXT);"
        in result["content"]
    )
    assert (
        f"INSERT INTO {expected_table} ({expected_columns}) VALUES (1, 'Ada');"
        in result["content"]
    )
    assert database.closed is True


@pytest.mark.parametrize("provider_id", ["postgresql", "mongodb", "redis"])
def test_backup_rejects_providers_without_restorable_format(monkeypatch, provider_id):
    database = BackupDatabase(None, {"columns": [], "data": []})
    provider = SimpleNamespace(
        id=provider_id,
        capabilities=SimpleNamespace(supports_backup=False),
    )
    monkeypatch.setattr(
        data_edit_service,
        "resolve_source",
        lambda _source_id: (provider, database),
    )

    result = data_edit_service.backup_database(1, ["items"])

    assert result == {
        "success": False,
        "error": f"{provider_id} 暂不支持可恢复备份",
    }
    assert database.queries == []
    assert database.closed is True
