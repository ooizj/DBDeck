from src.sources.mysql.tools import list_tables


class _FakeDb:
    def get_schema(self):
        return {
            "asset_owner": [],
            "asset_owner_contact": [],
        }

    def get_table_comments(self):
        return {
            "asset_owner": "资产方表",
            "asset_owner_contact": "资产方联系人表",
        }


def test_list_tables_includes_comments_without_changing_table_list_contract():
    result = list_tables(db=_FakeDb())

    assert result["success"] is True
    assert result["tables"] == ["asset_owner", "asset_owner_contact"]
    assert result["table_info"] == [
        {"name": "asset_owner", "comment": "资产方表"},
        {"name": "asset_owner_contact", "comment": "资产方联系人表"},
    ]
    assert result["count"] == 2
