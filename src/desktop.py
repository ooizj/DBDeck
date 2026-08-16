import argparse
import logging
import socket
import threading
import time
from contextlib import closing
from pathlib import Path

import uvicorn

from src.common.network import find_available_port
from src.main import app

logger = logging.getLogger(__name__)


class DesktopApi:
    def save_file(self, default_filename: str, content: str, file_types: str = "") -> dict:
        """通用文件保存对话框。content 为文本或 base64 编码的二进制（以 'base64:' 开头）。"""
        try:
            import webview
            import base64

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"success": False, "error": "No desktop window is available"}

            # pywebview 要求 "描述 (*.ext)" 格式，参考已有的 save_markdown
            descs = {
                "csv": "CSV", "json": "JSON", "xlsx": "Excel",
                "sql": "SQL", "md": "Markdown", "txt": "Text",
            }
            if file_types:
                exts = [e.lstrip("*.").strip() for e in file_types.split("|") if e.strip()]
                ft = tuple(f"{descs.get(e, e.upper())} (*.{e})" for e in exts)
            else:
                ft = ("All Files (*.*)",)

            paths = window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=ft,
            )
            if not paths:
                return {"success": False, "cancelled": True}

            selected_path = paths if isinstance(paths, str) else paths[0]
            path = Path(selected_path)
            if not path.name:
                return {"success": False, "cancelled": True}

            if content.startswith("base64:"):
                data = base64.b64decode(content[7:])
                path.write_bytes(data)
            else:
                path.write_text(content, encoding="utf-8")
            return {"success": True, "path": str(path)}
        except Exception as exc:
            logger.exception("Failed to save file")
            return {"success": False, "error": str(exc)}

    def save_markdown(self, default_filename: str, content: str) -> dict:
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"success": False, "error": "No desktop window is available"}

            if not default_filename.endswith(".md"):
                default_filename = f"{default_filename}.md"

            paths = window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=("Markdown (*.md)", "Text (*.txt)"),
            )
            if not paths:
                return {"success": False, "cancelled": True}

            selected_path = paths if isinstance(paths, str) else paths[0]
            path = Path(selected_path)
            if not path.name:
                return {"success": False, "cancelled": True}
            if not path.suffix:
                path = path.with_suffix(".md")
            path.write_text(content, encoding="utf-8")
            return {"success": True, "path": str(path)}
        except Exception as exc:
            logger.exception("Failed to save markdown export")
            return {"success": False, "error": str(exc)}

    def save_json(self, default_filename: str, content: str) -> dict:
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"success": False, "error": "No desktop window is available"}

            if not default_filename.endswith(".json"):
                default_filename = f"{default_filename}.json"

            paths = window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=("JSON Config (*.json)", "Text (*.txt)"),
            )
            if not paths:
                return {"success": False, "cancelled": True}

            selected_path = paths if isinstance(paths, str) else paths[0]
            path = Path(selected_path)
            if not path.name:
                return {"success": False, "cancelled": True}
            if not path.suffix:
                path = path.with_suffix(".json")
            path.write_text(content, encoding="utf-8")
            return {"success": True, "path": str(path)}
        except Exception as exc:
            logger.exception("Failed to save json export")
            return {"success": False, "error": str(exc)}

    def import_dbeaver_file(self) -> dict:
        try:
            import webview
            from src.services import config_service

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"success": False, "error": "No desktop window is available"}

            paths = window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=(
                    "DBeaver DBP (*.dbp;*.zip;*.json)",
                    "All Files (*.*)",
                ),
            )
            if not paths:
                return {"success": False, "cancelled": True}

            selected_path = paths if isinstance(paths, str) else paths[0]
            path = Path(selected_path)
            return config_service.import_dbeaver_path(str(path))
        except Exception as exc:
            logger.exception("Failed to import DBeaver file")
            return {"success": False, "error": str(exc)}


def _free_port(start: int = 31415) -> int:
    return find_available_port(start)


def _wait_until_ready(port: int, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.2)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError("Desktop server did not start in time")


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run DBDeck desktop app")
    parser.add_argument("--port", type=int, default=31415, help="preferred local port")
    args, _unknown = parser.parse_known_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    return args


def main(argv=None) -> None:
    args = _parse_args(argv)
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError(
            "pywebview is not installed. Run `pip install -r requirements.txt` first."
        ) from exc

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    port = _free_port(args.port)
    if port != args.port:
        logger.warning("Port %s is unavailable; using port %s instead", args.port, port)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_until_ready(port)

    import time as _time
    url = f"http://127.0.0.1:{port}?v={int(_time.time())}"
    logger.info("Starting desktop window at %s", url)
    window = webview.create_window(
        "DBDeck",
        url,
        js_api=DesktopApi(),
        width=1440,
        height=920,
        min_size=(1100, 720),
        text_select=True,
        background_color="#1a2332",
        hidden=True,                 # Hide window initially to prevent white/black flash
    )

    def on_loaded(*args, **kwargs):
        time.sleep(0.05)  # Tiny delay to let rendering settle
        window.show()
        window.events.loaded -= on_loaded

    window.events.loaded += on_loaded
    webview.start()
    server.should_exit = True


if __name__ == "__main__":
    main()
