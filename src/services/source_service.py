from __future__ import annotations

from typing import Any, Dict, Tuple

from fastapi import HTTPException

from src.common.errors import redact_sensitive, secrets_from_config
from src.common.storage import storage
from src.sources import all_providers, get_provider, has_provider
from src.sources.base import DataSourceClient, SourceProvider
from src.sources.connection_manager import connection_manager


def model_to_dict(model: Any) -> Dict[str, Any]:
    dump = getattr(model, "model_dump", None)
    if callable(dump):
        return dump()
    return model.dict()


def resolve_source(source_id: int) -> Tuple[SourceProvider, DataSourceClient]:
    source = storage.get_source(source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    db_type = source.get("type") or "mysql"
    if not has_provider(db_type):
        raise HTTPException(status_code=400, detail=f"Unsupported source type: {db_type}")
    provider = get_provider(db_type)
    return provider, connection_manager.get(source_id, source, provider)


def provider_for_payload(payload: Dict[str, Any]) -> SourceProvider:
    db_type = payload.get("type") or "mysql"
    if not has_provider(db_type):
        raise HTTPException(status_code=400, detail=f"Unsupported source type: {db_type}")
    return get_provider(db_type)


def validate_source_payload(payload: Dict[str, Any]) -> None:
    db_type = payload.get("type") or "mysql"
    if db_type == "mysql" and not (payload.get("database") or "").strip():
        raise ValueError("MySQL 数据库名称不能为空，请先选择或填写数据库名称")
    if db_type == "postgresql" and not (payload.get("database") or "").strip():
        raise ValueError("PostgreSQL 数据库名称不能为空，请先选择或填写数据库名称")


def list_provider_metadata() -> list[dict[str, Any]]:
    providers = []
    for p in all_providers():
        capabilities = p.capabilities
        providers.append({
            "id": p.id,
            "display_name": p.display_name,
            "capabilities": {
                "supports_ddl": capabilities.supports_ddl,
                "supports_migrate": capabilities.supports_migrate,
                "supports_explain": capabilities.supports_explain,
                "has_schema": capabilities.has_schema,
                "query_language": capabilities.query_language,
                "engine_family": capabilities.engine_family,
                "metadata_label": capabilities.metadata_label,
            },
        })
    return providers


def list_sources() -> list[dict[str, Any]]:
    return storage.get_sources()


def test_source(payload: Dict[str, Any]) -> dict[str, Any]:
    client = None
    try:
        provider = provider_for_payload(payload)
        client = provider.create_client(payload)
        client.get_schema()
        return {"success": True, "message": "Connection successful"}
    except Exception as e:
        return {
            "success": False,
            "error": redact_sensitive(e, secrets_from_config(payload)),
        }
    finally:
        if client:
            client.close()


def list_server_databases(payload: Dict[str, Any]) -> dict[str, Any]:
    try:
        provider = provider_for_payload(payload)
        return {"success": True, "databases": provider.list_server_databases(payload)}
    except Exception as e:
        return {
            "success": False,
            "error": redact_sensitive(e, secrets_from_config(payload)),
        }


def add_source(payload: Dict[str, Any]) -> dict[str, Any]:
    validate_source_payload(payload)
    source_id = storage.add_source(**payload)
    return {"success": True, "id": source_id}


def update_source(source_id: int, payload: Dict[str, Any]) -> dict[str, Any]:
    validate_source_payload(payload)
    connection_manager.drop(source_id)
    storage.update_source(source_id, **payload)
    return {"success": True}


def delete_source(source_id: int) -> dict[str, Any]:
    connection_manager.drop(source_id)
    storage.delete_source(source_id)
    return {"success": True}


def toggle_favorite(source_id: int) -> dict[str, Any]:
    return {"success": True, "is_favorite": storage.toggle_favorite(source_id)}


def set_source_group(source_id: int, group_name: str) -> dict[str, Any]:
    """只改分组，不影响连接配置，因此不断开已建立的连接。"""
    storage.update_source(source_id, group_name=group_name)
    return {"success": True}


def rename_group(group_id: int, name: str) -> dict[str, Any]:
    if not (name or "").strip():
        return {"success": False, "error": "分组名称不能为空"}
    storage.rename_group(group_id, name)
    return {"success": True}


def ungroup(group_id: int) -> dict[str, Any]:
    storage.ungroup(group_id)
    return {"success": True}


def disconnect_source(source_id: int) -> dict[str, Any]:
    connection_manager.drop(source_id)
    return {"success": True}


def get_tree() -> list[dict[str, Any]]:
    tree = []
    for s in storage.get_sources():
        tree.append({
            "id": s["id"],
            "name": s["name"],
            "host": s.get("host"),
            "port": s.get("port"),
            "user": s.get("user"),
            "password": s.get("password"),
            "database": s.get("database"),
            "direct_connection": bool(s.get("direct_connection")),
            "auth_source": s.get("auth_source"),
            "use_ssh_tunnel": bool(s.get("use_ssh_tunnel")),
            "ssh_host": s.get("ssh_host"),
            "ssh_port": s.get("ssh_port"),
            "ssh_user": s.get("ssh_user"),
            "ssh_password": s.get("ssh_password"),
            "ssh_private_key": s.get("ssh_private_key"),
            "ssh_private_key_passphrase": s.get("ssh_private_key_passphrase"),
            "type": "source",
            "db_type": s.get("type", "mysql"),
            "group_id": s.get("group_id"),
            "group_name": s.get("group_name") or "",
            "is_favorite": bool(s.get("is_favorite")),
            "children": [],
        })
    return tree


def get_script(source_id: int) -> dict[str, Any]:
    return {"success": True, "content": storage.get_script(source_id)}


def save_script(source_id: int, content: str) -> dict[str, Any]:
    storage.save_script(source_id, content)
    return {"success": True}
