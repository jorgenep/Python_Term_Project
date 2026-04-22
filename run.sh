#!/bin/bash
set -e

# Launcher for Phase 3 on Bazzite/Flatpak. The project venv was created against
# the VS Code Flatpak runtime's Python 3.13, so host shells need to hop into
# that runtime before starting the app.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_in_flatpak() {
	export LD_LIBRARY_PATH="/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
	exec "$SCRIPT_DIR/venv/bin/python" "$SCRIPT_DIR/main.py" "$@"
}

if [[ -n "${FLATPAK_ID:-}" ]]; then
	run_in_flatpak "$@"
fi

if command -v flatpak >/dev/null 2>&1; then
	REAL_SCRIPT_DIR="$(realpath "$SCRIPT_DIR")"
	exec flatpak run --command=bash com.visualstudio.code -lc \
		"cd '$REAL_SCRIPT_DIR' && export LD_LIBRARY_PATH='/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}' && exec ./venv/bin/python ./main.py" \
		-- "$@"
fi

echo "[ERROR] This launcher needs either the VS Code Flatpak runtime or a compatible Python 3.13 runtime." >&2
exit 1
