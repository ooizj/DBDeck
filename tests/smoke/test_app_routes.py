from fastapi.testclient import TestClient

from src.main import app


def test_main_api_routes_are_registered():
    paths = {getattr(route, "path", "") for route in app.routes}
    required = {
        "/api/health",
        "/api/providers",
        "/api/sources",
        "/api/metadata",
        "/api/query",
        "/api/clear-chat",
        "/api/config",
        "/api/export-config",
        "/api/import-config",
        "/api/import-dbeaver-config",
        "/api/migrate",
    }
    assert required.issubset(paths)


def test_loopback_http_security_headers_and_host_validation():
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"

    rejected = client.get("/api/health", headers={"host": "attacker.example"})
    assert rejected.status_code == 400


def test_cross_origin_state_changes_are_rejected():
    client = TestClient(app)
    response = client.post(
        "/api/health",
        headers={"origin": "https://attacker.example"},
    )
    assert response.status_code == 403
