from src.sources.redis.client import RedisClient, _redis_connection_kwargs


class FakeRedis:
    def __init__(self):
        self.store = {
            "user:1": ("string", "Ada"),
            "session:1": ("hash", {"user_id": "1", "role": "admin"}),
            "queue": ("list", ["a", "b"]),
        }

    def execute_command(self, *args):
        command = args[0].upper()
        if command == "GET":
            return self.store[args[1]][1]
        if command == "HGETALL":
            return self.store[args[1]][1]
        if command == "LRANGE":
            return self.store[args[1]][1][int(args[2]): int(args[3]) + 1]
        if command == "DEL":
            return 1
        return "OK"

    def type(self, key):
        return self.store.get(key, ("none", None))[0]

    def ttl(self, _key):
        return -1

    def strlen(self, key):
        return len(self.store[key][1])

    def hlen(self, key):
        return len(self.store[key][1])

    def llen(self, key):
        return len(self.store[key][1])

    def scan(self, cursor=0, match="*", count=100):
        if match == "*":
            keys = list(self.store.keys())
        elif match.endswith("*"):
            prefix = match[:-1]
            keys = [key for key in self.store if key.startswith(prefix)]
        else:
            keys = [key for key in self.store if key == match]
        return 0, keys

    def ping(self):
        return True


def make_client():
    client = RedisClient.__new__(RedisClient)
    client.client = FakeRedis()
    return client


def test_redis_execute_multiple_commands():
    result = make_client().execute("GET user:1\nHGETALL session:1")

    assert result["success"]
    assert len(result["statements"]) == 2
    assert result["statements"][0]["data"] == [["user:1", "Ada"]]
    assert result["statements"][1]["columns"] == ["field", "value"]
    assert result["active_statement_index"] == 1


def test_redis_schema_scans_keys_with_type_metadata():
    schema = make_client().get_schema()

    assert schema["user:1"][0]["type"] == "string"
    assert schema["session:1"][0]["type"] == "hash"


def test_redis_schema_filters_keys_by_pattern():
    schema = make_client().get_schema("session:*")

    assert list(schema) == ["session:1"]


def test_redis_connection_uses_resp2_and_omits_default_username():
    kwargs = _redis_connection_kwargs(
        {"user": "default", "password": "secret", "database": "2"},
        host="127.0.0.1",
        port=6379,
    )

    assert kwargs["protocol"] == 2
    assert kwargs["password"] == "secret"
    assert kwargs["db"] == 2
    assert "username" not in kwargs


def test_redis_connection_keeps_named_acl_username():
    kwargs = _redis_connection_kwargs(
        {"user": "app_user", "password": "secret"},
        host="127.0.0.1",
        port=6379,
    )

    assert kwargs["username"] == "app_user"


def test_redis_execute_error_redacts_config_password():
    client = RedisClient.__new__(RedisClient)
    client.config = {"password": "secret"}

    class FailingRedis:
        def execute_command(self, *_args):
            raise RuntimeError(
                "unknown command `HELLO`, with args beginning with: `3`, `AUTH`, `default`, `secret`,"
            )

    client.client = FailingRedis()
    result = client.execute("GET user:1")

    assert not result["success"]
    assert "secret" not in result["error"]
    assert "******" in result["error"]


def test_redis_formats_zset_scores_for_editor():
    client = RedisClient.__new__(RedisClient)
    result = client._format_result("ZRANGE", ["rank", "0", "-1", "WITHSCORES"], ["alice", "1", "bob", "2"])
    tuple_result = client._format_result("ZRANGE", ["rank", "0", "-1", "WITHSCORES"], [["carol", "3"]])

    assert result["columns"] == ["member", "score"]
    assert result["data"] == [["alice", "1"], ["bob", "2"]]
    assert tuple_result["data"] == [["carol", "3"]]


def test_redis_formats_stream_entries_for_editor():
    client = RedisClient.__new__(RedisClient)
    result = client._format_result(
        "XRANGE",
        ["events", "-", "+"],
        [["1-0", {"type": "created"}], ["2-0", {"type": "updated"}]],
    )

    assert result["columns"] == ["id", "fields"]
    assert result["data"] == [["1-0", {"type": "created"}], ["2-0", {"type": "updated"}]]
