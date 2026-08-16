from __future__ import annotations

import logging

from fastapi import APIRouter

from src.api.schemas import BookmarkRequest
from src.common.storage import storage

logger = logging.getLogger(__name__)
router = APIRouter()


# ========== 书签路由 ==========

@router.get("/bookmarks")
async def get_bookmarks(source_id: int = None):
    """获取书签列表"""
    try:
        bookmarks = storage.get_bookmarks(source_id)
        return {"success": True, "bookmarks": bookmarks}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/bookmarks")
async def add_bookmark(request: BookmarkRequest):
    """添加书签"""
    try:
        bookmark_id = storage.add_bookmark(
            source_id=request.source_id,
            object_type=request.object_type,
            object_name=request.object_name,
            label=request.label
        )
        return {"success": True, "id": bookmark_id}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.delete("/bookmarks")
async def remove_bookmark(source_id: int, object_type: str, object_name: str):
    """删除书签"""
    try:
        storage.remove_bookmark(source_id, object_type, object_name)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/bookmarks/check")
async def check_bookmark(source_id: int, object_type: str, object_name: str):
    """检查是否已收藏"""
    try:
        is_bookmarked = storage.is_bookmarked(source_id, object_type, object_name)
        return {"success": True, "is_bookmarked": is_bookmarked}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/sources/{source_id}/toggle-favorite")
async def toggle_favorite(source_id: int):
    """切换数据源收藏状态"""
    try:
        is_favorite = storage.toggle_favorite(source_id)
        return {"success": True, "is_favorite": is_favorite}
    except Exception as e:
        return {"success": False, "error": str(e)}
