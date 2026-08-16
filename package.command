#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x "./venv/bin/python" ]; then
  echo "未找到 ./venv/bin/python，正在创建虚拟环境..."
  if command -v python3.10 &>/dev/null; then
    python3.10 -m venv venv
  else
    python3 -m venv venv
  fi
fi

echo "安装/更新打包依赖..."
./venv/bin/python -m pip install -r requirements-build.txt

echo "开始打包 DBDeck..."
./venv/bin/python scripts/package_app.py

echo
echo "完成。按任意键关闭窗口。"
read -n 1 -s
