from src.sources.operation_policy import classify_mongo, classify_redis, classify_sql


def test_sql_operation_classification():
    assert classify_sql("select * from users").kind == "read"
    assert classify_sql("insert into users(name) values ('Ada')").kind == "write"
    assert classify_sql("drop table users").kind == "destructive"
    assert classify_sql("select 1; delete from users").kind == "write"


def test_mongo_operation_classification():
    assert classify_mongo('{"collection":"users","action":"find"}').kind == "read"
    assert classify_mongo('{"collection":"users","action":"update_many"}').kind == "write"
    assert classify_mongo('{"collection":"users","action":"drop"}').kind == "destructive"
    assert classify_mongo('db.getCollection("users").find({})').kind == "read"
    assert classify_mongo('db.users.find({}); db.users.drop()').kind == "destructive"
    assert classify_mongo(
        '[{"collection":"users","action":"find"}, {"collection":"users","action":"update_many"}]'
    ).kind == "write"


def test_redis_operation_classification_is_ready_for_provider():
    assert classify_redis("GET user:1").kind == "read"
    assert classify_redis("SET user:1 Ada").kind == "write"
    assert classify_redis("FLUSHALL").kind == "destructive"
    assert classify_redis("GET user:1\nDEL user:1").kind == "destructive"
    assert classify_redis("XRANGE events - +").kind == "read"
    assert classify_redis("XADD events * type created").kind == "write"
