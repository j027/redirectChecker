#!/bin/sh
set -e

Xvfb :0 -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!

for _ in $(seq 1 30); do
  if [ -S /tmp/.X11-unix/X0 ]; then
    break
  fi
  sleep 0.5
done

fluxbox -display :0 &
FLUXBOX_PID=$!

x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -quiet &
VNC_PID=$!

websockify --web=/usr/share/novnc 6080 localhost:5900 &
WS_PID=$!

shutdown() {
  trap - TERM INT
  if [ -n "${APP_PID:-}" ]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
  fi
  kill "$XVFB_PID" "$FLUXBOX_PID" "$VNC_PID" "$WS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap shutdown TERM INT

"$@" &
APP_PID=$!

wait "$APP_PID"
status=$?
shutdown
exit $status
