#!/bin/bash
set -euo pipefail

# Backward-compatible macOS entry point. All service behavior lives in Node so
# the same contract can be used by the future Windows tray application.
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

RUNTIME_DIR="${VISION_RUNTIME_DIR:-$HOME/.claude/vision-proxy}"
CLI_SCRIPT="${VISION_SERVICE_CLI:-$RUNTIME_DIR/service/cli.mjs}"
NODE_BIN="${NODE_BIN:-}"

if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/opt/node@20/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found" >&2
  exit 4
fi
if [ ! -f "$CLI_SCRIPT" ]; then
  echo "service CLI not found: $CLI_SCRIPT" >&2
  exit 4
fi

case "${1:-status}" in
  start|foreground|stop|restart|status|upstream|doctor)
    exec "$NODE_BIN" "$CLI_SCRIPT" "$@"
    ;;
  *)
    echo "Usage: $0 {start|foreground|stop|restart|status|upstream|doctor} [--json]" >&2
    exit 2
    ;;
esac
