# Contributing

[简体中文](CONTRIBUTING.zh-CN.md) | **English**

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

Put UI text in `web_ui/js/i18n/zh.js` and `en.js` (both dictionaries must have
the same keys) instead of hard-coding Chinese or English text in components,
and update both language versions of a document (e.g. `README.md` and
`README.en.md`).

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
