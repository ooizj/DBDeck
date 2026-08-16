from __future__ import annotations

import socket
from contextlib import closing


def find_available_port(
    preferred_port: int,
    *,
    host: str = "127.0.0.1",
    scan_limit: int = 100,
) -> int:
    """Return the preferred local port, or the next available port."""
    if not 1 <= preferred_port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    if scan_limit < 1:
        raise ValueError("scan_limit must be positive")

    last_port = min(65535, preferred_port + scan_limit - 1)
    for port in range(preferred_port, last_port + 1):
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue

    # A requested port near 65535 may leave no sequential range to scan.
    # Let the operating system select an available ephemeral port as fallback.
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])
