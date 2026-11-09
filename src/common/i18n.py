"""Language of user-facing backend messages (errors, notices returned to the UI).

The web UI sends its current language in the ``X-DBDeck-Language`` header (``zh`` or ``en``).
:class:`LanguageMiddleware` stores it in a context variable for the duration of the request, and
service code builds messages with :func:`msg`, which picks the Chinese or English text.

Without the header (old clients, scripts, tests) messages stay in Chinese, the original language.
Log messages and prompts sent to the LLM are not translated.
"""
from __future__ import annotations

import ctypes
import locale
import os
import re
import subprocess
import sys
from contextvars import ContextVar
from functools import lru_cache
from typing import Optional

SUPPORTED_LANGUAGES = ("zh", "en")
DEFAULT_LANGUAGE = "zh"
LANGUAGE_HEADER = "x-dbdeck-language"
UI_LANGUAGE_CONFIG_KEY = "UI_LANGUAGE"

_current_language: ContextVar[str] = ContextVar("dbdeck_language", default=DEFAULT_LANGUAGE)


def normalize_language(value: Optional[str]) -> Optional[str]:
    text = (value or "").strip().lower()
    if text.startswith("zh"):
        return "zh"
    if text.startswith("en"):
        return "en"
    return None


# Windows LANGID 的主语言号（LANGID & 0x3FF）
_WINDOWS_PRIMARY_LANGUAGES = {0x04: "zh", 0x09: "en"}


def _macos_language() -> Optional[str]:
    # 从 Finder/Dock 启动的 .app 没有 LANG，只能读系统偏好里的语言列表
    result = subprocess.run(
        ["defaults", "read", "-g", "AppleLanguages"],
        capture_output=True, text=True, timeout=2, check=False,
    )
    match = re.search(r'"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?', result.stdout or "")
    return match.group(1) if match else None


def _windows_language() -> Optional[str]:
    langid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
    primary = _WINDOWS_PRIMARY_LANGUAGES.get(langid & 0x3FF)
    if primary:
        return primary
    return locale.windows_locale.get(langid)


def _posix_language() -> Optional[str]:
    for name in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        value = os.environ.get(name, "").split(":")[0]
        if value and value not in ("C", "POSIX") and not value.startswith("C."):
            return value
    return None


@lru_cache(maxsize=1)
def detect_system_language() -> Optional[str]:
    """操作系统界面语言的原始标签（如 ``zh-Hans-CN``、``en_US``、``fr-FR``），取不到时为 None。

    桌面版 WebView 报告的 navigator.language 取决于 WebView 和应用自身的本地化声明，不一定等于
    系统语言，所以由后端直接读取系统设置；前端在用户没有手动选过语言时以此为默认。
    """
    try:
        if sys.platform == "darwin":
            return _macos_language() or _posix_language()
        if sys.platform == "win32":
            return _windows_language()
        return _posix_language()
    except Exception:  # 检测失败不影响启动，前端退回浏览器语言
        return None


def get_language() -> str:
    return _current_language.get()


def set_language(value: Optional[str]):
    """Set the language for the current context; returns a token for :func:`reset_language`."""
    return _current_language.set(normalize_language(value) or DEFAULT_LANGUAGE)


def reset_language(token) -> None:
    _current_language.reset(token)


def msg(zh: str, en: str) -> str:
    """Return the message in the current request's language."""
    return en if get_language() == "en" else zh


class LanguageMiddleware:
    """Pure ASGI middleware so the context variable is visible to sync endpoints run in the
    thread pool and to streaming response bodies (BaseHTTPMiddleware would break the latter)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        header_value = None
        for name, value in scope.get("headers") or []:
            if name.decode("latin-1").lower() == LANGUAGE_HEADER:
                header_value = value.decode("latin-1")
                break
        token = set_language(header_value)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_language(token)
