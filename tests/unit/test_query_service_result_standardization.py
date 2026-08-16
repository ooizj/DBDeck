from src.services.query_service import _standardize_result


def test_standardize_result_adds_statement_for_single_command_provider():
    result = {
        "success": True,
        "columns": ["count"],
        "data": [[3]],
        "row_count": 1,
        "duration_ms": 4.2,
    }

    standardized = _standardize_result(
        result,
        provider_id="mongodb",
        source_id=7,
        requested_query='{"collection":"users","action":"count"}',
        executed_query='db.getCollection("users").count({})',
        operation_kind="read",
    )

    assert standardized["statements"][0]["executed_query"] == 'db.getCollection("users").count({})'
    assert standardized["statements"][0]["duration_ms"] == 4.2
    assert standardized["active_statement_index"] == 0
    assert standardized["provider_id"] == "mongodb"
