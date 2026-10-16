from src.common.storage import Storage
from src.sources.connection_manager import ConnectionManager


def _source(storage, name, group_name=None):
    return storage.add_source(name=name, type="sqlite", database=f"/tmp/{name}.db", group_name=group_name)


def _groups(storage):
    return {s["name"]: s["group_name"] for s in storage.get_sources()}


def test_sources_are_grouped_by_name_and_empty_groups_are_pruned(tmp_path):
    storage = Storage(str(tmp_path / "config.db"))
    a = _source(storage, "a", "生产")
    _source(storage, "b", " 生产 ")
    _source(storage, "c")

    assert _groups(storage) == {"a": "生产", "b": "生产", "c": None}

    storage.update_source(a, group_name="测试")
    assert _groups(storage)["a"] == "测试"

    storage.update_source(a, group_name="")
    assert _groups(storage)["a"] is None
    with storage_conn(storage) as conn:
        names = [row[0] for row in conn.execute("SELECT name FROM connection_groups")]
    assert names == ["生产"]


def test_rename_group_merges_into_existing_and_ungroup_keeps_sources(tmp_path):
    storage = Storage(str(tmp_path / "config.db"))
    _source(storage, "a", "prod")
    _source(storage, "b", "生产")
    group_ids = {s["group_name"]: s["group_id"] for s in storage.get_sources()}

    storage.rename_group(group_ids["prod"], "生产")
    assert _groups(storage) == {"a": "生产", "b": "生产"}

    storage.ungroup(group_ids["生产"])
    assert _groups(storage) == {"a": None, "b": None}
    assert len(storage.get_sources()) == 2


def test_navigation_only_fields_do_not_change_connection_signature():
    base = {"id": 1, "type": "mysql", "host": "db", "password": "x"}
    navigated = {**base, "name": "renamed", "group_id": 3, "group_name": "生产", "is_favorite": 1}

    assert ConnectionManager._signature(base) == ConnectionManager._signature(navigated)
    assert ConnectionManager._signature(base) != ConnectionManager._signature({**base, "host": "other"})


def storage_conn(storage):
    import sqlite3

    return sqlite3.connect(storage.db_path)
