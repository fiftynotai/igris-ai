#!/bin/bash

# Description: Refresh ~/.igris/ brain core files from the igris-ai source repo
# Usage: igris_brain_refresh.sh [--dry-run]
# Dependencies: python3
# Exit codes:
#   0 - Success (brain core refreshed)
#   1 - Error (brain not found, source repo invalid)

set -euo pipefail

# ============================================================
# Parse flags
# ============================================================
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--dry-run]"
      exit 2
      ;;
  esac
done

# ============================================================
# Validate brain exists
# ============================================================
BRAIN_DIR="$HOME/.igris"

if [ ! -d "$BRAIN_DIR" ]; then
  echo "Error: Igris Brain not found at $BRAIN_DIR"
  echo ""
  echo "   Run the brain bootstrap first:"
  echo "   ./scripts/igris_brain_init.sh"
  echo ""
  exit 1
fi

# ============================================================
# Resolve source repo (IGRIS_DIR)
# ============================================================
IGRIS_DIR=""

# Try reading source_repo from config.json
if [ -f "$BRAIN_DIR/config.json" ]; then
  IGRIS_DIR=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    print(config.get('source_repo', ''))
except Exception:
    print('')
" "$BRAIN_DIR/config.json" 2>/dev/null || echo "")
fi

# Fall back to relative path from this script
if [ -z "$IGRIS_DIR" ] || [ ! -d "$IGRIS_DIR" ]; then
  IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
fi

# Validate the resolved path contains version.txt
if [ ! -f "$IGRIS_DIR/version.txt" ]; then
  echo "Error: Source repo at '$IGRIS_DIR' does not contain version.txt"
  echo ""
  echo "   Ensure the igris-ai repo path is correct in ~/.igris/config.json"
  echo "   or run this script from within the igris-ai repo."
  echo ""
  exit 1
fi

IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "unknown")

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN: Brain refresh from $IGRIS_DIR (v$IGRIS_VERSION)"
  echo "========================================"
else
  echo "Refreshing brain core from $IGRIS_DIR (v$IGRIS_VERSION)"
  echo "========================================"
fi
echo ""

# ============================================================
# Counters
# ============================================================
TOTAL_COPIED=0

# Helper: count files matching a glob pattern
# Usage: count_files /path/to/dir "*.md"
count_files() {
  local dir="$1"
  local pattern="$2"
  local count=0
  for f in "$dir"/$pattern; do
    [ -e "$f" ] && count=$((count + 1))
  done
  echo "$count"
}

# ============================================================
# Refresh: Prompts
# ============================================================
if [ -d "$IGRIS_DIR/core/prompts" ]; then
  COUNT=$(count_files "$IGRIS_DIR/core/prompts" "*.md")
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT prompts -> $BRAIN_DIR/core/prompts/"
  else
    mkdir -p "$BRAIN_DIR/core/prompts"
    cp "$IGRIS_DIR/core/prompts/"*.md "$BRAIN_DIR/core/prompts/" 2>/dev/null || true
    echo "   Prompts refreshed ($COUNT files)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No prompts directory found in source repo"
fi

# ============================================================
# Refresh: Agents
# ============================================================
if [ -d "$IGRIS_DIR/core/agents" ]; then
  COUNT=$(count_files "$IGRIS_DIR/core/agents" "*.md")
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT agents -> $BRAIN_DIR/core/agents/"
  else
    mkdir -p "$BRAIN_DIR/core/agents"
    cp "$IGRIS_DIR/core/agents/"*.md "$BRAIN_DIR/core/agents/" 2>/dev/null || true
    # Also copy manifest.yaml if it exists
    [ -f "$IGRIS_DIR/core/agents/manifest.yaml" ] && cp "$IGRIS_DIR/core/agents/manifest.yaml" "$BRAIN_DIR/core/agents/"
    echo "   Agents refreshed ($COUNT files)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No agents directory found in source repo"
fi

# ============================================================
# Refresh: Skills (clear + re-copy to remove stale skills)
# ============================================================
if [ -d "$IGRIS_DIR/core/skills" ]; then
  COUNT=0
  for d in "$IGRIS_DIR/core/skills/"*/; do
    [ -d "$d" ] && COUNT=$((COUNT + 1))
  done
  if [ "$DRY_RUN" = true ]; then
    echo "   Would clear $BRAIN_DIR/core/skills/ and re-copy $COUNT skill directories"
  else
    mkdir -p "$BRAIN_DIR/core/skills"
    # Clear existing skills to remove stale copies
    rm -rf "$BRAIN_DIR/core/skills/"*
    # Re-copy all skill directories
    cp -r "$IGRIS_DIR/core/skills/"* "$BRAIN_DIR/core/skills/" 2>/dev/null || true
    echo "   Skills refreshed ($COUNT directories, stale copies cleared)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No skills directory found in source repo"
fi

# ============================================================
# Refresh: Rules
# ============================================================
if [ -d "$IGRIS_DIR/core/rules" ]; then
  COUNT=$(count_files "$IGRIS_DIR/core/rules" "*.md")
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT rules -> $BRAIN_DIR/core/rules/"
  else
    mkdir -p "$BRAIN_DIR/core/rules"
    cp "$IGRIS_DIR/core/rules/"*.md "$BRAIN_DIR/core/rules/" 2>/dev/null || true
    echo "   Rules refreshed ($COUNT files)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No rules directory found in source repo"
fi

# ============================================================
# Refresh: Templates
# ============================================================
if [ -d "$IGRIS_DIR/core/templates" ]; then
  COUNT=$(count_files "$IGRIS_DIR/core/templates" "*.md")
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT templates -> $BRAIN_DIR/core/templates/"
  else
    mkdir -p "$BRAIN_DIR/core/templates"
    cp "$IGRIS_DIR/core/templates/"*.md "$BRAIN_DIR/core/templates/" 2>/dev/null || true
    echo "   Templates refreshed ($COUNT files)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No templates directory found in source repo"
fi

# ============================================================
# Refresh: SOUL.md
# ============================================================
if [ -f "$IGRIS_DIR/core/SOUL.md" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy SOUL.md -> $BRAIN_DIR/core/SOUL.md"
  else
    cp "$IGRIS_DIR/core/SOUL.md" "$BRAIN_DIR/core/" 2>/dev/null || true
    echo "   SOUL.md refreshed"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + 1))
fi

# ============================================================
# Refresh: igris_tree.json
# ============================================================
if [ -f "$IGRIS_DIR/core/igris_tree.json" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy igris_tree.json -> $BRAIN_DIR/core/igris_tree.json"
  else
    cp "$IGRIS_DIR/core/igris_tree.json" "$BRAIN_DIR/core/" 2>/dev/null || true
    echo "   igris_tree.json refreshed"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + 1))
fi

# ============================================================
# Refresh: Task Handlers
# ============================================================
if [ -d "$IGRIS_DIR/core/task-handlers" ]; then
  COUNT=0
  for f in "$IGRIS_DIR/core/task-handlers/"*; do
    [ -e "$f" ] && COUNT=$((COUNT + 1))
  done
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT task-handlers -> $BRAIN_DIR/core/task-handlers/"
  else
    mkdir -p "$BRAIN_DIR/core/task-handlers"
    cp -r "$IGRIS_DIR/core/task-handlers/"* "$BRAIN_DIR/core/task-handlers/" 2>/dev/null || true
    echo "   Task handlers refreshed ($COUNT items)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No task-handlers directory found in source repo"
fi

# ============================================================
# Refresh: Hooks (shared scripts + per-CLI bridges)
# ------------------------------------------------------------
# The hook tree is the source of truth for ~/.igris/core/hooks/. Mirror the
# layout verbatim (shared/*.sh, shared/post_tool_use.d/*.sh, bridges/*.sh,
# bridges/opencode/*.ts). Files under the source repo are populated into the
# brain so per-CLI adapters (install_claude_hooks.sh / install_opencode_hooks.sh
# / install_codex_hooks.sh) find the scripts they reference on a fresh install.
# Executable bits are restored via chmod after copy because `cp` may not carry
# them across filesystems.
# ============================================================
if [ -d "$IGRIS_DIR/core/hooks" ]; then
  COUNT=0
  # shellcheck disable=SC2044  # globbing `find` is fine; names come from our repo.
  for f in $(find "$IGRIS_DIR/core/hooks" -type f 2>/dev/null); do
    [ -e "$f" ] && COUNT=$((COUNT + 1))
  done
  if [ "$DRY_RUN" = true ]; then
    echo "   Would copy $COUNT hook files -> $BRAIN_DIR/core/hooks/"
  else
    mkdir -p "$BRAIN_DIR/core/hooks"
    cp -r "$IGRIS_DIR/core/hooks/"* "$BRAIN_DIR/core/hooks/" 2>/dev/null || true
    # Restore executable bits on all shell scripts. The .ts OpenCode plugin is
    # read by Bun — no +x required. `2>/dev/null || true` because empty globs
    # on older bash return non-zero.
    chmod +x "$BRAIN_DIR/core/hooks/shared/"*.sh 2>/dev/null || true
    chmod +x "$BRAIN_DIR/core/hooks/shared/post_tool_use.d/"*.sh 2>/dev/null || true
    chmod +x "$BRAIN_DIR/core/hooks/bridges/"*.sh 2>/dev/null || true
    echo "   Hooks refreshed ($COUNT files)"
  fi
  TOTAL_COPIED=$((TOTAL_COPIED + COUNT))
else
  echo "   No hooks directory found in source repo"
fi

# ============================================================
# Verify global symlinks (~/.claude/ -> ~/.igris/core/)
# ============================================================
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "   Would verify global symlinks in ~/.claude/"
else
  echo "Verifying global symlinks..."
  CLAUDE_DIR="$HOME/.claude"
  GLOBAL_OK=0
  GLOBAL_FIXED=0
  GLOBAL_WARN=0

  for symlink_type in agents skills rules; do
    local_link="$CLAUDE_DIR/$symlink_type"
    expected_target="$BRAIN_DIR/core/$symlink_type"

    if [ -L "$local_link" ]; then
      current_target=$(readlink "$local_link")
      if [ "$current_target" = "$expected_target" ]; then
        echo "   ✅ $symlink_type: OK"
        GLOBAL_OK=$((GLOBAL_OK + 1))
      else
        echo "   ⚠️  $symlink_type: points to '$current_target' (expected '$expected_target')"
        GLOBAL_WARN=$((GLOBAL_WARN + 1))
      fi
    elif [ -d "$local_link" ]; then
      echo "   ⚠️  $symlink_type: real directory at $local_link (not a symlink)"
      GLOBAL_WARN=$((GLOBAL_WARN + 1))
    elif [ ! -e "$local_link" ]; then
      # Missing — recreate
      if [ -d "$expected_target" ]; then
        mkdir -p "$CLAUDE_DIR"
        ln -s "$expected_target" "$local_link"
        echo "   ✅ $symlink_type: recreated symlink"
        GLOBAL_FIXED=$((GLOBAL_FIXED + 1))
      else
        echo "   ⚠️  $symlink_type: brain core directory missing at $expected_target"
        GLOBAL_WARN=$((GLOBAL_WARN + 1))
      fi
    fi
  done

  echo "   Global symlinks: $GLOBAL_OK ok, $GLOBAL_FIXED fixed, $GLOBAL_WARN warnings"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "========================================"
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN complete. $TOTAL_COPIED items would be refreshed."
  echo "Run without --dry-run to apply changes."
else
  echo "Brain core refreshed. $TOTAL_COPIED items updated."
  echo "Global symlinks verified. All projects see the latest versions."
fi
echo "========================================"
