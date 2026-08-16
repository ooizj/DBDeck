from src.common.sql_utils import build_select_pagination
from src.sources.sqlite.client import SQLiteClient


def test_generated_page_and_count_queries_run_against_sqlite(tmp_path):
    client = SQLiteClient({"database": str(tmp_path / "pagination.db")})
    try:
        setup = client.execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY);"
            "WITH RECURSIVE seq(value) AS ("
            "SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 205"
            ") INSERT INTO items(id) SELECT value FROM seq;"
        )
        assert setup["success"]

        count_sql, page_sql = build_select_pagination(
            "SELECT id FROM items ORDER BY id",
            page=2,
            page_size=100,
            dialect="sqlite",
        )
        count_result = client.execute(count_sql)
        page_result = client.execute(page_sql)

        assert count_result["data"] == [[205]]
        assert page_result["data"][0] == [101]
        assert page_result["data"][-1] == [200]
        assert len(page_result["data"]) == 100
    finally:
        client.close()
