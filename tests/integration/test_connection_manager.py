from src.sources.base import DataSourceClient, SourceProvider
from src.sources.connection_manager import ConnectionManager, ManagedClientProxy


class FakeClient(DataSourceClient):
    def __init__(self):
        self.closed = False

    def execute(self, query, params=None):
        return {"success": True, "query": query}

    def get_schema(self):
        return {}

    def close(self):
        self.closed = True


class FakeProvider(SourceProvider):
    id = "fake"
    display_name = "Fake"

    def __init__(self):
        self.created = []

    def create_client(self, config):
        client = FakeClient()
        self.created.append(client)
        return client

    def tools(self):
        raise NotImplementedError

    def system_prompt(self, *, session_ctx):
        return ""


def test_connection_manager_reuses_and_drops_clients():
    manager = ConnectionManager()
    provider = FakeProvider()
    source = {"id": 1, "type": "fake", "database": "a"}

    first = manager.get(1, source, provider)
    second = manager.get(1, dict(source), provider)
    assert isinstance(first, ManagedClientProxy)
    assert len(provider.created) == 1
    assert first._client is second._client

    changed = dict(source, database="b")
    third = manager.get(1, changed, provider)
    assert len(provider.created) == 2
    assert first._client.closed is True
    assert third._client.closed is False

    manager.drop(1)
    assert third._client.closed is True
