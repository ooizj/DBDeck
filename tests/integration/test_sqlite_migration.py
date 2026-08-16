from src.sources.sqlite.client import SQLiteClient
from src.sources.sql_migration import migrate_table


def test_sqlite_to_sqlite_migration_smoke(tmp_path):
    src = SQLiteClient({"database": str(tmp_path / "src.db")})
    dest = SQLiteClient({"database": str(tmp_path / "dest.db")})
    try:
        assert src.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")["success"]
        assert src.execute("INSERT INTO users (name) VALUES ('Ada'), ('Lin')")["success"]

        result = migrate_table(src, dest, "users")
        assert result["success"], result

        out = dest.execute("SELECT * FROM users ORDER BY id")
        assert out["success"], out
        assert out["row_count"] == 2
        assert out["data"][0][1] == "Ada"
    finally:
        src.close()
        dest.close()
