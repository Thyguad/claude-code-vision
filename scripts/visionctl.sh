#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
PROXY_DIR="$CLAUDE_DIR/vision-proxy"
PROXY_SCRIPT="$PROXY_DIR/proxy.mjs"
UPSTREAM_FILE="$PROXY_DIR/upstream.json"
STATE_FILE="$PROXY_DIR/state.json"
PID_FILE="$PROXY_DIR/proxy.pid"
LOG_FILE="$CLAUDE_DIR/vision-proxy.log"
CC_SWITCH_SETTINGS="$HOME/.cc-switch/settings.json"
CC_SWITCH_DB="$HOME/.cc-switch/cc-switch.db"
PORT="${PROXY_PORT:-18090}"
LOCAL_BASE_URL="http://127.0.0.1:$PORT"
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

json_get() {
  /usr/bin/python3 - "$1" "$2" <<'PY'
import json
import sys

path, dotted = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
    for part in dotted.split("."):
        data = data[part]
    if isinstance(data, (dict, list)):
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(data)
except Exception:
    pass
PY
}

json_update_env_base_url() {
  /usr/bin/python3 - "$SETTINGS_FILE" "$1" <<'PY'
import json
import os
import sys

path, base_url = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})["ANTHROPIC_BASE_URL"] = base_url
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PY
}

resolve_env_value() {
  /usr/bin/python3 - "$1" "$SETTINGS_FILE" "$UPSTREAM_FILE" "$CC_SWITCH_DB" <<'PY'
import json
import os
import sqlite3
import sys

key, settings_path, upstream_path, cc_db_path = sys.argv[1:5]

def emit(value):
    if value:
        print(value)
        raise SystemExit(0)

emit(os.environ.get(key, ""))

for path in (settings_path, upstream_path):
    try:
        with open(path) as f:
            data = json.load(f)
        emit(data.get("env", {}).get(key, ""))
    except Exception:
        pass

try:
    conn = sqlite3.connect(cc_db_path)
    rows = conn.execute("select settings_config from providers where app_type='claude'").fetchall()
    conn.close()
    for (settings_config,) in rows:
        env = json.loads(settings_config).get("env", {})
        emit(env.get(key, ""))
except Exception:
    pass
PY
}

write_settings_from_cc_switch_current_provider() {
  /usr/bin/python3 - "$SETTINGS_FILE" "$CC_SWITCH_SETTINGS" "$CC_SWITCH_DB" "$PORT" <<'PY'
import json
import os
import sqlite3
import sys
from urllib.parse import urlparse

settings_path, cc_settings_path, cc_db_path, port = sys.argv[1:5]

def is_local_proxy_url(value):
    value = (value or "").rstrip("/")
    if not value:
        return False
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        actual_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return host in ("127.0.0.1", "localhost", "::1") and str(actual_port) == str(port)
    except Exception:
        return value == f"http://127.0.0.1:{port}"

with open(cc_settings_path) as f:
    provider_id = json.load(f).get("currentProviderClaude", "")
if not provider_id:
    raise SystemExit(1)

conn = sqlite3.connect(cc_db_path)
row = conn.execute(
    "select settings_config from providers where app_type='claude' and id=?",
    (provider_id,),
).fetchone()
if not row:
    conn.close()
    raise SystemExit(1)

provider_settings = json.loads(row[0])
provider_env = provider_settings.setdefault("env", {})
provider_base = provider_env.get("ANTHROPIC_BASE_URL", "")
endpoint_row = conn.execute(
    "select url from provider_endpoints where app_type='claude' and provider_id=? order by id limit 1",
    (provider_id,),
).fetchone()
endpoint_url = endpoint_row[0] if endpoint_row else ""
if (not provider_base or is_local_proxy_url(provider_base)) and endpoint_url:
    provider_env["ANTHROPIC_BASE_URL"] = endpoint_url
    conn.execute(
        "update providers set settings_config=? where app_type='claude' and id=?",
        (json.dumps(provider_settings, ensure_ascii=False), provider_id),
    )
    conn.commit()
conn.close()

try:
    with open(settings_path) as f:
        current = json.load(f)
except Exception:
    current = {}

for key, value in provider_settings.items():
    current[key] = value

tmp = settings_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(current, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, settings_path)
PY
}

write_upstream_from_settings() {
  /usr/bin/python3 - "$SETTINGS_FILE" "$UPSTREAM_FILE" "$LOCAL_BASE_URL" "$CC_SWITCH_SETTINGS" "$CC_SWITCH_DB" "$PORT" <<'PY'
import json
import os
import sqlite3
import sys
import time
from urllib.parse import urlparse

settings_path, upstream_path, local_base, cc_settings_path, cc_db_path, port = sys.argv[1:7]

def is_local_proxy_url(value):
    value = (value or "").rstrip("/")
    if not value:
        return False
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        actual_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return host in ("127.0.0.1", "localhost", "::1") and str(actual_port) == str(port)
    except Exception:
        return value == local_base

with open(settings_path) as f:
    settings = json.load(f)
env = dict(settings.get("env", {}))
base_url = env.get("ANTHROPIC_BASE_URL", "")
provider_id = ""
try:
    with open(cc_settings_path) as f:
        provider_id = json.load(f).get("currentProviderClaude", "")
except Exception:
    provider_id = ""

if provider_id and os.path.exists(cc_db_path):
    try:
        conn = sqlite3.connect(cc_db_path)
        row = conn.execute(
            "select name, settings_config from providers where app_type='claude' and id=?",
            (provider_id,),
        ).fetchone()
        if row:
            name, settings_config = row
            provider_settings = json.loads(settings_config)
            provider_env = dict(provider_settings.get("env", {}))
            provider_base = provider_env.get("ANTHROPIC_BASE_URL", "")
            endpoint_row = conn.execute(
                "select url from provider_endpoints where app_type='claude' and provider_id=? order by id limit 1",
                (provider_id,),
            ).fetchone()
            endpoint_url = endpoint_row[0] if endpoint_row else ""
            if (not provider_base or is_local_proxy_url(provider_base)) and endpoint_url:
                provider_base = endpoint_url
                provider_env["ANTHROPIC_BASE_URL"] = endpoint_url
                provider_settings["env"] = provider_env
                conn.execute(
                    "update providers set settings_config=? where app_type='claude' and id=?",
                    (json.dumps(provider_settings, ensure_ascii=False), provider_id),
                )
                conn.commit()
            if provider_base and not is_local_proxy_url(provider_base):
                env = provider_env
                base_url = provider_base
                settings["_vision_provider_name"] = name
        conn.close()
    except Exception:
        pass

if is_local_proxy_url(base_url):
    try:
        with open(upstream_path) as f:
            existing = json.load(f)
        base_url = existing.get("baseUrl", base_url)
        env = existing.get("env", env)
    except Exception:
        pass

if not base_url or is_local_proxy_url(base_url):
    base_url = "https://api.anthropic.com"

model = (
    env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
    or env.get("ANTHROPIC_MODEL")
    or env.get("ANTHROPIC_DEFAULT_OPUS_MODEL")
    or env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    or ""
)

upstream = {
    "capturedAt": int(time.time()),
    "providerId": provider_id,
    "baseUrl": base_url,
    "authToken": env.get("ANTHROPIC_AUTH_TOKEN", ""),
    "env": env,
    "model": model,
    "name": settings.get("_vision_provider_name") or env.get("CC_SWITCH_PROVIDER_NAME", "cc-switch current provider"),
}
if os.environ.get("VISION_MODEL_OVERRIDE"):
    upstream["modelOverride"] = os.environ["VISION_MODEL_OVERRIDE"]
tmp = upstream_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(upstream, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, upstream_path)
PY
}

write_state() {
  /usr/bin/python3 - "$SETTINGS_FILE" "$STATE_FILE" "$UPSTREAM_FILE" "$LOCAL_BASE_URL" <<'PY'
import json
import os
import sys
import time

settings_path, state_path, upstream_path, local_base = sys.argv[1:5]
with open(settings_path) as f:
    settings = json.load(f)
with open(upstream_path) as f:
    upstream = json.load(f)
state = {
    "startedAt": int(time.time()),
    "localBaseUrl": local_base,
    "originalBaseUrl": upstream.get("baseUrl", ""),
    "originalEnv": upstream.get("env", {}),
}
tmp = state_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, state_path)
PY
}

restore_settings() {
  if [ -f "$CC_SWITCH_SETTINGS" ] && [ -f "$CC_SWITCH_DB" ]; then
    if write_settings_from_cc_switch_current_provider 2>/dev/null; then
      return 0
    fi
  fi

  if [ ! -f "$STATE_FILE" ]; then
    return 0
  fi
  /usr/bin/python3 - "$SETTINGS_FILE" "$STATE_FILE" <<'PY'
import json
import os
import sys

settings_path, state_path = sys.argv[1], sys.argv[2]
try:
    with open(settings_path) as f:
        settings = json.load(f)
    with open(state_path) as f:
        state = json.load(f)
    original_env = state.get("originalEnv") or {}
    if original_env:
        settings["env"] = original_env
    elif state.get("originalBaseUrl"):
        settings.setdefault("env", {})["ANTHROPIC_BASE_URL"] = state["originalBaseUrl"]
    tmp = settings_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, settings_path)
except Exception as exc:
    print(f"restore failed: {exc}", file=sys.stderr)
    raise
PY
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

stop_proxy_process() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  local pids
  pids=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
  fi
  sleep 0.5
  pids=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -KILL 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

start() {
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "node not found" >&2
    return 1
  fi

  mkdir -p "$PROXY_DIR"
  write_upstream_from_settings
  write_state

  export GEMINI_API_KEY="${GEMINI_API_KEY:-$(resolve_env_value "GEMINI_API_KEY")}"
  export HTTPS_PROXY="${HTTPS_PROXY:-$(resolve_env_value "HTTPS_PROXY")}"
  export HTTP_PROXY="${HTTP_PROXY:-$(resolve_env_value "HTTP_PROXY")}"
  export https_proxy="${https_proxy:-$HTTPS_PROXY}"
  export http_proxy="${http_proxy:-$HTTP_PROXY}"
  export PROXY_PORT="$PORT"
  export VISION_UPSTREAM_CONFIG="$UPSTREAM_FILE"
  export CLAUDE_SETTINGS_FILE="$SETTINGS_FILE"

  stop_proxy_process
  if command -v setsid >/dev/null 2>&1; then
    setsid "$NODE_BIN" "$PROXY_SCRIPT" > "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "$NODE_BIN" "$PROXY_SCRIPT" > "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"

  for _ in 1 2 3 4 5; do
    sleep 0.4
    if curl -fsS "$LOCAL_BASE_URL/health" >/dev/null 2>&1; then
      json_update_env_base_url "$LOCAL_BASE_URL"
  echo "running"
      return 0
    fi
  done

  cat "$LOG_FILE" >&2 || true
  stop_proxy_process
  restore_settings
  echo "failed" >&2
  return 1
}

foreground() {
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "node not found" >> "$LOG_FILE"
    return 1
  fi

  mkdir -p "$PROXY_DIR"
  write_upstream_from_settings
  write_state
  json_update_env_base_url "$LOCAL_BASE_URL"

  export GEMINI_API_KEY="${GEMINI_API_KEY:-$(resolve_env_value "GEMINI_API_KEY")}"
  export HTTPS_PROXY="${HTTPS_PROXY:-$(resolve_env_value "HTTPS_PROXY")}"
  export HTTP_PROXY="${HTTP_PROXY:-$(resolve_env_value "HTTP_PROXY")}"
  export https_proxy="${https_proxy:-$HTTPS_PROXY}"
  export http_proxy="${http_proxy:-$HTTP_PROXY}"
  export PROXY_PORT="$PORT"
  export VISION_UPSTREAM_CONFIG="$UPSTREAM_FILE"
  export CLAUDE_SETTINGS_FILE="$SETTINGS_FILE"

  echo $$ > "$PID_FILE"
  exec "$NODE_BIN" "$PROXY_SCRIPT" >> "$LOG_FILE" 2>&1
}

stop() {
  restore_settings
  stop_proxy_process
  echo "stopped"
}

status() {
  if is_running; then
    echo "running"
  else
    echo "stopped"
  fi
}

case "${1:-status}" in
  start) start ;;
  foreground) foreground ;;
  stop) stop ;;
  restart) stop_proxy_process; start ;;
  status) status ;;
  upstream) cat "$UPSTREAM_FILE" ;;
  *) echo "Usage: $0 {start|foreground|stop|restart|status|upstream}" >&2; exit 2 ;;
esac
