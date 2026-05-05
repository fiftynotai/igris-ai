#!/usr/bin/env bats
# TD-108 — igris_update.sh preservation contract (FS + DB + static source)
# Parent: TD-106 (which DELETE'd v4 ai/ assertions; this file restores
# coverage with v6-correct fixtures).

load test_helper

# ---------------------------------------------------------------------------
# Sandbox slug (generated once at file load — shared across all 3 tests)
# Prefix `td108-sandbox-` cannot collide with real project slugs.
# ---------------------------------------------------------------------------
SANDBOX_SLUG="td108-sandbox-$$-${RANDOM}"
SANDBOX_DIR="$HOME/.igris/projects/$SANDBOX_SLUG"
DB_PATH="$HOME/.igris/memory/knowledge.db"
MARKER="TD-108-MARKER-DO-NOT-OVERWRITE-$SANDBOX_SLUG"

# Sweep orphans from prior crashed runs (older than 60 min).
find "$HOME/.igris/projects" -maxdepth 1 -type d -name 'td108-sandbox-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# DB capability probe
#
# The brain DB uses two sqlite extensions that the macOS system sqlite3 (3.43)
# either disables or refuses to engage:
#   1. FTS5 triggers on `learnings_fts` — require PRAGMA trusted_schema=1 in
#      the SAME connection as the INSERT/DELETE.
#   2. vec0 virtual tables (`briefs_vec`, `learnings_vec`, `errors_vec`) and
#      their AFTER DELETE triggers — require the sqlite-vec extension to be
#      loaded via `.load`. The system sqlite3 disables `.load` entirely.
#
# Detect:
#   - A sqlite3 binary that supports `.load` (Homebrew sqlite, etc.)
#   - The sqlite-vec dylib in node_modules
# Skip Test 2 cleanly if either is unavailable. Teardown is unconditionally
# safe — uses the same probe and no-ops if not capable.
# ---------------------------------------------------------------------------
SQLITE3_BIN=""
VEC_DYLIB=""

probe_db_capability() {
  # Already probed?
  if [ -n "$SQLITE3_BIN" ] && [ -n "$VEC_DYLIB" ]; then
    return 0
  fi

  # 1. Find a sqlite3 binary that supports .load (system sqlite on macOS
  # disables it; Homebrew's does not).
  local candidates=(
    /opt/homebrew/opt/sqlite/bin/sqlite3
    /opt/homebrew/opt/sqlite3/bin/sqlite3
    /usr/local/opt/sqlite/bin/sqlite3
    /usr/local/opt/sqlite3/bin/sqlite3
    sqlite3
  )
  local cand err
  for cand in "${candidates[@]}"; do
    command -v "$cand" >/dev/null 2>&1 || continue
    err=$("$cand" :memory: ".load /nonexistent/_probe.dylib" 2>&1 || true)
    case "$err" in
      *"unknown command"*) continue ;;  # .load disabled
      *) SQLITE3_BIN="$cand"; break ;;
    esac
  done

  [ -z "$SQLITE3_BIN" ] && return 1

  # 2. Find sqlite-vec dylib in brain-mcp-server node_modules
  local repo_root="${IGRIS_ROOT:-$(pwd)}"
  local dylib_candidates=(
    "$repo_root/brain-mcp-server/node_modules/sqlite-vec-darwin-arm64/vec0.dylib"
    "$repo_root/brain-mcp-server/node_modules/sqlite-vec-darwin-x64/vec0.dylib"
    "$repo_root/brain-mcp-server/node_modules/sqlite-vec-linux-x64/vec0.so"
  )
  local d
  for d in "${dylib_candidates[@]}"; do
    if [ -f "$d" ]; then
      VEC_DYLIB="$d"
      break
    fi
  done

  [ -z "$VEC_DYLIB" ] && return 1
  return 0
}

# Run a SQL block with .load + PRAGMA trusted_schema already set.
# SQL is passed as a single string argument (not via stdin) to avoid heredoc
# nesting weirdness.
run_brain_sql() {
  local sql="$1"
  "$SQLITE3_BIN" "$DB_PATH" <<SQL
.load $VEC_DYLIB
PRAGMA trusted_schema=1;
$sql
SQL
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
snapshot_sandbox() {
  find "$SANDBOX_DIR" -type f -exec md5sum {} + 2>/dev/null | sort
}

# ---------------------------------------------------------------------------
# Per-test teardown — idempotent, safety-guarded
# ---------------------------------------------------------------------------
teardown() {
  # DB cleanup — exact-match DELETE on sandbox slug, safe to run on partial
  # seeds. No-op if DB capability is unavailable (Test 2 will have skipped
  # cleanly so nothing was inserted).
  if [ -f "$DB_PATH" ] && probe_db_capability; then
    run_brain_sql "
DELETE FROM brief_status WHERE project='$SANDBOX_SLUG';
DELETE FROM brief_files  WHERE project='$SANDBOX_SLUG';
DELETE FROM learnings    WHERE project='$SANDBOX_SLUG';
DELETE FROM projects     WHERE slug='$SANDBOX_SLUG';
" 2>/dev/null || true
  fi

  # FS cleanup — defensive case guard prevents wiping unexpected paths.
  # NON-NEGOTIABLE: without this guard, an empty/unset $SANDBOX_DIR could wipe
  # ~/.igris/projects/.
  if [ -n "${SANDBOX_DIR:-}" ] && [ -d "$SANDBOX_DIR" ]; then
    case "$SANDBOX_DIR" in
      */td108-sandbox-*) rm -rf "$SANDBOX_DIR" ;;
      *) echo "REFUSING to rm unexpected SANDBOX_DIR=$SANDBOX_DIR" >&2 ;;
    esac
  fi

  # Inherit test_helper TEST_TEMP_DIR cleanup
  if [ -n "${TEST_TEMP_DIR:-}" ] && [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# ===========================================================================
# Test 1 — FS preservation
# ===========================================================================
@test "igris_update --dry-run preserves session and brief files for active project" {
  setup_test_project
  init_igris_in_test_project

  # Seed 5 marker files (4 session + 1 briefs cache) per brief AC bullets 1+2
  mkdir -p "$SANDBOX_DIR/session" "$SANDBOX_DIR/briefs"
  echo "$MARKER" > "$SANDBOX_DIR/session/CURRENT_SESSION.md"
  echo "$MARKER" > "$SANDBOX_DIR/session/BLOCKERS.md"
  echo "$MARKER" > "$SANDBOX_DIR/session/DECISIONS.md"
  echo "$MARKER" > "$SANDBOX_DIR/session/LEARNINGS.md"
  echo "$MARKER" > "$SANDBOX_DIR/briefs/TD-108-MARKER.md"

  local before
  before=$(snapshot_sandbox)

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Sandbox must still exist and be byte-identical
  [ -d "$SANDBOX_DIR" ]
  local after
  after=$(snapshot_sandbox)
  [ "$before" = "$after" ]

  # Defensive: each seeded file still individually present
  assert_file_exists "$SANDBOX_DIR/session/CURRENT_SESSION.md"
  assert_file_exists "$SANDBOX_DIR/session/BLOCKERS.md"
  assert_file_exists "$SANDBOX_DIR/session/DECISIONS.md"
  assert_file_exists "$SANDBOX_DIR/session/LEARNINGS.md"
  assert_file_exists "$SANDBOX_DIR/briefs/TD-108-MARKER.md"
}

# ===========================================================================
# Test 2 — DB preservation
# event_log omitted: no such table in brain schema (verified against db.ts).
# Coverage: 3 tables (brief_status, brief_files, learnings) — brief AC says
# "3-4 tables" so this satisfies the contract.
# ===========================================================================
@test "igris_update --dry-run preserves brain DB rows for active project" {
  [ -f "$DB_PATH" ] || skip "brain DB not present"
  probe_db_capability || skip "sqlite3 with .load + sqlite-vec dylib unavailable (need Homebrew sqlite + brain-mcp-server node_modules)"

  setup_test_project
  init_igris_in_test_project

  # Pre-insert projects row for FK satisfaction (brief_status.project FK -> projects.slug).
  # Schema verified: slug + name + path are NOT NULL; status default 'active' is fine.
  local bf_id="td108-bf-$RANDOM"
  run_brain_sql "
INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('$SANDBOX_SLUG', 'TD-108 Sandbox', '/tmp/td108-sandbox', 'active');
INSERT INTO brief_status (project, brief_id, title, status) VALUES ('$SANDBOX_SLUG', 'TD-108-MARKER', 'TD-108 preservation test marker', 'Ready');
INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash) VALUES ('$bf_id', '$SANDBOX_SLUG', 'TD-108-MARKER', 'TD-108-MARKER.md', '$MARKER', 'sha256-stub');
INSERT INTO learnings (project, category, title, content) VALUES ('$SANDBOX_SLUG', 'pattern', 'TD-108 marker', '$MARKER');
"

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Each table: row count = 1 AND content field intact.
  # Reads use plain sqlite3 (no triggers fire on SELECT, so no extension required).
  local count title
  count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM brief_status WHERE project='$SANDBOX_SLUG' AND brief_id='TD-108-MARKER';")
  [ "$count" = "1" ]
  title=$(sqlite3 "$DB_PATH" "SELECT title FROM brief_status WHERE project='$SANDBOX_SLUG' AND brief_id='TD-108-MARKER';")
  [ "$title" = "TD-108 preservation test marker" ]

  count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM brief_files WHERE project='$SANDBOX_SLUG' AND brief_id='TD-108-MARKER';")
  [ "$count" = "1" ]
  local bf_content
  bf_content=$(sqlite3 "$DB_PATH" "SELECT content FROM brief_files WHERE project='$SANDBOX_SLUG' AND brief_id='TD-108-MARKER';")
  [ "$bf_content" = "$MARKER" ]

  count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM learnings WHERE project='$SANDBOX_SLUG' AND title='TD-108 marker';")
  [ "$count" = "1" ]
  local l_content
  l_content=$(sqlite3 "$DB_PATH" "SELECT content FROM learnings WHERE project='$SANDBOX_SLUG' AND title='TD-108 marker';")
  [ "$l_content" = "$MARKER" ]
}

# ===========================================================================
# Test 3 — Static source analysis
# ===========================================================================
@test "igris_update.sh source contains no writes to projects/ or knowledge.db" {
  local script="$SCRIPTS_DIR/igris_update.sh"

  # Disallow any sqlite3 invocation — script must never directly touch the brain DB
  run grep -nE 'sqlite3' "$script"
  if [ "$status" -eq 0 ]; then
    echo "Forbidden sqlite3 reference in update script:"
    echo "$output"
    false
  fi

  # Disallow write ops (rm/mv/cp/>/>>) targeting projects/ or knowledge.db
  # outside of echo "..." documentation strings.
  run grep -nE '^[^#]*(rm |mv |cp |>|>>)[^#]*(\.igris/projects|\.igris/memory|knowledge\.db)' "$script"

  # Filter out echo-line documentation (lines 200-203 advertise preservation)
  local hits
  hits=$(echo "$output" | grep -vE '^\s*[0-9]+:\s*echo ' || true)
  if [ -n "$hits" ]; then
    echo "Forbidden write to projects/ or knowledge.db:"
    echo "$hits"
    false
  fi
}
