from __future__ import annotations

from fastapi import APIRouter

from src.services import session_service

router = APIRouter()


@router.get("/sessions")
def get_sessions(source_id: int):
    """获取数据库会话列表"""
    return session_service.get_sessions(source_id)


@router.post("/sessions/kill")
def kill_session(source_id: int, session_id: str):
    """终止数据库会话"""
    return session_service.kill_session(source_id, session_id)
