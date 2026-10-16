from __future__ import annotations

import logging

from fastapi import APIRouter

from src.api.schemas import GroupNameRequest, ScriptRequest, SourceCreate
from src.services import source_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/providers")
async def list_providers():
    return source_service.list_provider_metadata()


@router.get("/scripts/{source_id}")
async def get_script(source_id: int):
    return source_service.get_script(source_id)


@router.post("/scripts/{source_id}")
async def save_script(source_id: int, request: ScriptRequest):
    return source_service.save_script(source_id, request.content)


@router.post("/sources/test")
async def test_source(source: SourceCreate):
    return source_service.test_source(source_service.model_to_dict(source))


@router.post("/sources/list-databases")
async def list_databases_api(source: SourceCreate):
    return source_service.list_server_databases(source_service.model_to_dict(source))


@router.get("/sources")
async def list_sources():
    return source_service.list_sources()


@router.post("/sources")
async def add_source(source: SourceCreate):
    try:
        return source_service.add_source(source_service.model_to_dict(source))
    except Exception as e:
        logger.exception("Failed to add source")
        return {"success": False, "error": str(e)}


@router.delete("/sources/{source_id}")
async def delete_source(source_id: int):
    return source_service.delete_source(source_id)


@router.post("/sources/{source_id}/disconnect")
async def disconnect_source(source_id: int):
    return source_service.disconnect_source(source_id)


@router.put("/sources/{source_id}")
async def update_source(source_id: int, source: SourceCreate):
    try:
        return source_service.update_source(source_id, source_service.model_to_dict(source))
    except Exception as e:
        logger.exception("Failed to update source")
        return {"success": False, "error": str(e)}


@router.post("/sources/{source_id}/toggle-favorite")
async def toggle_favorite(source_id: int):
    return source_service.toggle_favorite(source_id)


@router.put("/sources/{source_id}/group")
async def set_source_group(source_id: int, payload: GroupNameRequest):
    return source_service.set_source_group(source_id, payload.name)


@router.put("/source-groups/{group_id}")
async def rename_group(group_id: int, payload: GroupNameRequest):
    return source_service.rename_group(group_id, payload.name)


@router.delete("/source-groups/{group_id}")
async def ungroup(group_id: int):
    return source_service.ungroup(group_id)


@router.get("/tree")
async def get_tree():
    return source_service.get_tree()
