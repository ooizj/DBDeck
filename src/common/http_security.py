from __future__ import annotations

from urllib.parse import urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        (
            "script-src 'self' 'unsafe-eval' https://unpkg.com "
            "https://cdnjs.cloudflare.com https://cdn.sheetjs.com "
            "https://cdn.jsdelivr.net"
        ),
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' data: blob:",
        "font-src 'self' data: https://cdnjs.cloudflare.com",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ]
)


class LocalOriginMiddleware(BaseHTTPMiddleware):
    """Reject cross-origin state changes against the loopback-only API."""

    async def dispatch(self, request: Request, call_next) -> Response:
        origin = request.headers.get("origin")
        if request.method in _UNSAFE_METHODS and origin:
            origin_parts = urlsplit(origin)
            request_host = request.headers.get("host", "").lower()
            if origin_parts.netloc.lower() != request_host:
                return JSONResponse(
                    {"success": False, "error": "Cross-origin request rejected"},
                    status_code=403,
                )

        response = await call_next(request)
        response.headers["Content-Security-Policy"] = _CONTENT_SECURITY_POLICY
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response
