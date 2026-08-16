"""Lightweight runtime connection cache for configured data sources."""
from __future__ import annotations

import json
import threading
from typing import Any, Dict, Tuple

from src.sources.base import DataSourceClient, SourceProvider


class ManagedClientProxy:
    """Proxy that prevents request-level cleanup from closing cached clients."""

    def __init__(self, client: DataSourceClient) -> None:
        self._client = client

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    def close(self) -> None:
        pass


class ConnectionManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: Dict[int, Tuple[str, DataSourceClient]] = {}

    @staticmethod
    def _signature(source: Dict[str, Any]) -> str:
        return json.dumps(source, sort_keys=True, default=str)

    def get(
        self,
        source_id: int,
        source: Dict[str, Any],
        provider: SourceProvider,
    ) -> DataSourceClient:
        signature = self._signature(source)
        # 快速路径：缓存命中时无锁返回（CPython 下 dict.get 原子），
        # 避免某个数据源慢建连/SSH 握手时持有全局锁阻塞其它所有源。
        cached = self._clients.get(source_id)
        if cached and cached[0] == signature:
            return ManagedClientProxy(cached[1])
        # 缓存未命中：持锁双重检查后再建连。建连是慢操作，但仅在首次连接或配置变更时发生。
        with self._lock:
            cached = self._clients.get(source_id)
            if cached and cached[0] == signature:
                return ManagedClientProxy(cached[1])
            if cached:
                cached[1].close()
            client = provider.create_client(source)
            self._clients[source_id] = (signature, client)
            return ManagedClientProxy(client)

    def drop(self, source_id: int) -> None:
        with self._lock:
            cached = self._clients.pop(source_id, None)
        if cached:
            cached[1].close()

    def status(self) -> Dict[int, Dict[str, str]]:
        with self._lock:
            return {
                source_id: {"signature": signature, "client": type(client).__name__}
                for source_id, (signature, client) in self._clients.items()
            }

    def close_all(self) -> None:
        with self._lock:
            clients = [client for _, client in self._clients.values()]
            self._clients.clear()
        for client in clients:
            client.close()


connection_manager = ConnectionManager()
