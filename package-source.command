#!/bin/bash
# 把当前项目源码（含未提交的修改和新文件）打包成 zip，输出到 dist/。
# 文件清单来自 git：已跟踪文件 + 未被 .gitignore 忽略的新文件，
# 因此 config.db、__pycache__、.env、venv、dist 等不会被打进去。
set -euo pipefail

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"

if ! command -v git &>/dev/null || ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "错误：需要 git，且当前目录必须是 git 仓库。"
  exit 1
fi
if ! command -v zip &>/dev/null; then
  echo "错误：未找到 zip 命令。"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_DIR="$PROJECT_DIR/dist"
OUTPUT_FILE="$OUTPUT_DIR/${PROJECT_NAME}-src-${TIMESTAMP}.zip"
LIST_FILE="$(mktemp)"
trap 'rm -f "$LIST_FILE"' EXIT

mkdir -p "$OUTPUT_DIR"

# 已跟踪 + 未忽略的未跟踪文件；跳过已在工作区删除的文件；路径加上项目目录前缀
git ls-files --cached --others --exclude-standard | sort -u | while IFS= read -r file; do
  if [ -f "$file" ]; then
    printf '%s/%s\n' "$PROJECT_NAME" "$file"
  fi
done > "$LIST_FILE"

FILE_COUNT="$(wc -l < "$LIST_FILE" | tr -d ' ')"
echo "正在打包 $FILE_COUNT 个文件..."

(cd "$PROJECT_DIR/.." && zip -q -X "$OUTPUT_FILE" -@ < "$LIST_FILE")

echo "完成：$OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"

# 双击运行时保持窗口，终端里运行（非交互）时直接退出
if [ -t 0 ] && [ -z "${NO_PAUSE:-}" ]; then
  echo
  echo "按任意键关闭窗口。"
  read -n 1 -s
fi
