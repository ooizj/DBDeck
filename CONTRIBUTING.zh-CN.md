# 贡献指南

**简体中文** | [English](CONTRIBUTING.md)

欢迎通过 GitHub issue 和 pull request 参与贡献。

## 开发环境

```bash
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/check_product_ready.py
```

每次改动保持聚焦，行为变化要补回归测试；配置项或用户可见的行为发生变化时同步更新 README。
不要提交凭据、`config.db`、`.env`、构建产物，以及编辑器 / Agent 的本地设置。

界面文字请写进 `web_ui/js/i18n/zh.js` 和 `en.js`（两份词典 key 必须一致），不要在组件里直接写中文或英文文案；
文档请同时更新中英文两个版本（如 `README.md` 与 `README.en.md`）。

提交贡献即表示你同意贡献内容按本仓库附带的 MIT 许可证授权。
