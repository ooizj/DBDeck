from __future__ import annotations

import json
from typing import AsyncGenerator, Optional

from fastapi import HTTPException

from src.ai_core.agent import AgentManager
from src.services.source_service import resolve_source


agent_manager = AgentManager()


async def chat_events(
    query: str,
    *,
    source_id: Optional[int],
    workspace_id: Optional[int],
    session_id: Optional[str],
) -> AsyncGenerator[str, None]:
    try:
        provider, db = resolve_source(source_id)
    except HTTPException as e:
        yield json.dumps({"type": "error", "message": e.detail}, ensure_ascii=False) + "\n"
        return

    try:
        agent = agent_manager.get(session_id)
        async for event in agent.chat(
            query,
            provider=provider,
            db=db,
            workspace_id=workspace_id,
            source_id=source_id,
        ):
            yield json.dumps(event, ensure_ascii=False) + "\n"
    except Exception as e:
        yield json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False) + "\n"
    finally:
        db.close()


def clear_chat(session_id: Optional[str]) -> dict[str, bool]:
    agent_manager.reset(session_id)
    return {"success": True}
