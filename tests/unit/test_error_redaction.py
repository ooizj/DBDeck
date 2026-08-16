from src.common.errors import redact_sensitive, secrets_from_config


def test_redact_sensitive_replaces_known_secrets_and_auth_payloads():
    message = (
        "unknown command `HELLO`, with args beginning with: "
        "`3`, `AUTH`, `default`, `redis-password`,"
    )

    redacted = redact_sensitive(
        message,
        secrets_from_config({"password": "redis-password"}),
    )

    assert "redis-password" not in redacted
    assert "******" in redacted


def test_redact_sensitive_masks_url_passwords():
    redacted = redact_sensitive("redis://default:secret@example.com:6379/0")

    assert "secret" not in redacted
    assert "default:******@" in redacted
