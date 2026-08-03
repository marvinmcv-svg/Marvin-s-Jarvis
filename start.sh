#!/usr/bin/env bash
# Knowledge Galaxy launcher — starts (or restarts) the viewer server on :4700.
# Idempotent: kills any existing instance on the port first.
#
# Usage:  ./start.sh          (foreground, Ctrl-C to stop)
#         ./start.sh --bg     (background, survives shell exit)
set -e
cd "$(dirname "$0")"

PORT=4700

# Auto-load .env into the environment (if it exists). kg_core.py also loads
# .env at import, so this is belt-and-suspenders — either path works.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# Kill anything already on the port.
if command -v lsof >/dev/null 2>&1; then
  OLD=$(lsof -ti :$PORT 2>/dev/null || true)
elif command -v fuser >/dev/null 2>&1; then
  OLD=$(fuser ${PORT}/tcp 2>/dev/null || true)
fi
if [ -n "$OLD" ]; then
  echo "Stopping existing server on :$PORT (pid $OLD)..."
  kill $OLD 2>/dev/null || true
  sleep 1
fi

echo "Starting Knowledge Galaxy on http://localhost:$PORT/"
if [ "$1" = "--bg" ]; then
  setsid python3 server.py > server.log 2>&1 < /dev/null &
  echo "Started in background (pid $!).  Logs: server.log"
  sleep 1.5
  curl -s -o /dev/null -w "  health check: HTTP %{http_code}\n" http://localhost:$PORT/index.html || true
else
  exec python3 server.py
fi
