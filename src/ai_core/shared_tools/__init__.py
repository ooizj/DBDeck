"""
跨数据源类型共享的工具。

不同 provider 可以选择性把这些工具合并到自己的 registry：

    from src.ai_core.shared_tools import register_analyzer
    register_analyzer(my_registry)
"""
from .analyzer import register_analyzer

__all__ = ["register_analyzer"]
