#!/bin/bash
set -e

# Description: Launch the Igris AI Agent Token Dashboard (Crimson Arena)
# Usage: scripts/dashboard.sh [--port PORT] [--host HOST] [--open] [--reset-db]
# Dependencies: python3
# Exit codes:
#   0 - Success (server shut down normally)
#   1 - Error (dependency missing, etc.)

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD_DIR="${PROJECT_DIR}/dashboard"
VENV_DIR="${DASHBOARD_DIR}/.venv"
DB_FILE="${DASHBOARD_DIR}/arena.db"
REQUIREMENTS_FILE="${DASHBOARD_DIR}/requirements.txt"
DEFAULT_PORT=8001
DEFAULT_HOST="127.0.0.1"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

port="${DEFAULT_PORT}"
host="${DEFAULT_HOST}"
open_browser=false
reset_db=false

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        if [[ -z "$2" || "$2" =~ ^-- ]]; then
          echo "  Error: --port requires a port number"
          echo "  Usage: $0 [--port PORT] [--host HOST] [--open] [--reset-db]"
          exit 2
        fi
        port="$2"
        shift 2
        ;;
      --host)
        if [[ -z "$2" || "$2" =~ ^-- ]]; then
          echo "  Error: --host requires a host address"
          echo "  Usage: $0 [--port PORT] [--host HOST] [--open] [--reset-db]"
          exit 2
        fi
        host="$2"
        shift 2
        ;;
      --open)
        open_browser=true
        shift
        ;;
      --reset-db)
        reset_db=true
        shift
        ;;
      -h|--help)
        show_help
        exit 0
        ;;
      *)
        echo "  Unknown option: $1"
        echo "  Usage: $0 [--port PORT] [--host HOST] [--open] [--reset-db]"
        exit 2
        ;;
    esac
  done
}

show_help() {
  echo "Crimson Arena - Igris AI Agent Token Dashboard"
  echo ""
  echo "Usage: $0 [--port PORT] [--host HOST] [--open] [--reset-db]"
  echo ""
  echo "Options:"
  echo "  --port PORT   Set server port (default: ${DEFAULT_PORT})"
  echo "  --host HOST   Set server host (default: ${DEFAULT_HOST})"
  echo "  --open        Open browser after server starts"
  echo "  --reset-db    Delete arena.db before starting (fresh database)"
  echo "  -h, --help    Show this help message"
  echo ""
  echo "Examples:"
  echo "  $0                          # Start on localhost:${DEFAULT_PORT}"
  echo "  $0 --port 9000              # Start on port 9000"
  echo "  $0 --host 0.0.0.0           # Expose to local network"
  echo "  $0 --open                   # Start and open browser"
  echo "  $0 --reset-db --open        # Fresh start with browser"
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "  Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS:  brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo "  WSL:    sudo apt install python3"
    echo ""
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Virtual environment management
# ---------------------------------------------------------------------------

setup_venv() {
  if [ ! -d "${VENV_DIR}" ]; then
    echo "  Creating virtual environment..."
    python3 -m venv "${VENV_DIR}"
    echo "  Virtual environment created at ${VENV_DIR}"
  fi
}

install_requirements() {
  if [ ! -f "${REQUIREMENTS_FILE}" ]; then
    echo "  Error: requirements.txt not found at ${REQUIREMENTS_FILE}"
    exit 1
  fi

  # Install/upgrade if requirements changed or packages missing
  local marker_file="${VENV_DIR}/.requirements_hash"
  local current_hash
  current_hash=$(python3 -c "
import hashlib, sys
with open(sys.argv[1], 'rb') as f:
    print(hashlib.md5(f.read()).hexdigest())
" "${REQUIREMENTS_FILE}")

  local installed_hash=""
  if [ -f "${marker_file}" ]; then
    installed_hash=$(<"${marker_file}")
  fi

  if [ "${current_hash}" != "${installed_hash}" ]; then
    echo "  Installing dependencies..."
    "${VENV_DIR}/bin/pip" install --quiet --upgrade pip > /dev/null 2>&1
    "${VENV_DIR}/bin/pip" install --quiet -r "${REQUIREMENTS_FILE}"
    echo "${current_hash}" > "${marker_file}"
    echo "  Dependencies installed"
  else
    echo "  Dependencies up to date"
  fi
}

# ---------------------------------------------------------------------------
# Database management
# ---------------------------------------------------------------------------

handle_reset_db() {
  if [ "${reset_db}" = true ] && [ -f "${DB_FILE}" ]; then
    echo "  Resetting database..."
    rm -f "${DB_FILE}"
    echo "  Database deleted: ${DB_FILE}"
  fi
}

# ---------------------------------------------------------------------------
# Browser launch
# ---------------------------------------------------------------------------

open_in_browser() {
  local url="http://localhost:${port}"

  # Small delay to let server start
  (
    sleep 2
    if command -v open &> /dev/null; then
      open "${url}"
    elif command -v xdg-open &> /dev/null; then
      xdg-open "${url}"
    elif command -v wslview &> /dev/null; then
      wslview "${url}"
    else
      echo "  Could not detect browser opener. Visit: ${url}"
    fi
  ) &
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  echo ""
  echo "  Crimson Arena - Agent Token Dashboard"
  echo "  ======================================"
  echo ""

  echo "  Checking dependencies..."
  check_python3
  echo "  Python 3 found: $(python3 --version 2>&1)"
  echo ""

  echo "  Setting up environment..."
  setup_venv
  install_requirements
  echo ""

  handle_reset_db

  if [ "${open_browser}" = true ]; then
    open_in_browser
  fi

  echo "  Starting Crimson Arena on ${host}:${port}..."
  echo "  Dashboard URL: http://${host}:${port}"
  echo "  Press Ctrl+C to stop"
  echo ""

  # Export project dir so server.py can find metrics files
  export CLAUDE_PROJECT_DIR="${PROJECT_DIR}"
  export DASHBOARD_PORT="${port}"

  # Start uvicorn via the venv python
  "${VENV_DIR}/bin/python" -m uvicorn \
    server:app \
    --host "${host}" \
    --port "${port}" \
    --app-dir "${DASHBOARD_DIR}" \
    --log-level info
}

main "$@"
