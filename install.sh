#!/usr/bin/env bash
# Bake a GitHub PAT into besender-aggregate.user.js and copy the result to the clipboard.
# Usage: ./install.sh <github_pat>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <github_pat>" >&2
  echo "  Generate one at: https://github.com/settings/personal-access-tokens/new" >&2
  echo "  Scope: Contents = Read-only on lyp04/besender-tools" >&2
  exit 1
fi

PAT="$1"
SRC="$(dirname "$0")/besender-aggregate.user.js"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

# Replace __GH_PAT__ with the supplied token; output via pbcopy on macOS, xclip on Linux.
BAKED="$(sed "s|__GH_PAT__|${PAT}|g" "$SRC")"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$BAKED" | pbcopy
  echo "✓ 已复制到剪贴板（$(printf '%s' "$BAKED" | wc -c | tr -d ' ') 字节）。"
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$BAKED" | xclip -selection clipboard
  echo "✓ 已复制到剪贴板（$(printf '%s' "$BAKED" | wc -c | tr -d ' ') 字节）。"
else
  echo "$BAKED"
  echo "" >&2
  echo "（没找到 pbcopy/xclip，已 stdout 输出，请手动复制）" >&2
fi

cat <<'EOF'

下一步：
  1. Chrome 工具栏 Tampermonkey 图标 → 「管理面板」
  2. 点 ➕「添加新脚本」
  3. ⌘+A 清空 → ⌘+V 粘贴 → ⌘+S 保存
  4. 刷新 BESENDER 页面验证
EOF
