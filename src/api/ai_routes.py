from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import StreamingResponse

from src.api.schemas import ClearChatRequest, QueryRequest
from src.services import ai_service

router = APIRouter()


@router.post("/query")
async def chat(request: QueryRequest):
    return StreamingResponse(
        ai_service.chat_events(
            request.query,
            source_id=request.source_id,
            session_id=request.session_id,
        ),
        media_type="application/x-ndjson",
    )


@router.post("/clear-chat")
async def clear_chat(request: ClearChatRequest | None = Body(default=None)):
    return ai_service.clear_chat(request.session_id if request else None)
