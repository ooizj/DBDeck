"""data/rows 结果键契约的回归测试。

背景：所有 DataSourceClient.execute() 返回的结果用 "data" 键承载行数据，
但 chart/lock/session/explain 路由、data_edit/db_utils 辅助函数此前读取的是
不存在的 "rows" 键，导致这些功能整体静默返回空。这些测试钉死该契约，防止回退。
"""
from types import SimpleNamespace

from src.common.db_utils import get_primary_key, get_table_columns


class _FakeDb:
    """模拟 DataSourceClient：execute() 返回标准结果结构。"""

    def __init__(self, result):
        self._result = result

    def execute(self, query, params=None):
        return self._result

    def close(self):
        pass


def _provider(provider_id):
    return SimpleNamespace(id=provider_id, display_name=provider_id)


def test_get_table_columns_reads_data_key_mysql():
    # DESCRIBE 返回 5 列：Field, Type, Null, Key, Default
    db = _FakeDb({
        "success": True,
        "columns": ["Field", "Type", "Null", "Key", "Default"],
        "data": [
            ["id", "int", "NO", "PRI", None],
            ["name", "varchar(255)", "YES", "", None],
        ],
    })
    columns = get_table_columns(db, _provider("mysql"), "users")
    # 若误读 "rows" 键，这里会是 0
    assert len(columns) == 2
    assert columns[0]["name"] == "id"
    assert columns[0]["key"] == "PRI"
    assert columns[0]["nullable"] is False
    assert columns[1]["nullable"] is True


def test_get_table_columns_reads_data_key_sqlite():
    # PRAGMA table_info 行：cid, name, type, notnull, dflt_value, pk
    db = _FakeDb({
        "success": True,
        "columns": ["cid", "name", "type", "notnull", "dflt_value", "pk"],
        "data": [
            [0, "id", "INTEGER", 1, None, 1],
            [1, "name", "TEXT", 0, None, 0],
        ],
    })
    columns = get_table_columns(db, _provider("sqlite"), "users")
    assert len(columns) == 2
    assert columns[0]["name"] == "id"
    assert columns[0]["key"] == "PRI"  # row[5] 为真 -> PRI


def test_get_primary_key_reads_data_key_mysql():
    # SHOW KEYS FROM ... WHERE Key_name='PRIMARY' -> row[4] 为列名
    db = _FakeDb({
        "success": True,
        "columns": ["Table", "Non_unique", "Key_name", "Seq", "Column_name"],
        "data": [["users", "0", "PRIMARY", "1", "id"]],
    })
    pk = get_primary_key(db, _provider("mysql"), "users")
    # 若误读 "rows" 键，这里会是 None
    assert pk == "id"


def test_standardizer_preserves_data_key():
    from src.services.result_standardizer import standardize_result

    result = {"success": True, "columns": ["a"], "data": [[1], [2]]}
    out = standardize_result(
        result,
        provider_id="mysql",
        source_id=1,
        requested_query="select a from t",
        executed_query="select a from t",
        operation_kind="read",
    )
    assert out["data"] == [[1], [2]]
    assert out["row_count"] == 2
