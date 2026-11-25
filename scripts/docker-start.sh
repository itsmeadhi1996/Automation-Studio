#!/bin/sh
# No DISPLAY on purpose: without a screen, Replay and Debug run headless and Record Web shows
# the browser inside Studio (see canShowBrowser in browsers.mjs).
set -e
mkdir -p "${STUDIO_STORAGE_DIR:-/var/data}"
# exec keeps Node as the main process, so Render's SIGTERM reaches its shutdown handler
# and pending saves are written before the container stops.
exec node server.mjs
