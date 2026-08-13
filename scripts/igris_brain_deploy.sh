#!/bin/bash

# Description: Deploy the Igris Brain MCP Server on a VPS with HTTP transport
# Usage: igris_brain_deploy.sh [--domain <domain>] [--port <port>]
# Dependencies: node 20+, npm, pm2, nginx
# Exit codes:
#   0 - Success
#   1 - Error (missing dependency, build failure)

set -euo pipefail

# ============================================================
# Constants
# ============================================================
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
BRAIN_ENV="$BRAIN_DIR/brain.env"
MCP_SERVER_DIR="$BRAIN_DIR/mcp-server"
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PM2_APP_NAME="${IGRIS_PM2_APP_NAME:-igris-brain}"
DEFAULT_PORT="${IGRIS_BRAIN_PORT:-3001}"

# ============================================================
# Functions
# ============================================================

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
  check_command nginx "Nginx" "sudo apt install nginx" || missing=1

  echo ""

  if [ "$missing" -eq 1 ]; then
    echo "ERROR: Missing prerequisites. Install the missing tools above and re-run."
    exit 1
  fi

  echo "All prerequisites satisfied."
  echo ""
}

parse_arguments() {
  DOMAIN=""
  PORT=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)
        DOMAIN="${2:-}"
        shift 2
        ;;
      --port)
        PORT="${2:-}"
        shift 2
        ;;
      *)
        echo "Unknown argument: $1"
        echo "Usage: igris_brain_deploy.sh [--domain <domain>] [--port <port>]"
        exit 1
        ;;
    esac
  done
}

prompt_domain() {
  if [ -z "$DOMAIN" ]; then
    echo "Enter the domain name for the brain server (e.g., brain.example.com)."
    echo "Leave blank to skip Nginx config generation."
    read -r -p "Domain: " DOMAIN
    echo ""
  fi
}

setup_brain_directory() {
  echo "Setting up brain directory structure..."
  mkdir -p "$BRAIN_DIR/memory"
  mkdir -p "$BRAIN_DIR/staging"
  mkdir -p "$BRAIN_DIR/logs"
  mkdir -p "$MCP_SERVER_DIR"
  echo "  [ok] Directories created."
}

build_server() {
  echo ""
  echo "Building brain-mcp-server..."

  if [ ! -d "$IGRIS_DIR/brain-mcp-server" ]; then
    echo "ERROR: brain-mcp-server/ not found in $IGRIS_DIR"
    echo "       Make sure you are running this from the igris-ai repository."
    exit 1
  fi

  # Copy source files
  cp -r "$IGRIS_DIR/brain-mcp-server/"* "$MCP_SERVER_DIR/"
  echo "  [ok] Source files copied."

  # Install dependencies and build
  cd "$MCP_SERVER_DIR"
  echo "  Installing dependencies..."
  npm ci --silent 2>&1 | tail -1
  echo "  [ok] Dependencies installed."

  echo "  Building TypeScript..."
  npm run build --silent 2>&1 | tail -1
  echo "  [ok] Build complete."

  cd "$IGRIS_DIR"
}

generate_api_key() {
  # Generate a 32-byte random key, base64url encoded
  if command -v openssl &> /dev/null; then
    openssl rand -base64 32 | tr -d '=/+' | cut -c1-44
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  fi
}

setup_authentication() {
  echo ""
  echo "Setting up authentication..."

  if [ -f "$BRAIN_ENV" ]; then
    # shellcheck source=/dev/null
    source "$BRAIN_ENV"
    if [ -n "${BRAIN_API_KEY:-}" ]; then
      echo "  [ok] Existing API key found in $BRAIN_ENV"
    else
      BRAIN_API_KEY=$(generate_api_key)
      echo "BRAIN_API_KEY=$BRAIN_API_KEY" >> "$BRAIN_ENV"
      echo "  [ok] API key generated and appended to $BRAIN_ENV"
    fi
  else
    BRAIN_API_KEY=$(generate_api_key)
    cat > "$BRAIN_ENV" << EOF
# Igris Brain HTTP Server Environment
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

BRAIN_API_KEY=$BRAIN_API_KEY
BRAIN_PORT=$PORT
BRAIN_HTTP=1
EOF
    chmod 600 "$BRAIN_ENV"
    echo "  [ok] API key generated and saved to $BRAIN_ENV"
  fi

  # Reload env in case we just created it
  # shellcheck source=/dev/null
  source "$BRAIN_ENV"
}

create_pm2_config() {
  echo ""
  echo "Creating PM2 ecosystem config..."

  local pm2_config="$BRAIN_DIR/ecosystem.config.cjs"

  # PM2 config reads env from the env file — no inline secrets
  cat > "$pm2_config" << EOF
// PM2 ecosystem config for Igris Brain MCP Server
// Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
// API key loaded from: ${BRAIN_ENV}

module.exports = {
  apps: [
    {
      name: '${PM2_APP_NAME}',
      script: '${MCP_SERVER_DIR}/dist/index.js',
      args: '--http --port ${PORT}',
      cwd: '${MCP_SERVER_DIR}',
      interpreter: 'node',
      env_file: '${BRAIN_ENV}',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      error_file: '${BRAIN_DIR}/logs/brain-error.log',
      out_file: '${BRAIN_DIR}/logs/brain-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
EOF

  chmod 600 "$pm2_config"
  echo "  [ok] PM2 config written to $pm2_config (permissions: 600)"
}

start_pm2() {
  echo ""
  echo "Starting brain server with PM2..."

  local pm2_config="$BRAIN_DIR/ecosystem.config.cjs"

  # Stop existing instance if running
  pm2 delete "$PM2_APP_NAME" 2>/dev/null || true

  pm2 start "$pm2_config"
  pm2 save

  echo "  [ok] Brain server started."
  echo ""

  # Verify it's running
  sleep 2
  # TD-345: the missing `-q` is deliberate — do not add it back. `pm2 list |
  # grep -q` under this script's `set -euo pipefail` (line 10) reports a false
  # "no match" whenever grep short-circuits while pm2 still has output buffered
  # — pm2's table is long on a busy VPS. Without `-q`, grep reads to EOF, pm2
  # always finishes writing, and pm2's OWN failure still propagates through
  # pipefail into this `if` (falling to the [WARN] branch below).
  if pm2 list | grep "$PM2_APP_NAME" >/dev/null; then
    echo "  Verifying health..."
    local health_response
    health_response=$(curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "FAIL")
    if echo "$health_response" | grep '"status":"ok"' >/dev/null; then
      echo "  [ok] Health check passed: $health_response"
    else
      echo "  [WARN] Health check did not return expected response."
      echo "         Response: $health_response"
      echo "         Check logs: pm2 logs $PM2_APP_NAME"
    fi
  else
    echo "  [WARN] PM2 process may not be running. Check: pm2 list"
  fi
}

generate_nginx_config() {
  if [ -z "$DOMAIN" ]; then
    return
  fi

  echo ""
  echo "Generating Nginx configuration..."

  local nginx_conf="$BRAIN_DIR/nginx-brain.conf"

  cat > "$nginx_conf" << EOF
# Nginx reverse proxy config for Igris Brain MCP Server
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Install:
#   sudo cp ${nginx_conf} /etc/nginx/sites-available/igris-brain
#   sudo ln -s /etc/nginx/sites-available/igris-brain /etc/nginx/sites-enabled/
#   sudo nginx -t && sudo systemctl reload nginx
#
# Then obtain TLS certificate:
#   sudo certbot --nginx -d ${DOMAIN}

server {
    listen 80;
    server_name ${DOMAIN};

    # Health check (no auth)
    location /health {
        proxy_pass http://127.0.0.1:${PORT}/health;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # MCP endpoint (SSE-compatible proxy settings)
    location /mcp {
        proxy_pass http://127.0.0.1:${PORT}/mcp;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE-compatible settings — required for Streamable HTTP transport
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        chunked_transfer_encoding on;
    }
}
EOF

  echo "  [ok] Nginx config written to $nginx_conf"
  echo ""
  echo "  To install the Nginx config:"
  echo "    sudo cp $nginx_conf /etc/nginx/sites-available/igris-brain"
  echo "    sudo ln -s /etc/nginx/sites-available/igris-brain /etc/nginx/sites-enabled/"
  echo "    sudo nginx -t && sudo systemctl reload nginx"
  echo ""
  echo "  To add TLS (recommended):"
  echo "    sudo certbot --nginx -d $DOMAIN"
}

print_summary() {
  local remote_url
  if [ -n "$DOMAIN" ]; then
    remote_url="https://${DOMAIN}/mcp"
  else
    remote_url="http://<your-vps-ip>:${PORT}/mcp"
  fi

  echo ""
  echo "========================================"
  echo " Deployment Complete"
  echo "========================================"
  echo ""
  echo "The brain server is running at: http://127.0.0.1:${PORT}"
  if [ -n "$DOMAIN" ]; then
    echo "Public URL (after Nginx + TLS): https://${DOMAIN}"
  fi
  echo ""
  echo "PM2 commands:"
  echo "  pm2 logs $PM2_APP_NAME    # View logs"
  echo "  pm2 restart $PM2_APP_NAME # Restart server"
  echo "  pm2 stop $PM2_APP_NAME    # Stop server"
  echo "  pm2 monit                 # Monitor dashboard"
  echo ""
  echo "----------------------------------------"
  echo " Claude Code Configuration"
  echo "----------------------------------------"
  echo ""
  echo "Add this to ~/.claude.json on each remote machine that should"
  echo "connect to this brain server:"
  echo ""
  cat << EOF
{
  "mcpServers": {
    "igris-brain": {
      "type": "streamable-http",
      "url": "${remote_url}",
      "headers": {
        "Authorization": "Bearer <see ~/.igris/brain.env>"
      }
    }
  }
}
EOF
  echo ""
  echo "API key stored in: ${BRAIN_ENV}"
  echo "View key: cat ${BRAIN_ENV}"
  echo ""
  echo "========================================"
}

# ============================================================
# Main
# ============================================================

main() {
  echo "========================================"
  echo " Igris AI - Brain VPS Deployment"
  echo "========================================"
  echo ""

  parse_arguments "$@"
  check_prerequisites
  prompt_domain

  # Set port default
  if [ -z "$PORT" ]; then
    PORT="$DEFAULT_PORT"
  fi

  echo "Configuration:"
  echo "  Brain directory: $BRAIN_DIR"
  echo "  MCP server dir:  $MCP_SERVER_DIR"
  echo "  Port:            $PORT"
  echo "  Domain:          ${DOMAIN:-"(none - Nginx config skipped)"}"
  echo ""

  setup_brain_directory
  build_server
  setup_authentication
  create_pm2_config
  start_pm2
  generate_nginx_config
  print_summary
}

main "$@"
