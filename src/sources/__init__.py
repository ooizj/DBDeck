"""
SourceProvider 集合 —— 加载时把内置 provider 注册到 registry。
新增数据源：在这里 import 一下并 register_provider(ProviderClass())。
"""
from .registry import (
    all_providers,
    get_provider,
    has_provider,
    register_provider,
)
from .mongodb import MongoDBProvider
from .mysql import MySQLProvider
from .postgresql import PostgreSQLProvider
from .redis import RedisProvider
from .sqlite import SQLiteProvider

register_provider(MySQLProvider())
register_provider(PostgreSQLProvider())
register_provider(SQLiteProvider())
register_provider(MongoDBProvider())
register_provider(RedisProvider())

__all__ = [
    "all_providers",
    "get_provider",
    "has_provider",
    "register_provider",
]
