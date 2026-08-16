from src.common.storage import Storage
from src.services import config_service
import json
import zipfile


class DummyConfig:
    llm_api_key = ""
    llm_api_base = "https://api.openai.com/v1"
    llm_model = "test-model"
    llm_temperature = 0.1

    def reload(self):
        pass


def test_config_export_import_preserves_secret_values(tmp_path, monkeypatch):
    temp_storage = Storage(str(tmp_path / "config.db"))
    monkeypatch.setattr(config_service, "storage", temp_storage)
    monkeypatch.setattr(config_service, "config", DummyConfig())

    config_service.import_config(
        [{
            "name": "local",
            "type": "mysql",
            "host": "localhost",
            "port": 3306,
            "user": "root",
            "password": "db-password",
            "database": "demo",
            "ssh_password": "ssh-password",
            "ssh_private_key": "private-key",
        }],
        {"LLM_API_KEY": "sk-secret", "LLM_MODEL": "model-x"},
    )

    exported = config_service.export_config()["data"]
    source = exported["data_sources"][0]
    assert source["password"] == "db-password"
    assert source["ssh_password"] == "ssh-password"
    assert source["ssh_private_key"] == "private-key"
    assert exported["system_config"]["LLM_API_KEY"] == "sk-secret"


def test_parse_dbeaver_data_sources_maps_mysql_and_ssh_tunnel():
    parsed = config_service.parse_dbeaver_data_sources(
        {
            "connections": {
                "mysql8-example": {
                    "provider": "mysql",
                    "name": "prod",
                    "configuration": {
                        "host": "10.0.0.8",
                        "port": "3306",
                        "database": "app",
                        "handlers": {
                            "ssh_tunnel": {
                                "enabled": True,
                                "properties": {
                                    "host": "jump.example.com",
                                    "port": 22.0,
                                },
                            }
                        },
                    },
                }
            }
        }
    )

    assert parsed["skipped_count"] == 0
    assert parsed["data_sources"] == [
        {
            "name": "prod",
            "type": "mysql",
            "host": "10.0.0.8",
            "port": 3306,
            "user": None,
            "password": None,
            "database": "app",
            "use_ssh_tunnel": 1,
            "ssh_host": "jump.example.com",
            "ssh_port": 22,
            "ssh_user": None,
            "ssh_password": None,
            "ssh_private_key": None,
        }
    ]


def test_import_dbeaver_dbp_zip_adds_sources_and_deduplicates(tmp_path, monkeypatch):
    temp_storage = Storage(str(tmp_path / "config.db"))
    monkeypatch.setattr(config_service, "storage", temp_storage)
    monkeypatch.setattr(config_service, "config", DummyConfig())

    dbp_path = tmp_path / "General.dbp"
    data_sources = {
        "connections": {
            "mysql8-example": {
                "provider": "mysql",
                "name": "dev",
                "configuration": {
                    "url": "jdbc:mysql://127.0.0.1:3307/demo",
                    "configurationType": "MANUAL",
                },
            }
        }
    }
    with zipfile.ZipFile(dbp_path, "w") as zf:
        zf.writestr(
            "projects/General/.dbeaver/data-sources.json",
            json.dumps(data_sources),
        )

    first = config_service.import_dbeaver_file(dbp_path.name, dbp_path.read_bytes())
    second = config_service.import_dbeaver_file(dbp_path.name, dbp_path.read_bytes())

    assert first["success"] is True
    assert first["parsed_count"] == 1
    assert first["imported_count"] == 1
    assert second["imported_count"] == 0
    source = temp_storage.get_sources()[0]
    assert source["name"] == "dev"
    assert source["host"] == "127.0.0.1"
    assert source["port"] == 3307
    assert source["database"] == "demo"
