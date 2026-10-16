from contextlib import contextmanager
from types import SimpleNamespace

import sqlalchemy

from src.common.db_utils import quote_identifier, quote_qualified_identifier
from src.services import compare_service, data_edit_service, import_service, session_service
from src.sources.mongodb.tools import mongodb_tools
from src.sources.mysql.tools import mysql_tools, show_create_table
from src.sources.postgresql.tools import postgresql_tools
from src.sources.postgresql.provider import PostgreSQLProvider
from src.sources.redis.tools import redis_tools
from src.sources.sqlite.tools import sqlite_tools


class RecordingDatabase:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = list(responses or [])

    def execute(self, query, params=None):
        self.calls.append((query, params))
        if self.responses:
            return self.responses.pop(0)
        return {"columns": [], "data": [], "row_count": 0}

    def close(self):
        pass


class RecordingConnection:
    def __init__(self, statements, row=None):
        self.statements = statements
        self.row = row

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, statement, params=None):
        self.statements.append((str(statement), params))
        return SimpleNamespace(fetchone=lambda: self.row)

    def commit(self):
        pass


class RecordingEngine:
    def __init__(self, statements, row=None):
        self.statements = statements
        self.row = row

    def connect(self):
        return RecordingConnection(self.statements, self.row)


def test_sql_identifiers_are_quoted_instead_of_interpolated():
    assert quote_identifier("mysql", "odd`table") == "`odd``table`"
    assert quote_identifier("postgresql", "profile.name") == '"profile.name"'
    assert quote_qualified_identifier("postgresql", 'public.odd"table') == '"public"."odd""table"'


def test_compare_quotes_table_names(monkeypatch):
    database = RecordingDatabase(
        [
            {"columns": ["id"], "data": [(1,)]},
            {"columns": ["id"], "data": [(1,)]},
        ]
    )
    provider = SimpleNamespace(id="postgresql")

    @contextmanager
    def managed_source(_source_id):
        yield provider, database

    monkeypatch.setattr(compare_service, "managed_source", managed_source)
    result = compare_service.compare_table_data(
        1,
        'left"; DROP TABLE audit; --',
        "right",
        "id",
    )

    assert result["success"] is True
    assert 'FROM "left""; DROP TABLE audit; --"' in database.calls[0][0]


def test_export_uses_structured_filters(monkeypatch):
    database = RecordingDatabase([{"columns": ["name"], "data": [("O'Reilly",)]}])
    provider = SimpleNamespace(id="sqlite")
    monkeypatch.setattr(
        data_edit_service,
        "resolve_source",
        lambda _source_id: (provider, database),
    )

    result = data_edit_service.export_data(
        1,
        "customers",
        format="sql",
        where={"status": "active' OR 1=1; --"},
        limit=25,
    )

    query, params = database.calls[0]
    assert query == 'SELECT * FROM "customers" WHERE "status" = :filter_0 LIMIT 25'
    assert params == {"filter_0": "active' OR 1=1; --"}
    assert "O''Reilly" in result["content"]


def test_sql_export_orders_dict_values_by_the_reported_columns(monkeypatch):
    database = RecordingDatabase(
        [{"columns": ["id", "name"], "data": [{"name": "Ada", "id": 7}]}]
    )
    provider = SimpleNamespace(id="sqlite")
    monkeypatch.setattr(
        data_edit_service,
        "resolve_source",
        lambda _source_id: (provider, database),
    )

    result = data_edit_service.export_data(1, "customers", format="sql")

    assert result["content"] == (
        'INSERT INTO "customers" ("id", "name") VALUES (7, \'Ada\');'
    )


def test_import_quotes_uploaded_table_and_column_names(monkeypatch):
    statements = []
    database = RecordingDatabase()
    database.engine = RecordingEngine(statements)
    provider = SimpleNamespace(id="mysql")
    monkeypatch.setattr(
        "src.services.source_service.resolve_source",
        lambda _source_id: (provider, database),
    )
    monkeypatch.setattr(
        sqlalchemy,
        "inspect",
        lambda _engine: SimpleNamespace(get_table_names=lambda: []),
    )

    result = import_service.import_file(
        b"na`me\nAda\n",
        "people.csv",
        1,
        "peo`ple",
        "create",
    )

    assert result["success"] is True
    assert statements[0][0] == "CREATE TABLE `peo``ple` (`na``me` TEXT)"
    assert statements[1][0] == (
        "INSERT INTO `peo``ple` (`na``me`) VALUES (:p0)"
    )


def test_mysql_show_create_table_quotes_tool_input():
    statements = []
    database = SimpleNamespace(
        engine=RecordingEngine(statements, row=("odd`table", "CREATE TABLE ..."))
    )

    result = show_create_table(table="odd`table", db=database)

    assert result["success"] is True
    assert statements[0][0] == "SHOW CREATE TABLE `odd``table`"


def test_session_id_must_be_numeric():
    result = session_service.kill_session(1, "1); DROP TABLE audit; --")
    assert result["success"] is False


def test_shell_tool_is_not_registered():
    for registry in (
        mysql_tools,
        postgresql_tools,
        sqlite_tools,
        mongodb_tools,
        redis_tools,
    ):
        assert registry.get("execute_shell") is None


def test_postgresql_does_not_advertise_unsupported_migration():
    assert PostgreSQLProvider.capabilities.supports_migrate is False
