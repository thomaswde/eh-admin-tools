#!/bin/sh
set -eu

umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/app/main.py" ]; then
    APP_DIR="$SCRIPT_DIR/app"
else
    APP_DIR="$SCRIPT_DIR"
fi

LOCK_FILE="$SCRIPT_DIR/requirements.lock"
VERSION_FILE="$SCRIPT_DIR/VERSION"
NO_BROWSER=0
REQUESTED_PORT=""
DIAGNOSTICS=0
RESET_RUNTIME=0
SKIP_PDF_SETUP=${EH_SKIP_PDF_SETUP:-0}

usage() {
    cat <<'EOF'
Usage: ./start.sh [options]

Options:
  --no-browser          Start without opening a browser window
  --port PORT           Use a specific local port
  --diagnostics         Print safe startup diagnostics and exit
  --reset-runtime       Rebuild this version's private Python environment
  --skip-pdf-setup      Skip the optional Chromium download for PDF export
  --help                Show this help
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-browser)
            NO_BROWSER=1
            ;;
        --port)
            shift
            if [ "$#" -eq 0 ]; then
                echo "ERROR: --port requires a number." >&2
                exit 2
            fi
            REQUESTED_PORT=$1
            ;;
        --diagnostics)
            DIAGNOSTICS=1
            ;;
        --reset-runtime)
            RESET_RUNTIME=1
            ;;
        --skip-pdf-setup)
            SKIP_PDF_SETUP=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ ! -f "$LOCK_FILE" ]; then
    echo "ERROR: requirements.lock is missing. Re-extract the complete ZIP and try again." >&2
    exit 1
fi

if [ ! -f "$APP_DIR/main.py" ] || [ ! -f "$APP_DIR/index.html" ]; then
    echo "ERROR: Application files are missing. Re-extract the complete ZIP and try again." >&2
    exit 1
fi

find_python() {
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c '
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
' >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

BOOTSTRAP_PYTHON=$(find_python || true)
if [ -z "$BOOTSTRAP_PYTHON" ]; then
    cat >&2 <<'EOF'
ERROR: Python 3.10 or newer is required.

Install Python from https://www.python.org/downloads/ and run START-HERE.command
or ./start.sh again. On Debian/Ubuntu, also install the python3-venv package.
EOF
    exit 1
fi

UI_CACHE_KEY=$("$BOOTSTRAP_PYTHON" - "$APP_DIR" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

root = Path(sys.argv[1])
paths = [root / "index.html", *sorted((root / "css").rglob("*.css")), *sorted((root / "js").rglob("*.js"))]
digest = sha256()
for path in paths:
    if path.is_file():
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
print(digest.hexdigest()[:12])
PY
)

LOCK_HASH=$("$BOOTSTRAP_PYTHON" - "$LOCK_FILE" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys
print(sha256(Path(sys.argv[1]).read_bytes()).hexdigest()[:16])
PY
)

SYSTEM_NAME=$(uname -s 2>/dev/null || echo unknown)
if [ -n "${EH_ADMIN_TOOLS_STATE_DIR:-}" ]; then
    STATE_ROOT=$EH_ADMIN_TOOLS_STATE_DIR
elif [ "$SYSTEM_NAME" = "Darwin" ]; then
    STATE_ROOT="${HOME:?HOME is not set}/Library/Application Support/ExtraHop Admin Tools"
else
    STATE_ROOT="${XDG_STATE_HOME:-${HOME:?HOME is not set}/.local/state}/eh-admin-tools"
fi

RUNTIME_DIR="$STATE_ROOT/runtime-$LOCK_HASH"
VENV_DIR="$RUNTIME_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
LOG_DIR="$STATE_ROOT/logs"
SERVER_LOG="$LOG_DIR/server.log"
API_LOG="$LOG_DIR/api-responses.jsonl"
PLAYWRIGHT_BROWSERS_PATH="$STATE_ROOT/playwright-browsers"

safe_diagnostics() {
    echo "ExtraHop Admin Tools diagnostics"
    echo "  Package version: $(cat "$VERSION_FILE" 2>/dev/null || echo development)"
    echo "  Operating system: $SYSTEM_NAME"
    echo "  Bootstrap Python: $("$BOOTSTRAP_PYTHON" --version 2>&1)"
    echo "  Package directory: $SCRIPT_DIR"
    echo "  Application directory: $APP_DIR"
    echo "  State directory: $STATE_ROOT"
    echo "  Runtime hash: $LOCK_HASH"
    if [ -x "$VENV_PYTHON" ]; then
        echo "  Private runtime: present"
        "$VENV_PYTHON" -m pip check 2>&1 | sed 's/^/    /' || true
    else
        echo "  Private runtime: not installed yet"
    fi
    "$BOOTSTRAP_PYTHON" - <<'PY'
import json
import urllib.error
import urllib.request

found = False
for port in range(8000, 8011):
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/backend/health",
            timeout=0.2,
        ) as response:
            payload = json.load(response)
        if payload.get("app") == "extrahop-admin-tools":
            print(f"  Running instance: http://127.0.0.1:{port} ({payload.get('version', 'unknown version')})")
            found = True
    except Exception:
        pass
if not found:
    print("  Running instance: none found on ports 8000-8010")
PY
    if [ -f "$SERVER_LOG" ]; then
        echo "  Recent server log:"
        tail -n 20 "$SERVER_LOG" | sed 's/^/    /'
    else
        echo "  Server log: not created yet"
    fi
    echo "  API log: $API_LOG (contents intentionally omitted)"
}

if [ "$DIAGNOSTICS" -eq 1 ]; then
    safe_diagnostics
    exit 0
fi

mkdir -p "$STATE_ROOT" "$LOG_DIR"

if [ "$RESET_RUNTIME" -eq 1 ]; then
    case "$RUNTIME_DIR" in
        "$STATE_ROOT"/runtime-*)
            rm -rf "$RUNTIME_DIR"
            echo "Reset the private runtime for this package version."
            ;;
        *)
            echo "ERROR: Refusing to reset an unexpected runtime path." >&2
            exit 1
            ;;
    esac
fi

runtime_is_healthy() {
    [ -x "$VENV_PYTHON" ] &&
        "$VENV_PYTHON" -c 'import fastapi, httpx, playwright, uvicorn' >/dev/null 2>&1 &&
        "$VENV_PYTHON" -m pip check >/dev/null 2>&1
}

if ! runtime_is_healthy; then
    echo
    echo "Preparing a private Python runtime. This happens only on the first launch"
    echo "for this package version and requires an internet connection."
    echo

    BUILD_VENV="$RUNTIME_DIR/venv.build.$$"
    mkdir -p "$RUNTIME_DIR"
    rm -rf "$BUILD_VENV"

    if ! "$BOOTSTRAP_PYTHON" -m venv "$BUILD_VENV"; then
        cat >&2 <<'EOF'
ERROR: Python could not create a virtual environment.

On Debian/Ubuntu, install python3-venv and try again. Otherwise reinstall Python
from https://www.python.org/downloads/.
EOF
        exit 1
    fi

    if ! "$BUILD_VENV/bin/python" -m pip install \
        --disable-pip-version-check \
        --no-input \
        -r "$LOCK_FILE"; then
        rm -rf "$BUILD_VENV"
        echo "ERROR: Dependency installation failed. Check the internet connection, then retry." >&2
        exit 1
    fi

    "$BUILD_VENV/bin/python" -m pip check
    rm -rf "$VENV_DIR"
    mv "$BUILD_VENV" "$VENV_DIR"
fi

export PLAYWRIGHT_BROWSERS_PATH
PDF_MARKER="$RUNTIME_DIR/pdf-browser-ready"
pdf_browser_is_ready() {
    [ -f "$PDF_MARKER" ] &&
        "$VENV_PYTHON" -c '
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    raise SystemExit(0 if Path(playwright.chromium.executable_path).is_file() else 1)
' >/dev/null 2>&1
}

if [ "$SKIP_PDF_SETUP" != "1" ] && ! pdf_browser_is_ready; then
    echo
    echo "Installing the browser used for PDF export. This one-time download can take"
    echo "several minutes; the core admin tools do not depend on it."
    if "$VENV_PYTHON" -m playwright install chromium; then
        : > "$PDF_MARKER"
    else
        echo "WARNING: PDF browser setup failed. The app will still start; PDF export may be unavailable." >&2
    fi
fi

PORT_RESULT=$("$BOOTSTRAP_PYTHON" - "$REQUESTED_PORT" <<'PY'
import json
import socket
import sys
import urllib.request

requested = sys.argv[1]
if requested:
    try:
        port = int(requested)
    except ValueError:
        print("error:Port must be a number.")
        raise SystemExit
    if not 1024 <= port <= 65535:
        print("error:Port must be between 1024 and 65535.")
        raise SystemExit
    candidates = [port]
else:
    candidates = range(8000, 8011)

for port in candidates:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/backend/health",
            timeout=0.25,
        ) as response:
            payload = json.load(response)
        if payload.get("app") == "extrahop-admin-tools":
            print(f"existing:{port}")
            raise SystemExit
    except Exception:
        pass

    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        if requested:
            print(f"error:Port {port} is already used by another application.")
            raise SystemExit
    else:
        print(f"free:{port}")
        raise SystemExit
    finally:
        sock.close()

print("error:No free local port was found from 8000 through 8010.")
PY
)

PORT_STATUS=${PORT_RESULT%%:*}
PORT_VALUE=${PORT_RESULT#*:}
case "$PORT_STATUS" in
    existing)
        APP_URL="http://127.0.0.1:$PORT_VALUE/"
        BROWSER_URL="${APP_URL}?build=$UI_CACHE_KEY"
        echo "ExtraHop Admin Tools is already running at $BROWSER_URL"
        if [ "$NO_BROWSER" -eq 0 ]; then
            case "$SYSTEM_NAME" in
                Darwin) open "$BROWSER_URL" >/dev/null 2>&1 || true ;;
                Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$BROWSER_URL" >/dev/null 2>&1 || true ;;
            esac
        fi
        exit 0
        ;;
    free)
        PORT=$PORT_VALUE
        ;;
    error)
        echo "ERROR: $PORT_VALUE" >&2
        exit 1
        ;;
    *)
        echo "ERROR: Could not determine a local port." >&2
        exit 1
        ;;
esac

APP_URL="http://127.0.0.1:$PORT/"
BROWSER_URL="${APP_URL}?build=$UI_CACHE_KEY"
export EH_API_RESPONSE_LOG=${EH_API_RESPONSE_LOG:-$API_LOG}
export EH_API_LOG_VERBOSITY=${EH_API_LOG_VERBOSITY:-off}

open_when_ready() {
    attempts=0
    while [ "$attempts" -lt 80 ]; do
        if "$BOOTSTRAP_PYTHON" - "$APP_URL" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1] + "backend/health", timeout=0.25) as response:
    payload = json.load(response)
raise SystemExit(0 if payload.get("app") == "extrahop-admin-tools" else 1)
PY
        then
            echo
            echo "Ready: $BROWSER_URL"
            echo "Keep this terminal window open. Press Ctrl+C to stop the app."
            if [ "$NO_BROWSER" -eq 0 ]; then
                case "$SYSTEM_NAME" in
                    Darwin) open "$BROWSER_URL" >/dev/null 2>&1 || true ;;
                    Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$BROWSER_URL" >/dev/null 2>&1 || true ;;
                esac
            fi
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 0.25
    done
    echo "WARNING: Startup did not become ready. Run ./start.sh --diagnostics for details." >&2
}

open_when_ready &

echo
echo "Starting ExtraHop Admin Tools at $APP_URL"
echo "Server log: $SERVER_LOG"
echo

cd "$APP_DIR"
"$VENV_PYTHON" -m uvicorn main:app \
    --app-dir "$APP_DIR" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --workers 1 \
    2>&1 | tee -a "$SERVER_LOG"
