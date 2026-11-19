#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# doctor.bats — integration tests for `igris doctor`. End-to-end drift
# classification + --fix + --remove-orphans confirmation flow.

load _helpers.bash

# FR-212d: doctor now reads GLOBAL brain-level state (~/.claude/settings.json
# for hooks, ~/.claude.json for the brain MCP, harness config perms). To keep
# the exit-code assertions HERMETIC (not coupled to the dev's real ~/.claude/),
# every test runs under a sandboxed HOME seeded with a clean baseline:
#   - ~/.claude/settings.json carrying the canonical Igris hooks (no hooks-missing)
#   - ~/.claude.json with a valid igris-brain MCP entry at 600 (no mcp-unregistered)
#   - ~/.igris/config.json with cli_targets:{} (bridge-missing opt-out)
# Tests that want a drift to fire mutate this sandbox in their own body.
#
# `os.homedir()` honors $HOME on this platform, so exporting HOME redirects every
# brain-level read into the sandbox. The brain dir stays IGRIS_BRAIN_DIR (tmp).
setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
  export SANDBOX_HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$SANDBOX_HOME/.claude"
  # Valid global Igris hooks (mirrors the stub canonical-settings.json).
  printf '%s\n' "$STUB_CANONICAL_HOOKS" > "$SANDBOX_HOME/.claude/settings.json"
  # Valid igris-brain MCP entry pointing at a real on-disk file (600 so the
  # secret-perms class doesn't flag it).
  : > "$SANDBOX_HOME/fake-mcp.js"
  cat > "$SANDBOX_HOME/.claude.json" <<EOF
{ "mcpServers": { "igris-brain": { "type": "stdio", "command": "node", "args": ["$SANDBOX_HOME/fake-mcp.js"], "env": {} } } }
EOF
  chmod 600 "$SANDBOX_HOME/.claude.json"
  # Explicit bridge-missing opt-out (the staged ~/.claude/ would otherwise make
  # detectInstalledCLIs flag a real `claude` on PATH).
  cat > "$IGRIS_BRAIN_DIR/config.json" <<EOF
{ "version": "7.0.0", "cli_targets": {} }
EOF
  chmod 600 "$IGRIS_BRAIN_DIR/config.json"
  export HOME="$SANDBOX_HOME"
}

@test "doctor exits 0 on clean registry" {
  PROJ="$(stage_project clean)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 0 ]
}

@test "doctor exits 1 when the GLOBAL settings.json is missing the Igris hooks block (TD-100 silent-failure, FR-212d)" {
  # FR-212d: the TD-100 silent-failure class is GLOBAL now — overwrite the
  # staged-valid global hooks with a settings file lacking the Igris hooks so the
  # brain-level hooks-missing row fires.
  cat > "$HOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "hooks-missing" ]]
}

@test "doctor --fix repairs hooks-missing by refreshing the GLOBAL hooks (FR-212d)" {
  # FR-212d: hooks-missing is a brain-level row read from the GLOBAL
  # ~/.claude/settings.json (sandboxed by setup()). Overwrite the staged-valid
  # global hooks with a settings file LACKING the Igris hooks so the row fires,
  # then assert `--fix` re-merges the canonical Igris hooks into the global file.
  cat > "$HOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
  # The fix refreshes the GLOBAL ~/.claude/settings.json (the live hooks surface).
  [ -f "$HOME/.claude/settings.json" ]
  run python3 -c "import json,sys; d=json.load(open('$HOME/.claude/settings.json')); print(d['hooks']['SessionEnd'][0]['hooks'][0]['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "\$HOME/.igris/core/hooks/shared/session_end.sh" ]
}

@test "doctor --remove-orphans --yes deletes ghost-path rows" {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('ghost1','ghost1','/no/such/dir/abc','7.0.0');
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('ghost2','ghost2','/no/such/dir/def','7.0.0');
  "
  run $CLI_BIN doctor --remove-orphans --yes
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects;"
  [ "$output" = "0" ]
}

@test "doctor surfaces multi-slug-at-one-path (fifty_eco_system triple-slug case)" {
  PROJ="$(stage_project shared)"
  run $CLI_BIN install --slug slug-a "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug slug-b "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug slug-c "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "duplicate-path" ]]
}

@test "doctor --remove-orphans prompt advertises the new [y/N/a/all] label (TD-111)" {
  # Seed one orphan row, pipe 'y\n' on stdin so the prompt fires exactly
  # once and we capture the label literal in the same combined stdout/stderr.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('label-orphan','label-orphan','/no/such/dir/label-orphan','7.0.0');
  "
  # readline writes the prompt to stdout; we send 'y' on stdin to consume it.
  run bash -c "printf 'y\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  [ "$status" -eq 0 ]
  # The literal new label must appear; the legacy `[y/N/a/Y/A]` must not.
  [[ "$output" == *"[y/N/a/all]"* ]]
  [[ "$output" != *"[y/N/a/Y/A]"* ]]
}

@test "doctor handles paths with spaces (TD-100 ghost path)" {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('spaces','spaces','/var/folders/abc/project with spaces','7.0.0');
  "
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "path-missing" ]]
}

@test "doctor --fix: bridge-missing + hooks-missing both fixed in one pass (TD-122)" {
  # TD-122: pre-fix the bridge-missing arm `break`'d, skipping all drift rows
  # after it. Post-fix, the loop continues. FR-212d: `not-installed` was retired
  # (register-only), so the "second class after bridge-missing" is now the
  # brain-level global hooks-missing fix. We stage:
  #   1. a fake `claude` binary on PATH + ~/.claude/ config dir (no Igris hooks),
  #      so detectInstalledCLIs returns claude AND the global hooks-missing fires
  #   2. an ~/.igris/config.json with non-empty cli_targets that LACKS claude —
  #      the bridge-missing condition
  # After `doctor --fix`, BOTH should be repaired in a single invocation.

  # Stage a non-empty cli_targets that LACKS claude (a CLI in our catalog).
  # The detector treats this as bridge-missing iff claude is detected.
  cat > "$IGRIS_BRAIN_DIR/config.json" <<EOF
{ "version": "7.0.0", "cli_targets": { "codex": "ignored" } }
EOF

  # Fake claude on PATH: a stub executable in a temp dir we prepend.
  FAKEPATH="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKEPATH"
  cat > "$FAKEPATH/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$FAKEPATH/claude"

  # Fake HOME with a ~/.claude/ config dir (so claude is "detected") but a
  # settings.json that LACKS the Igris hooks (so the global hooks-missing row
  # fires). detect-cli walks `homedir() + ".claude"`; the global hooks check
  # reads `~/.claude/settings.json`.
  FAKEHOME="$BATS_TEST_TMPDIR/fakehome"
  mkdir -p "$FAKEHOME/.claude"
  cat > "$FAKEHOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF

  # Run --fix with the staged env. We tolerate non-zero exit (the bridge-fix arm
  # calls runInit which talks to GitHub releases — out of scope for this minimal
  # fixture). The TD-122 contract is that BOTH fix arms fire in one invocation —
  # pre-fix the bridge-missing arm `break`'d, so the later arm was unreachable.
  HOME="$FAKEHOME" PATH="$FAKEPATH:$PATH" run $CLI_BIN doctor --fix 2>&1
  # The smoking gun: both arms emitted their fix-attempt log lines. If `break`
  # ever returns to the bridge-missing arm (TD-122 regression), the global-hooks
  # refresh message will not appear.
  [[ "$output" =~ "bridge-missing for claude" ]]
  # FR-212d: the second class after bridge-missing is the brain-level global
  # hooks-missing fix.
  [[ "$output" =~ "refreshing the GLOBAL Igris hooks" ]]
}

# ---- BR-087 / TD-310: an honest sweep over an ownership-aware registry -------
#
# Fixture: the `_helpers.bash` `projects` shape plus a minimal `learnings` and a
# `brief_status` that carries the live FK to `projects(slug)`, so the counts the
# sweep shows (and the refusals it makes) come from real rows. `learnings` has
# NO FK, which is the point of T3: before TD-310, `--yes` deleted a row that
# owned only learnings without a word.
#
# Bash hygiene (test_standards conv. 7): every `[[ ]]` assertion carries
# `|| return 1`; nothing pipes a producer into `grep -q`.
seed_registry() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      FOREIGN KEY (project) REFERENCES projects(slug)
    );
  "
}

# orphan_row <slug> [name] [tech_stack] — a row whose path does not exist.
orphan_row() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" \
    "INSERT INTO projects (slug, name, path, tech_stack, igris_version) VALUES ('$1','${2:-$1}','/no/such/dir/$1','${3:-}','7.0.0');"
}

# own_learnings <slug> <n> / own_briefs <slug> <n>
own_learnings() {
  local i
  for ((i = 0; i < $2; i++)); do
    sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "INSERT INTO learnings (project) VALUES ('$1');"
  done
}
own_briefs() {
  local i
  for ((i = 0; i < $2; i++)); do
    sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "INSERT INTO brief_status (project, brief_id) VALUES ('$1','FX-$i');"
  done
}

project_count() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects;"
}

project_slugs() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT group_concat(slug, ',') FROM (SELECT slug FROM projects ORDER BY slug);"
}

@test "BR-087 B1: FEWER answers than rows — the unanswered row is not adjudicated and the verb exits 1" {
  # The `printf 'y\n'` pipe above (TD-111) pipes exactly as many answers as
  # rows, which is the count that hid this: the second prompt never resolved
  # and the verb exited 0 with a path-missing row still present.
  seed_registry
  orphan_row aa-orphan
  orphan_row bb-orphan
  run bash -c "printf 'y\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_count)" = "1" ]
  [[ "$output" == *"not adjudicated: bb-orphan"* ]] || return 1
}

@test "BR-087 B2: every piped answer is consumed — two rows, two 'y', both removed, exit 0" {
  seed_registry
  orphan_row aa-orphan
  orphan_row bb-orphan
  run bash -c "printf 'y\ny\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  echo "$output"
  [ "$(project_count)" = "0" ]
  [ "$status" -eq 0 ]
}

@test "BR-087 B3: a declined row ('n') is unresolved drift — kept, named, exit 1" {
  seed_registry
  orphan_row aa-orphan
  run bash -c "printf 'n\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_count)" = "1" ]
  [[ "$output" == *"kept (declined): aa-orphan"* ]] || return 1
}

@test "BR-087 B4: an abort ('a') leaves every remaining row unadjudicated — both named, exit 1" {
  seed_registry
  orphan_row aa-orphan
  orphan_row bb-orphan
  run bash -c "printf 'a\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_count)" = "2" ]
  [[ "$output" == *"not adjudicated: aa-orphan"* ]] || return 1
  [[ "$output" == *"not adjudicated: bb-orphan"* ]] || return 1
}

@test "BR-087 B5: an EMPTY stdin is not a decision — exit 1, row kept" {
  seed_registry
  orphan_row aa-orphan
  run bash -c "$CLI_BIN doctor --remove-orphans </dev/null 2>&1"
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_count)" = "1" ]
  [[ "$output" == *"not adjudicated: aa-orphan"* ]] || return 1
}

@test "TD-310 T1: an orphan's brief and learning counts are shown BEFORE any prompt" {
  seed_registry
  orphan_row owner
  own_briefs owner 1
  own_learnings owner 2
  run bash -c "printf 'n\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  echo "$output"
  # The drift table (printed before the sweep starts) carries the counts, and
  # it precedes the first prompt label.
  [[ "$output" == *"| owner | /no/such/dir/owner | path-missing | briefs 1, learnings 2"*"[y/N/a/all]"* ]] || return 1
  # ...and so does the prompt line itself.
  [[ "$output" == *"orphan (briefs 1, learnings 2); delete? [y/N/a/all]"* ]] || return 1
  [ "$(project_count)" = "1" ]
}

@test "TD-310 T2: --empty-only deletes exactly the rows that own nothing, never prompts" {
  seed_registry
  orphan_row e-empty
  orphan_row l-learn
  own_learnings l-learn 1
  orphan_row b-brief
  own_briefs b-brief 1
  run bash -c "$CLI_BIN doctor --remove-orphans --empty-only </dev/null 2>&1"
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_slugs)" = "b-brief,l-learn" ]
  [[ "$output" == *"removed: e-empty"* ]] || return 1
  [[ "$output" == *"kept: l-learn (owns briefs 0, learnings 1)"* ]] || return 1
  [[ "$output" == *"kept: b-brief (owns briefs 1, learnings 0)"* ]] || return 1
  [[ "$output" != *"[y/N/a/all]"* ]] || return 1
}

@test "TD-310 T3: --yes alone refuses a row that owns only learnings (no FK to stop it)" {
  seed_registry
  orphan_row l-learn
  own_learnings l-learn 1
  orphan_row e-empty
  run $CLI_BIN doctor --remove-orphans --yes
  echo "$output"
  [ "$status" -eq 1 ]
  [ "$(project_slugs)" = "l-learn" ]
  [[ "$output" == *"refused: l-learn — owns briefs 0, learnings 1"* ]] || return 1
  [[ "$output" == *"removed: e-empty"* ]] || return 1
  # The learning itself is untouched either way.
  [ "$(sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM learnings;")" = "1" ]
}

@test "TD-310 T3b (control): --yes --include-owning removes the same row — the refusal is the flag, not the FK" {
  seed_registry
  orphan_row l-learn
  own_learnings l-learn 1
  orphan_row e-empty
  run $CLI_BIN doctor --remove-orphans --yes --include-owning
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(project_count)" = "0" ]
  [[ "$output" == *"removed: l-learn"* ]] || return 1
}

@test "TD-310 T4: a moved project is offered a re-point, and following it keeps the curated name and tech stack" {
  seed_registry
  orphan_row moved-proj "Moved Project" "dart,flutter"
  own_learnings moved-proj 1
  run $CLI_BIN doctor
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"moved → igris register-project <new-path> --slug moved-proj"* ]] || return 1
  NEW_PATH="${BATS_TEST_TMPDIR:?}/moved-proj"
  mkdir -p "${NEW_PATH:?}"
  run $CLI_BIN register-project "$NEW_PATH" --slug moved-proj
  echo "$output"
  [ "$status" -eq 0 ]
  row="$(sqlite3 -separator '|' "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT path, name, tech_stack FROM projects WHERE slug='moved-proj';")"
  echo "row: $row"
  [ "$row" = "$NEW_PATH|Moved Project|dart,flutter" ]
  run $CLI_BIN doctor
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "TD-310 T5: --slug narrows the sweep to one row" {
  seed_registry
  orphan_row aa
  orphan_row bb
  run $CLI_BIN doctor --remove-orphans --slug aa --yes
  echo "$output"
  [ "$(project_slugs)" = "bb" ]
  [[ "$output" == *"removed: aa"* ]] || return 1
}

@test "TD-310 T6: knowledge whose project row is gone is REPORTED, never deleted" {
  seed_registry
  KEEP="$(stage_project keep)"
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" \
    "INSERT INTO projects (slug, name, path, igris_version) VALUES ('keep','keep','$KEEP','7.0.0');"
  own_learnings keep 1
  # Self-negative: every learning belongs to a registered row -> no dangling line.
  run $CLI_BIN doctor --remove-orphans --yes
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"dangling knowledge"* ]] || return 1
  own_learnings gone 1
  run $CLI_BIN doctor --remove-orphans --yes
  echo "$output"
  [[ "$output" == *"dangling knowledge (no registry row): gone — briefs 0, learnings 1"* ]] || return 1
  [ "$(sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM learnings WHERE project='gone';")" = "1" ]
}

@test "TD-310 T7: invalid flag combinations are usage errors — exit 1, nothing swept" {
  seed_registry
  orphan_row aa
  local args
  for args in "--empty-only" "--slug aa" "--include-owning" \
              "--remove-orphans --include-owning" \
              "--remove-orphans --yes --empty-only --include-owning"; do
    run bash -c "$CLI_BIN doctor $args </dev/null 2>&1"
    echo "[$args] $output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"usage:"* ]] || return 1
    [ "$(project_count)" = "1" ]
  done
}
