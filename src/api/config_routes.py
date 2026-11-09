from __future__ import annotations

import logging
import base64

from fastapi import APIRouter

from src.api.schemas import ConfigUpdateRequest, DBeaverImportRequest, ImportRequest, UiPreferencesRequest
from src.services import config_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/config")
def get_config():
    return config_service.get_config()


@router.post("/config")
def update_config(request: ConfigUpdateRequest):
    return config_service.update_config(request.settings)


@router.get("/ui-preferences")
def get_ui_preferences():
    return config_service.get_ui_preferences()


@router.post("/ui-preferences")
def update_ui_preferences(request: UiPreferencesRequest):
    return config_service.update_ui_preferences(language=request.language)


@router.get("/export-config")
def export_config():
    try:
        return config_service.export_config()
    except Exception as e:
        logger.exception("Failed to export config")
        return {"success": False, "error": str(e)}


@router.post("/import-config")
def import_config_api(request: ImportRequest):
    try:
        return config_service.import_config(request.data_sources, request.system_config)
    except Exception as e:
        logger.exception("Failed to import config")
        return {"success": False, "error": str(e)}


@router.post("/import-dbeaver-config")
def import_dbeaver_config_api(request: DBeaverImportRequest):
    try:
        content = base64.b64decode(request.content_base64)
        return config_service.import_dbeaver_file(request.filename, content)
    except Exception as e:
        logger.exception("Failed to import DBeaver config")
        return {"success": False, "error": str(e)}
