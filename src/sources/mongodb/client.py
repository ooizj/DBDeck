"""MongoDB 客户端。"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

from src.common.sql_utils import serialize_row
from src.sources.base import DataSourceClient
from src.sources.ssh_tunnel import close_ssh_tunnel, open_ssh_tunnel

try:
    import pymongo
except ImportError:
    pymongo = None

logger = logging.getLogger(__name__)

_ACTION_ALIASES = {
    "insertOne": "insert_one",
    "insert": "insert_one",
    "updateOne": "update_one",
    "updateMany": "update_many",
    "deleteOne": "delete_one",
    "deleteMany": "delete_many",
    "countDocuments": "count",
    "count_documents": "count",
}


def _build_uri(config_dict: Dict[str, Any], *, use_auth_source_in_path: bool = False) -> str:
    user = config_dict.get("user")
    password = config_dict.get("password")
    host = config_dict.get("host", "localhost")
    port = config_dict.get("port", 27017)
    db_name = config_dict.get("database", "test")
    direct = config_dict.get("direct_connection", True)
    if direct is None:
        direct = True
    auth_source = config_dict.get("auth_source")
    path_db = (auth_source or "admin") if use_auth_source_in_path else db_name

    if user:
        creds = quote_plus(user) + (f":{quote_plus(password)}" if password else "")
        uri = f"mongodb://{creds}@{host}:{port}/{path_db}"
    else:
        uri = f"mongodb://{host}:{port}/"

    params = ["retryWrites=false"]
    if direct:
        params.append("directConnection=true")
    if auth_source and not use_auth_source_in_path:
        params.append(f"authSource={auth_source}")

    sep = "&" if "?" in uri else "?"
    return uri + sep + "&".join(params)


class MongoDBClient(DataSourceClient):
    def __init__(self, config_dict: Dict[str, Any]) -> None:
        if not pymongo:
            raise ImportError("pymongo 未安装，请先 pip install pymongo")
        self.config = dict(config_dict)
        host = self.config.get("host", "localhost")
        port = int(self.config.get("port") or 27017)
        host, port, self._ssh_tunnel = open_ssh_tunnel(
            self.config, host, port, label="MongoDB"
        )
        self.config["host"] = host
        self.config["port"] = port
        self.database_name = config_dict.get("database", "test")
        uri = _build_uri(self.config)
        self.client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000)
        self.db = self.client[self.database_name]

    def execute(
        self, query: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        total_start = time.perf_counter()
        statement_results: List[Dict[str, Any]] = []
        try:
            parsed_statements = self._parse_queries(query)
        except ValueError as e:
            return {
                "success": False,
                "error": str(e),
                "error_msg": str(e),
                "statements": statement_results,
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"解析失败: {e}",
                "error_msg": f"解析失败: {e}",
                "statements": statement_results,
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }

        if not parsed_statements:
            return {
                "success": False,
                "error": "MongoDB 命令不能为空",
                "error_msg": "MongoDB 命令不能为空",
                "statements": statement_results,
                "duration_ms": round((time.perf_counter() - total_start) * 1000, 2),
            }

        last_payload: Dict[str, Any] = {
            "success": True,
            "columns": [],
            "column_metadata": {},
            "data": [],
            "row_count": 0,
        }
        for index, (statement_text, cmd) in enumerate(parsed_statements):
            statement_start = time.perf_counter()
            payload = self._execute_command(cmd, statement_start)
            action = _ACTION_ALIASES.get(
                cmd.get("action", "find"), cmd.get("action", "find")
            )
            payload.setdefault("columns", [])
            payload.setdefault("column_metadata", {})
            payload.setdefault("data", [])
            payload.setdefault("row_count", len(payload.get("data") or []))
            payload.setdefault("affected_rows", None)
            payload.setdefault("duration_ms", round((time.perf_counter() - statement_start) * 1000, 2))
            payload["statement_index"] = index
            payload["sql"] = statement_text
            payload["executed_query"] = statement_text
            payload["operation_kind"] = self._operation_kind_for_action(action)
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

    def _execute_command(
        self, cmd: Dict[str, Any], statement_start: float
    ) -> Dict[str, Any]:
        collection_name = cmd.get("collection")
        action = _ACTION_ALIASES.get(cmd.get("action", "find"), cmd.get("action", "find"))
        filter_query = cmd.get("filter", {})
        limit = cmd.get("limit", 100)

        if not collection_name:
            return {
                "success": False,
                "error": "必须提供 collection 字段",
                "error_msg": "必须提供 collection 字段",
                "duration_ms": round((time.perf_counter() - statement_start) * 1000, 2),
            }

        try:
            def with_duration(payload: Dict[str, Any]) -> Dict[str, Any]:
                payload["duration_ms"] = round(
                    (time.perf_counter() - statement_start) * 1000, 2
                )
                return payload

            coll = self.db[collection_name]
            if action == "find":
                cursor = coll.find(filter_query)
                if "sort" in cmd:
                    sort_val = cmd["sort"]
                    if isinstance(sort_val, dict):
                        sort_list = list(sort_val.items())
                    elif isinstance(sort_val, list):
                        sort_list = [tuple(item) if isinstance(item, list) else item for item in sort_val]
                    elif isinstance(sort_val, str):
                        sort_list = [(sort_val, 1)]
                    else:
                        sort_list = sort_val
                    cursor = cursor.sort(sort_list)
                if "skip" in cmd:
                    cursor = cursor.skip(cmd["skip"])
                cursor = cursor.limit(cmd.get("limit", limit))
                rows = [serialize_row(doc) for doc in cursor]
                columns: List[str] = []
                if rows:
                    keys_set: set[str] = set()
                    for row in rows:
                        keys_set.update(row.keys())
                    columns = sorted(keys_set)
                return with_duration({
                    "success": True,
                    "columns": columns,
                    "data": [[row.get(col) for col in columns] for row in rows],
                    "row_count": len(rows),
                })
            if action == "count":
                cnt = coll.count_documents(filter_query)
                return with_duration({
                    "success": True,
                    "columns": ["count"],
                    "data": [[cnt]],
                    "row_count": 1,
                })
            if action == "insert_one":
                doc = cmd.get("document", {})
                result = coll.insert_one(doc)
                return with_duration({
                    "success": True,
                    "message": f"Inserted with ID: {result.inserted_id}",
                    "inserted_id": str(result.inserted_id),
                    "row_count": 1,
                    "affected_rows": 1,
                })
            if action == "update_one":
                update_data = cmd.get("update", {})
                result = coll.update_one(filter_query, update_data)
                return with_duration({
                    "success": True,
                    "matched_count": result.matched_count,
                    "modified_count": result.modified_count,
                    "row_count": result.modified_count,
                    "affected_rows": result.modified_count,
                })
            if action == "update_many":
                update_data = cmd.get("update", {})
                result = coll.update_many(filter_query, update_data)
                return with_duration({
                    "success": True,
                    "matched_count": result.matched_count,
                    "modified_count": result.modified_count,
                    "row_count": result.modified_count,
                    "affected_rows": result.modified_count,
                })
            if action == "delete_one":
                result = coll.delete_one(filter_query)
                return with_duration({
                    "success": True,
                    "deleted_count": result.deleted_count,
                    "row_count": result.deleted_count,
                    "affected_rows": result.deleted_count,
                })
            if action == "delete_many":
                result = coll.delete_many(filter_query)
                return with_duration({
                    "success": True,
                    "deleted_count": result.deleted_count,
                    "row_count": result.deleted_count,
                    "affected_rows": result.deleted_count,
                })
            if action == "drop":
                result = coll.drop()
                return with_duration({"success": True, "dropped": bool(result)})
            if action == "aggregate":
                pipeline = cmd.get("pipeline", [])
                options = cmd.get("options", {})
                cursor = coll.aggregate(pipeline, **options)
                rows = [serialize_row(doc) for doc in cursor]
                columns: List[str] = []
                if rows:
                    keys_set: set[str] = set()
                    for row in rows:
                        keys_set.update(row.keys())
                    columns = sorted(keys_set)
                return with_duration({
                    "success": True,
                    "columns": columns,
                    "data": [[row.get(col) for col in columns] for row in rows],
                    "row_count": len(rows),
                })
            if action == "distinct":
                key = cmd.get("key")
                if not key:
                    return with_duration({
                        "success": False,
                        "error": "distinct 操作必须指定 key",
                        "error_msg": "distinct 操作必须指定 key",
                    })
                filter_query = cmd.get("filter", {})
                values = coll.distinct(key, filter_query)
                return with_duration({
                    "success": True,
                    "columns": [key],
                    "data": [[val] for val in values],
                    "row_count": len(values),
                })
            return with_duration({
                "success": False,
                "error": f"不支持的 action: {action}",
                "error_msg": f"不支持的 action: {action}",
            })
        except Exception as e:
            logger.error(f"MongoDB error: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "error_msg": str(e),
                "duration_ms": round((time.perf_counter() - statement_start) * 1000, 2),
            }

    @staticmethod
    def _operation_kind_for_action(action: str) -> str:
        normalized = str(action or "find").replace("_", "").lower()
        if normalized in {
            "find",
            "count",
            "countdocuments",
            "distinct",
            "aggregate",
        }:
            return "read"
        if normalized in {"insert", "insertone", "updateone", "updatemany"}:
            return "write"
        if normalized in {"deleteone", "deletemany", "drop"}:
            return "destructive"
        return "unknown"

    @staticmethod
    def _clean_js_object(s: str) -> str:
        s = re.sub(r"'([^'\\]*(?:\\.[^'\\]*)*)'", r'"\1"', s)
        s = re.sub(r'([{,]\s*)([a-zA-Z0-9_$]+)\s*:', r'\1"\2":', s)
        return s

    @staticmethod
    def _parse_arguments_string(arg_str: str) -> List[Any]:
        arg_str = arg_str.strip()
        if not arg_str:
            return []
        
        args = []
        idx = 0
        start_idx = 0
        brace_count = 0
        bracket_count = 0
        paren_count = 0
        in_string = None
        escape = False
        
        while idx < len(arg_str):
            c = arg_str[idx]
            if escape:
                escape = False
                idx += 1
                continue
            if c == '\\':
                escape = True
                idx += 1
                continue
            
            if in_string:
                if c == in_string:
                    in_string = None
            else:
                if c in ("'", '"'):
                    in_string = c
                elif c == '{':
                    brace_count += 1
                elif c == '}':
                    brace_count -= 1
                elif c == '[':
                    bracket_count += 1
                elif c == ']':
                    bracket_count -= 1
                elif c == '(':
                    paren_count += 1
                elif c == ')':
                    paren_count -= 1
                elif c == ',' and brace_count == 0 and bracket_count == 0 and paren_count == 0:
                    args.append(arg_str[start_idx:idx].strip())
                    start_idx = idx + 1
            idx += 1
        
        args.append(arg_str[start_idx:idx].strip())
        
        parsed_args = []
        for arg in args:
            if not arg:
                continue
            cleaned = MongoDBClient._clean_js_object(arg)
            try:
                parsed_args.append(json.loads(cleaned))
            except Exception:
                if arg.lower() == 'true':
                    parsed_args.append(True)
                elif arg.lower() == 'false':
                    parsed_args.append(False)
                elif arg.lower() == 'null':
                    parsed_args.append(None)
                else:
                    if arg.startswith('{') or arg.startswith('['):
                        raise ValueError(f"语法错误: 无法解析的对象或列表: {arg}")
                    if (arg.startswith('"') and arg.endswith('"')) or (arg.startswith("'") and arg.endswith("'")):
                        parsed_args.append(arg[1:-1])
                    else:
                        try:
                            if '.' in arg:
                                parsed_args.append(float(arg))
                            else:
                                parsed_args.append(int(arg))
                        except ValueError:
                            parsed_args.append(arg)
        return parsed_args

    @staticmethod
    def _next_starts_statement(query: str, index: int) -> bool:
        while index < len(query) and query[index].isspace():
            index += 1
        return query.startswith("db.", index) or query.startswith("{", index)

    @staticmethod
    def _split_query_statements(query: str) -> List[str]:
        statements: List[str] = []
        start = 0
        brace_count = 0
        bracket_count = 0
        paren_count = 0
        in_string = None
        escape = False

        def push(end: int) -> None:
            text = query[start:end].strip()
            if text:
                statements.append(text)

        idx = 0
        while idx < len(query):
            char = query[idx]
            if escape:
                escape = False
                idx += 1
                continue
            if char == "\\":
                escape = True
                idx += 1
                continue

            if in_string:
                if char == in_string:
                    in_string = None
            else:
                if char in ("'", '"'):
                    in_string = char
                elif char == "{":
                    brace_count += 1
                elif char == "}":
                    brace_count = max(brace_count - 1, 0)
                elif char == "[":
                    bracket_count += 1
                elif char == "]":
                    bracket_count = max(bracket_count - 1, 0)
                elif char == "(":
                    paren_count += 1
                elif char == ")":
                    paren_count = max(paren_count - 1, 0)
                elif brace_count == 0 and bracket_count == 0 and paren_count == 0:
                    if char == ";" or (
                        char in ("\n", "\r")
                        and MongoDBClient._next_starts_statement(query, idx + 1)
                    ):
                        push(idx)
                        start = idx + 1
            idx += 1

        push(len(query))
        return statements

    @staticmethod
    def _strip_js_comments(text: str) -> str:
        """去除 JavaScript 风格的行注释 (//) 与块注释 (/* */)。

        Mongo shell 查询允许这两种注释；拆分语句前先去掉它们，避免一条纯注释
        被当作独立语句而多出一个空的结果 tab。字符串字面量内的 // 与 /* 会被保留。
        """
        out: List[str] = []
        i = 0
        n = len(text)
        in_string: Optional[str] = None
        while i < n:
            ch = text[i]
            if in_string is not None:
                out.append(ch)
                # 转义字符：把反斜杠和它后面的字符一并保留，避免误判字符串结束
                if ch == "\\" and i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
                if ch == in_string:
                    in_string = None
                i += 1
                continue
            if ch in ("'", '"'):
                in_string = ch
                out.append(ch)
                i += 1
                continue
            # 行注释 // ... ：跳过到行尾（保留换行符，便于按换行拆分语句）
            if ch == "/" and i + 1 < n and text[i + 1] == "/":
                i += 2
                while i < n and text[i] not in ("\n", "\r"):
                    i += 1
                continue
            # 块注释 /* ... */ ：跳过，用一个换行替代，保持语句边界
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                i += 2
                while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                    i += 1
                i += 2
                out.append("\n")
                continue
            out.append(ch)
            i += 1
        return "".join(out)

    @staticmethod
    def _parse_queries(query: str) -> List[tuple[str, Dict[str, Any]]]:
        query_str = MongoDBClient._strip_js_comments(query).strip()
        if not query_str:
            return []

        try:
            payload = json.loads(query_str)
            if isinstance(payload, list):
                parsed: List[tuple[str, Dict[str, Any]]] = []
                for item in payload:
                    if not isinstance(item, dict):
                        raise ValueError("MongoDB JSON 数组中的每一项都必须是对象")
                    parsed.append((json.dumps(item, ensure_ascii=False), item))
                return parsed
            if isinstance(payload, dict):
                return [(query_str, payload)]
        except json.JSONDecodeError:
            pass

        return [
            (statement, MongoDBClient._parse_query(statement))
            for statement in MongoDBClient._split_query_statements(query_str)
        ]

    @staticmethod
    def _parse_query(query: str) -> Dict[str, Any]:
        """支持 JSON 格式以及更强大的 db.collectionName.find().sort().limit().skip() 链式调用。"""
        query_str = query.strip()
        if not query_str.startswith("db."):
            try:
                return json.loads(query_str)
            except json.JSONDecodeError as e:
                if query_str.startswith("{") or query_str.startswith("["):
                    raise ValueError(f"JSON 语法错误: {e}")
                pass
                
        # 提取 db.collection
        idx = 3 # 越过 'db.'
        if query_str[idx:].startswith("getCollection("):
            idx += len("getCollection(")
            start_quote = None
            coll_name = ""
            while idx < len(query_str):
                c = query_str[idx]
                if c in ("'", '"'):
                    if start_quote is None:
                        start_quote = c
                    elif start_quote == c:
                        start_quote = None
                elif c == ')' and start_quote is None:
                    idx += 1
                    break
                elif start_quote is not None:
                    coll_name += c
                idx += 1
        else:
            start_idx = idx
            while idx < len(query_str) and (query_str[idx].isalnum() or query_str[idx] in ('_', '$')):
                idx += 1
            coll_name = query_str[start_idx:idx]
        
        cmd = {"collection": coll_name, "action": "find"}
        
        # 循环解析链式方法
        while idx < len(query_str):
            while idx < len(query_str) and query_str[idx].isspace():
                idx += 1
            if idx >= len(query_str):
                break
            if query_str[idx] != '.':
                break
            idx += 1 # 跳过 '.'
            
            while idx < len(query_str) and query_str[idx].isspace():
                idx += 1
            start_idx = idx
            while idx < len(query_str) and (query_str[idx].isalnum() or query_str[idx] in ('_', '$')):
                idx += 1
            method_name = query_str[start_idx:idx]
            
            while idx < len(query_str) and query_str[idx].isspace():
                idx += 1
            if idx >= len(query_str) or query_str[idx] != '(':
                raise ValueError(f"Expected '(' after method {method_name}")
            idx += 1 # 跳过 '('
            
            # 解析括号内的完整参数子串（支持括号匹配和字符串内转义）
            arg_start = idx
            paren_count = 1
            brace_count = 0
            bracket_count = 0
            in_string = None
            escape = False
            
            while idx < len(query_str):
                c = query_str[idx]
                if escape:
                    escape = False
                    idx += 1
                    continue
                if c == '\\':
                    escape = True
                    idx += 1
                    continue
                
                if in_string:
                    if c == in_string:
                        in_string = None
                else:
                    if c in ("'", '"'):
                        in_string = c
                    elif c == '(':
                        paren_count += 1
                    elif c == ')':
                        paren_count -= 1
                        if paren_count == 0:
                            break
                    elif c == '{':
                        brace_count += 1
                    elif c == '}':
                        brace_count -= 1
                    elif c == '[':
                        bracket_count += 1
                    elif c == ']':
                        bracket_count -= 1
                idx += 1
            
            if paren_count != 0:
                raise ValueError(f"Unmatched parenthesis in method {method_name}")
            
            arg_str = query_str[arg_start:idx].strip()
            idx += 1 # 跳过 ')'
            
            parsed_args = MongoDBClient._parse_arguments_string(arg_str)
            action = _ACTION_ALIASES.get(method_name, method_name)
            
            # 路由解析结果
            if action in ("find", "count", "delete_one", "delete_many", "drop"):
                cmd["action"] = action
                if parsed_args:
                    cmd["filter"] = parsed_args[0]
            elif action in ("update_one", "update_many"):
                cmd["action"] = action
                cmd["filter"] = parsed_args[0] if len(parsed_args) > 0 else {}
                cmd["update"] = parsed_args[1] if len(parsed_args) > 1 else {}
            elif action == "insert_one":
                cmd["action"] = action
                cmd["document"] = parsed_args[0] if parsed_args else {}
            elif action == "aggregate":
                cmd["action"] = action
                cmd["pipeline"] = parsed_args[0] if len(parsed_args) > 0 else []
                cmd["options"] = parsed_args[1] if len(parsed_args) > 1 else {}
            elif action == "distinct":
                cmd["action"] = action
                cmd["key"] = parsed_args[0] if len(parsed_args) > 0 else ""
                cmd["filter"] = parsed_args[1] if len(parsed_args) > 1 else {}
            elif action == "sort":
                if len(parsed_args) == 2 and isinstance(parsed_args[0], str) and isinstance(parsed_args[1], (int, float)):
                    cmd["sort"] = {parsed_args[0]: int(parsed_args[1])}
                elif parsed_args:
                    cmd["sort"] = parsed_args[0]
            elif action == "limit":
                if parsed_args:
                    cmd["limit"] = int(parsed_args[0])
            elif action == "skip":
                if parsed_args:
                    cmd["skip"] = int(parsed_args[0])
            else:
                raise ValueError(f"不支持的 MongoDB 方法或存在拼写错误: {method_name}")

        while idx < len(query_str) and query_str[idx].isspace():
            idx += 1
        if idx < len(query_str):
            raise ValueError(f"MongoDB 命令尾部存在无法解析的内容: {query_str[idx:]}")

        return cmd

    def get_schema(self) -> Dict[str, Any]:
        schema: Dict[str, Any] = {}
        for coll_name in self.db.list_collection_names():
            schema[coll_name] = []
        return schema

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass
        finally:
            close_ssh_tunnel(getattr(self, "_ssh_tunnel", None))
            self._ssh_tunnel = None


def list_mongo_databases(config_dict: Dict[str, Any]) -> List[str]:
    if not pymongo:
        return []
    tunnel = None
    temp = dict(config_dict)
    host = temp.get("host", "localhost")
    port = int(temp.get("port") or 27017)
    host, port, tunnel = open_ssh_tunnel(temp, host, port, label="MongoDB")
    temp["host"] = host
    temp["port"] = port
    uri = _build_uri(temp, use_auth_source_in_path=True)
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000)
    try:
        return client.list_database_names()
    except Exception as e:
        logger.warning(f"Failed to list mongo databases: {e}")
        db_name = config_dict.get("database")
        return [db_name] if db_name else []
    finally:
        try:
            client.close()
        finally:
            close_ssh_tunnel(tunnel)
