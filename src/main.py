import argparse
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

# 触发 SourceProvider 注册（import 副作用）
import src.sources  # noqa: F401
from src.api.routes import router
from src.common.http_security import LocalOriginMiddleware
from src.common.network import find_available_port
from src.version import __version__

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def resource_path(relative_path: str) -> Path:
    """Resolve project resources both in source checkout and PyInstaller bundles."""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / relative_path
    return Path(__file__).resolve().parent.parent / relative_path


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    from src.sources.connection_manager import connection_manager

    connection_manager.close_all()


app = FastAPI(title="DBDeck", version=__version__, lifespan=lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"],
)
app.add_middleware(LocalOriginMiddleware)

# 注册 API 路由
app.include_router(router, prefix="/api")


class RevalidatingStaticFiles(StaticFiles):
    """静态资源每次都向服务端校验（ETag），避免 WebView 缓存旧版 JS 模块。"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# 最合理的静态文件挂载方式：
# 1. 挂载 web_ui 目录到根路径 /
# 2. html=True 会让 FastAPI 在访问 / 时自动查找 index.html
# 3. 这种方式能自动处理 css/, js/ 等所有子目录
app.mount("/", RevalidatingStaticFiles(directory=resource_path("web_ui"), html=True), name="web_ui")

# 注意：开启 html=True 后，就不再需要显式的 @app.get("/") 路由了。
# 如果仍需显式控制，确保它在 mount 之前定义。

def _port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run DBDeck web server")
    parser.add_argument("--port", type=_port, default=31415, help="preferred local port")
    return parser.parse_args(argv)


def main(argv=None) -> None:
    args = _parse_args(argv)
    port = find_available_port(args.port)
    if port != args.port:
        logger.warning("Port %s is unavailable; using port %s instead", args.port, port)
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
