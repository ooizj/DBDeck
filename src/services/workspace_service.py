from __future__ import annotations

import base64
import os
import platform
import subprocess
from typing import Any, Dict, List, Tuple

from fastapi import HTTPException

from src.common.storage import storage

SKIP_NAMES = {
    "__pycache__", "node_modules", ".git", "venv", ".venv", "dist", "build",
}

EXT_LANGUAGE_MAP: Dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".json": "json",
    ".sql": "sql",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".txt": "plaintext",
    ".csv": "plaintext",
    ".log": "plaintext",
    ".env": "plaintext",
    ".vue": "vue",
    ".svelte": "svelte",
    ".r": "r",
    ".dockerfile": "dockerfile",
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
}


def list_workspaces() -> list[dict[str, Any]]:
    return storage.get_workspaces()


def add_workspace(name: str, path: str) -> dict[str, Any]:
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail=f"路径不存在或不是目录：{path}")
    return {"success": True, "id": storage.add_workspace(name, path)}


async def update_workspace(workspace_id: int, fields: dict[str, Any]) -> dict[str, bool]:
    if "path" in fields and not os.path.isdir(fields["path"]):
        raise HTTPException(status_code=400, detail=f"路径不存在或不是目录：{fields['path']}")
    storage.update_workspace(workspace_id, **fields)
    from src.ai_core.mcp_client import manager as mcp_manager
    await mcp_manager.drop(workspace_id)
    return {"success": True}


async def delete_workspace(workspace_id: int) -> dict[str, bool]:
    from src.ai_core.mcp_client import manager as mcp_manager
    await mcp_manager.drop(workspace_id)
    storage.delete_workspace(workspace_id)
    return {"success": True}


def resolve_workspace(workspace_id: int) -> dict:
    ws = storage.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


def safe_resolve(workspace_root: str, relative_path: str) -> str:
    root = os.path.realpath(workspace_root)
    resolved = os.path.realpath(os.path.join(root, relative_path))
    if not resolved.startswith(root + os.sep) and resolved != root:
        raise HTTPException(status_code=403, detail="Path is outside workspace")
    return resolved


def detect_language(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    return EXT_LANGUAGE_MAP.get(ext, "plaintext")


def is_binary(filepath: str, sample_size: int = 8192) -> bool:
    try:
        with open(filepath, "rb") as f:
            return b"\x00" in f.read(sample_size)
    except Exception:
        return True


def compact_directory(workspace_root: str, relative_path: str, name: str) -> Tuple[str, str]:
    current_rel = relative_path
    current_name = name
    while True:
        target = os.path.join(workspace_root, current_rel)
        try:
            entries = [
                e for e in os.scandir(target)
                if not e.name.startswith(".") and e.name not in SKIP_NAMES
            ]
        except (PermissionError, OSError):
            break
        if len(entries) == 1 and entries[0].is_dir(follow_symlinks=False):
            next_entry = entries[0]
            current_rel = os.path.relpath(next_entry.path, workspace_root)
            current_name = f"{current_name} / {next_entry.name}"
        else:
            break
    return current_name, current_rel


def list_workspace_files(workspace_id: int, path: str = "") -> List[Dict[str, Any]]:
    ws = resolve_workspace(workspace_id)
    target = safe_resolve(ws["path"], path or "")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail="Path is not a directory")
    try:
        entries = os.scandir(target)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    root = os.path.realpath(ws["path"])
    items: List[Dict[str, Any]] = []
    for entry in entries:
        if entry.name.startswith(".") or entry.name in SKIP_NAMES:
            continue
        rel = os.path.relpath(entry.path, root)
        if entry.is_dir(follow_symlinks=False):
            compact_name, compact_rel = compact_directory(root, rel, entry.name)
            items.append({
                "name": compact_name,
                "path": compact_rel,
                "is_dir": True,
                "size": None,
                "extension": None,
            })
        else:
            ext = os.path.splitext(entry.name)[1].lstrip(".")
            try:
                size = entry.stat(follow_symlinks=False).st_size
            except OSError:
                size = 0
            items.append({
                "name": entry.name,
                "path": rel,
                "is_dir": False,
                "size": size,
                "extension": ext or None,
            })
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return items


def read_workspace_file(workspace_id: int, path: str) -> dict[str, Any]:
    ws = resolve_workspace(workspace_id)
    target = safe_resolve(ws["path"], path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="File not found")

    ext = os.path.splitext(target)[1].lower()
    if ext in IMAGE_EXTS:
        try:
            with open(target, "rb") as img_f:
                encoded = base64.b64encode(img_f.read()).decode("utf-8")
            mime = MIME_MAP.get(ext, "image/png")
            return {
                "success": True,
                "is_image": True,
                "content": f"data:{mime};base64,{encoded}",
                "language": ext.lstrip("."),
            }
        except Exception as e:
            return {"success": False, "error": f"读取图片失败: {e}"}

    if is_binary(target):
        return {"success": False, "error": "Binary file cannot be displayed"}
    try:
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {
        "success": True,
        "content": content,
        "language": detect_language(os.path.basename(target)),
    }


def save_workspace_file(workspace_id: int, path: str, content: str) -> dict[str, bool]:
    ws = resolve_workspace(workspace_id)
    target = safe_resolve(ws["path"], path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"success": True}


def reveal_file_location(workspace_id: int, path: str) -> dict[str, bool]:
    ws = resolve_workspace(workspace_id)
    target = safe_resolve(ws["path"], path)
    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail="File or folder not found")
    try:
        system = platform.system()
        if system == "Windows":
            subprocess.run(["explorer", "/select,", target] if os.path.isfile(target) else ["explorer", target])
        elif system == "Darwin":
            subprocess.run(["open", "-R", target] if os.path.isfile(target) else ["open", target])
        else:
            dir_to_open = os.path.dirname(target) if os.path.isfile(target) else target
            subprocess.run(["xdg-open", dir_to_open])
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open location: {e}")
