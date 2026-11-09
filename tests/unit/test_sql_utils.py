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


def test_serialize_row_converts_binary_values_to_json_safe_strings():
    from fastapi.encoders import jsonable_encoder

    from src.common.sql_utils import serialize_row

    row = serialize_row([1, memoryview(b"\x01\xab"), b"text", bytearray(b"\xff\x00"), None])
    assert row == [1, "0x01ab", "text", "0xff00", None]
    assert jsonable_encoder({"data": [row]}) == {"data": [row]}


def test_serialize_value_handles_non_finite_floats_and_timedelta():
    import datetime

    from fastapi.responses import JSONResponse

    from src.common.sql_utils import serialize_row

    row = serialize_row([
        float("nan"),
        float("inf"),
        float("-inf"),
        1.5,
        datetime.timedelta(hours=12, minutes=34, seconds=56),
        datetime.timedelta(hours=30, microseconds=500),
        -datetime.timedelta(hours=1, minutes=2, seconds=3),
    ])
    assert row == ["NaN", "Infinity", "-Infinity", 1.5, "12:34:56", "30:00:00.000500", "-01:02:03"]
    JSONResponse({"data": [row]})


def test_postgresql_client_keeps_interval_and_range_as_text():
    from unittest.mock import patch

    from src.sources.postgresql import client as pg_client

    registered = []
    with patch.object(pg_client.psycopg2.extensions, "register_type", lambda caster, conn: registered.append(caster.name)):
        pg_client._register_text_result_types(object())
    assert "DBDECK_INTERVAL" in registered
    assert "DBDECK_DATERANGE_ARRAY" in registered


def test_serialize_value_shows_control_char_binary_as_hex():
    from src.common.sql_utils import serialize_value

    assert serialize_value(b"\x00") == "0x00"
    assert serialize_value(b"\x01\x02") == "0x0102"
    assert serialize_value("中文".encode()) == "中文"
    assert serialize_value(b"line1\nline2\t") == "line1\nline2\t"


def test_mysql_client_converts_bit_to_int():
    from pymysql.constants import FIELD_TYPE

    from src.sources.mysql.client import _MYSQL_CONVERSIONS

    convert = _MYSQL_CONVERSIONS[FIELD_TYPE.BIT]
    assert convert(b"\x01") == 1
    assert convert(b"\xff" * 8) == 2**64 - 1


def test_serialize_value_handles_bson_special_types():
    import uuid

    from bson import Binary, DBRef, MaxKey, MinKey, ObjectId, Regex, Timestamp
    from fastapi.encoders import jsonable_encoder
    from fastapi.responses import JSONResponse

    from src.common.sql_utils import serialize_row

    oid = ObjectId("6af128fe50a3e8347c5e179d")
    uid = uuid.UUID("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
    doc = {
        "bin": Binary(b"\xde\xad"),
        "uuid": Binary(uid.bytes, 4),
        "ts": Timestamp(1700000000, 1),
        "re": Regex("^a", "i"),
        "min": MinKey(),
        "max": MaxKey(),
        "ref": DBRef("coll", oid),
        "nested": [{"ts": Timestamp(1, 2)}],
    }
    row = serialize_row(doc)
    assert row == {
        "bin": "0xdead",
        "uuid": str(uid),
        "ts": "Timestamp({ t: 1700000000, i: 1 })",
        "re": "/^a/i",
        "min": "MinKey()",
        "max": "MaxKey()",
        "ref": {"$ref": "coll", "$id": str(oid)},
        "nested": [{"ts": "Timestamp({ t: 1, i: 2 })"}],
    }
    JSONResponse(jsonable_encoder({"data": [row]}))
