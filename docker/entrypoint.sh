#!/usr/bin/env bash
# Start the virtual screen and its web viewer (unless disabled), then the MCP
# server. If any of them dies, stop everything so Docker restarts the container.
set -euo pipefail

if [ -z "${MCP_AUTH_PASSWORD:-}" ]; then
  echo "[entrypoint] MCP_AUTH_PASSWORD is not set: refusing to start." >&2
  exit 1
fi

mkdir -p "${CARREFOUR_DATA_DIR:-/data}"
pids=()

if [ "${CARREFOUR_REMOTE_LOGIN:-1}" = "1" ]; then
  if [ -z "${VNC_PASSWORD:-}" ]; then
    echo "[entrypoint] VNC_PASSWORD is not set. Set it, or CARREFOUR_REMOTE_LOGIN=0 to run without the sign-in screen." >&2
    exit 1
  fi
  size="${CARREFOUR_LOGIN_WINDOW_SIZE:-1280x900}"
  export DISPLAY=:99
  export CARREFOUR_LOGIN_WINDOW_SIZE="$size"
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

  Xvfb :99 -screen 0 "${size}x24" -nolisten tcp -ac >/dev/null 2>&1 &
  pids+=($!)
  for _ in $(seq 1 100); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

  mkdir -p /root/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null 2>&1
  x11vnc -display :99 -rfbauth /root/.vnc/passwd -rfbport 5900 -localhost \
    -forever -shared -noxdamage -quiet >/dev/null 2>&1 &
  pids+=($!)

  websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &
  pids+=($!)

  export CARREFOUR_REMOTE_LOGIN_URL="${CARREFOUR_REMOTE_LOGIN_URL:-http://localhost:6080/vnc.html?autoconnect=1&resize=scale}"
  echo "[entrypoint] sign-in screen: ${CARREFOUR_REMOTE_LOGIN_URL}" >&2
else
  unset DISPLAY CARREFOUR_REMOTE_LOGIN_URL
fi

node /app/dist/index.js --http &
pids+=($!)

stop() {
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait || true
}
trap 'stop; exit 0' TERM INT

set +e
wait -n "${pids[@]}"
code=$?
set -e
echo "[entrypoint] a process exited (code ${code}), stopping the container." >&2
stop
exit "$code"
