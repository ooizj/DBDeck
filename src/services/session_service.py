"""会话管理业务逻辑（从 session_routes 下沉而来）。

路由层只做 HTTP 编排；本模块负责按 provider 方言查询会话/终止会话并归一化结果。
连接生命周期由 managed_source 管理。
"""
from __future__ import annotations

import logging

from src.common.db_utils import managed_source
from src.common.errors import redact_sensitive

logger = logging.getLogger(__name__)


def get_sessions(source_id: int) -> dict:
    """获取数据库会话列表。"""
    try:
        with managed_source(source_id) as (provider, db):
            if provider.id == "mysql":
                result = db.execute("SHOW PROCESSLIST")
                sessions = []
                if result and 'data' in result:
                    for row in result['data']:
                        sessions.append({
                            'id': row[0],
                            'user': row[1],
                            'host': row[2],
                            'db': row[3],
                            'command': row[4],
                            'time': row[5],
                            'state': row[6],
                            'info': row[7][:100] if row[7] else None
                        })
                return {"success": True, "sessions": sessions}

            elif provider.id == "postgresql":
                query = """
                    SELECT pid, usename, client_addr, datname, state, query,
                           backend_start, state_change, wait_event_type, wait_event
                    FROM pg_stat_activity
                    WHERE pid != pg_backend_pid()
                    ORDER BY backend_start DESC
                """
                result = db.execute(query)
                sessions = []
                if result and 'data' in result:
                    for row in result['data']:
                        sessions.append({
                            'id': row[0],
                            'user': row[1],
                            'host': str(row[2]) if row[2] else 'local',
                            'db': row[3],
                            'state': row[4],
                            'query': row[5][:100] if row[5] else None,
                            'started': str(row[6]),
                            'last_active': str(row[7]),
                            'wait_type': row[8],
                            'wait_event': row[9]
                        })
                return {"success": True, "sessions": sessions}

            elif provider.id == "sqlite":
                return {"success": True, "sessions": [], "message": "SQLite 不支持多会话"}

            elif provider.id == "mongodb":
                result = db.execute("db.currentOp(true)")
                sessions = []
                if result and 'inprog' in result:
                    for op in result['inprog']:
                        sessions.append({
                            'id': op.get('opid'),
                            'user': op.get('effectiveUsers', [{}])[0].get('user', 'unknown'),
                            'host': op.get('client', 'unknown'),
                            'db': op.get('ns', '').split('.')[0],
                            'command': op.get('op'),
                            'time': op.get('microsecs_running', 0) / 1000000,
                            'state': 'active' if op.get('active') else 'idle',
                            'info': str(op.get('query', ''))[:100]
                        })
                return {"success": True, "sessions": sessions}

            elif provider.id == "redis":
                result = db.execute("CLIENT LIST")
                sessions = []
                if result:
                    lines = result.strip().split('\n')
                    for line in lines[1:]:  # 跳过标题行
                        parts = line.split()
                        session = {}
                        for part in parts:
                            if '=' in part:
                                key, value = part.split('=', 1)
                                session[key] = value
                        if session:
                            sessions.append({
                                'id': session.get('id'),
                                'user': session.get('user', 'default'),
                                'host': session.get('addr', 'unknown'),
                                'db': session.get('db', '0'),
                                'command': session.get('cmd', 'unknown'),
                                'time': int(session.get('age', 0)),
                                'state': 'idle' if session.get('idle', '0') != '0' else 'active',
                                'info': session.get('name', '')
                            })
                return {"success": True, "sessions": sessions}

            return {"success": False, "error": f"不支持的数据库类型: {provider.id}"}

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}


def kill_session(source_id: int, session_id: str) -> dict:
    """终止数据库会话。"""
    try:
        numeric_session_id = int(session_id)
        if numeric_session_id < 0:
            raise ValueError("会话 ID 必须是非负整数")
        with managed_source(source_id) as (provider, db):
            if provider.id == "mysql":
                db.execute(f"KILL {numeric_session_id}")
                return {"success": True, "message": f"已终止会话 {numeric_session_id}"}

            elif provider.id == "postgresql":
                db.execute(
                    "SELECT pg_terminate_backend(:session_id)",
                    {"session_id": numeric_session_id},
                )
                return {"success": True, "message": f"已终止会话 {numeric_session_id}"}

            elif provider.id == "mongodb":
                db.execute(f"db.killOp({numeric_session_id})")
                return {"success": True, "message": f"已终止会话 {numeric_session_id}"}

            elif provider.id == "redis":
                db.execute(f"CLIENT KILL ID {numeric_session_id}")
                return {"success": True, "message": f"已终止会话 {numeric_session_id}"}

            return {"success": False, "error": f"不支持的数据库类型: {provider.id}"}

    except Exception as e:
        return {"success": False, "error": redact_sensitive(e)}
