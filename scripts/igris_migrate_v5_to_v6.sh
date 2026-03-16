#!/bin/bash
set -e

# Description: Migrates an Igris AI v5 installation to v6.
#              Handles path changes, rules consolidation, new v6 files,
#              symlink setup, config update, and DB path updates.
# Usage: igris_migrate_v5_to_v6.sh [--dry-run] [--force]
#   --dry-run  Show what would be done without making changes
#   --force    Skip confirmation prompts
# Dependencies: sqlite3, python3 (or jq)
# Exit codes:
#   0 - Migration completed successfully
#   1 - Migration failed or aborted

# ============================================================
# Configuration
# ============================================================

BRAIN_DIR="$HOME/.igris"
CORE_DIR="$BRAIN_DIR/core"
DB_PATH="$BRAIN_DIR/memory/knowledge.db"
CONFIG_PATH="$BRAIN_DIR/config.json"
IGRIS_DIR="${IGRIS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

DRY_RUN=false
FORCE=false
ERRORS=0

# ============================================================
# Parse Arguments
# ============================================================

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
    -h|--help)
      echo "Usage: igris_migrate_v5_to_v6.sh [--dry-run] [--force]"
      echo ""
      echo "Migrates Igris AI v5 installation to v6."
      echo ""
      echo "Options:"
      echo "  --dry-run  Show what would be done without making changes"
      echo "  --force    Skip confirmation prompts"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ============================================================
# Helpers
# ============================================================

log_info() {
  echo "  [info] $1"
}

log_ok() {
  echo "  [ok] $1"
}

log_skip() {
  echo "  [skip] $1"
}

log_warn() {
  echo "  [warn] $1" >&2
}

log_error() {
  echo "  [ERROR] $1" >&2
  ERRORS=$((ERRORS + 1))
}

log_action() {
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] Would: $1"
  else
    echo "  [action] $1"
  fi
}

confirm() {
  if [ "$FORCE" = true ] || [ "$DRY_RUN" = true ]; then
    return 0
  fi
  printf "\n  %s (y/n) " "$1"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Read JSON value using jq or python3
json_get() {
  local file="$1"
  local key="$2"
  if command -v jq &> /dev/null; then
    jq -r "$key" "$file" 2>/dev/null || echo ""
  else
    python3 -c "
import json, sys
with open('$file') as f:
    data = json.load(f)
keys = '$key'.strip('.').split('.')
for k in keys:
    data = data.get(k, {}) if isinstance(data, dict) else ''
print(data if isinstance(data, str) else '')
" 2>/dev/null || echo ""
  fi
}

# ============================================================
# Pre-flight Checks
# ============================================================

preflight() {
  echo ""
  echo "========================================"
  echo " Igris AI — v5 → v6 Migration"
  echo "========================================"
  echo ""

  if [ "$DRY_RUN" = true ]; then
    echo "  MODE: DRY RUN (no changes will be made)"
    echo ""
  fi

  # Check brain exists
  if [ ! -d "$BRAIN_DIR" ]; then
    echo "  ERROR: No Igris brain found at $BRAIN_DIR" >&2
    echo "  Run igris_brain_init.sh first to create a fresh v6 installation." >&2
    exit 1
  fi

  # Check source repo
  if [ ! -d "$IGRIS_DIR/core" ]; then
    echo "  ERROR: Igris source repo not found at $IGRIS_DIR/core" >&2
    echo "  Set IGRIS_DIR or run from the igris-ai repository." >&2
    exit 1
  fi

  # Detect current version
  local current_version="unknown"
  if [ -f "$CONFIG_PATH" ]; then
    current_version=$(json_get "$CONFIG_PATH" ".version")
    [ -z "$current_version" ] && current_version="unknown"
  fi

  echo "  Current brain version: $current_version"
  echo "  Source repo: $IGRIS_DIR"
  echo "  Brain directory: $BRAIN_DIR"
  echo ""

  # Check if already v6
  if [ "$current_version" = "6.0.0" ]; then
    # Verify v6 structure is intact
    local v6_ok=true
    [ ! -f "$CORE_DIR/igris_tree.json" ] && v6_ok=false
    [ ! -f "$CORE_DIR/rules/00-igris-universal.md" ] && v6_ok=false
    [ ! -d "$BRAIN_DIR/projects" ] && v6_ok=false

    if [ "$v6_ok" = true ] && [ "$FORCE" != true ]; then
      echo "  Already running v6.0.0 with intact structure."
      echo "  Use --force to re-run migration anyway."
      exit 0
    fi
  fi

  # Detect v5 indicators
  echo "  Detecting v5 artifacts..."
  local v5_detected=false

  if [ -d "$BRAIN_DIR/cache" ] && [ ! -L "$BRAIN_DIR/cache" ]; then
    log_info "Found: ~/.igris/cache/ directory (v5 data location)"
    v5_detected=true
  fi

  if [ -f "$CORE_DIR/rules/01-igris-init.md" ]; then
    log_info "Found: Old rules 01-05 in core/rules/"
    v5_detected=true
  fi

  if [ -d "$BRAIN_DIR/staging" ]; then
    log_info "Found: ~/.igris/staging/ directory (deprecated)"
    v5_detected=true
  fi

  if [ -d "$BRAIN_DIR/personas" ]; then
    log_info "Found: ~/.igris/personas/ directory (deprecated)"
    v5_detected=true
  fi

  if [ "$v5_detected" = false ] && [ "$current_version" != "6.0.0" ]; then
    log_info "No v5 artifacts found but version is not 6.0.0"
    log_info "Will update version and ensure v6 structure"
  fi

  echo ""
}

# ============================================================
# Step 1: Migrate cache/ → projects/
# ============================================================

migrate_cache_to_projects() {
  echo "Step 1: Migrate cache/ → projects/"
  echo "----------------------------------------"

  # Case 1: cache/ is already a symlink to projects/ (already migrated)
  if [ -L "$BRAIN_DIR/cache" ]; then
    local target
    target=$(readlink "$BRAIN_DIR/cache")
    if echo "$target" | grep -q "projects"; then
      log_skip "cache/ is already a symlink to projects/"
      return
    fi
  fi

  # Case 2: cache/ doesn't exist, projects/ does (already v6)
  if [ ! -e "$BRAIN_DIR/cache" ] && [ -d "$BRAIN_DIR/projects" ]; then
    log_action "Creating backward-compat symlink: cache → projects"
    if [ "$DRY_RUN" = false ]; then
      ln -sf "$BRAIN_DIR/projects" "$BRAIN_DIR/cache"
    fi
    log_ok "Symlink created"
    return
  fi

  # Case 3: cache/ doesn't exist, projects/ doesn't exist (fresh)
  if [ ! -e "$BRAIN_DIR/cache" ] && [ ! -d "$BRAIN_DIR/projects" ]; then
    log_action "Creating projects/ directory"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$BRAIN_DIR/projects"
      ln -sf "$BRAIN_DIR/projects" "$BRAIN_DIR/cache"
    fi
    log_ok "Created projects/ with cache symlink"
    return
  fi

  # Case 4: cache/ is a real directory with data (v5 → v6 migration needed)
  if [ -d "$BRAIN_DIR/cache" ] && [ ! -L "$BRAIN_DIR/cache" ]; then
    local project_count
    project_count=$(find "$BRAIN_DIR/cache" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    log_info "Found $project_count project(s) in cache/"

    if [ -d "$BRAIN_DIR/projects" ]; then
      # Both exist — merge
      log_action "Merging cache/ into existing projects/"
      if [ "$DRY_RUN" = false ]; then
        for proj_dir in "$BRAIN_DIR/cache"/*/; do
          [ ! -d "$proj_dir" ] && continue
          local proj_name
          proj_name=$(basename "$proj_dir")
          local dest="$BRAIN_DIR/projects/$proj_name"
          if [ -d "$dest" ]; then
            # Merge: copy only files that don't exist in projects/
            rsync -a --ignore-existing "$proj_dir" "$dest/"
            log_ok "Merged $proj_name (preserved existing files in projects/)"
          else
            mv "$proj_dir" "$dest"
            log_ok "Moved $proj_name to projects/"
          fi
        done
        # Remove old cache dir and create symlink
        rm -rf "$BRAIN_DIR/cache"
        ln -sf "$BRAIN_DIR/projects" "$BRAIN_DIR/cache"
      fi
    else
      # Simple rename
      log_action "Renaming cache/ → projects/ (${project_count} projects)"
      if [ "$DRY_RUN" = false ]; then
        mv "$BRAIN_DIR/cache" "$BRAIN_DIR/projects"
        ln -sf "$BRAIN_DIR/projects" "$BRAIN_DIR/cache"
      fi
    fi
    log_ok "Data migrated, backward-compat symlink created"
  fi

  echo ""
}

# ============================================================
# Step 2: Ensure project directory structure (v6 subdirs)
# ============================================================

ensure_project_structure() {
  echo "Step 2: Ensure v6 project directory structure"
  echo "----------------------------------------"

  if [ ! -d "$BRAIN_DIR/projects" ]; then
    log_skip "No projects directory found"
    echo ""
    return
  fi

  for proj_dir in "$BRAIN_DIR/projects"/*/; do
    [ ! -d "$proj_dir" ] && continue
    local proj_name
    proj_name=$(basename "$proj_dir")
    [ "$proj_name" = "metrics" ] && continue  # Skip global metrics dir

    local created=""
    for subdir in context session briefs plans hooks reference; do
      if [ ! -d "$proj_dir/$subdir" ]; then
        log_action "Creating $proj_name/$subdir/"
        if [ "$DRY_RUN" = false ]; then
          mkdir -p "$proj_dir/$subdir"
        fi
        created="$created $subdir"
      fi
    done

    if [ -n "$created" ]; then
      log_ok "$proj_name: created$created"
    else
      log_skip "$proj_name: all v6 subdirs exist"
    fi
  done

  echo ""
}

# ============================================================
# Step 3: Consolidate rules (01-05 → 00-igris-universal)
# ============================================================

consolidate_rules() {
  echo "Step 3: Consolidate rules"
  echo "----------------------------------------"

  local rules_dir="$CORE_DIR/rules"

  # Check for old rules
  local old_rules_found=false
  for i in 01 02 03 04 05; do
    if ls "$rules_dir"/${i}-*.md &>/dev/null; then
      old_rules_found=true
      break
    fi
  done

  if [ "$old_rules_found" = true ]; then
    log_action "Removing old rules 01-05"
    if [ "$DRY_RUN" = false ]; then
      for i in 01 02 03 04 05; do
        rm -f "$rules_dir"/${i}-*.md
      done
    fi
    log_ok "Old rules removed"
  else
    log_skip "No old rules 01-05 found"
  fi

  # Ensure universal rule exists
  if [ ! -f "$rules_dir/00-igris-universal.md" ]; then
    log_action "Copying 00-igris-universal.md from source repo"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$rules_dir"
      cp "$IGRIS_DIR/core/rules/00-igris-universal.md" "$rules_dir/"
    fi
    log_ok "Universal rule installed"
  else
    log_skip "00-igris-universal.md already present"
  fi

  echo ""
}

# ============================================================
# Step 4: Update core files (igris_tree.json, task-handlers, agents)
# ============================================================

update_core_files() {
  echo "Step 4: Update core files to v6"
  echo "----------------------------------------"

  # igris_tree.json
  if [ -f "$IGRIS_DIR/core/igris_tree.json" ]; then
    log_action "Copying igris_tree.json"
    if [ "$DRY_RUN" = false ]; then
      cp "$IGRIS_DIR/core/igris_tree.json" "$CORE_DIR/igris_tree.json"
    fi
    log_ok "igris_tree.json installed"
  else
    log_error "igris_tree.json not found in source repo!"
  fi

  # Task handlers
  if [ -d "$IGRIS_DIR/core/task-handlers" ]; then
    log_action "Copying task-handlers/"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CORE_DIR/task-handlers"
      cp -r "$IGRIS_DIR/core/task-handlers/"* "$CORE_DIR/task-handlers/" 2>/dev/null || true
    fi
    log_ok "Task handlers installed"
  fi

  # Agents (v6 tree-routed versions)
  if [ -d "$IGRIS_DIR/core/agents" ]; then
    log_action "Updating agent definitions to v6"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CORE_DIR/agents"
      for agent in "$IGRIS_DIR/core/agents"/*.md; do
        [ ! -f "$agent" ] && continue
        cp "$agent" "$CORE_DIR/agents/"
      done
      # Also copy manifest if exists
      [ -f "$IGRIS_DIR/core/agents/manifest.yaml" ] && cp "$IGRIS_DIR/core/agents/manifest.yaml" "$CORE_DIR/agents/"
    fi
    log_ok "Agent definitions updated"
  fi

  # Skills
  if [ -d "$IGRIS_DIR/core/skills" ]; then
    log_action "Updating skills"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CORE_DIR/skills"
      rsync -a --delete "$IGRIS_DIR/core/skills/" "$CORE_DIR/skills/"
    fi
    log_ok "Skills updated"
  fi

  # Prompts
  if [ -d "$IGRIS_DIR/core/prompts" ]; then
    log_action "Updating prompts"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CORE_DIR/prompts"
      cp "$IGRIS_DIR/core/prompts/"*.md "$CORE_DIR/prompts/" 2>/dev/null || true
    fi
    log_ok "Prompts updated"
  fi

  # Templates
  if [ -d "$IGRIS_DIR/core/templates" ]; then
    log_action "Updating templates"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CORE_DIR/templates"
      cp "$IGRIS_DIR/core/templates/"* "$CORE_DIR/templates/" 2>/dev/null || true
    fi
    log_ok "Templates updated"
  fi

  # SOUL.md
  if [ -f "$IGRIS_DIR/core/SOUL.md" ]; then
    log_action "Updating SOUL.md"
    if [ "$DRY_RUN" = false ]; then
      cp "$IGRIS_DIR/core/SOUL.md" "$CORE_DIR/SOUL.md"
    fi
    log_ok "SOUL.md updated"
  fi

  echo ""
}

# ============================================================
# Step 5: Clean up deprecated directories
# ============================================================

cleanup_deprecated() {
  echo "Step 5: Clean up deprecated v5 artifacts"
  echo "----------------------------------------"

  # Staging directory
  if [ -d "$BRAIN_DIR/staging" ]; then
    log_action "Removing ~/.igris/staging/ (deprecated)"
    if [ "$DRY_RUN" = false ]; then
      rm -rf "$BRAIN_DIR/staging"
    fi
    log_ok "Removed staging/"
  else
    log_skip "No staging/ directory"
  fi

  # Personas directory
  if [ -d "$BRAIN_DIR/personas" ]; then
    log_action "Removing ~/.igris/personas/ (deprecated — persona is SOUL.md only)"
    if [ "$DRY_RUN" = false ]; then
      rm -rf "$BRAIN_DIR/personas"
    fi
    log_ok "Removed personas/"
  else
    log_skip "No personas/ directory"
  fi

  echo ""
}

# ============================================================
# Step 6: Update config.json
# ============================================================

update_config() {
  echo "Step 6: Update config.json"
  echo "----------------------------------------"

  if [ ! -f "$CONFIG_PATH" ]; then
    log_warn "No config.json found — skipping"
    echo ""
    return
  fi

  log_action "Updating version and paths in config.json"
  if [ "$DRY_RUN" = false ]; then
    python3 << 'PYEOF'
import json
import os
import sys

config_path = os.path.expanduser("~/.igris/config.json")

try:
    with open(config_path) as f:
        config = json.load(f)
except Exception as e:
    print(f"  [ERROR] Failed to read config.json: {e}", file=sys.stderr)
    sys.exit(0)  # Don't fail migration for config issues

# Update version
old_version = config.get("version", "unknown")
config["version"] = "6.0.0"

# Update paths
config["paths"] = {
    "brain": "~/.igris",
    "core": "~/.igris/core",
    "memory": "~/.igris/memory",
    "projects": "~/.igris/projects"
}

# Remove deprecated path keys
config["paths"].pop("staging", None)

try:
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    print(f"  [ok] Version: {old_version} → 6.0.0")
    print(f"  [ok] Paths updated (staging → projects)")
except Exception as e:
    print(f"  [ERROR] Failed to write config.json: {e}", file=sys.stderr)
PYEOF
  fi

  echo ""
}

# ============================================================
# Step 7: Update DB project paths
# ============================================================

update_db_paths() {
  echo "Step 7: Update database"
  echo "----------------------------------------"

  if [ ! -f "$DB_PATH" ]; then
    log_warn "No knowledge.db found — skipping"
    echo ""
    return
  fi

  # Check for stale cache paths in project registry
  local stale_count
  stale_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM projects WHERE path LIKE '%/.igris/cache/%';" 2>/dev/null || echo "0")

  if [ "$stale_count" -gt 0 ]; then
    log_action "Updating $stale_count project path(s): cache/ → projects/"
    if [ "$DRY_RUN" = false ]; then
      sqlite3 "$DB_PATH" "UPDATE projects SET path = REPLACE(path, '/.igris/cache/', '/.igris/projects/') WHERE path LIKE '%/.igris/cache/%';" 2>/dev/null
    fi
    log_ok "DB paths updated"
  else
    log_skip "No stale cache/ paths in DB"
  fi

  # Update version in .igris_version file if it exists
  if [ -f "$BRAIN_DIR/.igris_version" ]; then
    log_action "Updating .igris_version to 6.0.0"
    if [ "$DRY_RUN" = false ]; then
      echo "6.0.0" > "$BRAIN_DIR/.igris_version"
    fi
    log_ok ".igris_version updated"
  fi

  echo ""
}

# ============================================================
# Step 8: Set up .claude/ symlinks for registered projects
# ============================================================

setup_project_symlinks() {
  echo "Step 8: Update .claude/ symlinks in registered projects"
  echo "----------------------------------------"

  if [ ! -f "$DB_PATH" ]; then
    log_warn "No knowledge.db — skipping project symlinks"
    echo ""
    return
  fi

  local projects
  projects=$(sqlite3 "$DB_PATH" "SELECT slug, path FROM projects WHERE status = 'active';" 2>/dev/null) || true

  if [ -z "$projects" ]; then
    log_skip "No active projects in DB"
    echo ""
    return
  fi

  echo "$projects" | while IFS='|' read -r slug proj_path; do
    # Skip if project directory doesn't exist
    if [ ! -d "$proj_path" ]; then
      log_skip "$slug: directory not found ($proj_path)"
      continue
    fi

    local claude_dir="$proj_path/.claude"

    # Ensure .claude directory exists
    if [ ! -d "$claude_dir" ]; then
      log_skip "$slug: no .claude/ directory"
      continue
    fi

    # Set up agent symlinks
    local agents_dir="$claude_dir/agents"
    if [ -d "$agents_dir" ]; then
      local needs_update=false
      # Check if any agent is NOT a symlink (copy-based v5)
      for agent in "$agents_dir"/*.md; do
        [ ! -f "$agent" ] && continue
        if [ ! -L "$agent" ]; then
          needs_update=true
          break
        fi
        # Check if symlink points to wrong location
        local link_target
        link_target=$(readlink "$agent")
        if ! echo "$link_target" | grep -q "/.igris/core/agents/"; then
          needs_update=true
          break
        fi
      done

      if [ "$needs_update" = true ]; then
        log_action "$slug: Converting agents to symlinks → ~/.igris/core/agents/"
        if [ "$DRY_RUN" = false ]; then
          for agent_src in "$CORE_DIR/agents"/*.md; do
            [ ! -f "$agent_src" ] && continue
            local agent_name
            agent_name=$(basename "$agent_src")
            rm -f "$agents_dir/$agent_name"
            ln -sf "$agent_src" "$agents_dir/$agent_name"
          done
        fi
        log_ok "$slug: agents symlinked"
      else
        log_skip "$slug: agents already symlinked"
      fi
    fi

    # Set up rules symlinks
    local rules_dir="$claude_dir/rules"
    if [ -d "$rules_dir" ]; then
      # Remove old v5 rules
      local old_removed=false
      for i in 01 02 03 04 05; do
        if ls "$rules_dir"/${i}-*.md &>/dev/null; then
          log_action "$slug: Removing old rule files from .claude/rules/"
          if [ "$DRY_RUN" = false ]; then
            rm -f "$rules_dir"/${i}-*.md
          fi
          old_removed=true
        fi
      done

      # Ensure universal rule symlink
      if [ ! -L "$rules_dir/00-igris-universal.md" ]; then
        log_action "$slug: Symlinking universal rule"
        if [ "$DRY_RUN" = false ]; then
          rm -f "$rules_dir/00-igris-universal.md"
          ln -sf "$CORE_DIR/rules/00-igris-universal.md" "$rules_dir/00-igris-universal.md"
        fi
        log_ok "$slug: rules updated"
      elif [ "$old_removed" = true ]; then
        log_ok "$slug: old rules removed, universal rule already symlinked"
      else
        log_skip "$slug: rules already v6"
      fi
    fi

    # Set up skills symlinks
    local skills_dir="$claude_dir/skills"
    if [ -d "$skills_dir" ] && [ -d "$CORE_DIR/skills" ]; then
      local skill_needs_update=false
      # Quick check: are skills symlinks to ~/.igris/core/skills/?
      for skill in "$skills_dir"/*/; do
        [ ! -d "$skill" ] && continue
        if [ ! -L "${skill%/}" ]; then
          skill_needs_update=true
          break
        fi
      done

      if [ "$skill_needs_update" = true ]; then
        log_action "$slug: Converting skills to symlinks → ~/.igris/core/skills/"
        if [ "$DRY_RUN" = false ]; then
          for skill_src in "$CORE_DIR/skills"/*/; do
            [ ! -d "$skill_src" ] && continue
            local skill_name
            skill_name=$(basename "$skill_src")
            rm -rf "$skills_dir/$skill_name"
            ln -sf "${skill_src%/}" "$skills_dir/$skill_name"
          done
        fi
        log_ok "$slug: skills symlinked"
      else
        log_skip "$slug: skills already symlinked (or none found)"
      fi
    fi

  done

  echo ""
}

# ============================================================
# Step 9: Verification
# ============================================================

verify() {
  echo "Step 9: Verification"
  echo "----------------------------------------"

  local checks_passed=0
  local checks_total=0

  # Check projects dir
  checks_total=$((checks_total + 1))
  if [ -d "$BRAIN_DIR/projects" ]; then
    log_ok "~/.igris/projects/ exists"
    checks_passed=$((checks_passed + 1))
  else
    log_error "~/.igris/projects/ missing!"
  fi

  # Check cache symlink
  checks_total=$((checks_total + 1))
  if [ -L "$BRAIN_DIR/cache" ]; then
    log_ok "~/.igris/cache → projects symlink exists"
    checks_passed=$((checks_passed + 1))
  else
    log_error "~/.igris/cache symlink missing!"
  fi

  # Check igris_tree.json
  checks_total=$((checks_total + 1))
  if [ -f "$CORE_DIR/igris_tree.json" ]; then
    log_ok "igris_tree.json present"
    checks_passed=$((checks_passed + 1))
  else
    log_error "igris_tree.json missing!"
  fi

  # Check universal rule
  checks_total=$((checks_total + 1))
  if [ -f "$CORE_DIR/rules/00-igris-universal.md" ]; then
    log_ok "00-igris-universal.md present"
    checks_passed=$((checks_passed + 1))
  else
    log_error "00-igris-universal.md missing!"
  fi

  # Check no old rules
  checks_total=$((checks_total + 1))
  if ! ls "$CORE_DIR/rules"/01-*.md &>/dev/null; then
    log_ok "No old v5 rules in core/rules/"
    checks_passed=$((checks_passed + 1))
  else
    log_error "Old v5 rules still present in core/rules/!"
  fi

  # Check config version
  checks_total=$((checks_total + 1))
  if [ -f "$CONFIG_PATH" ]; then
    local ver
    ver=$(json_get "$CONFIG_PATH" ".version")
    if [ "$ver" = "6.0.0" ]; then
      log_ok "config.json version is 6.0.0"
      checks_passed=$((checks_passed + 1))
    else
      log_error "config.json version is '$ver' (expected 6.0.0)"
    fi
  else
    log_warn "No config.json to verify"
    checks_passed=$((checks_passed + 1))
  fi

  # Check no deprecated dirs
  checks_total=$((checks_total + 1))
  if [ ! -d "$BRAIN_DIR/staging" ] && [ ! -d "$BRAIN_DIR/personas" ]; then
    log_ok "No deprecated directories"
    checks_passed=$((checks_passed + 1))
  else
    log_warn "Deprecated directories still exist"
  fi

  # Check SOUL.md
  checks_total=$((checks_total + 1))
  if [ -f "$CORE_DIR/SOUL.md" ]; then
    log_ok "SOUL.md present in core/"
    checks_passed=$((checks_passed + 1))
  else
    log_warn "SOUL.md not found in core/"
  fi

  echo ""
  echo "  Verification: $checks_passed/$checks_total checks passed"
  echo ""
}

# ============================================================
# Main
# ============================================================

main() {
  preflight

  if [ "$DRY_RUN" = false ]; then
    if ! confirm "Proceed with v5 → v6 migration?"; then
      echo "  Aborted."
      exit 0
    fi
    echo ""
  fi

  migrate_cache_to_projects
  ensure_project_structure
  consolidate_rules
  update_core_files
  cleanup_deprecated
  update_config
  update_db_paths
  setup_project_symlinks

  if [ "$DRY_RUN" = false ]; then
    verify
  fi

  echo "========================================"
  if [ "$DRY_RUN" = true ]; then
    echo " Dry run complete. No changes were made."
    echo " Run without --dry-run to apply changes."
  elif [ "$ERRORS" -gt 0 ]; then
    echo " Migration completed with $ERRORS error(s)."
    echo " Review errors above and fix manually."
  else
    echo " Migration to v6.0.0 complete!"
    echo ""
    echo " Next steps:"
    echo "   1. Start a new Claude Code session (rules reload on start)"
    echo "   2. Run /scan to verify system status"
    echo "   3. Run /awaken to test full initialization"
  fi
  echo "========================================"
}

main "$@"
