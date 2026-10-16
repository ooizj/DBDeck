from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class SourceCreate(BaseModel):
    name: str
    type: str = "mysql"
    host: Optional[str] = None
    port: Optional[int] = None
    user: Optional[str] = None
    password: Optional[str] = None
    database: str
    direct_connection: Optional[bool] = False
    auth_source: Optional[str] = None
    use_ssh_tunnel: Optional[bool] = False
    ssh_host: Optional[str] = None
    ssh_port: Optional[int] = 22
    ssh_user: Optional[str] = None
    ssh_password: Optional[str] = None
    ssh_private_key: Optional[str] = None
    ssh_private_key_passphrase: Optional[str] = None
    group_name: Optional[str] = None


class GroupNameRequest(BaseModel):
    name: str


class QueryRequest(BaseModel):
    query: str
    source_id: Optional[int] = None
    session_id: Optional[str] = None


class ClearChatRequest(BaseModel):
    session_id: Optional[str] = None


class SQLRequest(BaseModel):
    query: str
    source_id: int
    page: Optional[int] = None
    page_size: int = 100


class ExportQueryRequest(BaseModel):
    query: str
    source_id: int


class ScriptRequest(BaseModel):
    content: str


class MigrateRequest(BaseModel):
    src_id: int
    dest_id: int
    tables: List[str]


class ConfigUpdateRequest(BaseModel):
    settings: Dict[str, Any]


class ImportRequest(BaseModel):
    data_sources: List[Dict[str, Any]]
    system_config: Dict[str, Any]


class DBeaverImportRequest(BaseModel):
    filename: str
    content_base64: str


class DataEditRequest(BaseModel):
    source_id: int
    table: str
    operation: str  # 'insert', 'update', 'delete'
    data: Dict[str, Any]  # 行数据
    where: Optional[Dict[str, Any]] = None  # 更新/删除时的条件


class BatchEditRequest(BaseModel):
    source_id: int
    table: str
    operations: List[DataEditRequest]


class ExportRequest(BaseModel):
    source_id: int
    table: str
    format: str = 'csv'  # csv, json, sql, markdown
    where: Optional[Dict[str, Any]] = None
    limit: Optional[int] = None


class BackupRequest(BaseModel):
    source_id: int
    tables: Optional[List[str]] = None
    include_structure: bool = True
    include_data: bool = True


class SessionQuery(BaseModel):
    source_id: int
