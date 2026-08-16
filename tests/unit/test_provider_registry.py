from src.sources import all_providers, get_provider, has_provider


def test_builtin_providers_are_registered_with_product_metadata():
    providers = {p.id: p for p in all_providers()}
    assert {"mysql", "sqlite", "mongodb", "redis"}.issubset(providers)
    assert has_provider("mysql")
    assert get_provider("mongodb").capabilities.engine_family == "document"
    assert get_provider("redis").capabilities.query_language == "redis"
    assert get_provider("sqlite").capabilities.metadata_label == "table"
