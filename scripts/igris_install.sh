#!/bin/bash

# Description: Per-project symlink installer for the centralized ~/.igris/ brain
# Usage: igris_install.sh [target-directory]
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success (project installed and registered)
#   1 - Error (brain not found, invalid directory)

set -euo pipefail

echo "🔗 Igris AI - Project Installer (Global Mode)"
echo "========================================"
echo ""

BRAIN_DIR="$HOME/.igris"

# ============================================================
# Check brain exists
# ============================================================
if [ ! -d "$BRAIN_DIR" ]; then
  echo "❌ Error: Igris Brain not found at $BRAIN_DIR"
  echo ""
  echo "   Run the brain bootstrap first:"
  echo "   ./scripts/igris_brain_init.sh"
  echo ""
  exit 1
fi

echo "🧠 Brain detected at $BRAIN_DIR"

# ============================================================
# Parse arguments: --cli=<list>, --include=<list>, and positional TARGET_DIR
#
# --cli controls which CLIs receive Igris surfaces (claude/opencode/gemini/codex).
# --include is orthogonal: it controls *which Igris surfaces* ship to those CLIs.
#   Accepted values: skills, hooks, all (default).
# ============================================================
CLI_TARGETS=""
INCLUDE_TARGETS="all"
POSITIONAL_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli=*)
      CLI_TARGETS="${1#--cli=}"
      ;;
    --cli)
      # Support space-separated form: --cli <list>
      shift
      CLI_TARGETS="${1:-}"
      ;;
    --include=*)
      INCLUDE_TARGETS="${1#--include=}"
      ;;
    --include)
      shift
      INCLUDE_TARGETS="${1:-all}"
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      ;;
  esac
  shift
done

# Normalize INCLUDE_TARGETS (strip spaces; default to "all" when empty).
INCLUDE_TARGETS=$(echo "$INCLUDE_TARGETS" | tr -d '[:space:]')
if [ -z "$INCLUDE_TARGETS" ]; then
  INCLUDE_TARGETS="all"
fi

# Restore positional args so the rest of the script sees them as $1, $2, ...
set -- "${POSITIONAL_ARGS[@]}"

# Helper: returns 0 when INCLUDE_TARGETS covers the requested surface.
# Usage: include_has skills|hooks
include_has() {
  local surface="$1"
  case ",${INCLUDE_TARGETS}," in
    *,all,*)        return 0 ;;
    *,"$surface",*) return 0 ;;
    *)              return 1 ;;
  esac
}

# ============================================================
# Get target project directory
# ============================================================
TARGET_DIR="${1:-.}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

cd "$TARGET_DIR"
TARGET_DIR=$(pwd)

echo "📁 Target directory: $TARGET_DIR"
echo ""

# ============================================================
# Get source repo and version info
# ============================================================
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "6.0.0")

# ============================================================
# Refresh brain core from source repo
# ============================================================
echo ""
echo "Refreshing brain core..."
if [ -f "$IGRIS_DIR/scripts/igris_brain_refresh.sh" ]; then
  bash "$IGRIS_DIR/scripts/igris_brain_refresh.sh"
else
  echo "   igris_brain_refresh.sh not found, skipping core refresh"
fi
echo ""

# ============================================================
# Create project-local directories
# ============================================================
echo "📦 Creating project directories..."

mkdir -p .claude/hooks
mkdir -p scripts

# ============================================================
# Disable Claude Code built-in git instructions (BR-058)
# Igris commit standards (03-igris-commits.md) are the sole authority
# ============================================================
echo ""
echo "🔧 Configuring Claude Code settings..."

SETTINGS_FILE=".claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Merge includeGitInstructions into existing settings
  python3 -c "
import json, sys
settings_file = sys.argv[1]
with open(settings_file, 'r') as f:
    settings = json.load(f)
settings['includeGitInstructions'] = False
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
" "$SETTINGS_FILE"
  echo "   ✅ Updated $SETTINGS_FILE (includeGitInstructions: false)"
else
  # Create new settings with includeGitInstructions disabled
  python3 -c "
import json, sys
settings = {'includeGitInstructions': False}
with open(sys.argv[1], 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
" "$SETTINGS_FILE"
  echo "   ✅ Created $SETTINGS_FILE (includeGitInstructions: false)"
fi

# ============================================================
# Default subconscious engine to OFF for V7 (TD-102)
# Rule-based engine had 2% true-positive rate; redesign tracked under FR-118
# (V7.1 headline). Re-enable is just a flag flip — schedule rows preserved.
# ============================================================
echo ""
echo "🧠 Configuring subconscious engine default..."

CONFIG_FILE="$BRAIN_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  python3 - "$CONFIG_FILE" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
cfg = json.loads(p.read_text())
section = cfg.setdefault("subconscious", {})
# Only set the default if the key is absent — never clobber an operator
# who has explicitly re-enabled the engine after FR-118 ships.
if "enabled" not in section:
    section["enabled"] = False
    p.write_text(json.dumps(cfg, indent=2) + "\n")
    print("   ✅ subconscious.enabled: false (TD-102)")
else:
    print(f"   ✅ subconscious.enabled already set to {section['enabled']} (preserved)")
PY
else
  echo "   ⚠️  $CONFIG_FILE not found — skipping subconscious flag write"
fi

# Create per-project directories in brain
PROJECT_DIR="$HOME/.igris/projects/$(basename "$TARGET_DIR")"
mkdir -p "$PROJECT_DIR/session"
mkdir -p "$PROJECT_DIR/briefs"
mkdir -p "$PROJECT_DIR/metrics"
mkdir -p "$PROJECT_DIR/context"
mkdir -p "$PROJECT_DIR/plans"
mkdir -p "$PROJECT_DIR/hooks"
mkdir -p "$PROJECT_DIR/reference"

# Create worker logs directory (idempotent)
mkdir -p "$HOME/.igris/logs/worker"

echo "   ✅ Project directories created"
echo "   ✅ Project dir at $PROJECT_DIR"

# ============================================================
# Create per-project .claude/ symlinks for Claude Code
# ============================================================
echo ""
echo "🔗 Creating .claude/ symlinks..."

mkdir -p .claude/agents
mkdir -p .claude/rules
mkdir -p .claude/skills

# Agents: symlink individual files
if [ -d "$BRAIN_DIR/core/agents" ]; then
  for agent in "$BRAIN_DIR/core/agents/"*.md; do
    [ -f "$agent" ] && ln -sf "$agent" ".claude/agents/$(basename "$agent")"
  done
  [ -f "$BRAIN_DIR/core/agents/manifest.yaml" ] && ln -sf "$BRAIN_DIR/core/agents/manifest.yaml" ".claude/agents/manifest.yaml"
  echo "   ✅ Agents linked"
fi

# Rules: symlink universal rule
if [ -f "$BRAIN_DIR/core/rules/00-igris-universal.md" ]; then
  ln -sf "$BRAIN_DIR/core/rules/00-igris-universal.md" ".claude/rules/00-igris-universal.md"
  echo "   ✅ Rules linked"
fi

# Skills: symlink skill directories
if [ -d "$BRAIN_DIR/core/skills" ]; then
  for skill in "$BRAIN_DIR/core/skills/"*/; do
    [ -d "$skill" ] && ln -sf "$skill" ".claude/skills/$(basename "$skill")"
  done
  echo "   ✅ Skills linked"
fi

# ============================================================
# Multi-CLI skill distribution (FR-103)
# Delegate to igris_cli_sync.sh when --cli=<list> is passed and the list
# includes targets beyond plain "claude" (which is already handled above).
# Gated on --include=skills|all (default: all).
# ============================================================
if [ -n "$CLI_TARGETS" ] && include_has skills; then
  # Skip the dispatcher only when CLI_TARGETS is exactly "claude" (regression
  # preservation for AC#2 — symlinks above already satisfy the Claude case).
  if [ "$CLI_TARGETS" != "claude" ]; then
    echo ""
    echo "🔀 Multi-CLI skill sync: $CLI_TARGETS"
    CLI_SYNC_SCRIPT="$IGRIS_DIR/scripts/igris_cli_sync.sh"
    if [ -f "$CLI_SYNC_SCRIPT" ]; then
      bash "$CLI_SYNC_SCRIPT" --cli="$CLI_TARGETS" --project-dir="$TARGET_DIR"
    else
      echo "   ⚠️  igris_cli_sync.sh not found at $CLI_SYNC_SCRIPT — skipping multi-CLI sync"
    fi
  fi
fi

# ============================================================
# Multi-CLI hook sync (FR-104)
# Delegate to igris_hooks_sync.sh when --cli=<list> is passed and the
# includes list contains `hooks` (or `all`). Default include=all covers this.
# Unlike skill sync, hook sync runs for *every* CLI in the list (including
# plain "claude") because the Claude path is the settings.json regen step.
# ============================================================
if [ -n "$CLI_TARGETS" ] && include_has hooks; then
  echo ""
  echo "🪝 Multi-CLI hook sync: $CLI_TARGETS"
  HOOK_SYNC_SCRIPT="$IGRIS_DIR/scripts/igris_hooks_sync.sh"
  if [ -f "$HOOK_SYNC_SCRIPT" ]; then
    bash "$HOOK_SYNC_SCRIPT" --cli="$CLI_TARGETS" --project-dir="$TARGET_DIR"
  else
    echo "   ⚠️  igris_hooks_sync.sh not found at $HOOK_SYNC_SCRIPT — skipping hook sync"
  fi
fi

# ============================================================
# Create project-local session files (fresh templates, not symlinks)
# ============================================================
echo ""
echo "📝 Creating project-local files..."

# CURRENT_SESSION.md
if [ ! -f "$PROJECT_DIR/session/CURRENT_SESSION.md" ]; then
  cat > "$PROJECT_DIR/session/CURRENT_SESSION.md" << 'EOF'
# Current Session

**Status:** No active session
**Last Updated:** N/A

---

## Session Goal

[No active session]

---

## Tasks

[None]

---

## Current State

[No active work in progress]

---

## Next Steps When Resuming

[N/A]
EOF
  echo "   ✅ CURRENT_SESSION.md created (in cache)"
else
  echo "   ⚠️  CURRENT_SESSION.md already exists (skipping)"
fi

# BLOCKERS.md
if [ ! -f "$PROJECT_DIR/session/BLOCKERS.md" ]; then
  cat > "$PROJECT_DIR/session/BLOCKERS.md" << 'EOF'
# Active Blockers

**Last Updated:** N/A

---

[No active blockers]
EOF
  echo "   ✅ BLOCKERS.md created (in cache)"
else
  echo "   ⚠️  BLOCKERS.md already exists (skipping)"
fi

# DECISIONS.md
if [ ! -f "$PROJECT_DIR/session/DECISIONS.md" ]; then
  cat > "$PROJECT_DIR/session/DECISIONS.md" << 'EOF'
# Architectural Decisions

**Last Updated:** N/A

---

[No decisions recorded yet]
EOF
  echo "   ✅ DECISIONS.md created (in cache)"
else
  echo "   ⚠️  DECISIONS.md already exists (skipping)"
fi

# LEARNINGS.md
if [ ! -f "$PROJECT_DIR/session/LEARNINGS.md" ]; then
  cat > "$PROJECT_DIR/session/LEARNINGS.md" << 'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF
  echo "   ✅ LEARNINGS.md created (in cache)"
else
  echo "   ⚠️  LEARNINGS.md already exists (skipping)"
fi

# Archive note: Archiving is now handled via brain DB (igris_brief_update with status='Archived')

# ============================================================
# Generate CLAUDE.md from template
# ============================================================
echo ""
echo "🤖 Generating CLAUDE.md..."

INSTALL_DATE=$(date -u +"%Y-%m-%d")

# Read persona from SOUL.md (if exists)
PERSONA_INJECTION=""
if [ -f "$BRAIN_DIR/core/SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "$BRAIN_DIR/core/SOUL.md")
elif [ -f "$IGRIS_DIR/core/SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "$IGRIS_DIR/core/SOUL.md")
fi

# Generate CLAUDE.md using template
TEMPLATE_FILE="$IGRIS_DIR/scripts/templates/CLAUDE.md.template"
if [ -f "$TEMPLATE_FILE" ]; then
  # First pass: simple variable substitution
  sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
      -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
      "$TEMPLATE_FILE" > CLAUDE.md.tmp

  # Second pass: persona injection (multi-line content from SOUL.md)
  if [ -n "$PERSONA_INJECTION" ]; then
    ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
    perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
  else
    perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
  fi

  mv CLAUDE.md.tmp CLAUDE.md
  echo "   ✅ CLAUDE.md generated from template"
else
  echo "   ⚠️  Template not found at $TEMPLATE_FILE"
  echo "   CLAUDE.md not generated. You may need to create it manually."
fi

# ============================================================
# Register project in brain
# ============================================================
echo ""
echo "📋 Registering project in brain..."

SLUG=$(basename "$TARGET_DIR")

# Detect tech stack from project indicators
TECH_STACK=$(python3 -c "
import os, sys, glob
project_dir = sys.argv[1]
stacks = []
indicators = {
    'pubspec.yaml': 'flutter',
    'package.json': 'typescript/javascript',
    'Cargo.toml': 'rust',
    'go.mod': 'go',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
}
for filename, stack in indicators.items():
    if os.path.isfile(os.path.join(project_dir, filename)):
        if stack not in stacks:
            stacks.append(stack)
# Check for bash scripts
if glob.glob(os.path.join(project_dir, '*.sh')) or glob.glob(os.path.join(project_dir, 'scripts', '*.sh')):
    stacks.append('bash')
print(','.join(stacks) if stacks else '')
" "$TARGET_DIR" 2>/dev/null || echo "")

python3 -c "
import sqlite3, sys
from datetime import datetime, timezone
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA busy_timeout = 5000')
db.execute('''
    INSERT INTO projects (slug, name, path, tech_stack, igris_version, last_session_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        tech_stack = excluded.tech_stack,
        igris_version = excluded.igris_version,
        last_session_at = excluded.last_session_at
''', (sys.argv[2], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], now))
db.commit()
db.close()
" "$BRAIN_DIR/memory/knowledge.db" "$SLUG" "$TARGET_DIR" "$TECH_STACK" "$IGRIS_VERSION"

echo "   ✅ Project registered: $SLUG (tech_stack: ${TECH_STACK:-none detected})"

# ============================================================
# Push project to remote brain (if configured)
# ============================================================
echo ""
echo "🌐 Checking remote brain..."

REMOTE_PUSH_RESULT=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    url = config.get('remote_brain', {}).get('url', '')
    key = config.get('remote_brain', {}).get('api_key', '')
    if url and key:
        print(url + '|' + key)
    else:
        print('')
except Exception:
    print('')
" "$BRAIN_DIR/config.json" 2>/dev/null || echo "")

if [ -n "$REMOTE_PUSH_RESULT" ]; then
  REMOTE_URL="${REMOTE_PUSH_RESULT%%|*}"
  API_KEY="${REMOTE_PUSH_RESULT##*|}"
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  PUSH_BODY=$(python3 -c "
import json, sys
body = {
    'tables': {
        'projects': [{
            'slug': sys.argv[1],
            'name': sys.argv[1],
            'path': sys.argv[2],
            'tech_stack': sys.argv[3],
            'igris_version': sys.argv[4],
            'status': 'active',
            'registered_at': sys.argv[5],
            'last_session_at': sys.argv[5],
            'metadata': '{}'
        }]
    }
}
print(json.dumps(body))
" "$SLUG" "$TARGET_DIR" "$TECH_STACK" "$IGRIS_VERSION" "$NOW")

  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    -X POST "${REMOTE_URL%/}/sync/push" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$PUSH_BODY" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ Project pushed to remote brain"
  else
    echo "   ⚠️  Remote brain push returned HTTP $HTTP_CODE (continuing anyway)"
  fi
else
  echo "   ⚠️  Remote brain not configured, skipping push"
fi

# ============================================================
# Create version tracking file
# ============================================================
echo ""
echo "📌 Creating version tracking..."

python3 -c "
import json, sys
from datetime import datetime, timezone
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
version_info = {
    'igris_ai_version': sys.argv[1],
    'install_mode': 'global',
    'brain_path': sys.argv[2],
    'installed_at': now,
    'last_updated': now
}
with open('.igris_version', 'w') as f:
    json.dump(version_info, f, indent=2)
    f.write('\n')
" "$IGRIS_VERSION" "$BRAIN_DIR"

echo "   ✅ .igris_version created"

# ============================================================
# Copy worker scripts to brain
# ============================================================
echo ""
echo "🔧 Installing worker scripts..."

mkdir -p "$HOME/.igris/scripts"

if [ -f "$IGRIS_DIR/scripts/igris_worker.sh" ]; then
  cp "$IGRIS_DIR/scripts/igris_worker.sh" "$HOME/.igris/scripts/igris_worker.sh"
  chmod +x "$HOME/.igris/scripts/igris_worker.sh"
  echo "   ✅ igris_worker.sh installed"
else
  echo "   ⚠️  igris_worker.sh not found in source repo"
fi

if [ -f "$IGRIS_DIR/scripts/igris_worker_config.sh" ]; then
  cp "$IGRIS_DIR/scripts/igris_worker_config.sh" "$HOME/.igris/scripts/igris_worker_config.sh"
  chmod +x "$HOME/.igris/scripts/igris_worker_config.sh"
  echo "   ✅ igris_worker_config.sh installed"
else
  echo "   ⚠️  igris_worker_config.sh not found in source repo"
fi

# ============================================================
# Brain health check
# ============================================================
echo ""
echo "🩺 Brain health check..."

if [ -f "$BRAIN_DIR/memory/knowledge.db" ]; then
  INTEGRITY=$(sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
  if [ "$INTEGRITY" = "ok" ]; then
    echo "   ✅ Local brain: knowledge.db OK"
  else
    echo "   ⚠️  Local brain: knowledge.db integrity issue detected"
  fi
else
  echo "   ⚠️  Local brain: knowledge.db not found (may be remote-only mode)"
fi

# Check if remote brain is configured
if [ -f "$BRAIN_DIR/config.json" ]; then
  REMOTE_URL=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    print(config.get('remote_brain', {}).get('url', ''))
except:
    print('')
" "$BRAIN_DIR/config.json" 2>/dev/null || echo "")

  if [ -n "$REMOTE_URL" ]; then
    HEALTH_URL="${REMOTE_URL%/}/health"
    if command -v curl &> /dev/null; then
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null || echo "000")
      if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✅ Remote brain: healthy (HTTP $HTTP_CODE)"
      else
        echo "   ⚠️  Remote brain: HTTP $HTTP_CODE (may not be running)"
      fi
    fi
  fi
fi

# Soft-migrate: drop vestigial features.mcp_server flag from existing configs (BR-065)
if [ -f "$BRAIN_DIR/config.json" ]; then
  python3 -c "
import json, sys
path = sys.argv[1]
try:
    with open(path, 'r') as f:
        config = json.load(f)
    if 'features' in config and isinstance(config['features'], dict):
        if config['features'].pop('mcp_server', None) is not None:
            with open(path, 'w') as f:
                json.dump(config, f, indent=2)
                f.write('\n')
except Exception:
    pass
" "$BRAIN_DIR/config.json" 2>/dev/null || true
fi

# ============================================================
# Done
# ============================================================
echo ""
echo "========================================"
echo "✅ Igris AI installed in $TARGET_DIR (global mode)"
echo "========================================"
echo ""
echo "📊 Summary:"
echo "   🌐 Global: agents, rules, skills via .claude/ symlinks to ~/.igris/core/"
echo "   📝 Project files: session, context, plans, hooks, reference"
echo "   🤖 CLAUDE.md generated with persona injection"
echo "   🗄️  Registered as: $SLUG"
if [ -n "$CLI_TARGETS" ]; then
  if include_has skills && [ "$CLI_TARGETS" != "claude" ]; then
    echo "   🔀 CLI skills synced: $CLI_TARGETS"
  fi
  if include_has hooks; then
    echo "   🪝 CLI hooks synced: $CLI_TARGETS"
  fi
fi
echo "   📦 Include: $INCLUDE_TARGETS"
echo ""
echo "📚 Getting Started:"
echo ""
echo "1. Launch Claude Code:"
echo "   $ claude"
echo ""
echo "   Igris AI will auto-initialize and show:"
echo "   - System assessment (briefs, blockers, git status)"
echo "   - Intelligent recommendations"
echo "   - Ready for your command!"
echo ""
echo "2. Core Commands:"
echo "   /hunt <brief>   - Autonomous implementation"
echo "   /scan            - Show status report"
echo "   /register        - Create brief"
echo "   /standardize     - Generate coding guidelines"
echo ""
echo "🔗 Docs: https://github.com/fiftynotai/igris-ai"
echo ""
