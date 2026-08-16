from __future__ import annotations

import logging
import base64

from fastapi import APIRouter

from src.api.schemas import ConfigUpdateRequest, DBeaverImportRequest, ImportRequest
from src.services import config_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/config")
async def get_config():
    return config_service.get_config()


@router.post("/config")
async def update_config(request: ConfigUpdateRequest):
    return config_service.update_config(request.settings)


@router.get("/export-config")
async def export_config():
    try:
        return config_service.export_config()
    except Exception as e:
        logger.exception("Failed to export config")
        return {"success": False, "error": str(e)}


@router.post("/import-config")
async def import_config_api(request: ImportRequest):
    try:
        return config_service.import_config(request.data_sources, request.system_config)
    except Exception as e:
        logger.exception("Failed to import config")
        return {"success": False, "error": str(e)}


@router.post("/import-dbeaver-config")
async def import_dbeaver_config_api(request: DBeaverImportRequest):
    try:
        content = base64.b64decode(request.content_base64)
        return config_service.import_dbeaver_file(request.filename, content)
    except Exception as e:
        logger.exception("Failed to import DBeaver config")
        return {"success": False, "error": str(e)}
