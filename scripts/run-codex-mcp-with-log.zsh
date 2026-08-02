#!/bin/zsh

set -euo pipefail

umask 077

readonly PROJECT_DIR="/Users/zhangshun/Desktop/aiProject/myAICanDo"
readonly LOG_FILE="/tmp/my-ai-can-do-mcp.log"

: >> "$LOG_FILE"
chmod 600 "$LOG_FILE"

exec /opt/homebrew/bin/bun \
  --cwd "$PROJECT_DIR" \
  "$PROJECT_DIR/src/mcp/stdio-server.ts" \
  2> >(tee -a "$LOG_FILE" >&2)
