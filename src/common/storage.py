import sqlite3
import os
import shutil
import sys
from typing import List, Dict, Any, Optional
from pathlib import Path


def _default_db_path() -> Path:
    if getattr(sys, "frozen", False):
        legacy_db_path = None
        if sys.platform == "darwin":
            support_dir = Path.home() / "Library" / "Application Support"
            app_dir = support_dir / "DBDeck"
            legacy_db_path = support_dir / "Universal DB Studio" / "config.db"
        elif sys.platform == "win32":
            support_dir = Path(
                os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
            )
            app_dir = support_dir / "DBDeck"
        else:
            support_dir = Path(
                os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
            )
            app_dir = support_dir / "DBDeck"
        app_dir.mkdir(parents=True, exist_ok=True)
        db_path = app_dir / "config.db"
        if (
            legacy_db_path is not None
            and not db_path.exists()
            and legacy_db_path.is_file()
        ):
            shutil.copy2(legacy_db_path, db_path)
        return db_path
    return Path(__file__).parent.parent.parent / "config.db"


DB_PATH = _default_db_path()

class Storage:
    def __init__(self, db_path: str = str(DB_PATH)):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS data_sources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    type TEXT DEFAULT 'mysql',
                    host TEXT,
                    port INTEGER,
                    user TEXT,
                    password TEXT,
                    database TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # 检查是否需要迁移（如果 type 列不存在）
            cursor = conn.execute("PRAGMA table_info(data_sources)")
            columns = [row[1] for row in cursor.fetchall()]
            if 'type' not in columns:
                conn.execute("ALTER TABLE data_sources ADD COLUMN type TEXT DEFAULT 'mysql'")
            if 'direct_connection' not in columns:
                conn.execute("ALTER TABLE data_sources ADD COLUMN direct_connection INTEGER DEFAULT 0")
            if 'auth_source' not in columns:
                conn.execute("ALTER TABLE data_sources ADD COLUMN auth_source TEXT")
            ssh_columns = {
                "use_ssh_tunnel": "INTEGER DEFAULT 0",
                "ssh_host": "TEXT",
                "ssh_port": "INTEGER DEFAULT 22",
                "ssh_user": "TEXT",
                "ssh_password": "TEXT",
                "ssh_private_key": "TEXT",
                "ssh_private_key_passphrase": "TEXT",
            }
            for column, definition in ssh_columns.items():
                if column not in columns:
                    conn.execute(
                        f"ALTER TABLE data_sources ADD COLUMN {column} {definition}"
                    )
            
            conn.execute("""
                CREATE TABLE IF NOT EXISTS scripts (
                    source_id INTEGER PRIMARY KEY,
                    content TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (source_id) REFERENCES data_sources (id) ON DELETE CASCADE
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS system_config (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS project_workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS query_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id INTEGER,
                    source_name TEXT,
                    query TEXT NOT NULL,
                    executed_query TEXT,
                    row_count INTEGER DEFAULT 0,
                    duration_ms REAL,
                    status TEXT DEFAULT 'success',
                    error_msg TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # 书签表
            conn.execute("""
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id INTEGER NOT NULL,
                    object_type TEXT NOT NULL,
                    object_name TEXT NOT NULL,
                    label TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (source_id) REFERENCES data_sources (id) ON DELETE CASCADE,
                    UNIQUE(source_id, object_type, object_name)
                )
            """)
            
            # 连接分组表
            conn.execute("""
                CREATE TABLE IF NOT EXISTS connection_groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    parent_id INTEGER,
                    color TEXT DEFAULT '#666666',
                    sort_order INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (parent_id) REFERENCES connection_groups (id) ON DELETE CASCADE
                )
            """)
            
            # 添加 group_id 到 data_sources
            cursor = conn.execute("PRAGMA table_info(data_sources)")
            columns = [row[1] for row in cursor.fetchall()]
            if 'group_id' not in columns:
                conn.execute("ALTER TABLE data_sources ADD COLUMN group_id INTEGER REFERENCES connection_groups(id)")
            if 'is_favorite' not in columns:
                conn.execute("ALTER TABLE data_sources ADD COLUMN is_favorite INTEGER DEFAULT 0")
            
            # SQL模板表
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sql_templates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    description TEXT,
                    category TEXT DEFAULT 'custom',
                    db_type TEXT,
                    is_builtin INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            conn.commit()

    def set_config(self, key: str, value: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (key, value)
            )
            conn.commit()

    def get_config(self, key: str, default: str = "") -> str:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT value FROM system_config WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row[0] if row else default

    def get_all_config(self) -> Dict[str, str]:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT key, value FROM system_config")
            return {row[0]: row[1] for row in cursor.fetchall()}

    def save_script(self, source_id: int, content: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO scripts (source_id, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (source_id, content)
            )
            conn.commit()

    def get_script(self, source_id: int) -> str:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT content FROM scripts WHERE source_id = ?", (source_id,))
            row = cursor.fetchone()
            return row[0] if row else ""

    def add_source(self, **kwargs) -> int:
        keys = kwargs.keys()
        placeholders = ", ".join(["?"] * len(keys))
        columns = ", ".join(keys)
        values = tuple(kwargs.values())
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                f"INSERT INTO data_sources ({columns}) VALUES ({placeholders})",
                values
            )
            return cursor.lastrowid

    def update_source(self, source_id: int, **kwargs):
        set_clause = ", ".join([f"{k}=?" for k in kwargs.keys()])
        values = tuple(kwargs.values()) + (source_id,)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                f"UPDATE data_sources SET {set_clause} WHERE id=?",
                values
            )
            conn.commit()

    def get_sources(self) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM data_sources")
            return [dict(row) for row in cursor.fetchall()]

    def get_source(self, source_id: int) -> Optional[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM data_sources WHERE id = ?", (source_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def delete_source(self, source_id: int):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM data_sources WHERE id = ?", (source_id,))
            conn.commit()

    def add_workspace(self, name: str, path: str) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "INSERT INTO project_workspaces (name, path) VALUES (?, ?)",
                (name, path),
            )
            return cursor.lastrowid

    def update_workspace(self, workspace_id: int, **kwargs):
        if not kwargs:
            return
        set_clause = ", ".join([f"{k}=?" for k in kwargs.keys()])
        values = tuple(kwargs.values()) + (workspace_id,)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                f"UPDATE project_workspaces SET {set_clause} WHERE id=?",
                values,
            )
            conn.commit()

    def get_workspaces(self) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM project_workspaces ORDER BY id")
            return [dict(row) for row in cursor.fetchall()]

    def get_workspace(self, workspace_id: int) -> Optional[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM project_workspaces WHERE id = ?",
                (workspace_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def delete_workspace(self, workspace_id: int):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM project_workspaces WHERE id = ?", (workspace_id,))
            conn.commit()

    def add_history(self, source_id=None, source_name=None, query="", executed_query="",
                    row_count=0, duration_ms=None, status="success", error_msg=None):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO query_history (source_id, source_name, query, executed_query, row_count, duration_ms, status, error_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (source_id, source_name, query, executed_query, row_count, duration_ms, status, error_msg),
            )
            conn.commit()

    def get_history(self, limit=100, offset=0, source_id=None, search=None):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            conditions = []
            params = []
            if source_id is not None:
                conditions.append("source_id = ?")
                params.append(source_id)
            if search:
                conditions.append("query LIKE ?")
                params.append(f"%{search}%")
            where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
            params.extend([limit, offset])
            cursor = conn.execute(
                f"SELECT * FROM query_history{where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                params,
            )
            return [dict(row) for row in cursor.fetchall()]

    def clear_history(self, source_id=None):
        with sqlite3.connect(self.db_path) as conn:
            if source_id is not None:
                conn.execute("DELETE FROM query_history WHERE source_id = ?", (source_id,))
            else:
                conn.execute("DELETE FROM query_history")
            conn.commit()

    # ========== 书签功能 ==========
    def add_bookmark(self, source_id: int, object_type: str, object_name: str, label: str = None) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO bookmarks (source_id, object_type, object_name, label) VALUES (?, ?, ?, ?)",
                (source_id, object_type, object_name, label or object_name)
            )
            conn.commit()
            return cursor.lastrowid

    def remove_bookmark(self, source_id: int, object_type: str, object_name: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "DELETE FROM bookmarks WHERE source_id = ? AND object_type = ? AND object_name = ?",
                (source_id, object_type, object_name)
            )
            conn.commit()

    def get_bookmarks(self, source_id: int = None) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            if source_id:
                cursor = conn.execute(
                    "SELECT b.*, ds.name as source_name, ds.type as source_type FROM bookmarks b JOIN data_sources ds ON b.source_id = ds.id WHERE b.source_id = ? ORDER BY b.created_at DESC",
                    (source_id,)
                )
            else:
                cursor = conn.execute(
                    "SELECT b.*, ds.name as source_name, ds.type as source_type FROM bookmarks b JOIN data_sources ds ON b.source_id = ds.id ORDER BY b.created_at DESC"
                )
            return [dict(row) for row in cursor.fetchall()]

    def is_bookmarked(self, source_id: int, object_type: str, object_name: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "SELECT 1 FROM bookmarks WHERE source_id = ? AND object_type = ? AND object_name = ?",
                (source_id, object_type, object_name)
            )
            return cursor.fetchone() is not None

    def toggle_favorite(self, source_id: int) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT is_favorite FROM data_sources WHERE id = ?", (source_id,))
            row = cursor.fetchone()
            if row:
                new_val = 0 if row[0] else 1
                conn.execute("UPDATE data_sources SET is_favorite = ? WHERE id = ?", (new_val, source_id))
                conn.commit()
                return bool(new_val)
            return False

storage = Storage()
