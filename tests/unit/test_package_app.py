import pytest

from scripts import package_app


def test_macos_package_settings(monkeypatch):
    monkeypatch.setattr(package_app.sys, "platform", "darwin")

    icon, arguments, output = package_app.platform_settings()

    assert icon == package_app.ROOT / "assets" / "app-icon.icns"
    assert "webview.platforms.cocoa" in arguments
    assert output == package_app.ROOT / "dist" / "DBDeck.app"


def test_windows_package_settings(monkeypatch):
    monkeypatch.setattr(package_app.sys, "platform", "win32")

    icon, arguments, output = package_app.platform_settings()

    assert icon == package_app.ROOT / "assets" / "app-icon.ico"
    assert "--onefile" in arguments
    assert "webview.platforms.winforms" in arguments
    assert "webview.platforms.edgechromium" in arguments
    assert output == package_app.ROOT / "dist" / "DBDeck.exe"


def test_package_settings_reject_unsupported_platform(monkeypatch):
    monkeypatch.setattr(package_app.sys, "platform", "linux")

    with pytest.raises(SystemExit, match="supports macOS and Windows only"):
        package_app.platform_settings()
