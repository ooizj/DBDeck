from src.common.sql_utils import add_limit_to_select, add_limit_to_sql, split_sql_by_tokens


def test_add_limit_to_simple_select_but_not_count():
    assert "LIMIT" in add_limit_to_select("select * from users", dialect="sqlite").upper()
    assert add_limit_to_select("select count(*) from users", dialect="sqlite") == "select count(*) from users"


def test_split_sql_preserves_semicolon_inside_string():
    statements = split_sql_by_tokens("select ';' as marker; select 2;", dialect="sqlite")
    assert len(statements) == 2
    assert "';'" in statements[0]


def test_add_limit_to_sql_handles_multiple_statements():
    sql = "select * from users; update users set name = 'A' where id = 1;"
    processed = add_limit_to_sql(sql, dialect="sqlite")
    assert "LIMIT" in processed.upper()
    assert "update users" in processed
