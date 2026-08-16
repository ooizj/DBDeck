# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development setup

```bash
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/check_product_ready.py
```

Keep changes focused, add regression tests for behavior changes, and update
the README when configuration or user-visible behavior changes. Do not commit
credentials, `config.db`, `.env`, build output, or editor/agent-local settings.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
