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
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "4.0.0")

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

mkdir -p ai/context
mkdir -p ai/masks
mkdir -p ai/prompts
mkdir -p ai/templates
mkdir -p .claude/hooks
mkdir -p scripts

# Create brain cache directories for this project
CACHE_DIR="$HOME/.igris/cache/$(basename "$TARGET_DIR")"
mkdir -p "$CACHE_DIR/session"
mkdir -p "$CACHE_DIR/briefs"
mkdir -p "$CACHE_DIR/metrics"

# Create worker and output directories (idempotent)
mkdir -p "$HOME/.igris/logs/worker"
mkdir -p "$HOME/.igris/output/content"
mkdir -p "$HOME/.igris/output/social-media"
mkdir -p "$HOME/.igris/output/media-gen"
mkdir -p "$HOME/.igris/output/research"
mkdir -p "$HOME/.igris/output/operational"

echo "   ✅ Project directories created"
echo "   ✅ Brain cache at $CACHE_DIR"
echo "   ✅ Worker and output directories created"

# ============================================================
# Linking prompts and templates (agents/rules/skills are global)
# ============================================================
echo ""
echo "🔗 Linking prompts and templates..."
echo "   (agents, rules, and skills are handled globally via ~/.claude/)"

SYMLINK_COUNT=0

# Prompts: symlink individual files
if [ -d "$BRAIN_DIR/core/prompts" ]; then
  for f in "$BRAIN_DIR/core/prompts/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" "ai/prompts/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Prompts linked"
fi

# Templates: symlink individual files
if [ -d "$BRAIN_DIR/core/templates" ]; then
  for f in "$BRAIN_DIR/core/templates/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" "ai/templates/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Templates linked"
fi

echo "   📊 Total symlinks: $SYMLINK_COUNT (prompts + templates only)"

# ============================================================
# Create project-local session files (fresh templates, not symlinks)
# ============================================================
echo ""
echo "📝 Creating project-local files..."

# CURRENT_SESSION.md
if [ ! -f "$CACHE_DIR/session/CURRENT_SESSION.md" ]; then
  cat > "$CACHE_DIR/session/CURRENT_SESSION.md" << 'EOF'
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
if [ ! -f "$CACHE_DIR/session/BLOCKERS.md" ]; then
  cat > "$CACHE_DIR/session/BLOCKERS.md" << 'EOF'
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
if [ ! -f "$CACHE_DIR/session/DECISIONS.md" ]; then
  cat > "$CACHE_DIR/session/DECISIONS.md" << 'EOF'
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
if [ ! -f "$CACHE_DIR/session/LEARNINGS.md" ]; then
  cat > "$CACHE_DIR/session/LEARNINGS.md" << 'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF
  echo "   ✅ LEARNINGS.md created (in cache)"
else
  echo "   ⚠️  LEARNINGS.md already exists (skipping)"
fi

# Context README
if [ ! -f "ai/context/README.md" ]; then
  cat > ai/context/README.md << 'EOF'
# Architecture Context

This directory should contain project-specific architecture documentation:

- **architecture_map.md** - Architecture pattern, layer boundaries, module structure
- **api_pattern.md** - API call patterns, state management, error handling
- **coding_guidelines.md** - Naming conventions, doc-comments, linting rules
- **module_catalog.md** - Module inventory, purposes, dependencies

## How to Generate

Use the DOCUMENT command to have IGRIS analyze your project and create these files:

```
DOCUMENT architecture
```

The /document skill will ask questions about your architecture and generate comprehensive documentation.
EOF
  echo "   ✅ context/README.md created"
else
  echo "   ⚠️  context/README.md already exists (skipping)"
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
if [ -f "SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "SOUL.md")
elif [ -f "$IGRIS_DIR/SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "$IGRIS_DIR/SOUL.md")
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

# ============================================================
# Done
# ============================================================
echo ""
echo "========================================"
echo "✅ Igris AI installed in $TARGET_DIR (global mode)"
echo "========================================"
echo ""
echo "📊 Summary:"
echo "   🌐 Global: agents, rules, skills via ~/.claude/ (shared across all projects)"
echo "   🔗 Project symlinks: $SYMLINK_COUNT (prompts + templates only)"
echo "   📝 Project files: session, context, CLAUDE.md"
echo "   🗄️  Registered as: $SLUG"
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
