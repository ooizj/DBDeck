"""后端提示信息的语言：X-DBDeck-Language 请求头 → msg(中文, English)。"""
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from src.common import i18n
from src.common.i18n import (
    LanguageMiddleware,
    get_language,
    msg,
    normalize_language,
    reset_language,
    set_language,
)
from src.common.storage import Storage
from src.services import config_service


def test_msg_defaults_to_chinese_and_follows_the_current_language():
    assert msg("中文", "English") == "中文"
    token = set_language("en-US")
    try:
        assert get_language() == "en"
        assert msg("中文", "English") == "English"
    finally:
        reset_language(token)
    assert msg("中文", "English") == "中文"


def test_unknown_languages_fall_back_to_chinese():
    assert normalize_language("zh-TW") == "zh"
    assert normalize_language("EN") == "en"
    assert normalize_language("fr") is None
    token = set_language("fr")
    try:
        assert get_language() == "zh"
    finally:
        reset_language(token)


def _app():
    app = FastAPI()
    app.add_middleware(LanguageMiddleware)

    @app.get("/sync")
    def sync_endpoint():  # 同步路由在线程池中执行
        return {"message": msg("你好", "Hello")}

    @app.get("/async")
    async def async_endpoint():
        return {"message": msg("你好", "Hello")}

    @app.get("/stream")
    async def stream_endpoint():
        async def events():
            yield msg("流", "stream")

        return StreamingResponse(events())

    return app


def test_middleware_applies_the_header_to_sync_async_and_streaming_endpoints():
    client = TestClient(_app())
    for path in ("/sync", "/async"):
        assert client.get(path).json() == {"message": "你好"}
        assert client.get(path, headers={"X-DBDeck-Language": "en"}).json() == {"message": "Hello"}
        assert client.get(path, headers={"X-DBDeck-Language": "zh"}).json() == {"message": "你好"}
    assert client.get("/stream", headers={"X-DBDeck-Language": "en"}).text == "stream"
    assert client.get("/stream").text == "流"


def test_ui_language_preference_is_saved_in_config_storage(tmp_path, monkeypatch):
    temp_storage = Storage(str(tmp_path / "config.db"))
    monkeypatch.setattr(config_service, "storage", temp_storage)
    monkeypatch.setattr(config_service, "detect_system_language", lambda: "zh-Hans-CN")

    assert config_service.get_ui_preferences() == {"success": True, "language": None, "system_language": "zh-Hans-CN"}
    assert config_service.update_ui_preferences("en-GB") == {"success": True, "language": "en"}
    assert config_service.get_ui_preferences()["language"] == "en"

    rejected = config_service.update_ui_preferences("fr")
    assert rejected["success"] is False
    assert config_service.get_ui_preferences()["language"] == "en"
    # 选择「跟随系统」时清除保存的语言
    assert config_service.update_ui_preferences("system") == {"success": True, "language": None}
    assert config_service.get_ui_preferences()["language"] is None
    # 界面语言不混进 AI 设置
    assert "UI_LANGUAGE" not in config_service.get_config_values()


def _detect(monkeypatch, platform, **fakes):
    monkeypatch.setattr(i18n.sys, "platform", platform)
    for name, value in fakes.items():
        monkeypatch.setattr(i18n, name, value)
    i18n.detect_system_language.cache_clear()
    try:
        return i18n.detect_system_language()
    finally:
        i18n.detect_system_language.cache_clear()


def test_system_language_on_macos_reads_apple_languages(monkeypatch):
    class Result:
        stdout = '(\n    "zh-Hans-CN",\n    "en-CN"\n)\n'

    monkeypatch.setattr(i18n.subprocess, "run", lambda *a, **k: Result())
    assert _detect(monkeypatch, "darwin") == "zh-Hans-CN"

    Result.stdout = "(\n    en,\n    \"zh-Hans\"\n)\n"
    assert _detect(monkeypatch, "darwin") == "en"


def test_system_language_on_windows_uses_the_ui_language_id(monkeypatch):
    class Kernel32:
        def __init__(self, langid):
            self.langid = langid

        def GetUserDefaultUILanguage(self):
            return self.langid

    class WinDll:
        kernel32 = Kernel32(0x0804)  # zh-CN

    monkeypatch.setattr(i18n.ctypes, "windll", WinDll, raising=False)
    assert i18n._windows_language() == "zh"
    WinDll.kernel32 = Kernel32(0x0409)  # en-US
    assert i18n._windows_language() == "en"
    WinDll.kernel32 = Kernel32(0x040C)  # fr-FR
    assert i18n._windows_language() == "fr_FR"
    WinDll.kernel32 = Kernel32(0x0804)
    assert _detect(monkeypatch, "win32") == "zh"


def test_system_language_on_linux_uses_locale_env_and_never_raises(monkeypatch):
    for name in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LANG", "zh_CN.UTF-8")
    assert _detect(monkeypatch, "linux") == "zh_CN.UTF-8"
    monkeypatch.setenv("LANG", "C.UTF-8")
    assert _detect(monkeypatch, "linux") is None

    def boom():
        raise OSError("no locale")

    assert _detect(monkeypatch, "linux", _posix_language=boom) is None
