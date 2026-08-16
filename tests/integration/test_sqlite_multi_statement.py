from src.sources.sqlite.client import SQLiteClient


def test_sqlite_execute_returns_statement_results(tmp_path):
    client = SQLiteClient({"database": str(tmp_path / "multi.db")})
    try:
        result = client.execute(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);"
            "INSERT INTO users (name) VALUES ('Ada');"
            "SELECT * FROM users;"
        )
        assert result["success"]
        assert len(result["statements"]) == 3
        assert result["statements"][0]["affected_rows"] >= 0
        assert result["statements"][1]["affected_rows"] == 1
        assert result["statements"][2]["columns"] == ["id", "name"]
        assert isinstance(result["duration_ms"], (int, float))
        assert all(
            isinstance(statement["duration_ms"], (int, float))
            for statement in result["statements"]
        )
        assert result["data"] == [[1, "Ada"]]
    finally:
        client.close()
