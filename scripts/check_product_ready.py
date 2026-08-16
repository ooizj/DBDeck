from __future__ import annotations

import compileall
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def run_pytest() -> None:
    subprocess.run([sys.executable, "-m", "pytest", "-q"], cwd=ROOT, check=True)


def check_imports() -> None:
    from src.main import app

    paths = {getattr(route, "path", "") for route in app.routes}
    required = {
        "/api/health",
        "/api/providers",
        "/api/sources",
        "/api/metadata",
        "/api/query",
        "/api/config",
        "/api/migrate",
    }
    missing = sorted(required - paths)
    if missing:
        raise AssertionError(f"Missing API routes: {missing}")


def check_provider_registry() -> None:
    from src.sources import all_providers

    ids = {provider.id for provider in all_providers()}
    expected = {"mysql", "postgresql", "sqlite", "mongodb", "redis"}
    missing = expected - ids
    if missing:
        raise AssertionError(f"Missing providers: {sorted(missing)}")


def check_operation_policy() -> None:
    from src.sources.operation_policy import classify_mongo, classify_redis, classify_sql

    assert classify_sql("select 1").kind == "read"
    assert classify_sql("delete from t").kind == "write"
    assert classify_mongo('{"collection":"c","action":"drop"}').kind == "destructive"
    assert classify_redis("FLUSHALL").kind == "destructive"


def check_sqlite_migration() -> None:
    from src.sources.sqlite.client import SQLiteClient
    from src.sources.sql_migration import migrate_table

    with tempfile.TemporaryDirectory() as tmp:
        src = SQLiteClient({"database": str(Path(tmp) / "src.db")})
        dest = SQLiteClient({"database": str(Path(tmp) / "dest.db")})
        try:
            src.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
            src.execute("INSERT INTO users (name) VALUES ('Ada'), ('Lin')")
            result = migrate_table(src, dest, "users")
            assert result["success"], result
            out = dest.execute("SELECT * FROM users")
            assert out["row_count"] == 2, out
        finally:
            src.close()
            dest.close()


def main() -> None:
    if not compileall.compile_dir(ROOT / "src", quiet=1):
        raise SystemExit("compileall failed")
    check_imports()
    check_provider_registry()
    check_operation_policy()
    check_sqlite_migration()
    run_pytest()
    print("product readiness checks passed")


if __name__ == "__main__":
    main()
