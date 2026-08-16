import copy
from types import SimpleNamespace

import pytest

from src.ai_core.agent import Agent
from src.ai_core.tools.registry import ToolRegistry
from src.sources.base import Capabilities, SourceProvider


class _AsyncStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        self._iter = iter(self._chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


def _content_chunk(content):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=content, tool_calls=None),
                finish_reason="stop",
            )
        ]
    )


def _tool_call_chunk(name, arguments):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0,
                            id="call_1",
                            function=SimpleNamespace(name=name, arguments=arguments),
                        )
                    ],
                ),
                finish_reason="tool_calls",
            )
        ]
    )


class _FakeCompletions:
    def __init__(self, streams):
        self._streams = list(streams)
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        return _AsyncStream(self._streams.pop(0))


class _FakeClient:
    def __init__(self, streams):
        self.completions = _FakeCompletions(streams)
        self.chat = SimpleNamespace(completions=self.completions)


class _FakeDb:
    def __init__(self):
        self.executed = []

    def execute(self, sql):
        self.executed.append(sql)
        return {
            "success": True,
            "columns": ["id", "name"],
            "data": [[1, "Ada"]],
            "row_count": 1,
        }


class _FakeProvider(SourceProvider):
    id = "mysql"
    display_name = "MySQL"
    capabilities = Capabilities(query_language="sql")

    def __init__(self):
        self._tools = ToolRegistry()

        @self._tools.tool(
            name="execute_sql",
            description="执行 SQL",
            parameters={
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"],
            },
            needs_db=True,
        )
        def execute_sql(*, sql, db):
            result = db.execute(sql)
            return {
                **result,
                "success": True,
                "kind": "read",
                "query": sql,
                "executed_sql": sql,
            }

    def create_client(self, config):
        del config
        raise NotImplementedError

    def tools(self):
        return self._tools

    def system_prompt(self, *, session_ctx):
        del session_ctx
        return "system"


@pytest.mark.asyncio
async def test_agent_repairs_final_sql_without_tool_call(monkeypatch):
    from src.common.config import config

    monkeypatch.setattr(config, "llm_api_key", "test-key")
    monkeypatch.setattr(config, "llm_api_base", "https://example.test/v1")

    client = _FakeClient(
        [
            [_content_chunk("```sql\nSELECT id, name FROM users;\n```")],
            [_tool_call_chunk("execute_sql", '{"sql":"SELECT id, name FROM users;"}')],
            [_content_chunk("查询完成，共 1 条")],
        ]
    )
    agent = Agent()
    agent._client = client
    agent._client_key = (config.llm_api_key, config.llm_api_base)
    db = _FakeDb()

    events = [
        event
        async for event in agent.chat(
            "查询用户表",
            provider=_FakeProvider(),
            db=db,
            source_id=7,
        )
    ]

    assert db.executed == ["SELECT id, name FROM users;"]
    assert any(e["type"] == "tool_start" and e["tool"] == "execute_sql" for e in events)
    assert client.completions.calls[1]["messages"][-1]["role"] == "system"
    assert "没有调用数据库工具" in client.completions.calls[1]["messages"][-1]["content"]
    final = events[-1]
    assert final["type"] == "final"
    assert final["sql"] == "SELECT id, name FROM users;"
    assert final["data"]["row_count"] == 1


@pytest.mark.asyncio
async def test_agent_only_repairs_final_sql_once(monkeypatch):
    from src.common.config import config

    monkeypatch.setattr(config, "llm_api_key", "test-key")
    monkeypatch.setattr(config, "llm_api_base", "https://example.test/v1")

    client = _FakeClient(
        [
            [_content_chunk("```sql\nSELECT id FROM users;\n```")],
            [_content_chunk("```sql\nSELECT id FROM users;\n```")],
        ]
    )
    agent = Agent()
    agent._client = client
    agent._client_key = (config.llm_api_key, config.llm_api_base)
    db = _FakeDb()

    events = [
        event
        async for event in agent.chat(
            "查询用户表",
            provider=_FakeProvider(),
            db=db,
            source_id=7,
        )
    ]

    assert db.executed == []
    assert len(client.completions.calls) == 2
    assert events[-1]["type"] == "final"
    assert events[-1]["data"] is None
