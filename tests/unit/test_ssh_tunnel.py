import pytest

from src.sources.ssh_tunnel import clean_str, open_ssh_tunnel


def test_open_ssh_tunnel_returns_original_endpoint_when_disabled():
    host, port, tunnel = open_ssh_tunnel({}, "db.internal", 3306, label="Test")

    assert host == "db.internal"
    assert port == 3306
    assert tunnel is None


def test_open_ssh_tunnel_validates_required_fields_before_starting():
    with pytest.raises(ValueError, match="SSH 主机和 SSH 用户"):
        open_ssh_tunnel(
            {"use_ssh_tunnel": True, "ssh_host": "jump.example.com"},
            "db.internal",
            3306,
            label="Test",
        )


def test_clean_str_trims_and_normalizes_empty_values():
    assert clean_str("  user  ") == "user"
    assert clean_str("  ") is None
    assert clean_str(None) is None
