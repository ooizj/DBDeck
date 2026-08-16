"""Error-message helpers."""
from __future__ import annotations

import re
from typing import Any, Iterable


_SENSITIVE_KEYS = {
    "password",
    "ssh_password",
    "ssh_private_key_passphrase",
}


def secrets_from_config(config: dict[str, Any] | None) -> list[str]:
    if not config:
        return []
    secrets: list[str] = []
    for key, value in config.items():
        if key in _SENSITIVE_KEYS and value:
            secrets.append(str(value))
    return secrets


def redact_sensitive(message: Any, secrets: Iterable[str] | None = None) -> str:
    text = str(message)
    for secret in secrets or []:
        if secret:
            text = text.replace(str(secret), "******")

    text = re.sub(
        r"(?i)(AUTH\s+\S+\s+)([^\s,;]+)",
        r"\1******",
        text,
    )
    text = re.sub(
        r"(?i)(AUTH\s+)([^\s,;]+)",
        r"\1******",
        text,
    )
    text = re.sub(
        r"(?i)(://[^:/\s]+:)([^@\s]+)(@)",
        r"\1******\3",
        text,
    )
    text = re.sub(
        r"(?i)(password['\"]?\s*[:=]\s*['\"]?)([^'\",\s}]+)",
        r"\1******",
        text,
    )
    return text
