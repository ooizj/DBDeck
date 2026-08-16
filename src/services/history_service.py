from __future__ import annotations

from src.common.storage import storage


def list_history(limit=100, offset=0, source_id=None, search=None):
    return storage.get_history(limit, offset, source_id, search)


def add_history(**kwargs):
    storage.add_history(**kwargs)


def clear_history(source_id=None):
    storage.clear_history(source_id)
