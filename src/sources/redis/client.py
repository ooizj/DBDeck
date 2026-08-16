"""Redis 客户端。"""
from __future__ import annotations

import logging
import shlex
import time
from typing import Any, Dict, List, Optional

from src.common.errors import redact_sensitive, secrets_from_config
from src.sources.base import DataSourceClient
from src.sources.operation_policy import classify_redis
from src.sources.ssh_tunnel import close_ssh_tunnel, open_ssh_tunnel

try:
    import redis
except ImportError:
    redis = None

logger = logging.getLogger(__name__)


def _db_index(config_dict: Dict[str, Any]) -> int:
    raw = config_dict.get("database")
    if raw in (None, ""):
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _display_ttl(ttl: int) -> str:
    if ttl == -2:
        return "missing"
    if ttl == -1:
        return "persistent"
    return f"{ttl}s"


def _stringify(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (list, tuple, set)):
        return [_stringify(item) for item in value]
    if isinstance(value, dict):
        return {_stringify(k): _stringify(v) for k, v in value.items()}
    return value


def _clean_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _redis_connection_kwargs(
    config_dict: Dict[str, Any],
    *,
    host: str,
    port: int,
    include_db: bool = True,
) -> Dict[str, Any]:
    username = _clean_str(config_dict.get("user"))
    if username and username.lower() == "default":
        username = None

    kwargs: Dict[str, Any] = {
        "host": host,
        "port": port,
        "password": _clean_str(config_dict.get("password")),
        "socket_connect_timeout": 5,
        "socket_timeout": 10 if include_db else 5,
        "decode_responses": True,
        "protocol": 2,
    }
    if include_db:
        kwargs["db"] = _db_index(config_dict)
    if username:
        kwargs["username"] = username
    return kwargs


class RedisClient(DataSourceClient):
    def __init__(self, config_dict: Dict[str, Any]) -> None:
        if not redis:
            raise ImportError("redis 未安装，请先 pip install redis")
        self.config = config_dict
        self.database_name = str(_db_index(config_dict))
        host = config_dict.get("host") or "localhost"
        port = int(config_dict.get("port") or 6379)
        host, port, self._ssh_tunnel = open_ssh_tunnel(
            config_dict, host, port, label="Redis"
        )
        self.client = redis.Redis(**_redis_connection_kwargs(
            config_dict,
            host=host,
            port=port,
            include_db=True,
        ))

    def execute(
        self, query: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        total_start = time.perf_counter()
        statements = self._split_commands(query)
        statement_results: List[Dict[str, Any]] = []
        if not statements:
            return {
                "success": False,
                "error": "Redis 命令不能为空",
                "error_msg": "Redis 命令不能为空",
                "statements": [],
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }

        last_payload: Dict[str, Any] = {
            "success": True,
            "columns": [],
            "column_metadata": {},
            "data": [],
            "row_count": 0,
        }
        for index, statement in enumerate(statements):
            statement_start = time.perf_counter()
            payload = self._execute_one(statement, statement_start)
            payload.setdefault("columns", [])
            payload.setdefault("column_metadata", {})
            payload.setdefault("data", [])
            payload.setdefault("row_count", len(payload.get("data") or []))
            payload.setdefault("affected_rows", None)
            payload.setdefault(
                "duration_ms", round((time.perf_counter() - statement_start) * 1000, 2)
            )
            payload["statement_index"] = index
            payload["sql"] = statement
            payload["executed_query"] = statement
            payload["operation_kind"] = classify_redis(statement).kind
            statement_results.append(dict(payload))
            last_payload = payload
            if not payload.get("success"):
                return {
                    **payload,
                    "statements": statement_results,
                    "active_statement_index": index,
                    "duration_ms": round(
                        (time.perf_counter() - total_start) * 1000, 2
                    ),
                }

        readable_indexes = [
            idx for idx, item in enumerate(statement_results) if item.get("columns")
        ]
        active_index = readable_indexes[-1] if readable_indexes else len(statement_results) - 1
        return {
            **last_payload,
            "statements": statement_results,
            "active_statement_index": active_index,
            "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
        }

    def _execute_one(self, statement: str, statement_start: float) -> Dict[str, Any]:
        try:
            args = shlex.split(statement, posix=True)
        except ValueError as e:
            return self._with_duration(
                {
                    "success": False,
                    "error": f"Redis 命令解析失败: {e}",
                    "error_msg": f"Redis 命令解析失败: {e}",
                },
                statement_start,
            )
        if not args:
            return self._with_duration(
                {
                    "success": False,
                    "error": "Redis 命令不能为空",
                    "error_msg": "Redis 命令不能为空",
                },
                statement_start,
            )

        command = args[0].upper()
        try:
            raw = self.client.execute_command(*args)
            return self._with_duration(
                self._format_result(command, args[1:], _stringify(raw)),
                statement_start,
            )
        except Exception as e:
            safe_error = redact_sensitive(e, secrets_from_config(self.config))
            logger.error("Redis error: %s", safe_error)
            return self._with_duration(
                {"success": False, "error": safe_error, "error_msg": safe_error},
                statement_start,
            )

    @staticmethod
    def _with_duration(payload: Dict[str, Any], statement_start: float) -> Dict[str, Any]:
        payload["duration_ms"] = round((time.perf_counter() - statement_start) * 1000, 2)
        return payload

    def _format_result(self, command: str, args: List[str], value: Any) -> Dict[str, Any]:
        if command == "GET":
            return {
                "success": True,
                "columns": ["key", "value"],
                "data": [[args[0] if args else "", value]],
                "row_count": 1,
            }
        if command == "MGET":
            values = value if isinstance(value, list) else []
            return {
                "success": True,
                "columns": ["key", "value"],
                "data": [[key, values[idx] if idx < len(values) else None] for idx, key in enumerate(args)],
                "row_count": len(args),
            }
        if command in {"HGETALL", "HSCAN"}:
            if command == "HSCAN" and isinstance(value, (list, tuple)) and len(value) == 2:
                value = value[1]
            rows = self._dict_rows(value, "field", "value")
            return {"success": True, "columns": ["field", "value"], "data": rows, "row_count": len(rows)}
        if command in {"ZRANGE", "ZRANGEBYSCORE"} and any(
            str(arg).upper() == "WITHSCORES" for arg in args
        ):
            values = self._iterable_values(value)
            if values and isinstance(values[0], (list, tuple)) and len(values[0]) == 2:
                rows = [[item[0], item[1]] for item in values]
            else:
                rows = []
                for idx in range(0, len(values), 2):
                    rows.append([values[idx], values[idx + 1] if idx + 1 < len(values) else None])
            return {"success": True, "columns": ["member", "score"], "data": rows, "row_count": len(rows)}
        if command in {"XRANGE", "XREVRANGE"}:
            rows = []
            for item in self._iterable_values(value):
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    rows.append([item[0], item[1]])
                else:
                    rows.append(["", item])
            return {"success": True, "columns": ["id", "fields"], "data": rows, "row_count": len(rows)}
        if command in {"LRANGE", "ZRANGE", "ZRANGEBYSCORE", "SMEMBERS", "SCAN", "SSCAN", "ZSCAN", "KEYS"}:
            values = self._iterable_values(value)
            columns = ["index", "value"]
            if command in {"SCAN", "KEYS"}:
                columns = ["key", "type", "ttl"]
                keys = values
                rows = [[key, self._safe_type(key), _display_ttl(self._safe_ttl(key))] for key in keys]
                return {"success": True, "columns": columns, "data": rows, "row_count": len(rows)}
            rows = [[idx, item] for idx, item in enumerate(values)]
            return {"success": True, "columns": columns, "data": rows, "row_count": len(rows)}
        if command == "INFO" and isinstance(value, dict):
            rows = []
            for key, item in value.items():
                if isinstance(item, dict):
                    rows.extend([[key, sub_key, sub_val] for sub_key, sub_val in item.items()])
                else:
                    rows.append(["", key, item])
            return {"success": True, "columns": ["section", "key", "value"], "data": rows, "row_count": len(rows)}
        if command in {"TYPE", "TTL", "PTTL", "EXISTS", "DBSIZE"}:
            return {"success": True, "columns": ["result"], "data": [[value]], "row_count": 1}

        affected = value if isinstance(value, int) else 1
        if isinstance(value, (list, tuple, set, dict)):
            rows = self._generic_rows(value)
            return {"success": True, "columns": ["key", "value"], "data": rows, "row_count": len(rows)}
        return {
            "success": True,
            "message": str(value),
            "row_count": affected,
            "affected_rows": affected,
        }

    @staticmethod
    def _dict_rows(value: Any, key_label: str, value_label: str) -> List[List[Any]]:
        if isinstance(value, dict):
            return [[key, item] for key, item in value.items()]
        if isinstance(value, list):
            return [[value[idx], value[idx + 1] if idx + 1 < len(value) else None] for idx in range(0, len(value), 2)]
        return []

    @staticmethod
    def _iterable_values(value: Any) -> List[Any]:
        if isinstance(value, tuple) and len(value) == 2 and isinstance(value[1], list):
            return value[1]
        if isinstance(value, set):
            return sorted(value)
        if isinstance(value, list):
            return value
        return [value] if value is not None else []

    @staticmethod
    def _generic_rows(value: Any) -> List[List[Any]]:
        if isinstance(value, dict):
            return [[key, item] for key, item in value.items()]
        if isinstance(value, (list, tuple, set)):
            return [[idx, item] for idx, item in enumerate(value)]
        return [["result", value]]

    def _safe_type(self, key: str) -> str:
        try:
            return str(self.client.type(key))
        except Exception:
            return "unknown"

    def _safe_ttl(self, key: str) -> int:
        try:
            return int(self.client.ttl(key))
        except Exception:
            return -2

    def _safe_length(self, key: str, key_type: str) -> Optional[int]:
        try:
            if key_type == "string":
                return self.client.strlen(key)
            if key_type == "hash":
                return self.client.hlen(key)
            if key_type == "list":
                return self.client.llen(key)
            if key_type == "set":
                return self.client.scard(key)
            if key_type == "zset":
                return self.client.zcard(key)
            if key_type == "stream":
                return self.client.xlen(key)
        except Exception:
            return None
        return None

    @staticmethod
    def _split_commands(query: str) -> List[str]:
        statements: List[str] = []
        current: List[str] = []
        quote: Optional[str] = None
        escape = False
        for char in query or "":
            if escape:
                current.append(char)
                escape = False
                continue
            if char == "\\":
                current.append(char)
                escape = True
                continue
            if quote:
                current.append(char)
                if char == quote:
                    quote = None
                continue
            if char in {"'", '"'}:
                current.append(char)
                quote = char
                continue
            if char in {";", "\n", "\r"}:
                text = "".join(current).strip()
                if text and not text.startswith("#"):
                    statements.append(text)
                current = []
                continue
            current.append(char)
        text = "".join(current).strip()
        if text and not text.startswith("#"):
            statements.append(text)
        return statements

    def get_schema(self, pattern: str = "*") -> Dict[str, Any]:
        self.client.ping()
        schema: Dict[str, Any] = {}
        cursor = 0
        keys_to_describe: List[str] = []
        max_keys = 200
        key_pattern = (pattern or "*").strip() or "*"
        try:
            while True:
                cursor, keys = self.client.scan(
                    cursor=cursor,
                    match=key_pattern,
                    count=500,
                )
                for key in keys:
                    keys_to_describe.append(key)
                    if len(keys_to_describe) >= max_keys:
                        break
                if len(keys_to_describe) >= max_keys:
                    break
                if cursor == 0:
                    break

            types: List[Any] = []
            ttls: List[Any] = []
            if keys_to_describe:
                try:
                    pipe = self.client.pipeline(transaction=False)
                    for key in keys_to_describe:
                        pipe.type(key)
                        pipe.ttl(key)
                    values = pipe.execute()
                    types = values[0::2]
                    ttls = values[1::2]
                except Exception:
                    types = [self._safe_type(key) for key in keys_to_describe]
                    ttls = [self._safe_ttl(key) for key in keys_to_describe]

            for idx, key in enumerate(keys_to_describe):
                key_type = str(_stringify(types[idx])) if idx < len(types) else self._safe_type(key)
                ttl = ttls[idx] if idx < len(ttls) else self._safe_ttl(key)
                schema[str(key)] = [
                    {"name": "type", "type": key_type, "nullable": False, "comment": ""},
                    {"name": "ttl", "type": _display_ttl(int(ttl)), "nullable": True, "comment": ""},
                    {"name": "length", "type": "", "nullable": True, "comment": "打开 key 后加载"},
                ]
        except Exception as e:
            logger.error(
                "Failed to scan redis keys: %s",
                redact_sensitive(e, secrets_from_config(self.config)),
            )
        return schema

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass
        finally:
            close_ssh_tunnel(getattr(self, "_ssh_tunnel", None))
            self._ssh_tunnel = None


def list_redis_databases(config_dict: Dict[str, Any]) -> List[str]:
    if not redis:
        return []
    tunnel = None
    host = config_dict.get("host") or "localhost"
    port = int(config_dict.get("port") or 6379)
    host, port, tunnel = open_ssh_tunnel(config_dict, host, port, label="Redis")
    client = redis.Redis(**_redis_connection_kwargs(
        config_dict,
        host=host,
        port=port,
        include_db=False,
    ))
    try:
        db_count = 16
        try:
            db_count = int(client.config_get("databases").get("databases", db_count))
        except Exception:
            pass
        used = set()
        try:
            info = client.info("keyspace")
            for name in info:
                if str(name).startswith("db"):
                    used.add(str(name)[2:])
        except Exception:
            pass
        return sorted({str(i) for i in range(db_count)} | used, key=lambda item: int(item))
    except Exception as e:
        logger.warning(
            "Failed to list redis databases: %s",
            redact_sensitive(e, secrets_from_config(config_dict)),
        )
        return [str(_db_index(config_dict))]
    finally:
        try:
            client.close()
        finally:
            close_ssh_tunnel(tunnel)
