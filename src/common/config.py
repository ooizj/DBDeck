import os
import logging
from typing import Dict, Any
from pathlib import Path
from dotenv import load_dotenv

# 加载 .env (仅作为基础配置)
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(env_path)

logger = logging.getLogger(__name__)

class Config:
    """统一配置管理 (支持从 SQLite 动态加载)"""
    
    def __init__(self):
        # MySQL 默认配置（仍可从 env 读取）
        self.db_host = os.getenv("MYSQL_HOST", "localhost")
        self.db_port = int(os.getenv("MYSQL_PORT", 3306))
        self.db_user = os.getenv("MYSQL_USER", "root")
        self.db_password = os.getenv("MYSQL_PASSWORD", "")
        self.db_name = os.getenv("MYSQL_DATABASE", "test")
        
        # 系统配置
        self.max_rows = int(os.getenv("MAX_ROWS", 1000))
        self.timeout = int(os.getenv("QUERY_TIMEOUT", 30))
        
        # LLM 配置初始化
        self.reload()

    def reload(self):
        """从 SQLite 加载配置，如果不存在则从环境变量加载"""
        from src.common.storage import storage
        
        # 优先从数据库加载
        db_config = storage.get_all_config()
        
        self.llm_api_key = db_config.get("LLM_API_KEY") or os.getenv("LLM_API_KEY", "")
        self.llm_api_base = db_config.get("LLM_API_BASE") or os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
        self.llm_model = db_config.get("LLM_MODEL") or os.getenv("LLM_MODEL", "gpt-4-turbo")
        self.llm_temperature = float(db_config.get("LLM_TEMPERATURE") or os.getenv("LLM_TEMPERATURE", "0.1"))
        # 单次回复最大输出长度上限（含 reasoning_content）。防止推理模型陷入思考死循环时无限输出/烧 token。
        self.llm_max_tokens = int(db_config.get("LLM_MAX_TOKENS") or os.getenv("LLM_MAX_TOKENS", "8192"))

    @property
    def sqlalchemy_url(self) -> str:
        if os.getenv("DB_TYPE") == "sqlite":
            db_path = os.getenv("MYSQL_DATABASE", "test.db")
            return f"sqlite:///{db_path}"
        return f"mysql+pymysql://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

config = Config()
