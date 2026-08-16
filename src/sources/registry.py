"""
SourceProvider 注册中心。

新增数据源 = 在 sources/<type>/ 下写一个 provider.py，然后在 sources/__init__.py 里 import。
"""
from __future__ import annotations

from typing import Dict, List

from .base import SourceProvider

_providers: Dict[str, SourceProvider] = {}


def register_provider(provider: SourceProvider) -> None:
    _providers[provider.id] = provider


def get_provider(source_type: str) -> SourceProvider:
    if source_type not in _providers:
        raise ValueError(f"未知数据源类型: {source_type}")
    return _providers[source_type]


def all_providers() -> List[SourceProvider]:
    return list(_providers.values())


def has_provider(source_type: str) -> bool:
    return source_type in _providers
