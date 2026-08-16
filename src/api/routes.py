from __future__ import annotations

from fastapi import APIRouter

from src.api.ai_routes import router as ai_router
from src.api.config_routes import router as config_router
from src.api.history_routes import router as history_router
from src.api.import_routes import router as import_router
from src.api.migration_routes import router as migration_router
from src.api.query_routes import router as query_router
from src.api.source_routes import router as source_router
from src.api.data_edit_routes import router as data_edit_router
from src.api.bookmark_routes import router as bookmark_router
from src.api.session_routes import router as session_router
from src.api.search_routes import router as search_router
from src.api.explain_routes import router as explain_router
from src.api.compare_routes import router as compare_router

router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok"}


router.include_router(source_router)
router.include_router(query_router)
router.include_router(ai_router)
router.include_router(config_router)
router.include_router(migration_router)
router.include_router(history_router)
router.include_router(import_router)
router.include_router(data_edit_router)
router.include_router(bookmark_router)
router.include_router(session_router)
router.include_router(search_router)
router.include_router(explain_router)
router.include_router(compare_router)
