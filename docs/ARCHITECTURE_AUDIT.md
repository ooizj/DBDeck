# Architecture Audit

DBDeck is a local desktop-first database client with LLM-assisted operations. The current architecture is viable, but product quality depends on keeping HTTP routing, runtime services, provider implementations, and UI state clearly separated.

## Must-Fix Items

- Keep `src/api/*_routes.py` as HTTP-only orchestration. Business logic belongs in `src/services/*`.
- Keep database-specific behavior behind `SourceProvider`, `DataSourceClient`, provider tools, and operation classifiers. Route code must not import concrete MySQL, SQLite, or MongoDB client classes.
- Keep AI write safety enforced in backend policy. Prompt instructions are not sufficient for `write`, `destructive`, or `unknown` operations.
- Keep connection lifecycle centralized in `ConnectionManager`. Source update/delete and app shutdown must close cached clients and SSH tunnels.
- Keep workspace file capabilities distinct from database provider capabilities. The application intentionally exposes no Shell execution tool.
- Continue reducing `web_ui/js/app.js`; it is still the main frontend risk. New stateful behavior should go into `web_ui/js/state/*` modules.

## Current State

- Backend routes are split by feature area and aggregate through `src/api/routes.py`.
- Service modules own source, query, config, migration, workspace, and AI orchestration.
- Provider metadata now includes `engine_family`, `query_language`, and `metadata_label`.
- AI sessions are scoped by `session_id` and cleaned by TTL / session limit.
- Config export intentionally preserves passwords, SSH credentials, and LLM API keys for personal desktop migration.

## Product Readiness Checklist

- `python -m compileall -q src` passes.
- `python -m pytest -q` passes.
- `python scripts/check_product_ready.py` passes.
- Desktop app binds only to `127.0.0.1`.
- Packaged app includes `web_ui`, provider prompts, and runtime config storage path.
- Manual smoke covers: add source, query, AI write confirmation, config export/import, workspace open/save, SQLite migration.
