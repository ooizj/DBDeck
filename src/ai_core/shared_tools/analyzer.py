"""
通用数据分析子 Agent —— 只依赖"上一次查询的列名 + 行数据"，与具体数据源无关。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from openai import AsyncOpenAI

from src.ai_core.tools.registry import ToolContext, ToolRegistry
from src.common.config import config

_PROMPT_PATH = Path(__file__).parent / "analyzer.md"


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


async def _one_shot(system_prompt: str, user_prompt: str, temperature: float) -> str:
    client = AsyncOpenAI(api_key=config.llm_api_key, base_url=config.llm_api_base)
    resp = await client.chat.completions.create(
        model=config.llm_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


def register_analyzer(registry: ToolRegistry) -> None:
    @registry.tool(
        name="call_analyzer",
        description=(
            "把上一次查询的结果交给数据分析子 Agent，让它产出洞察、趋势、异常说明。"
            "用户问 '为什么 / 趋势 / 异常 / 给点建议' 时调用。调用前必须先执行过查询。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "用户原始的分析问题"},
                "focus": {
                    "type": "string",
                    "description": "可选：希望分析师重点关注的方面，如 '环比变化' / '异常值'",
                },
            },
            "required": ["question"],
        },
        tags=["subagent", "shared"],
    )
    async def call_analyzer(
        *,
        question: str,
        focus: Optional[str] = None,
        ctx: ToolContext,
    ) -> Dict[str, Any]:
        last_query = ctx.session.get("last_query")
        last_result = ctx.session.get("last_result")
        if not last_result:
            return {
                "success": False,
                "error": "当前没有可分析的数据，请先执行一条查询。",
            }
        payload = {
            "question": question,
            "focus": focus,
            "query": last_query,
            "columns": last_result.get("columns"),
            "row_count": last_result.get("row_count"),
            "sample_rows": (last_result.get("data") or [])[:50],
        }
        user_prompt = (
            "下面是用户的分析任务和最近一次查询的样本数据，请基于真实数据给出分析。\n\n"
            + json.dumps(payload, ensure_ascii=False, indent=2)
        )
        answer = await _one_shot(_load_prompt(), user_prompt, temperature=0.6)
        return {"success": True, "analysis": answer}
