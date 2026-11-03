"""全表搜索：在选定的库（MySQL 库 / PostgreSQL 模式 / SQLite main，不选即全部）的表里按关键字查找数据。

流程分两步，便于前端逐表执行、显示进度并随时取消：
1. plan_search：读取字段元数据，按表名、字段类型、字段名、WHERE 过滤条件筛出每张表的候选字段；
2. search_table：对单张表执行搜索，返回命中行以及每行命中的字段。

关键字会被同时解析为文本、数字、日期/时间，分别用于字符串、数字、日期时间字段：
- 字符串字段：LIKE 匹配；关键字是日期时再额外匹配 2024-01-15 / 2024/01/15 / 20240115 等写法；
- 数字字段：关键字是数字时按值相等匹配；
- 日期时间字段：关键字是日期（如 2024-01、2024-01-15、2024-01-15 10:30）时按时间范围匹配。
"""
from __future__ import annotations

import fnmatch
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import sqlglot
from sqlalchemy import bindparam, inspect, text
from sqlglot import exp

from src.common.db_utils import managed_source
from src.common.errors import redact_sensitive
from src.common.sql_identifiers import quote_identifier
from src.common.sql_utils import serialize_row, serialize_value

SUPPORTED_PROVIDERS = ("mysql", "postgresql", "sqlite")
CATEGORIES = ("string", "number", "datetime")
MATCH_MODES = ("contains", "equals", "prefix")
STATEMENT_TIMEOUT_MS = 30_000
MYSQL_SYSTEM_DATABASES = {"information_schema", "mysql", "performance_schema", "sys"}
POSTGRES_SYSTEM_SCHEMAS = {"pg_catalog", "information_schema"}
LIKE_ESCAPE = "!"
MATCH_FLAG_PREFIX = "__dbdeck_match_"


# ---------------------------------------------------------------------------
# 关键字解析
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DateKeyword:
    start: datetime
    end: Optional[datetime]  # 不含；溢出（9999 年末）时为 None
    precision: str  # month / day / minute / second
    parts: Tuple[int, ...]  # (年, 月[, 日[, 时, 分[, 秒]]])


@dataclass(frozen=True)
class TimeKeyword:
    start: str  # HH:MM:SS
    end: Optional[str]


@dataclass(frozen=True)
class KeywordInfo:
    text: str
    number: Optional[Decimal]
    date: Optional[DateKeyword]
    time: Optional[TimeKeyword]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "text_variants": date_text_variants(self),
            "number": str(self.number) if self.number is not None else None,
            "date": {
                "start": _format_datetime(self.date.start),
                "end": _format_datetime(self.date.end) if self.date.end else None,
                "precision": self.date.precision,
            } if self.date else None,
            "time": {"start": self.time.start, "end": self.time.end} if self.time else None,
        }


_NUMBER_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)$")
_DATE_RE = re.compile(
    r"^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?"
    r"(?:(?:T|\s*)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$"
)
_CJK_DATE_CHARS = str.maketrans({"年": "-", "月": "-", "日": " ", "时": ":", "分": ":", "秒": " "})
_COMPACT_DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$")
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")


def _format_datetime(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _parse_date(keyword: str) -> Optional[DateKeyword]:
    # 2024年1月15日 10时30分 -> 2024-1-15 10:30
    normalized = re.sub(r"\s+", " ", keyword.translate(_CJK_DATE_CHARS)).strip().rstrip(":-").strip()
    match = _DATE_RE.match(normalized) or _COMPACT_DATE_RE.match(normalized)
    if not match:
        return None
    raw = [int(g) if g is not None else None for g in match.groups()]
    year, month, day, hour, minute, second = raw
    if day is None and hour is not None:
        return None
    try:
        start = datetime(year, month, day or 1, hour or 0, minute or 0, second or 0)
    except ValueError:
        return None
    if day is None:
        precision, parts = "month", (year, month)
        end_year, end_month = (year + 1, 1) if month == 12 else (year, month + 1)
        end = datetime(end_year, end_month, 1) if end_year <= 9999 else None
    else:
        if hour is None:
            precision, step, parts = "day", timedelta(days=1), (year, month, day)
        elif second is None:
            precision, step, parts = "minute", timedelta(minutes=1), (year, month, day, hour, minute)
        else:
            precision, step, parts = "second", timedelta(seconds=1), (year, month, day, hour, minute, second)
        try:
            end = start + step
        except OverflowError:
            end = None
    return DateKeyword(start=start, end=end, precision=precision, parts=parts)


def _parse_time(keyword: str) -> Optional[TimeKeyword]:
    match = _TIME_RE.match(keyword)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    second = int(match.group(3)) if match.group(3) is not None else None
    if hour > 23 or minute > 59 or (second is not None and second > 59):
        return None
    base = datetime(2000, 1, 1, hour, minute, second or 0)
    end = base + (timedelta(seconds=1) if second is not None else timedelta(minutes=1))
    return TimeKeyword(
        start=base.strftime("%H:%M:%S"),
        end=end.strftime("%H:%M:%S") if end.day == base.day else None,
    )


def parse_keyword(keyword: str) -> KeywordInfo:
    value = (keyword or "").strip()
    if not value:
        raise ValueError("关键字不能为空")
    number = None
    if _NUMBER_RE.match(value):
        try:
            number = Decimal(value)
        except InvalidOperation:
            number = None
    return KeywordInfo(text=value, number=number, date=_parse_date(value), time=_parse_time(value))


def date_text_variants(info: KeywordInfo) -> List[str]:
    """日期关键字在字符串字段里可能出现的几种写法（含原始关键字）。"""
    variants = [info.text]
    if info.date:
        year, month, *rest = info.date.parts
        ym = (f"{year:04d}-{month:02d}", f"{year:04d}/{month:02d}")
        if rest:
            day = rest[0]
            dates = [f"{ym[0]}-{day:02d}", f"{ym[1]}/{day:02d}"]
            time_part = ""
            if len(rest) >= 3:
                time_part = f" {rest[1]:02d}:{rest[2]:02d}" + (f":{rest[3]:02d}" if len(rest) == 4 else "")
            candidates = [d + time_part for d in dates]
            if not time_part:
                candidates.append(f"{year:04d}{month:02d}{day:02d}")
        else:
            candidates = list(ym)
        for candidate in candidates:
            if candidate not in variants:
                variants.append(candidate)
    return variants


# ---------------------------------------------------------------------------
# 字段类型分类
# ---------------------------------------------------------------------------

_STRING_TYPES = {
    "char", "varchar", "nchar", "nvarchar", "tinytext", "text", "mediumtext", "longtext",
    "enum", "set", "json", "jsonb", "character", "character varying", "bpchar", "citext",
    "uuid", "clob", "string", "name", "xml", "inet", "cidr", "macaddr",
}
_NUMBER_TYPES = {
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric",
    "float", "double", "double precision", "real", "year", "serial", "bigserial", "smallserial",
    "int2", "int4", "int8", "float4", "float8",
}
_DATETIME_TYPES = {
    "date", "datetime", "timestamp", "timestamp without time zone", "timestamp with time zone",
    "timestamptz", "time", "time without time zone", "time with time zone", "timetz",
}


def _base_type(type_name: str) -> str:
    base = re.sub(r"\(.*?\)", "", str(type_name or "").lower())
    base = re.sub(r"\b(unsigned|zerofill|signed)\b", "", base)
    return re.sub(r"\s+", " ", base).strip()


def classify_column_type(type_name: str, provider_id: str = "mysql") -> Optional[str]:
    """把字段类型归为 string / number / datetime；无法搜索的类型（二进制、几何等）返回 None。"""
    base = _base_type(type_name)
    if base in _DATETIME_TYPES:
        return "datetime"
    if base in _NUMBER_TYPES:
        return "number"
    if base in _STRING_TYPES:
        return "string"
    if provider_id == "sqlite":
        # SQLite 的类型名是自由文本，按其类型亲和性规则推断
        if not base or any(token in base for token in ("char", "clob", "text")):
            return "string"
        if "int" in base or any(token in base for token in ("real", "floa", "doub", "num", "dec")):
            return "number"
        if "date" in base or "time" in base:
            return "datetime"
    return None


def _datetime_kind(type_name: str) -> str:
    base = _base_type(type_name)
    if base.startswith("time") and not base.startswith("timestamp"):
        return "time"
    if base == "date":
        return "date"
    return "datetime"


# ---------------------------------------------------------------------------
# 元数据
# ---------------------------------------------------------------------------

def _require_supported(provider) -> None:
    if provider.id not in SUPPORTED_PROVIDERS:
        raise ValueError(f"{provider.display_name or provider.id} 暂不支持全表搜索")


def _list_databases(provider, db) -> Tuple[List[str], str]:
    with db.engine.connect() as conn:
        if provider.id == "mysql":
            current = db.engine.url.database or ""
            rows = conn.execute(text("SHOW DATABASES")).fetchall()
            names = [row[0] for row in rows if str(row[0]).lower() not in MYSQL_SYSTEM_DATABASES]
        elif provider.id == "postgresql":
            current = conn.execute(text("SELECT current_schema()")).scalar() or "public"
            rows = conn.execute(text("""
                SELECT schema_name FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
                  AND schema_name !~ '^pg_(toast|temp)'
                ORDER BY schema_name
            """)).fetchall()
            names = [row[0] for row in rows]
        else:
            current, names = "main", ["main"]
    if current and current not in names:
        names.insert(0, current)
    return names, current


def _resolve_databases(provider, db, databases: Optional[Sequence[str]]) -> List[str]:
    """不选数据库时搜索全部（MySQL 排除系统库）。"""
    names, _ = _list_databases(provider, db)
    wanted = [d for d in (databases or []) if d and d.strip()]
    if not wanted:
        return names
    missing = [d for d in wanted if d not in names]
    if missing:
        raise ValueError(f"数据库不存在: {', '.join(missing)}")
    return wanted


def _check_database_name(provider_id: str, database: str) -> None:
    """单表搜索不再列出全部库，只拦截系统库/非法库名；库或表不存在时由元数据查询返回空。"""
    lowered = (database or "").lower()
    if (
        not lowered
        or (provider_id == "mysql" and lowered in MYSQL_SYSTEM_DATABASES)
        or (provider_id == "postgresql" and (lowered in POSTGRES_SYSTEM_SCHEMAS or lowered.startswith(("pg_toast", "pg_temp"))))
        or (provider_id == "sqlite" and database != "main")
    ):
        raise ValueError(f"不支持搜索该数据库: {database}")


def _load_columns(provider, db, databases: Sequence[str], table: Optional[str] = None) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    """返回 {(库, 表): [{name, type, display_type, comment, primary_key}]}，只含普通表，不含视图。

    传入 table 时只查这一张表，避免单表搜索时把整个库的字段元数据都读一遍。
    """
    result: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    if provider.id == "sqlite":
        inspector = inspect(db.engine)
        for table_name in inspector.get_table_names():
            if table is not None and table_name != table:
                continue
            result[("main", table_name)] = [
                {
                    "name": col["name"],
                    "type": str(col["type"]),
                    "display_type": str(col["type"]),
                    "comment": col.get("comment") or "",
                    "primary_key": bool(col.get("primary_key")),
                }
                for col in inspector.get_columns(table_name)
            ]
        return result

    if provider.id == "mysql":
        sql = """
            SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE,
                   c.COLUMN_KEY = 'PRI', c.COLUMN_COMMENT
            FROM information_schema.COLUMNS c
            JOIN information_schema.TABLES t
              ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            WHERE c.TABLE_SCHEMA IN :schemas AND t.TABLE_TYPE = 'BASE TABLE' {table_filter}
            ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
        """
        table_filter = "AND c.TABLE_NAME = :table"
    else:
        sql = """
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
                   CASE WHEN c.data_type IN ('USER-DEFINED', 'ARRAY') THEN c.udt_name ELSE c.data_type END,
                   EXISTS (
                       SELECT 1 FROM information_schema.table_constraints tc
                       JOIN information_schema.key_column_usage k
                         ON k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name
                       WHERE tc.constraint_type = 'PRIMARY KEY'
                         AND k.table_schema = c.table_schema AND k.table_name = c.table_name
                         AND k.column_name = c.column_name
                   ),
                   pg_catalog.col_description(cls.oid, c.ordinal_position)
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
            JOIN pg_catalog.pg_class cls ON cls.relnamespace = n.oid AND cls.relname = c.table_name
            WHERE c.table_schema IN :schemas AND t.table_type = 'BASE TABLE' {table_filter}
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
        """
        table_filter = "AND c.table_name = :table"
    params: Dict[str, Any] = {"schemas": list(databases)}
    if table is not None:
        params["table"] = table
    statement = text(sql.format(table_filter=table_filter if table is not None else "")).bindparams(
        bindparam("schemas", expanding=True)
    )
    with db.engine.connect() as conn:
        rows = conn.execute(statement, params).fetchall()
    for schema, table_name, column_name, data_type, column_type, is_pk, comment in rows:
        # MySQL 用 DATA_TYPE（不带长度）分类，COLUMN_TYPE 展示
        result.setdefault((schema, table_name), []).append({
            "name": column_name,
            "type": data_type if provider.id == "mysql" else column_type,
            "display_type": column_type,
            "comment": comment or "",
            "primary_key": bool(is_pk),
        })
    return result


def _split_patterns(value: Optional[str]) -> List[str]:
    return [p.lower() for p in re.split(r"[\s,，;；]+", value or "") if p]


def _name_matches(patterns: List[str], database: str, table: str) -> bool:
    """表名过滤：普通关键字按包含匹配，含 * ? 时按通配符匹配；同时匹配 表名 与 库.表。"""
    names = (table.lower(), f"{database}.{table}".lower())
    for pattern in patterns:
        if any(ch in pattern for ch in "*?"):
            if any(fnmatch.fnmatchcase(name, pattern) for name in names):
                return True
        elif any(pattern in name for name in names):
            return True
    return False


def _filter_tables(keys, include: Optional[str], exclude: Optional[str]):
    includes, excludes = _split_patterns(include), _split_patterns(exclude)
    return [
        key for key in keys
        if (not includes or _name_matches(includes, *key)) and not (excludes and _name_matches(excludes, *key))
    ]


_SQLGLOT_DIALECTS = {"mysql": "mysql", "postgresql": "postgres", "sqlite": "sqlite"}


def parse_where_filter(provider_id: str, where: Optional[str]) -> Tuple[Optional[str], List[str]]:
    """校验附加的 WHERE 过滤条件，返回 (条件, 条件里引用的本表字段名)。只允许单个条件表达式。"""
    value = (where or "").strip()
    if not value:
        return None, []
    if re.match(r"(?i)^where\b", value):
        value = value[5:].strip()
    if ";" in value:
        raise ValueError("过滤条件不能包含分号")
    try:
        statements = sqlglot.parse(f"SELECT * FROM dbdeck_t WHERE {value}", read=_SQLGLOT_DIALECTS[provider_id])
    except sqlglot.errors.SqlglotError as e:
        raise ValueError(f"过滤条件语法错误: {value}") from e
    if len(statements) != 1 or not isinstance(statements[0], exp.Select) or not statements[0].args.get("where"):
        raise ValueError(f"过滤条件无效: {value}")
    select = statements[0]
    extra_args = {k for k, v in select.args.items() if v and k not in ("expressions", "from", "from_", "where")}
    if extra_args:
        raise ValueError(f"过滤条件只能是条件表达式，不能包含 {', '.join(sorted(extra_args)).upper()}")
    columns = []
    for col in select.args["where"].find_all(exp.Column):
        # 只收集属于本表的字段，子查询里的字段不算
        if col.find_ancestor(exp.Select) is select and col.name and col.name not in columns:
            columns.append(col.name)
    return value, columns


def _candidate_columns(
    provider_id: str,
    columns: List[Dict[str, Any]],
    info: KeywordInfo,
    categories: Sequence[str],
    column_name: str,
) -> List[Dict[str, str]]:
    name_filter = (column_name or "").strip().lower()
    candidates = []
    for col in columns:
        category = classify_column_type(col["type"], provider_id)
        if category is None or category not in categories:
            continue
        if name_filter and name_filter not in str(col["name"]).lower():
            continue
        if category == "number" and info.number is None:
            continue
        if category == "datetime":
            kind = _datetime_kind(col["type"])
            if kind == "time" and info.time is None:
                continue
            if kind != "time" and info.date is None:
                continue
        candidates.append({
            "name": col["name"],
            "type": col.get("display_type") or col["type"],
            "category": category,
            "kind": _datetime_kind(col["type"]) if category == "datetime" else category,
        })
    return candidates


def _missing_filter_columns(columns: List[Dict[str, Any]], filter_columns: Sequence[str]) -> List[str]:
    names = {str(c["name"]).lower() for c in columns}
    return [c for c in filter_columns if c.lower() not in names]


def _normalize_options(categories, match_mode) -> Tuple[List[str], str]:
    categories = [c for c in (categories or CATEGORIES) if c in CATEGORIES] or list(CATEGORIES)
    return categories, match_mode if match_mode in MATCH_MODES else "contains"


# ---------------------------------------------------------------------------
# SQL 构建
# ---------------------------------------------------------------------------

def _escape_like(value: str) -> str:
    return (
        value.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
        .replace("%", LIKE_ESCAPE + "%")
        .replace("_", LIKE_ESCAPE + "_")
    )


def _sql_literal(provider_id: str, value: Any) -> str:
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return str(value)
    escaped = str(value).replace("'", "''")
    if provider_id == "mysql":
        escaped = escaped.replace("\\", "\\\\")
    return f"'{escaped}'"


def _quote(provider_id: str, identifier: str, *, for_text_clause: bool) -> str:
    quoted = quote_identifier(provider_id, identifier)
    # text() 会把 ":name" 当成绑定参数，标识符里的冒号需要转义
    return quoted.replace(":", "\\:") if for_text_clause else quoted


class _ParamSink:
    """收集绑定参数；literal 模式下直接渲染成 SQL 字面量（用于展示/复制的 SQL）。"""

    def __init__(self, provider_id: str, literal: bool) -> None:
        self.provider_id = provider_id
        self.literal = literal
        self.params: Dict[str, Any] = {}
        self._names: Dict[Tuple[str, Any], str] = {}

    def __call__(self, value: Any) -> str:
        if self.literal:
            return _sql_literal(self.provider_id, value)
        key = (type(value).__name__, value)
        name = self._names.get(key)
        if name is None:
            name = f"p{len(self._names)}"
            self._names[key] = name
            self.params[name] = value
        return f":{name}"


def _string_condition(provider_id: str, col_sql: str, info: KeywordInfo, match_mode: str, bind: Callable[[Any], str]) -> str:
    target = f"CAST({col_sql} AS TEXT)" if provider_id == "postgresql" else col_sql
    op = "ILIKE" if provider_id == "postgresql" else "LIKE"
    if match_mode == "contains":
        patterns = [f"%{_escape_like(v)}%" for v in date_text_variants(info)]
    elif match_mode == "prefix":
        patterns = [f"{_escape_like(info.text)}%"]
    else:
        patterns = [_escape_like(info.text)]
    parts = [f"{target} {op} {bind(p)} ESCAPE '{LIKE_ESCAPE}'" for p in patterns]
    return parts[0] if len(parts) == 1 else "(" + " OR ".join(parts) + ")"


def _number_value(provider_id: str, number: Decimal) -> Any:
    if number == number.to_integral_value():
        return int(number)
    # sqlite3 驱动不支持 Decimal 参数
    return float(number) if provider_id == "sqlite" else number


def _range_condition(expr: str, start: str, end: Optional[str], bind: Callable[[Any], str]) -> str:
    if end is None:
        return f"{expr} >= {bind(start)}"
    return f"({expr} >= {bind(start)} AND {expr} < {bind(end)})"


def _datetime_condition(provider_id: str, col_sql: str, kind: str, info: KeywordInfo, bind: Callable[[Any], str]) -> str:
    if kind == "time":
        expr = f"time({col_sql})" if provider_id == "sqlite" else col_sql
        return _range_condition(expr, info.time.start, info.time.end, bind)
    start, end = info.date.start, info.date.end
    if kind == "date":
        # DATE 字段没有时分秒，关键字带时间时按所在的整天匹配
        day = start.date()
        if info.date.precision == "month":
            day_end = end.date() if end else None
        else:
            day_end = day + timedelta(days=1) if day < date.max else None
        if provider_id == "sqlite":
            return _range_condition(f"date({col_sql})", day.isoformat(), day_end.isoformat() if day_end else None, bind)
        return _range_condition(col_sql, day.isoformat(), day_end.isoformat() if day_end else None, bind)
    expr = f"datetime({col_sql})" if provider_id == "sqlite" else col_sql
    return _range_condition(expr, _format_datetime(start), _format_datetime(end) if end else None, bind)


def _column_condition(provider_id: str, column: Dict[str, str], info: KeywordInfo, match_mode: str, bind, *, for_text_clause: bool) -> str:
    col_sql = _quote(provider_id, column["name"], for_text_clause=for_text_clause)
    if column["category"] == "string":
        return _string_condition(provider_id, col_sql, info, match_mode, bind)
    if column["category"] == "number":
        return f"{col_sql} = {bind(_number_value(provider_id, info.number))}"
    return _datetime_condition(provider_id, col_sql, column["kind"], info, bind)


def _relation_sql(provider_id: str, database: str, table: str, *, for_text_clause: bool) -> str:
    table_sql = _quote(provider_id, table, for_text_clause=for_text_clause)
    if provider_id == "sqlite":
        return table_sql
    return f"{_quote(provider_id, database, for_text_clause=for_text_clause)}.{table_sql}"


def build_search_sql(
    provider_id: str,
    database: str,
    table: str,
    columns: List[Dict[str, str]],
    info: KeywordInfo,
    match_mode: str,
    *,
    limit: Optional[int] = None,
    literal: bool = False,
    with_match_flags: bool = False,
    where_filter: Optional[str] = None,
) -> Tuple[str, Dict[str, Any]]:
    """构建单表搜索 SQL。literal=True 时生成可直接复制执行的 SQL（不带 LIMIT 与命中标记列）。

    where_filter 是已经过 parse_where_filter 校验的附加条件，以 AND 拼接。
    """
    for_text_clause = not literal
    bind = _ParamSink(provider_id, literal)
    conditions = [
        _column_condition(provider_id, col, info, match_mode, bind, for_text_clause=for_text_clause)
        for col in columns
    ]
    select_items = ["*"]
    if with_match_flags:
        select_items = ["dbdeck_t.*"] + [
            f"CASE WHEN {cond} THEN 1 ELSE 0 END AS {MATCH_FLAG_PREFIX}{index}"
            for index, cond in enumerate(conditions)
        ]
    hint = f"/*+ MAX_EXECUTION_TIME({STATEMENT_TIMEOUT_MS}) */ " if provider_id == "mysql" and not literal else ""
    relation = _relation_sql(provider_id, database, table, for_text_clause=for_text_clause)
    alias = " AS dbdeck_t" if with_match_flags else ""
    where = "\n   OR ".join(conditions)
    if where_filter:
        # text() 会把 ":name" 当成绑定参数，过滤条件里的冒号原样保留
        filter_sql = where_filter.replace(":", "\\:") if for_text_clause else where_filter
        where = f"({where})\n  AND ({filter_sql})"
    sql = f"SELECT {hint}{', '.join(select_items)}\nFROM {relation}{alias}\nWHERE {where}"
    if limit is not None:
        sql += f"\nLIMIT {int(limit)}"
    return sql, bind.params


def _record_id(columns: List[str], values: List[Any], pk_columns: List[str]) -> str:
    """记录 ID：取主键值（联合主键用逗号拼接）；没有主键时用 "第一个字段: 值"。"""
    index = {name: i for i, name in enumerate(columns)}
    if pk_columns and all(name in index for name in pk_columns):
        return ", ".join(str(serialize_value(values[index[name]])) for name in pk_columns)
    if columns:
        return f"{columns[0]}: {serialize_value(values[0])}"
    return ""


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------

def list_databases(source_id: int) -> Dict[str, Any]:
    try:
        with managed_source(source_id) as (provider, db):
            _require_supported(provider)
            names, current = _list_databases(provider, db)
            return {"success": True, "databases": names, "current": current, "provider": provider.id}
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def list_tables(
    source_id: int,
    databases: Optional[Sequence[str]] = None,
    table_include: str = "",
    table_exclude: str = "",
) -> Dict[str, Any]:
    """预览会被搜索的表（已应用表名包含/不包含过滤）。"""
    try:
        with managed_source(source_id) as (provider, db):
            _require_supported(provider)
            targets = _resolve_databases(provider, db, databases)
            columns = _load_columns(provider, db, targets)
        keys = _filter_tables(sorted(columns), table_include, table_exclude)
        return {
            "success": True,
            "databases": targets,
            "total": len(columns),
            "tables": [{"database": d, "table": t} for d, t in keys],
        }
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def plan_search(
    source_id: int,
    keyword: str,
    databases: Optional[Sequence[str]] = None,
    table_include: str = "",
    table_exclude: str = "",
    column_types: Optional[Sequence[str]] = None,
    column_name: str = "",
    match_mode: str = "contains",
    where: str = "",
) -> Dict[str, Any]:
    try:
        info = parse_keyword(keyword)
        categories, match_mode = _normalize_options(column_types, match_mode)
        with managed_source(source_id) as (provider, db):
            _require_supported(provider)
            where_filter, filter_columns = parse_where_filter(provider.id, where)
            targets_db = _resolve_databases(provider, db, databases)
            columns_by_table = _load_columns(provider, db, targets_db)
        keys = _filter_tables(sorted(columns_by_table), table_include, table_exclude)
        targets, skipped_by_filter = [], []
        for database, table_name in keys:
            columns = columns_by_table[(database, table_name)]
            missing = _missing_filter_columns(columns, filter_columns)
            if missing:
                skipped_by_filter.append({"database": database, "table": table_name, "missing": missing})
                continue
            candidates = _candidate_columns(provider.id, columns, info, categories, column_name)
            if candidates:
                targets.append({"database": database, "table": table_name, "columns": candidates})
        warnings = []
        if categories == ["number"] and info.number is None:
            warnings.append("关键字不是数字，数字字段不会参与搜索")
        if categories == ["datetime"] and info.date is None and info.time is None:
            warnings.append("关键字不是可识别的日期/时间（如 2024-01、2024-01-15、2024-01-15 10:30、10:30），日期字段不会参与搜索")
        if skipped_by_filter:
            warnings.append(f"{len(skipped_by_filter)} 张表缺少过滤条件里的字段，已跳过")
        return {
            "success": True,
            "databases": targets_db,
            "keyword": info.to_dict(),
            "match_mode": match_mode,
            "where": where_filter,
            "table_count": len(keys),
            "targets": targets,
            "skipped_by_filter": skipped_by_filter,
            "warnings": warnings,
        }
    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def search_table(
    source_id: int,
    database: str,
    table: str,
    keyword: str,
    column_types: Optional[Sequence[str]] = None,
    column_name: str = "",
    match_mode: str = "contains",
    where: str = "",
    limit: Optional[int] = 50,
) -> Dict[str, Any]:
    """搜索单张表。limit 为空或 <= 0 表示不限制返回行数。"""
    start = time.perf_counter()
    base = {"database": database, "table": table}
    try:
        info = parse_keyword(keyword)
        categories, match_mode = _normalize_options(column_types, match_mode)
        limit = None if not limit or int(limit) <= 0 else int(limit)
        with managed_source(source_id) as (provider, db):
            _require_supported(provider)
            where_filter, filter_columns = parse_where_filter(provider.id, where)
            _check_database_name(provider.id, database)
            columns = _load_columns(provider, db, [database], table).get((database, table))
            if columns is None:
                return {**base, "success": False, "error": f"表不存在: {database}.{table}"}
            missing = _missing_filter_columns(columns, filter_columns)
            if missing:
                return {**base, "success": False, "error": f"表中没有过滤条件里的字段: {', '.join(missing)}"}
            candidates = _candidate_columns(provider.id, columns, info, categories, column_name)
            if not candidates:
                return {**base, "success": True, "columns": [], "rows": [], "matched": [], "record_ids": [],
                        "has_more": False, "sql": "", "duration_ms": 0}
            sql, params = build_search_sql(
                provider.id, database, table, candidates, info, match_mode,
                limit=None if limit is None else limit + 1, with_match_flags=True, where_filter=where_filter,
            )
            with db.engine.connect() as conn:
                if provider.id == "postgresql":
                    conn.execute(text(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"))
                result = conn.execute(text(sql), params)
                all_columns = list(result.keys())
                raw_rows = result.fetchall()
                conn.rollback()
        data_width = len(all_columns) - len(candidates)
        data_columns = all_columns[:data_width]
        pk_columns = [c["name"] for c in columns if c.get("primary_key")]
        rows, matched, record_ids = [], [], []
        for raw in raw_rows if limit is None else raw_rows[:limit]:
            values = list(raw)
            rows.append(serialize_row(values[:data_width]))
            flags = values[data_width:]
            matched.append([candidates[i]["name"] for i, flag in enumerate(flags) if int(flag or 0) == 1])
            record_ids.append(_record_id(data_columns, values[:data_width], pk_columns))
        display_sql, _ = build_search_sql(
            provider.id, database, table, candidates, info, match_mode, literal=True, where_filter=where_filter,
        )
        return {
            **base,
            "success": True,
            "columns": data_columns,
            "column_comments": {c["name"]: c.get("comment") or "" for c in columns},
            "primary_key": pk_columns,
            "search_columns": [c["name"] for c in candidates],
            "rows": rows,
            "matched": matched,
            "record_ids": record_ids,
            "has_more": limit is not None and len(raw_rows) > limit,
            "sql": display_sql,
            "duration_ms": round((time.perf_counter() - start) * 1000, 2),
        }
    except Exception as e:
        return {
            **base,
            "success": False,
            "error": redact_sensitive(e),
            "duration_ms": round((time.perf_counter() - start) * 1000, 2),
        }
