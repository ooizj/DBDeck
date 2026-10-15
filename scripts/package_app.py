from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "DBDeck"


def platform_settings() -> tuple[Path, list[str], Path]:
    """Return icon, PyInstaller platform arguments, and packaged app path."""
    if sys.platform == "darwin":
        return (
            ROOT / "assets" / "app-icon.icns",
            [
                "--osx-bundle-identifier",
                "io.github.ooizj.dbdeck",
                "--hidden-import",
                "webview.platforms.cocoa",
            ],
            ROOT / "dist" / f"{APP_NAME}.app",
        )
    if sys.platform == "win32":
        return (
            ROOT / "assets" / "app-icon.ico",
            [
                "--onefile",
                "--hidden-import",
                "webview.platforms.winforms",
                "--hidden-import",
                "webview.platforms.edgechromium",
            ],
            ROOT / "dist" / f"{APP_NAME}.exe",
        )
    raise SystemExit("Desktop packaging currently supports macOS and Windows only.")


def run(cmd: list[str]) -> None:
    print("$ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True)


def main() -> None:
    os.chdir(ROOT)
    dist_dir = ROOT / "dist"
    build_dir = ROOT / "build"
    app_icon, platform_args, app_path = platform_settings()

    if app_path.exists():
        if app_path.is_dir():
            shutil.rmtree(app_path)
        else:
            app_path.unlink()

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        APP_NAME,
        "--icon",
        str(app_icon),
        "--add-data",
        f"{ROOT / 'web_ui'}:web_ui",
        "--add-data",
        f"{ROOT / 'src'}:src",
        "--add-data",
        f"{ROOT / 'LICENSE'}:.",
        "--add-data",
        f"{ROOT / 'THIRD_PARTY_NOTICES.md'}:.",
        "--hidden-import",
        "pymysql",
        "--hidden-import",
        "redis",
        "--hidden-import",
        "cryptography",
        "--hidden-import",
        "sqlglot",
        "--hidden-import",
        "sshtunnel",
        "--hidden-import",
        "paramiko",
        "--collect-submodules",
        "sqlglot",
        "--collect-submodules",
        "paramiko",
        "--collect-submodules",
        "uvicorn",
        "--collect-submodules",
        "webview",
        *platform_args,
        str(ROOT / "src" / "desktop.py"),
    ]
    run(command)

    print()
    print(f"打包完成: {app_path}")
    if sys.platform == "win32":
        print(f"可以双击 {app_path} 启动。")
    else:
        print("可以双击 dist 目录里的 DBDeck.app 启动。")
    print(f"构建缓存: {build_dir}")


if __name__ == "__main__":
    main()
