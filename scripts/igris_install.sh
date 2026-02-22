#!/bin/bash

# Description: Per-project symlink installer for the centralized ~/.igris/ brain
# Usage: igris_install.sh [target-directory]
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success (project installed and registered)
#   1 - Error (brain not found, invalid directory)

set -euo pipefail

echo "🔗 Igris AI - Project Installer (Symlink Mode)"
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
# Create project-local directories
# ============================================================
echo "📦 Creating project directories..."

mkdir -p ai/briefs
mkdir -p ai/session/archive
mkdir -p ai/context
mkdir -p ai/masks
mkdir -p ai/prompts
mkdir -p ai/templates
mkdir -p .claude/agents
mkdir -p .claude/hooks
mkdir -p .claude/rules
mkdir -p .claude/skills
mkdir -p scripts

echo "   ✅ Project directories created"

# ============================================================
# Create symlinks: Agents
# ============================================================
echo ""
echo "🔗 Creating symlinks..."

SYMLINK_COUNT=0

# Agents: symlink individual .md files
if [ -d "$BRAIN_DIR/core/agents" ]; then
  for f in "$BRAIN_DIR/core/agents/"*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" ".claude/agents/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  # Also symlink manifest.yaml if it exists
  if [ -f "$BRAIN_DIR/core/agents/manifest.yaml" ]; then
    ln -sf "$BRAIN_DIR/core/agents/manifest.yaml" ".claude/agents/manifest.yaml"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  fi
  echo "   ✅ Agents linked"
fi

# ============================================================
# Create symlinks: Rules
# ============================================================
if [ -d "$BRAIN_DIR/core/rules" ]; then
  for f in "$BRAIN_DIR/core/rules/"*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" ".claude/rules/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Rules linked"
fi

# ============================================================
# Create symlinks: Prompts
# ============================================================
if [ -d "$BRAIN_DIR/core/prompts" ]; then
  for f in "$BRAIN_DIR/core/prompts/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" "ai/prompts/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Prompts linked"
fi

# ============================================================
# Create symlinks: Templates
# ============================================================
if [ -d "$BRAIN_DIR/core/templates" ]; then
  for f in "$BRAIN_DIR/core/templates/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    ln -sf "$f" "ai/templates/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Templates linked"
fi

# ============================================================
# Create symlinks: Skills (directory-level, skip existing)
# ============================================================
if [ -d "$BRAIN_DIR/core/skills" ]; then
  for d in "$BRAIN_DIR/core/skills/"*/; do
    [ -d "$d" ] || continue
    DIRNAME=$(basename "$d")
    # Skip if local skill already exists (project-specific override)
    if [ -d ".claude/skills/$DIRNAME" ] && [ ! -L ".claude/skills/$DIRNAME" ]; then
      echo "   ⚠️  Skipping skill '$DIRNAME' (local override exists)"
      continue
    fi
    ln -sf "$d" ".claude/skills/$DIRNAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "   ✅ Skills linked"
fi

echo "   📊 Total symlinks: $SYMLINK_COUNT"

# ============================================================
# Create project-local session files (fresh templates, not symlinks)
# ============================================================
echo ""
echo "📝 Creating project-local files..."

# CURRENT_SESSION.md
if [ ! -f "ai/session/CURRENT_SESSION.md" ]; then
  cat > ai/session/CURRENT_SESSION.md << 'EOF'
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
  echo "   ✅ CURRENT_SESSION.md created"
else
  echo "   ⚠️  CURRENT_SESSION.md already exists (skipping)"
fi

# BLOCKERS.md
if [ ! -f "ai/session/BLOCKERS.md" ]; then
  cat > ai/session/BLOCKERS.md << 'EOF'
# Active Blockers

**Last Updated:** N/A

---

[No active blockers]
EOF
  echo "   ✅ BLOCKERS.md created"
else
  echo "   ⚠️  BLOCKERS.md already exists (skipping)"
fi

# DECISIONS.md
if [ ! -f "ai/session/DECISIONS.md" ]; then
  cat > ai/session/DECISIONS.md << 'EOF'
# Architectural Decisions

**Last Updated:** N/A

---

[No decisions recorded yet]
EOF
  echo "   ✅ DECISIONS.md created"
else
  echo "   ⚠️  DECISIONS.md already exists (skipping)"
fi

# LEARNINGS.md
if [ ! -f "ai/session/LEARNINGS.md" ]; then
  cat > ai/session/LEARNINGS.md << 'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF
  echo "   ✅ LEARNINGS.md created"
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

# Archive README
if [ ! -f "ai/session/archive/README.md" ]; then
  cat > ai/session/archive/README.md << 'EOF'
# Session Archive

Completed sessions are archived here for reference.

## Naming Convention

`YYYY-MM-DD-NNN.md` where NNN is a session number for that day.

Example: `2025-10-13-001.md`
EOF
  echo "   ✅ archive/README.md created"
fi

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
python3 -c "
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA busy_timeout = 5000')
db.execute('INSERT OR IGNORE INTO projects (slug, name, path) VALUES (?, ?, ?)',
           (sys.argv[2], sys.argv[2], sys.argv[3]))
db.commit()
db.close()
" "$BRAIN_DIR/memory/knowledge.db" "$SLUG" "$TARGET_DIR"

echo "   ✅ Project registered: $SLUG"

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
    'install_mode': 'symlink',
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
# Optional dashboard setup
# ============================================================
echo ""
echo "🖥️  Dashboard Setup (Optional)"
echo "--------------------------------"

DASHBOARD_DIR="$IGRIS_DIR/dashboard"

if [ -d "$DASHBOARD_DIR" ] && [ -f "$DASHBOARD_DIR/server.py" ]; then
  if [ -t 0 ]; then
    echo "   Crimson Arena dashboard is available for local development."
    echo ""
    read -rp "   Set up dashboard for local use? [y/N]: " SETUP_DASHBOARD
    SETUP_DASHBOARD=${SETUP_DASHBOARD:-N}

    if [[ "$SETUP_DASHBOARD" =~ ^[Yy]$ ]]; then
      DASH_TARGET="$BRAIN_DIR/dashboard"
      mkdir -p "$DASH_TARGET/static"

      cp "$DASHBOARD_DIR/server.py" "$DASH_TARGET/"
      if [ -d "$DASHBOARD_DIR/static" ]; then
        cp -r "$DASHBOARD_DIR/static/"* "$DASH_TARGET/static/" 2>/dev/null || true
      fi

      echo "   ✅ Dashboard files copied to $DASH_TARGET"
      echo ""
      echo "   To run locally:"
      echo "   cd $DASH_TARGET && python3 -m uvicorn server:app --port 8001"
      echo ""
      echo "   Required Python packages:"
      echo "   pip3 install fastapi 'uvicorn[standard]' httpx aiosqlite"
    else
      echo "   Skipping dashboard setup."
    fi
  else
    echo "   (Non-interactive mode: skipping dashboard setup)"
  fi
else
  echo "   Dashboard not found in source repo (skipping)."
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
echo "✅ Igris AI installed in $TARGET_DIR (symlink mode)"
echo "========================================"
echo ""
echo "📊 Summary:"
echo "   🔗 Symlinks created: $SYMLINK_COUNT"
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
