from __future__ import annotations

from urllib.parse import urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        # 前端依赖均已放在 web_ui/vendor，本地加载，不再放行外部 CDN
        "script-src 'self' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
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
