import pytest

from src.sources.mongodb.client import MongoDBClient


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    def skip(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def __iter__(self):
        return iter(self.rows)


class FakeCollection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, _filter):
        return FakeCursor(self.rows)

    def count_documents(self, _filter):
        return len(self.rows)


class FakeDB:
    def __init__(self):
        self.collections = {
            "users": FakeCollection([{"_id": 1, "name": "Ada"}]),
            "orders": FakeCollection([{"_id": 10}, {"_id": 11}]),
        }

    def __getitem__(self, collection_name):
        return self.collections[collection_name]


def make_client():
    client = MongoDBClient.__new__(MongoDBClient)
    client.db = FakeDB()
    return client


def test_mongodb_execute_multiple_shell_statements():
    result = make_client().execute(
        'db.getCollection("users").find({});\n'
        'db.getCollection("orders").count({})'
    )

    assert result["success"]
    assert len(result["statements"]) == 2
    assert result["statements"][0]["columns"] == ["_id", "name"]
    assert result["statements"][0]["row_count"] == 1
    assert result["statements"][1]["columns"] == ["count"]
    assert result["statements"][1]["data"] == [[2]]
    assert result["active_statement_index"] == 1


def test_mongodb_strips_line_comment_before_query():
    result = make_client().execute(
        '// 这是一个注释\n'
        'db.getCollection("users").find({})'
    )

    assert result["success"]
    assert len(result["statements"]) == 1
    assert result["statements"][0]["columns"] == ["_id", "name"]
    assert result["statements"][0]["row_count"] == 1


def test_mongodb_strips_block_comment_before_query():
    result = make_client().execute(
        '/* 块注释 */\n'
        'db.getCollection("users").find({})'
    )

    assert result["success"]
    assert len(result["statements"]) == 1
    assert result["statements"][0]["columns"] == ["_id", "name"]


def test_mongodb_comment_between_queries_does_not_become_statement():
    result = make_client().execute(
        'db.getCollection("users").find({})\n'
        '// 中间的注释，不应成为结果\n'
        'db.getCollection("orders").count({})'
    )

    assert result["success"]
    assert len(result["statements"]) == 2
    assert result["statements"][0]["columns"] == ["_id", "name"]
    assert result["statements"][1]["columns"] == ["count"]


def test_mongodb_only_comment_is_empty():
    result = make_client().execute('// 只有一行注释')

    assert result["success"] is False
    assert result["statements"] == []


def test_mongodb_slashes_inside_string_are_preserved():
    result = make_client().execute(
        'db.getCollection("users").find({"name": "a//b"})'
    )

    assert result["success"]
    assert len(result["statements"]) == 1


def test_mongodb_execute_json_command_array():
    result = make_client().execute(
        '[{"collection":"users","action":"find","filter":{}},'
        '{"collection":"orders","action":"count","filter":{}}]'
    )

    assert result["success"]
    assert len(result["statements"]) == 2
    assert result["statements"][0]["operation_kind"] == "read"
    assert result["statements"][1]["row_count"] == 1


def test_mongodb_schema_propagates_collection_loading_error():
    client = MongoDBClient.__new__(MongoDBClient)

    class FailingDB:
        def list_collection_names(self):
            raise RuntimeError("incompatible MongoDB wire version")

    client.db = FailingDB()

    with pytest.raises(RuntimeError, match="incompatible MongoDB wire version"):
        client.get_schema()
