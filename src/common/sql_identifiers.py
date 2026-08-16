from __future__ import annotations

from typing import Optional


def split_qualified_identifier(identifier: str) -> tuple[Optional[str], str]:
    """Split an optional schema-qualified identifier and reject invalid input."""
    if not isinstance(identifier, str) or not identifier.strip() or "\x00" in identifier:
        raise ValueError("Identifier must be a non-empty string")
    parts = [part.strip() for part in identifier.split(".")]
    if any(not part for part in parts) or len(parts) > 2:
        raise ValueError(f"Invalid identifier: {identifier}")
    return (parts[0], parts[1]) if len(parts) == 2 else (None, parts[0])


def quote_identifier(provider_id: str, identifier: str) -> str:
    """Quote one atomic SQL identifier, preserving dots in the name."""
    if not isinstance(identifier, str) or not identifier.strip() or "\x00" in identifier:
        raise ValueError("Identifier must be a non-empty string")
    quote = "`" if provider_id == "mysql" else '"'
    return quote + identifier.replace(quote, quote * 2) + quote


def quote_qualified_identifier(provider_id: str, identifier: str) -> str:
    """Quote an optionally schema-qualified SQL relation name."""
    schema, name = split_qualified_identifier(identifier)
    return ".".join(
        quote_identifier(provider_id, part)
        for part in (schema, name)
        if part is not None
    )
