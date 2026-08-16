"""Shared SSH tunnel helpers for TCP-based data source clients."""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


def clean_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def open_ssh_tunnel(
    config_dict: Dict[str, Any],
    remote_host: str,
    remote_port: int,
    *,
    label: str,
) -> Tuple[str, int, Any]:
    """Start an SSH tunnel when enabled and return local bind host/port plus handle."""
    if not config_dict.get("use_ssh_tunnel"):
        return remote_host, remote_port, None

    ssh_host = clean_str(config_dict.get("ssh_host"))
    ssh_user = clean_str(config_dict.get("ssh_user"))
    if not ssh_host or not ssh_user:
        raise ValueError("启用 SSH 通道时必须填写 SSH 主机和 SSH 用户")

    try:
        from sshtunnel import SSHTunnelForwarder
    except ImportError as exc:
        raise RuntimeError("SSH 通道依赖未安装，请先 pip install sshtunnel") from exc

    ssh_password = clean_str(config_dict.get("ssh_password"))
    ssh_private_key = clean_str(config_dict.get("ssh_private_key"))
    ssh_private_key_passphrase = clean_str(
        config_dict.get("ssh_private_key_passphrase")
    )
    tunnel_kwargs: Dict[str, Any] = {
        "ssh_address_or_host": (ssh_host, int(config_dict.get("ssh_port") or 22)),
        "ssh_username": ssh_user,
        "ssh_config_file": None,
        "allow_agent": not (ssh_password or ssh_private_key),
        "host_pkey_directories": [],
        "remote_bind_address": (remote_host, int(remote_port)),
        "local_bind_address": ("127.0.0.1", 0),
    }
    if ssh_password:
        tunnel_kwargs["ssh_password"] = ssh_password
    if ssh_private_key:
        tunnel_kwargs["ssh_pkey"] = ssh_private_key
    if ssh_private_key_passphrase:
        tunnel_kwargs["ssh_private_key_password"] = ssh_private_key_passphrase

    tunnel = SSHTunnelForwarder(**tunnel_kwargs)
    tunnel.start()
    logger.info(
        "Started %s SSH tunnel %s:%s -> %s:%s",
        label,
        tunnel.local_bind_host,
        tunnel.local_bind_port,
        remote_host,
        remote_port,
    )
    return tunnel.local_bind_host, tunnel.local_bind_port, tunnel


def close_ssh_tunnel(tunnel: Any) -> None:
    if not tunnel:
        return
    try:
        tunnel.stop()
    except Exception:
        logger.warning("Failed to stop SSH tunnel", exc_info=True)
