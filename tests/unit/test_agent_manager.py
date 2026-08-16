import time

from src.ai_core.agent import AgentManager


def test_agent_manager_isolates_sessions_and_cleans_ttl():
    manager = AgentManager(ttl_seconds=1, max_sessions=4)
    first = manager.get("a")
    second = manager.get("b")
    assert first is not second

    manager._agents["a"] = (first, time.time() - 5)
    manager.cleanup()
    assert "a" not in manager._agents
    assert "b" in manager._agents


def test_agent_manager_enforces_session_limit():
    manager = AgentManager(ttl_seconds=60, max_sessions=2)
    manager.get("a")
    manager.get("b")
    manager.get("c")
    assert len(manager._agents) == 2
