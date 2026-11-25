#!/bin/sh
# Replay, Debug and Record Web open a visible browser. A server has no screen,
# so give those browsers a virtual one.
set -e
if command -v Xvfb >/dev/null 2>&1 && [ -z "$DISPLAY" ]; then
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
fi
mkdir -p "${STUDIO_STORAGE_DIR:-/var/data}"
# exec keeps Node as the main process, so Render's SIGTERM reaches its shutdown handler
# and pending saves are written before the container stops.
exec node server.mjs
