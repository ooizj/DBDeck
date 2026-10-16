from __future__ import annotations

import logging
import io
import json
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from src.common.config import config
from src.common.storage import storage

logger = logging.getLogger(__name__)

SUPPORTED_DBEAVER_PROVIDERS = {
    "mysql": "mysql",
    "postgresql": "postgresql",
    "postgres": "postgresql",
    "sqlite": "sqlite",
    "redis": "redis",
    "mongodb": "mongodb",
}

SOURCE_FIELDS = {
    "name",
    "type",
    "host",
    "port",
    "user",
    "password",
    "database",
    "direct_connection",
    "auth_source",
    "use_ssh_tunnel",
    "ssh_host",
    "ssh_port",
    "ssh_user",
    "ssh_password",
    "ssh_private_key",
    "ssh_private_key_passphrase",
    "group_name",
    "is_favorite",
}


def get_config_values() -> Dict[str, str]:
    db_config = storage.get_all_config()
    return {
        "LLM_API_KEY": db_config.get("LLM_API_KEY") or config.llm_api_key,
        "LLM_API_BASE": db_config.get("LLM_API_BASE") or config.llm_api_base,
        "LLM_MODEL": db_config.get("LLM_MODEL") or config.llm_model,
        "LLM_TEMPERATURE": db_config.get("LLM_TEMPERATURE")
        or str(config.llm_temperature),
        "LLM_MAX_TOKENS": db_config.get("LLM_MAX_TOKENS")
        or str(config.llm_max_tokens),
    }


def get_config() -> Dict[str, Any]:
    return {"success": True, "config": get_config_values()}


def update_config(settings: Dict[str, Any]) -> dict[str, bool]:
    for key, value in settings.items():
        storage.set_config(key, str(value))
    config.reload()
    return {"success": True}


def export_config() -> dict[str, Any]:
    return {
        "success": True,
        "data": {
            "data_sources": storage.get_sources(),
            "system_config": storage.get_all_config(),
        },
    }


def _coerce_int(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    return int(float(value))


def _jdbc_parts(url: Optional[str]) -> dict[str, Any]:
    if not url or not url.startswith("jdbc:"):
        return {}
    parsed = urlparse(url[5:])
    database = parsed.path.lstrip("/") if parsed.path else None
    return {
        "host": parsed.hostname,
        "port": parsed.port,
        "database": database or None,
    }


def _first_present(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _dbeaver_connection_to_source(conn_id: str, conn: dict[str, Any]) -> dict[str, Any] | None:
    provider = (conn.get("provider") or conn.get("driver") or "").lower()
    source_type = SUPPORTED_DBEAVER_PROVIDERS.get(provider)
    if not source_type:
        return None

    cfg = conn.get("configuration") or {}
    jdbc = _jdbc_parts(cfg.get("url"))
    source: dict[str, Any] = {
        "name": conn.get("name") or conn_id,
        "type": source_type,
        "host": _first_present(cfg.get("host"), jdbc.get("host")),
        "port": _coerce_int(_first_present(cfg.get("port"), jdbc.get("port"))),
        "user": _first_present(
            cfg.get("user"),
            cfg.get("username"),
            cfg.get("userName"),
            cfg.get("login"),
        ),
        "password": _first_present(cfg.get("password")),
        "database": _first_present(
            cfg.get("database"),
            cfg.get("databaseName"),
            cfg.get("schema"),
            jdbc.get("database"),
            "",
        ),
    }

    if source_type == "sqlite":
        source["database"] = _first_present(
            cfg.get("database"),
            cfg.get("databaseName"),
            cfg.get("path"),
            cfg.get("url"),
            "",
        )

    ssh = ((cfg.get("handlers") or {}).get("ssh_tunnel") or {})
    ssh_props = ssh.get("properties") or {}
    if ssh.get("enabled"):
        source.update(
            {
                "use_ssh_tunnel": 1,
                "ssh_host": _first_present(ssh_props.get("host"), ssh_props.get("jumpServer0.host")),
                "ssh_port": _coerce_int(
                    _first_present(ssh_props.get("port"), ssh_props.get("jumpServer0.port"), 22)
                ),
                "ssh_user": _first_present(
                    ssh_props.get("user"),
                    ssh_props.get("username"),
                    ssh_props.get("jumpServer0.user"),
                    ssh_props.get("jumpServer0.username"),
                ),
                "ssh_password": _first_present(ssh_props.get("password"), ssh_props.get("jumpServer0.password")),
                "ssh_private_key": _first_present(
                    ssh_props.get("keyFile"),
                    ssh_props.get("privateKey"),
                    ssh_props.get("jumpServer0.keyFile"),
                ),
            }
        )
    else:
        source["use_ssh_tunnel"] = 0

    return {key: value for key, value in source.items() if key in SOURCE_FIELDS}


def parse_dbeaver_data_sources(data: dict[str, Any]) -> dict[str, Any]:
    connections = data.get("connections")
    if not isinstance(connections, dict):
        raise ValueError("无效的 DBeaver data-sources.json：缺少 connections")

    imported_sources = []
    skipped_count = 0
    for conn_id, conn in connections.items():
        if not isinstance(conn, dict):
            skipped_count += 1
            continue
        source = _dbeaver_connection_to_source(conn_id, conn)
        if source is None:
            skipped_count += 1
            continue
        imported_sources.append(source)

    return {"data_sources": imported_sources, "skipped_count": skipped_count}


def parse_dbeaver_file(filename: str, content: bytes) -> dict[str, Any]:
    suffix = Path(filename).suffix.lower()
    content_file = io.BytesIO(content)
    if zipfile.is_zipfile(content_file):
        content_file.seek(0)
        with zipfile.ZipFile(content_file) as zf:
            candidates = [
                name
                for name in zf.namelist()
                if name.endswith("/.dbeaver/data-sources.json")
                or name.endswith(".dbeaver/data-sources.json")
            ]
            if not candidates:
                raise ValueError("未在 DBeaver 归档中找到 .dbeaver/data-sources.json")
            with zf.open(candidates[0]) as fp:
                return parse_dbeaver_data_sources(json.loads(fp.read().decode("utf-8")))

    if suffix in {".dbp", ".zip"}:
        raise ValueError("文件不是有效的 DBeaver .dbp/.zip 归档")

    return parse_dbeaver_data_sources(json.loads(content.decode("utf-8")))


def _find_dbeaver_data_sources_file(path: Path) -> Path:
    if path.is_file():
        return path

    direct_candidates = [
        path / ".dbeaver" / "data-sources.json",
        path / "projects" / "General" / ".dbeaver" / "data-sources.json",
    ]
    for candidate in direct_candidates:
        if candidate.exists():
            return candidate

    matches = list(path.glob("projects/*/.dbeaver/data-sources.json"))
    if matches:
        return matches[0]

    matches = list(path.glob("**/.dbeaver/data-sources.json"))
    if matches:
        return matches[0]

    raise ValueError("未在目录中找到 .dbeaver/data-sources.json")


def parse_dbeaver_path(path: str) -> dict[str, Any]:
    source_path = Path(path).expanduser()
    if not source_path.exists():
        raise ValueError(f"路径不存在: {path}")
    if source_path.is_file() and source_path.suffix.lower() in {".dbp", ".zip"}:
        return parse_dbeaver_file(source_path.name, source_path.read_bytes())

    data_sources_path = _find_dbeaver_data_sources_file(source_path)
    return parse_dbeaver_data_sources(json.loads(data_sources_path.read_text(encoding="utf-8")))


def import_config(data_sources: list[dict[str, Any]], system_config: Dict[str, Any]) -> dict[str, Any]:
    existing_sources = storage.get_sources()

    def make_key(s: dict[str, Any]) -> tuple[Any, ...]:
        return (
            (s.get("name") or "").strip(),
            (s.get("type") or "").strip(),
            (s.get("database") or "").strip(),
            (s.get("host") or "").strip(),
            s.get("port"),
        )

    existing_keys = {make_key(s) for s in existing_sources}
    imported_count = 0
    for source in data_sources:
        clean_source = dict(source)
        clean_source.pop("id", None)
        clean_source.pop("created_at", None)
        clean_source = {key: value for key, value in clean_source.items() if key in SOURCE_FIELDS}
        if "port" in clean_source and clean_source["port"] is not None:
            clean_source["port"] = int(clean_source["port"])
        if "ssh_port" in clean_source and clean_source["ssh_port"] is not None:
            clean_source["ssh_port"] = int(clean_source["ssh_port"])
        if "use_ssh_tunnel" in clean_source:
            clean_source["use_ssh_tunnel"] = int(bool(clean_source["use_ssh_tunnel"]))
        if "direct_connection" in clean_source:
            clean_source["direct_connection"] = int(bool(clean_source["direct_connection"]))

        key = make_key(clean_source)
        if key not in existing_keys:
            storage.add_source(**clean_source)
            existing_keys.add(key)
            imported_count += 1

    for key, value in system_config.items():
        storage.set_config(key, str(value))
    config.reload()
    return {"success": True, "imported_count": imported_count}


def import_dbeaver_file(filename: str, content: bytes) -> dict[str, Any]:
    parsed = parse_dbeaver_file(filename, content)
    result = import_config(parsed["data_sources"], {})
    result.update(
        {
            "parsed_count": len(parsed["data_sources"]),
            "skipped_count": parsed["skipped_count"],
            "source": "dbeaver",
        }
    )
    return result


def import_dbeaver_path(path: str) -> dict[str, Any]:
    parsed = parse_dbeaver_path(path)
    result = import_config(parsed["data_sources"], {})
    result.update(
        {
            "parsed_count": len(parsed["data_sources"]),
            "skipped_count": parsed["skipped_count"],
            "source": "dbeaver",
        }
    )
    return result
