from src.common import storage


def test_frozen_app_migrates_legacy_config_to_dbdeck(tmp_path, monkeypatch):
    legacy_db = (
        tmp_path
        / "Library"
        / "Application Support"
        / "Universal DB Studio"
        / "config.db"
    )
    legacy_db.parent.mkdir(parents=True)
    legacy_db.write_bytes(b"legacy-config")

    monkeypatch.setattr(storage.sys, "frozen", True, raising=False)
    monkeypatch.setattr(storage.sys, "platform", "darwin")
    monkeypatch.setattr(storage.Path, "home", classmethod(lambda cls: tmp_path))

    db_path = storage._default_db_path()

    assert db_path == tmp_path / "Library" / "Application Support" / "DBDeck" / "config.db"
    assert db_path.read_bytes() == b"legacy-config"
    assert legacy_db.exists()


def test_frozen_windows_app_uses_local_app_data(tmp_path, monkeypatch):
    local_app_data = tmp_path / "LocalAppData"
    monkeypatch.setattr(storage.sys, "frozen", True, raising=False)
    monkeypatch.setattr(storage.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))

    db_path = storage._default_db_path()

    assert db_path == local_app_data / "DBDeck" / "config.db"
    assert db_path.parent.is_dir()
