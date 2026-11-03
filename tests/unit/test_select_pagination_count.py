from src.common.sql_utils import build_select_pagination


def _count_sql(sql: str, dialect: str = "mysql") -> str:
    count_sql, _ = build_select_pagination(sql, page=1, page_size=100, dialect=dialect)
    return count_sql


def test_count_query_ignores_duplicate_column_names():
    count_sql = _count_sql(
        "SELECT CONCAT('x', w.id) AS id, w.id, e.name "
        "FROM t w LEFT JOIN other.e e ON e.id = w.ent_id WHERE w.type = 2"
    )
    assert count_sql == (
        "SELECT COUNT(*) AS __codex_total FROM (SELECT 1 FROM t AS w "
        "LEFT JOIN other.e AS e ON e.id = w.ent_id WHERE w.type = 2) AS __codex_count"
    )


def test_count_query_keeps_projection_when_it_affects_row_count():
    assert "SELECT DISTINCT a" in _count_sql("SELECT DISTINCT a FROM t")
    assert "SELECT a, COUNT(*)" in _count_sql("SELECT a, COUNT(*) FROM t GROUP BY a")
    assert "SELECT COUNT(*) FROM t" in _count_sql("SELECT COUNT(*) FROM t")
