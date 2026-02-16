#!/bin/bash

# Description: Update the Igris Brain MCP Server on a VPS from GitHub
# Usage: igris_vps_update.sh [--if-changed] [--force] [--branch <name>]
# Dependencies: git, node 20+, npm, pm2
# Exit codes:
#   0 - Success (or no changes when --if-changed)
#   1 - Error (missing dependency, build failure, pull failure)
#   2 - Invalid arguments

set -e

# ============================================================
# Constants
# ============================================================
BRAIN_DIR="$HOME/.igris"
BRAIN_ENV="$BRAIN_DIR/brain.env"
MCP_SERVER_DIR="$BRAIN_DIR/mcp-server"
REPO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PM2_APP_NAME="igris-brain"
DEFAULT_PORT=3001

# ============================================================
# Defaults
# ============================================================
IF_CHANGED=false
FORCE=false
BRANCH="main"
OLD_COMMIT=""
NEW_COMMIT=""

# ============================================================
# Functions
# ============================================================

print_usage() {
  echo "Usage: igris_vps_update.sh [--if-changed] [--force] [--branch <name>]"
  echo ""
  echo "Options:"
  echo "  --if-changed   Only update if remote has new commits (for cron usage)"
  echo "  --force        Skip change check, always rebuild"
  echo "  --branch NAME  Override branch (default: main)"
  echo ""
  echo "Examples:"
  echo "  igris_vps_update.sh                        # Update from main"
  echo "  igris_vps_update.sh --if-changed            # Cron-safe update"
  echo "  igris_vps_update.sh --branch develop        # Update from develop"
  echo "  igris_vps_update.sh --force --branch main   # Force rebuild"
}

check_command() {
  local cmd="$1"
  local name="$2"
  local install_hint="$3"

  if command -v "$cmd" &> /dev/null; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1)
    echo "  [ok] $name: $version"
    return 0
  else
    echo "  [MISSING] $name is not installed."
    echo "            Install: $install_hint"
    return 1
  fi
}

check_prerequisites() {
  echo "Checking prerequisites..."
  echo ""

  local missing=0

  # Git
  check_command git "Git" "sudo apt install git" || missing=1

  # Node.js 20+
  if command -v node &> /dev/null; then
    local node_version
    local node_major
    node_version=$(node --version)
    node_major=$(echo "$node_version" | sed 's/v//' | cut -d. -f1)
    if [ "$node_major" -ge 20 ]; then
      echo "  [ok] Node.js: $node_version"
    else
      echo "  [FAIL] Node.js $node_version found but v20+ is required."
      missing=1
    fi
  else
    echo "  [MISSING] Node.js is not installed."
    echo "            Install: https://nodejs.org/ or use nvm"
    missing=1
  fi

  check_command npm "npm" "Included with Node.js" || missing=1
  check_command pm2 "PM2" "npm install -g pm2" || missing=1

  echo ""

  if [ "$missing" -eq 1 ]; then
    echo "ERROR: Missing prerequisites. Install the missing tools above and re-run."
    exit 1
  fi

  echo "All prerequisites satisfied."
  echo ""

  # Verify repo directory is a git repository
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "ERROR: $REPO_DIR is not a git repository."
    echo "       The update script must be run from within the igris-ai repository."
    exit 1
  fi

  # Verify brain has been deployed
  if [ ! -d "$MCP_SERVER_DIR" ]; then
    echo "ERROR: Brain MCP server not found at $MCP_SERVER_DIR"
    echo "       Run igris_brain_deploy.sh first to perform initial deployment."
    exit 1
  fi
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --if-changed)
        IF_CHANGED=true
        shift
        ;;
      --force)
        FORCE=true
        shift
        ;;
      --branch)
        if [ -z "$2" ] || [[ "$2" == --* ]]; then
          echo "ERROR: --branch requires a branch name argument."
          echo ""
          print_usage
          exit 2
        fi
        BRANCH="$2"
        shift 2
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        echo "ERROR: Unknown argument: $1"
        echo ""
        print_usage
        exit 2
        ;;
    esac
  done
}

check_for_changes() {
  # Fetch latest from remote
  git fetch origin "$BRANCH" --quiet 2>/dev/null

  # Compare local HEAD with remote branch
  # git diff --quiet returns 0 if NO differences, 1 if differences exist
  if git diff --quiet HEAD "origin/$BRANCH" 2>/dev/null; then
    # No changes
    return 1
  else
    # Changes exist
    return 0
  fi
}

pull_latest() {
  echo ""
  echo "Pulling latest changes from origin/$BRANCH..."

  OLD_COMMIT=$(git rev-parse --short HEAD)

  if ! git pull origin "$BRANCH" --ff-only 2>&1; then
    echo ""
    echo "ERROR: Branch has diverged from origin/$BRANCH."
    echo "       Fast-forward merge is not possible."
    echo "       SSH into the VPS and resolve manually:"
    echo "         cd $REPO_DIR"
    echo "         git status"
    echo "         git log --oneline -5"
    exit 1
  fi

  NEW_COMMIT=$(git rev-parse --short HEAD)

  echo ""
  echo "  Commits pulled ($OLD_COMMIT -> $NEW_COMMIT):"
  git log --oneline "$OLD_COMMIT".."$NEW_COMMIT" | sed 's/^/    /'
  echo ""
}

build_server() {
  echo "Building brain-mcp-server..."

  if [ ! -d "$REPO_DIR/brain-mcp-server" ]; then
    echo "ERROR: brain-mcp-server/ not found in $REPO_DIR"
    echo "       Make sure the repository contains the brain-mcp-server directory."
    exit 1
  fi

  # Back up existing dist directory for rollback on failure
  local has_backup=false
  if [ -d "$MCP_SERVER_DIR/dist" ]; then
    cp -r "$MCP_SERVER_DIR/dist" "$MCP_SERVER_DIR/dist.backup"
    has_backup=true
    echo "  [ok] Existing build backed up to dist.backup"
  fi

  # Copy source files
  cp -r "$REPO_DIR/brain-mcp-server/"* "$MCP_SERVER_DIR/"
  echo "  [ok] Source files copied."

  # Install dependencies and build
  cd "$MCP_SERVER_DIR"

  echo "  Installing dependencies..."
  if ! npm ci --silent 2>&1 | tail -1; then
    echo ""
    echo "  [FAIL] npm ci failed."
    if [ "$has_backup" = true ]; then
      echo "  Restoring previous build from backup..."
      rm -rf "$MCP_SERVER_DIR/dist"
      mv "$MCP_SERVER_DIR/dist.backup" "$MCP_SERVER_DIR/dist"
      echo "  [ok] Previous build restored. Server should still be functional."
    fi
    exit 1
  fi
  echo "  [ok] Dependencies installed."

  echo "  Building TypeScript..."
  if ! npm run build --silent 2>&1 | tail -1; then
    echo ""
    echo "  [FAIL] npm run build failed."
    if [ "$has_backup" = true ]; then
      echo "  Restoring previous build from backup..."
      rm -rf "$MCP_SERVER_DIR/dist"
      mv "$MCP_SERVER_DIR/dist.backup" "$MCP_SERVER_DIR/dist"
      echo "  [ok] Previous build restored. Server should still be functional."
    fi
    exit 1
  fi
  echo "  [ok] Build complete."

  # Build succeeded, remove backup
  if [ "$has_backup" = true ]; then
    rm -rf "$MCP_SERVER_DIR/dist.backup"
  fi

  cd "$REPO_DIR"
}

restart_server() {
  echo ""
  echo "Restarting brain server..."

  # Source brain.env to get PORT
  local PORT="$DEFAULT_PORT"
  if [ -f "$BRAIN_ENV" ]; then
    # shellcheck source=/dev/null
    source "$BRAIN_ENV"
    PORT="${BRAIN_PORT:-$DEFAULT_PORT}"
  fi

  pm2 restart "$PM2_APP_NAME" 2>&1 | tail -2
  echo "  [ok] PM2 restart issued."

  # Wait for server to come up
  sleep 2

  # Health check
  local health_response
  health_response=$(curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "FAIL")

  if echo "$health_response" | grep -q '"status":"ok"'; then
    echo "  [ok] Health check passed: $health_response"
  else
    echo "  [WARN] Health check did not return expected response."
    echo "         Response: $health_response"
    echo "         Check logs: pm2 logs $PM2_APP_NAME"
  fi
}

log_update() {
  local log_dir="$BRAIN_DIR/logs"
  local log_file="$log_dir/update.log"

  # Create logs directory if missing
  mkdir -p "$log_dir"

  # Count commits
  local commit_count
  commit_count=$(git log --oneline "$OLD_COMMIT".."$NEW_COMMIT" 2>/dev/null | wc -l | tr -d ' ')

  # Append to update log
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$timestamp] Updated: $OLD_COMMIT -> $NEW_COMMIT ($commit_count commits)" >> "$log_file"
}

print_cron_instructions() {
  echo ""
  echo "----------------------------------------"
  echo " Auto-Update Setup"
  echo "----------------------------------------"
  echo ""
  echo "To auto-update every 5 minutes, add this cron entry:"
  echo "  crontab -e"
  echo "  */5 * * * * $REPO_DIR/scripts/igris_vps_update.sh --if-changed >> $BRAIN_DIR/logs/update.log 2>&1"
  echo ""
}

print_summary() {
  # Count commits
  local commit_count
  commit_count=$(git log --oneline "$OLD_COMMIT".."$NEW_COMMIT" 2>/dev/null | wc -l | tr -d ' ')

  # Get server version from health check
  local PORT="$DEFAULT_PORT"
  if [ -f "$BRAIN_ENV" ]; then
    # shellcheck source=/dev/null
    source "$BRAIN_ENV"
    PORT="${BRAIN_PORT:-$DEFAULT_PORT}"
  fi
  local server_version
  server_version=$(curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "unavailable")

  echo ""
  echo "========================================"
  echo " Update Complete"
  echo "========================================"
  echo ""
  echo "  Previous commit: $OLD_COMMIT"
  echo "  Current commit:  $NEW_COMMIT"
  echo "  Commits pulled:  $commit_count"
  echo "  Server health:   $server_version"
  echo ""
  echo "PM2 commands:"
  echo "  pm2 logs $PM2_APP_NAME    # View logs"
  echo "  pm2 monit                 # Monitor dashboard"
  echo ""
  echo "Update log: $BRAIN_DIR/logs/update.log"
  echo ""
  echo "========================================"
}

# ============================================================
# Main
# ============================================================

main() {
  parse_arguments "$@"
  check_prerequisites

  cd "$REPO_DIR"

  if [ "$IF_CHANGED" = true ] && [ "$FORCE" != true ]; then
    if ! check_for_changes; then
      # No changes -- exit silently for cron
      exit 0
    fi
  fi

  echo "========================================"
  echo " Igris AI - Brain VPS Update"
  echo "========================================"
  echo ""
  echo "  Repository: $REPO_DIR"
  echo "  Branch:     $BRANCH"
  echo "  Mode:       $([ "$FORCE" = true ] && echo "force" || echo "standard")"
  echo ""

  pull_latest
  build_server
  restart_server
  log_update
  print_summary

  # Show cron instructions only on manual (non --if-changed) runs
  if [ "$IF_CHANGED" != true ]; then
    print_cron_instructions
  fi
}

main "$@"
