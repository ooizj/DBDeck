# 架构审计

**简体中文** | [English](ARCHITECTURE_AUDIT.md)

DBDeck 是以本地桌面为主、带 LLM 辅助操作的数据库客户端。当前架构可行，但产品质量取决于 HTTP 路由、运行时服务、provider 实现和界面状态之间能否保持清晰的分层。

## 必须坚持的事项

- `src/api/*_routes.py` 只负责 HTTP 编排，业务逻辑放在 `src/services/*`。
- 数据库特有的行为放在 `SourceProvider`、`DataSourceClient`、provider 工具和操作分类器之后。路由代码不得直接 import 具体的 MySQL、SQLite 或 MongoDB 客户端类。
- AI 写操作的安全由后端策略强制保证。对 `write`、`destructive` 或 `unknown` 操作，仅靠提示词约束是不够的。
- 连接生命周期统一由 `ConnectionManager` 管理。更新/删除数据源以及应用退出时，必须关闭缓存的客户端和 SSH 通道。
- 应用有意不向 AI Agent 提供文件系统或 Shell 执行工具。
- 继续精简 `web_ui/js/app.js`，它仍是前端的主要风险点。新的有状态逻辑应放进 `web_ui/js/state/*` 模块。

## 当前状态

- 后端路由按功能拆分，并通过 `src/api/routes.py` 汇总。
- 服务模块负责数据源、查询、配置、迁移和 AI 的编排。
- Provider 元数据已包含 `engine_family`、`query_language` 和 `metadata_label`。
- AI 会话按 `session_id` 隔离，并按 TTL / 会话数上限清理。
- 配置导出有意保留密码、SSH 凭据和 LLM API Key，便于个人在不同电脑间迁移桌面配置。

## 产品就绪检查清单

- `python -m compileall -q src` 通过。
- `python -m pytest -q` 通过。
- `python scripts/check_product_ready.py` 通过。
- 桌面应用只监听 `127.0.0.1`。
- 打包后的应用包含 `web_ui`、provider 提示词和运行时配置存储路径。
- 手动冒烟测试覆盖：添加数据源、查询、AI 写操作确认、配置导出/导入、SQLite 迁移。
