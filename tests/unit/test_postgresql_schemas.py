from src.sources.postgresql.client import is_system_schema, qualify_name


def test_default_schema_objects_keep_bare_name():
    assert qualify_name("public", "review", "public") == "review"
    assert qualify_name(None, "review", "public") == "review"


def test_other_schema_objects_are_qualified():
    assert qualify_name("xapp_review", "review", "public") == "xapp_review.review"
    # search_path 为空时没有默认模式，全部带模式前缀
    assert qualify_name("public", "review", None) == "public.review"


def test_system_schemas_are_hidden():
    for name in ("pg_catalog", "information_schema", "pg_toast", "pg_temp_3", "pg_toast_temp_1"):
        assert is_system_schema(name)
    for name in ("public", "xapp_review", "pg_custom"):
        assert not is_system_schema(name)
