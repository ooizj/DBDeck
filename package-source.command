#!/bin/bash
# 把当前项目源码（含未提交的修改和新文件）打包成 zip，输出到 dist/。
# 文件清单来自 git：已跟踪文件 + 未被 .gitignore 忽略的新文件，
# 因此 config.db、__pycache__、.env、venv、dist 等不会被打进去。
# zip 根目录另外附带「SYNC_NOTES.md」（基准提交、操作步骤、需删除的文件），
# 以及「COMMIT_MESSAGE.txt」（来自项目根目录的 COMMIT_MESSAGE.txt，该文件不提交）。
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
NOTES_DIR="$(mktemp -d)"
trap 'rm -f "$LIST_FILE"; rm -rf "$NOTES_DIR"' EXIT

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

# ---------- 同步说明 ----------
ZIP_NAME="$(basename "$OUTPUT_FILE")"
SYNC_DIR="/tmp/${PROJECT_NAME}-sync"
BASE_COMMIT="$(git rev-parse --short HEAD)"
BASE_SUBJECT="$(git log -1 --format=%s)"
DELETED_FILES="$(git ls-files --deleted)"
MODE_CHANGES="$(git diff --summary | grep 'mode change' | sed 's/^ *//' || true)"
NOTES_FILE="$NOTES_DIR/SYNC_NOTES.md"
HAS_COMMIT_MESSAGE=""
if [ -s "$PROJECT_DIR/COMMIT_MESSAGE.txt" ]; then
  cp "$PROJECT_DIR/COMMIT_MESSAGE.txt" "$NOTES_DIR/COMMIT_MESSAGE.txt"
  HAS_COMMIT_MESSAGE=1
fi

{
  echo "# ${PROJECT_NAME} 源码同步说明"
  echo
  echo "- 打包时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 基准提交：\`${BASE_COMMIT}\` ${BASE_SUBJECT}"
  echo "- 压缩包：\`${ZIP_NAME}\`（共 ${FILE_COUNT} 个文件，在 \`${PROJECT_NAME}/\` 目录下）"
  echo
  echo "压缩包只包含新增和修改的文件，**删除的文件需要按下面的清单手动删除**。"
  echo
  echo "## 操作步骤（macOS / Linux）"
  echo
  echo '```bash'
  echo "cd <新电脑上的 ${PROJECT_NAME} 仓库目录>"
  echo "git status                 # 确认没有未提交的改动"
  echo "git pull"
  echo "git log -1 --oneline       # 确认是基准提交 ${BASE_COMMIT}，不一致先停下来核对"
  echo "rm -rf ${SYNC_DIR} && unzip -q -o <压缩包路径>/${ZIP_NAME} -d ${SYNC_DIR}"
  echo "rsync -a ${SYNC_DIR}/${PROJECT_NAME}/ ./   # 覆盖到仓库，不会删除任何文件"
  if [ -n "$DELETED_FILES" ]; then
    echo "git rm -q --ignore-unmatch -- \\"
    printf '%s\n' "$DELETED_FILES" | sed 's/^/  /; $!s/$/ \\/'
  fi
  echo "git add -A"
  echo "git status                 # 核对改动"
  if [ -n "$HAS_COMMIT_MESSAGE" ]; then
    echo "git commit -F ${SYNC_DIR}/COMMIT_MESSAGE.txt"
  else
    echo "git commit -m \"<提交说明>\""
  fi
  echo '```'
  echo
  echo "Windows：解压后把 \`${PROJECT_NAME}\` 文件夹里的内容复制覆盖到仓库目录，再在 Git Bash 中执行上面的 \`git rm\` / \`git add\` / \`git commit\` 命令。"
  echo
  echo "## 需要删除的文件"
  echo
  if [ -n "$DELETED_FILES" ]; then
    printf '%s\n' "$DELETED_FILES" | sed 's/^/- `/; s/$/`/'
  else
    echo "无"
  fi
  echo
  echo "## 权限变化"
  echo
  if [ -n "$MODE_CHANGES" ]; then
    printf '%s\n' "$MODE_CHANGES" | sed 's/^/- /'
    echo
    echo "用 unzip 解压会保留可执行权限；如果没有保留，执行 \`chmod +x <文件>\`。"
  else
    echo "无"
  fi
  echo
  echo "## 提交说明"
  echo
  if [ -n "$HAS_COMMIT_MESSAGE" ]; then
    echo "见压缩包根目录的 \`COMMIT_MESSAGE.txt\`："
    echo
    echo '```'
    cat "$NOTES_DIR/COMMIT_MESSAGE.txt"
    echo '```'
  else
    echo "未提供。可在项目根目录创建 COMMIT_MESSAGE.txt 写好提交说明，重新打包后会自动附带。"
  fi
} > "$NOTES_FILE"

(cd "$NOTES_DIR" && zip -q -X "$OUTPUT_FILE" ./*)

echo "完成：$OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
echo "已附带：SYNC_NOTES.md${HAS_COMMIT_MESSAGE:+、COMMIT_MESSAGE.txt}（需删除 $(printf '%s' "$DELETED_FILES" | grep -c . || true) 个文件）"

# 双击运行时保持窗口，终端里运行（非交互）时直接退出
if [ -t 0 ] && [ -z "${NO_PAUSE:-}" ]; then
  echo
  echo "按任意键关闭窗口。"
  read -n 1 -s
fi
