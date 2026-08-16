from src.ai_core.tool_policy import needs_confirmation


def test_database_writes_require_confirmation():
    assert not needs_confirmation("execute_sql", {"sql": "select * from users"})
    assert needs_confirmation("execute_sql", {"sql": "delete from users"})
    assert needs_confirmation("execute_mongo_query", {"query": '{"action":"drop","collection":"users"}'})
    assert needs_confirmation("execute_redis_command", {"command": "FLUSHDB"})


def test_filesystem_writes_require_confirmation():
    assert needs_confirmation("fs_write_file", {"path": "/tmp/a"})
    assert not needs_confirmation("list_tables", {})
