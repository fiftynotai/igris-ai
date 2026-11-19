#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# session_end_hook.test.bash - Tests for core/hooks/shared/session_end.sh's
# FR-274 knowledge-watermark side effect.
#
# The hook's contract under test (H1-H5 and H7; the plan's H6 — exit 0 and
# EMPTY stdout in every case — is asserted inside each test, not as its own):
#   - H1 a registered git repo + an `igris` on PATH: the hook records the row
#     path's HEAD SHA and branch (read back from the DB, not trusted from output).
#   - H2 an unregistered directory: nothing is written (the FR-212c gate).
#   - H3 no `igris` on PATH: exit 0, no stderr, the stored watermark unchanged.
#   - H4 a registered NON-git directory: the stored watermark unchanged.
#   - H5 fired from a SUBDIRECTORY: the slug is the gate's resolved slug and the
#     ROW path's HEAD is recorded (never basename(cwd)).
#   - H7 a hung `igris` killed by the harness still leaves the detached
#     perception spawn done: `record_watermark` runs LAST (warden B2).
#
# Sandboxing: HOME=$SANDBOX/home and IGRIS_BRAIN_DIR=$HOME/.igris (the gate
# hardcodes $HOME/.igris/memory/knowledge.db; the CLI honours IGRIS_BRAIN_DIR).
# PATH is REBUILT from /usr/bin:/bin plus a sandbox bin, so the operator's global
# `igris` is never reachable; the sandbox `igris` is a shim onto THIS checkout's
# cli/dist. No CURRENT_SESSION.md is seeded, so the hook's deregister step never
# curls, and no perception extractor exists under the sandbox HOME.

load test_helper

HOOK_REL="core/hooks/shared/session_end.sh"

setup() {
  HOOK="$IGRIS_ROOT/$HOOK_REL"
  [ -f "$HOOK" ] || skip "hook missing at $HOOK"
  CLI_ENTRY="$IGRIS_ROOT/cli/dist/index.js"
  [ -f "$CLI_ENTRY" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  NODE_BIN="$(command -v node)" || skip "node not available"

  SANDBOX="$(mkdir -p "$TEST_TEMP_DIR/session_end_$BATS_TEST_NUMBER" && cd "$TEST_TEMP_DIR/session_end_$BATS_TEST_NUMBER" && pwd -P)"
  mkdir -p "$SANDBOX/home/.igris/memory" "$SANDBOX/bin" "$SANDBOX/nobin"
  DB="$SANDBOX/home/.igris/memory/knowledge.db"

  # The sandbox `igris`: this checkout's built CLI, nothing global.
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$CLI_ENTRY" > "$SANDBOX/bin/igris"
  chmod +x "$SANDBOX/bin/igris"

  # Git fixture hygiene (row 158): a scratch global config, no system config.
  export GIT_CONFIG_GLOBAL="$SANDBOX/gitconfig"
  export GIT_CONFIG_NOSYSTEM=1
  printf '[user]\n\tname = fr274\n\temail = fr274@igris.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"

  # The brain core projects CREATE + projects:1 + projects:2, verbatim.
  sqlite3 "$DB" "
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '', igris_version TEXT DEFAULT '4.0.0',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now')), last_session_at TEXT,
      metadata TEXT DEFAULT '{}', archetype TEXT DEFAULT 'unclassified');
    ALTER TABLE projects ADD COLUMN repo_url TEXT;
    ALTER TABLE projects ADD COLUMN knowledge_sha TEXT;
    ALTER TABLE projects ADD COLUMN knowledge_branch TEXT;
    ALTER TABLE projects ADD COLUMN knowledge_recorded_at TEXT;"
}

# make_repo <dir> — two commits, checked out on feature/wm. Echoes nothing.
make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "${repo:?}" init -q
  echo one > "$repo/one.txt"; git -C "${repo:?}" add -A; git -C "${repo:?}" commit -q -m one
  git -C "${repo:?}" checkout -q -b feature/wm
  echo two > "$repo/two.txt"; git -C "${repo:?}" add -A; git -C "${repo:?}" commit -q -m two
}

# register <slug> <path> — a projects row carrying a SEEDED watermark.
register() {
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path, knowledge_sha, knowledge_branch, knowledge_recorded_at)
    VALUES ('$1', '$1', '$2', '$(printf 'e%.0s' $(seq 1 40))', 'seeded', '2026-01-01 00:00:00');"
}

triple() {
  sqlite3 "$DB" "SELECT knowledge_sha || '|' || COALESCE(knowledge_branch, 'NULL') || '|' || knowledge_recorded_at FROM projects WHERE slug = '$1';"
}

# fire <cwd> <path-mode: with|without> — run the hook with a Claude-shaped
# stdin payload; stdout and stderr land in separate files for H6.
fire() {
  local cwd="$1" mode="$2" path_env="/usr/bin:/bin"
  [ "$mode" = "with" ] && path_env="$SANDBOX/bin:/usr/bin:/bin"
  [ "$mode" = "without" ] && path_env="$SANDBOX/nobin:/usr/bin:/bin"
  printf '{"session_id":"s","reason":"exit","cwd":"%s"}' "$cwd" \
    | env -i HOME="$SANDBOX/home" IGRIS_BRAIN_DIR="$SANDBOX/home/.igris" PATH="$path_env" \
        GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
        bash "$HOOK" > "$SANDBOX/out" 2> "$SANDBOX/err"
}

@test "H1 (AC1): a registered repo — the hook records the row path's HEAD and branch; stdout empty" {
  make_repo "$SANDBOX/proj"
  register wmproj "$SANDBOX/proj"
  run fire "$SANDBOX/proj" with
  [ "$status" -eq 0 ]
  [ ! -s "$SANDBOX/out" ]
  sha="$(git -C "${SANDBOX:?}/proj" rev-parse HEAD)"
  got="$(triple wmproj)"
  echo "got=$got sha=$sha"
  [ "${got%%|*}" = "$sha" ]
  rest="${got#*|}"
  [ "${rest%%|*}" = "feature/wm" ]
  [ "${got##*|}" != "2026-01-01 00:00:00" ]
}

@test "H2: an unregistered directory — nothing is written, exit 0, stdout empty" {
  make_repo "$SANDBOX/proj"
  make_repo "$SANDBOX/other"
  register wmproj "$SANDBOX/proj"
  before="$(sqlite3 "$DB" 'SELECT * FROM projects')"
  run fire "$SANDBOX/other" with
  [ "$status" -eq 0 ]
  [ ! -s "$SANDBOX/out" ]
  [ "$(sqlite3 "$DB" 'SELECT * FROM projects')" = "$before" ]
}

@test "H3: no igris on PATH — exit 0, no stderr, the stored watermark unchanged" {
  make_repo "$SANDBOX/proj"
  register wmproj "$SANDBOX/proj"
  before="$(triple wmproj)"
  run fire "$SANDBOX/proj" without
  [ "$status" -eq 0 ]
  [ ! -s "$SANDBOX/out" ]
  [ ! -s "$SANDBOX/err" ]
  [ "$(triple wmproj)" = "$before" ]
}

@test "H4 (AC2): a registered NON-git directory — the stored watermark unchanged, exit 0" {
  mkdir -p "$SANDBOX/plain"
  register plain "$SANDBOX/plain"
  before="$(triple plain)"
  run fire "$SANDBOX/plain" with
  [ "$status" -eq 0 ]
  [ ! -s "$SANDBOX/out" ]
  [ "$(triple plain)" = "$before" ]
}

@test "H5: fired from a SUBDIRECTORY — the gate's slug, the ROW path's HEAD" {
  make_repo "$SANDBOX/proj"
  mkdir -p "$SANDBOX/proj/deep/er"
  register wmproj "$SANDBOX/proj"
  run fire "$SANDBOX/proj/deep/er" with
  [ "$status" -eq 0 ]
  [ ! -s "$SANDBOX/out" ]
  sha="$(git -C "${SANDBOX:?}/proj" rev-parse HEAD)"
  got="$(triple wmproj)"
  [ "${got%%|*}" = "$sha" ]
  # No row was minted for basename(cwd).
  [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM projects WHERE slug = 'er'")" = "0" ]
}

@test "H7 (warden B2): a hung igris cannot cost the detached perception spawn — the spawn happens first" {
  make_repo "$SANDBOX/proj"
  register wmproj "$SANDBOX/proj"
  # A stand-in perception wrapper: executable, so the hook spawns it; it only
  # leaves a marker. And an `igris` that hangs, like a slow or wedged CLI.
  mkdir -p "$SANDBOX/home/.igris/core/hooks/shared" "$SANDBOX/hangbin"
  printf '#!/bin/bash\ncat >/dev/null\necho spawned > "%s/perception.marker"\n' "$SANDBOX" \
    > "$SANDBOX/home/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  chmod +x "$SANDBOX/home/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  printf '#!/bin/sh\necho $$ > "%s/igris.pid"\nexec sleep 8\n' "$SANDBOX" > "$SANDBOX/hangbin/igris"
  chmod +x "$SANDBOX/hangbin/igris"
  # The harness kills the hook after 2 s (perl alarm: macOS ships no timeout(1)).
  printf '{"session_id":"s","reason":"exit","cwd":"%s"}' "$SANDBOX/proj" \
    | env -i HOME="$SANDBOX/home" IGRIS_BRAIN_DIR="$SANDBOX/home/.igris" \
        PATH="$SANDBOX/hangbin:/usr/bin:/bin" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
        perl -e 'alarm 2; exec @ARGV' bash "$HOOK" > "$SANDBOX/out" 2> "$SANDBOX/err" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -f "$SANDBOX/perception.marker" ] && break
    sleep 0.3
  done
  [ -f "$SANDBOX/igris.pid" ] && kill "$(cat "$SANDBOX/igris.pid")" 2>/dev/null || true
  [ -f "$SANDBOX/perception.marker" ]
  # The static twin: in main(), the perception spawn line precedes record_watermark.
  spawn_line="$(grep -n 'perception_extract_and_persist.sh" "$slug" "session_end"' "$HOOK" | head -1 | cut -d: -f1)"
  call_line="$(awk '/^main\(\)/{m=1} m && /^[[:space:]]*record_watermark /{print NR; exit}' "$HOOK")"
  [ -n "$spawn_line" ] && [ -n "$call_line" ]
  [ "$spawn_line" -lt "$call_line" ]
}
