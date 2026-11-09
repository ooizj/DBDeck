"""SQL 系数据源共用的纯函数。"""
from __future__ import annotations

import datetime
import decimal
import math
from typing import Any

import sqlglot
from sqlglot import exp

try:
    from bson import ObjectId
except ImportError:
    ObjectId = None

try:
    from bson.decimal128 import Decimal128
except ImportError:
    Decimal128 = None

try:
    from bson import Binary, DBRef, MaxKey, MinKey, Regex, Timestamp
    from bson.binary import UUID_SUBTYPE
except ImportError:
    Binary = DBRef = MaxKey = MinKey = Regex = Timestamp = None
    UUID_SUBTYPE = 4


def _format_timedelta(td: datetime.timedelta) -> str:
    total_us = td.days * 86_400_000_000 + td.seconds * 1_000_000 + td.microseconds
    sign = "-" if total_us < 0 else ""
    total_us = abs(total_us)
    seconds, micro = divmod(total_us, 1_000_000)
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    text = f"{sign}{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{text}.{micro:06d}" if micro else text


def _regex_flags(flags: int) -> str:
    import re

    mapping = ((re.IGNORECASE, "i"), (re.MULTILINE, "m"), (re.DOTALL, "s"), (re.VERBOSE, "x"))
    return "".join(letter for flag, letter in mapping if flags & flag)


def serialize_value(v: Any) -> Any:
    """把行内单个值序列化成 JSON 可写出的形式。"""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, datetime.timedelta):
        # MySQL TIME 由 pymysql 返回为 timedelta，按 [-]HH:MM:SS[.ffffff] 展示（小时可超过 24）
        return _format_timedelta(v)
    if isinstance(v, float) and not math.isfinite(v):
        # NaN / Infinity 不是合法 JSON，会让整个响应 500
        return "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")
    if isinstance(v, decimal.Decimal):
        return str(v)
    if ObjectId and isinstance(v, ObjectId):
        return str(v)
    if Decimal128 and isinstance(v, Decimal128):
        return str(v)
    if Binary is not None:
        # MongoDB 特殊类型：FastAPI 无法编码，会让整个响应 500；按 mongosh 风格展示
        if isinstance(v, Binary):
            if v.subtype == UUID_SUBTYPE and len(v) == 16:
                return str(v.as_uuid())
            return "0x" + bytes(v).hex()
        if isinstance(v, Timestamp):
            return f"Timestamp({{ t: {v.time}, i: {v.inc} }})"
        if isinstance(v, Regex):
            return f"/{v.pattern}/{v.flags if isinstance(v.flags, str) else _regex_flags(v.flags)}"
        if isinstance(v, MinKey):
            return "MinKey()"
        if isinstance(v, MaxKey):
            return "MaxKey()"
        if isinstance(v, DBRef):
            return serialize_value(v.as_doc().to_dict())
    if isinstance(v, memoryview):
        # psycopg2 把 PostgreSQL bytea 返回为 memoryview，按 0x 十六进制展示
        return "0x" + v.tobytes().hex()
    if isinstance(v, (bytes, bytearray)):
        # 可读的 UTF-8 文本照常显示；无法解码或含控制字符的二进制转 0x 十六进制
        try:
            decoded = bytes(v).decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + bytes(v).hex()
        if any(ord(ch) < 32 and ch not in "\t\n\r" or ord(ch) == 127 for ch in decoded):
            return "0x" + bytes(v).hex()
        return decoded
    if isinstance(v, dict):
        return {k: serialize_value(val) for k, val in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [serialize_value(val) for val in v]
    return v


def serialize_row(row: Any) -> Any:
    if isinstance(row, (list, tuple)):
        return [serialize_value(v) for v in row]
    if isinstance(row, dict):
        return {k: serialize_value(v) for k, v in row.items()}
    return row


def _restore_trailing_semicolon(original: str, processed: str) -> str:
    if original.rstrip().endswith(";") and not processed.rstrip().endswith(";"):
        return processed.rstrip() + ";"
    return processed


def add_limit_to_select(sql: str, limit: int = 100, dialect: str = "mysql") -> str:
    """
    使用 sqlglot 解析 SQL，如果是 SELECT 语句且没有 LIMIT，则添加 LIMIT。
    特别处理：对于不带 GROUP BY 的聚合查询（如 SELECT COUNT(*)），不添加 LIMIT。
    """
    try:
        parsed = sqlglot.parse_one(sql, read=dialect)
        if isinstance(parsed, exp.Select):
            if not parsed.args.get("limit"):
                has_group_by = parsed.args.get("group") is not None
                is_aggregate = any(expr.find(exp.AggFunc) for expr in parsed.expressions)
                if is_aggregate and not has_group_by:
                    return sql
                limited = parsed.limit(limit).sql(dialect=dialect)
                return _restore_trailing_semicolon(sql, limited)
    except Exception:
        return sql
    return sql


def add_limit_to_sql(sql: str, limit: int = 100, dialect: str = "mysql") -> str:
    """Apply SELECT limits statement-by-statement for SQL scripts."""
    statements = split_sql_by_tokens(sql, dialect=dialect)
    if len(statements) <= 1:
        return add_limit_to_select(sql, limit=limit, dialect=dialect)
    return "\n".join(
        add_limit_to_select(stmt, limit=limit, dialect=dialect)
        for stmt in statements
    )


def _can_replace_projection_for_count(query: exp.Expression) -> bool:
    """投影列不影响结果行数时（无 DISTINCT / GROUP BY / HAVING / 聚合），计数可改为 SELECT 1。"""
    if not isinstance(query, exp.Select):
        return False
    if any(query.args.get(key) for key in ("distinct", "group", "having")):
        return False
    return not any(expr.find(exp.AggFunc) for expr in query.expressions)


def build_select_pagination(
    sql: str,
    *,
    page: int,
    page_size: int,
    dialect: str = "mysql",
) -> tuple[str, str] | None:
    """Build count and page queries for one SELECT without an explicit LIMIT."""
    statements = split_sql_by_tokens(sql, dialect=dialect)
    if len(statements) != 1:
        return None

    try:
        parsed = sqlglot.parse_one(statements[0], read=dialect)
    except Exception:
        return None
    if not isinstance(parsed, exp.Query):
        return None
    if parsed.args.get("limit") is not None or parsed.args.get("offset") is not None:
        return None

    safe_page = max(int(page), 1)
    safe_page_size = min(max(int(page_size), 1), 500)
    offset = (safe_page - 1) * safe_page_size
    page_sql = parsed.copy().limit(safe_page_size).offset(offset).sql(dialect=dialect)

    count_target = parsed.copy()
    count_target.set("order", None)
    if _can_replace_projection_for_count(count_target):
        # 计数不需要原始列；派生表中列名重复（如 `x AS id, w.id`）在 MySQL/PG 会直接报错
        count_target.set("expressions", [exp.Literal.number(1)])
    count_sql = (
        exp.select(exp.func("COUNT", exp.Star()).as_("__codex_total"))
        .from_(count_target.subquery(alias="__codex_count"))
        .sql(dialect=dialect)
    )
    return count_sql, page_sql


def _strip_comments(stmt: str) -> str:
    """去除 SQL 语句中的行注释和块注释（保留优化器提示 /*+ ... */），返回去除后可能为空的字符串。"""
    import re
    # 去除块注释 /* ... */ 但保留优化器提示 /*+ ... */
    s = re.sub(r'/\*(?!\+).*?\*/', '', stmt, flags=re.DOTALL)
    # 去除行注释 -- ...
    s = re.sub(r'--[^\n]*', '', s)
    return s.strip()


def split_sql_by_tokens(sql: str, dialect: str = "mysql") -> list[str]:
    """
    使用 sqlglot tokenizer 拆分多条 SQL 语句，能够正确跳过字符串、注释等包含的分号。
    纯注释片段会被跳过，不会产生空的结果 tab。
    返回的语句会去除前导注释，只保留实际执行的 SQL。
    """
    try:
        from sqlglot.tokens import TokenType
        tokens = sqlglot.tokenize(sql, read=dialect)
    except Exception:
        return [_strip_comments(s) for s in sql.split(";") if s.strip() and _strip_comments(s.strip())]

    statements = []
    current_start = 0
    has_real_token = False

    for token in tokens:
        if token.token_type != TokenType.SEMICOLON:
            has_real_token = True
        else:
            if has_real_token:
                stmt = sql[current_start : token.end + 1].strip()
                if stmt and _strip_comments(stmt):
                    statements.append(_strip_comments(stmt))
            current_start = token.end + 1
            has_real_token = False

    if has_real_token:
        stmt = sql[current_start:].strip()
        if stmt and _strip_comments(stmt):
            statements.append(_strip_comments(stmt))

    return statements
