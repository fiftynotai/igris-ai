#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# review_model_gate.test.bash — FR-277 (AC6). The reviewer != author check:
#   the checker  core/scripts/cli-adapters/model_tier.sh review
#   the L2 gate  scripts/git-hooks/commit-msg  (§4)
#
# RED-FIRST, ON A REAL BRIEF (coding_guidelines §18.11)
# -----------------------------------------------------
# test/fixtures/review-model/FR-267.md is `brief_files.content` for the
# igris-ai brief FR-267, byte-for-byte, and FR-267.events.tsv is every one of
# its agent_events rows: its latest warden stop row and its forger rows all
# read `inherit:claude-fable-5` — a real review on the author's model. RM-RED
# reproduces the refusal in a sandboxed brain; RM-RED's self-negative deletes
# §4 from a copy of the hook and the same world exits 0. TD-497.md/.tsv is the
# GREEN twin (warden `sonnet`, forger `inherit:claude-opus-5-5`).
#
#   RM-RED  real snapshot: hook exit 1, VERDICT=EQUAL; self-negative exits 0
#   RM-GREEN real GREEN snapshot: exit 0, silent
#   RM-CX   synthetic inherit:gpt-6.1-sol on both: exit 0, EQUAL_UNPROJECTED
#           printed; mutation: PROJECTED including openai refuses it
#   RM-D    warden requested opus, resolved claude-sonnet-5-5-20261001; forger
#           opus: PASS (resolved wins)
#   RM-U1/U2/U3 no forger / `inherit:` empty / foo vs bar: exit 0,
#           "UNKNOWN (not a pass)"; mutation: UNKNOWN as a silent pass
#   RM-O1   orchestrator opus, warden opus: EQUAL
#   RM-L1   warden round 1 equal, round 2 different: PASS; mutation: first row
#   RM-N1   no warden rows: silent, exit 0 (S9)
#   RM-B1/B2 the bypass; independence both ways with §2/§3 (the G6 pattern)
#   RM-F1-4 no DB / no table / no checker in either location / unreadable DB:
#           exit 0; WARN only on unreadable. RM-F3b: the runtime-mirror checker
#   RM-P/Q  rows under another project are ignored; project `it's-proj` works
#           through bound parameters
#   NZ      the checker direct, one pair per case
#
# Sandbox copied from test/agent_event_gate.test.bash; the real brain is never
# opened. Every sed mutation proves it landed.

load test_helper

ROLES="$IGRIS_ROOT/core/scripts/brief_agent_log_roles.sh"
AC_CHECK="$IGRIS_ROOT/core/scripts/brief_ac_check.sh"
ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"
FIXTURES="$IGRIS_ROOT/test/fixtures/review-model"

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  unset IGRIS_ADAPTER_COMMON_SOURCED

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/rmg.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  SCRATCH="$SANDBOX/scratch"
  mkdir -p "$SCRATCH"
  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  make_repo
  MSG_FILE="$SANDBOX/COMMIT_EDITMSG"
  make_db "$DB"
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  cleanup_test_temp_dir
}

# make_repo — $REPO as a git repo carrying the parsers and the checker.
make_repo() {
  mkdir -p "$REPO/core/scripts/cli-adapters"
  git -C "${REPO:?}" init -q
  git -C "${REPO:?}" config user.email t@t.t
  git -C "${REPO:?}" config user.name t
  cp "$ROLES" "$REPO/core/scripts/brief_agent_log_roles.sh"
  cp "$AC_CHECK" "$REPO/core/scripts/brief_ac_check.sh"
  cp "$ADAPTERS/model_tier.sh" "$ADAPTERS/_common.sh" "$REPO/core/scripts/cli-adapters/"
}

make_db() {
  sqlite3 "$1" "
    CREATE TABLE brief_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, filename TEXT, content TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL, agent TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('start','stop','error','retry')),
      phase TEXT, brief_id TEXT, duration_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_create INTEGER,
      result TEXT, error_message TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model_requested TEXT, model_resolved TEXT,
      round INTEGER NOT NULL DEFAULT 1, project TEXT
    );
  "
}

# seed_snapshot <ID> — the fixture's brief content and every events row, the
# igris-ai project rewritten to the sandbox project.
seed_snapshot() {
  python3 - "$DB" "$PROJECT" "$1" "$FIXTURES/$1.md" "$FIXTURES/$1.events.tsv" <<'PY'
import sqlite3, sys
db, project, bid, md, tsv = sys.argv[1:6]
con = sqlite3.connect(db)
con.execute("INSERT INTO brief_files (project, brief_id, filename, content) VALUES (?,?,?,?)",
            (project, bid, bid + ".md", open(md, encoding="utf-8").read()))
rows = open(tsv, encoding="utf-8").read().splitlines()[1:]
for ln in rows:
    agent, et, req, res, created, proj = [None if v == "\\N" else v for v in ln.split("\t")]
    con.execute("INSERT INTO agent_events (instance_id, agent, event_type, brief_id, model_requested,"
                " model_resolved, created_at, project) VALUES (?,?,?,?,?,?,?,?)",
                ("inst-1", agent, et, bid, req, res, created, project if proj == "igris-ai" else proj))
con.commit()
PY
}

# ev <brief> <agent> <event_type> <requested> [resolved] [project|NULL] [created_at]
ev() {
  python3 - "$DB" "$@" <<'PY'
import sqlite3, sys
db, bid, agent, et, req = sys.argv[1:6]
res = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] != "" else None
proj = sys.argv[7] if len(sys.argv) > 7 else None
created = sys.argv[8] if len(sys.argv) > 8 else None
con = sqlite3.connect(db)
con.execute("INSERT INTO agent_events (instance_id, agent, event_type, brief_id, model_requested, model_resolved,"
            " project, created_at) VALUES (?,?,?,?,?,?,?,COALESCE(?, datetime('now')))",
            ("inst-1", agent, et, bid, req, res, None if proj == "NULL" else proj, created))
con.commit()
PY
}

closing_msg() { printf 'fix(x): a change\n\nbody line\n\ncloses #%s\n' "$1" > "$MSG_FILE"; }

# run_hook [env assignments...] — the hook under /bin/bash (git runs it by its
# shebang; on macOS that is bash 3.2). The cd is double-quoted: RM-Q's repo
# name carries a quote.
run_hook() { run bash -c "cd \"$REPO\" && HOME='$FAKEHOME' $* /bin/bash '$HOOK_SRC' '$MSG_FILE' 2>&1"; }

# review <brief> — the checker direct.
review() { run bash "$REPO/core/scripts/cli-adapters/model_tier.sh" review --brief-id "$1" --project "$PROJECT" --db "$DB"; }

# mutate <file> <sed-expr> <needle> — prove the needle is unique, then gone.
mutate() {
  [ "$(grep -cF -- "$3" "$1")" -eq 1 ] || { echo "mutation site '$3' not unique in $1" >&2; return 1; }
  sed -i.bak -e "$2" "$1"
  [ "$(grep -cF -- "$3" "$1")" -eq 0 ] || { echo "mutation did not land" >&2; return 1; }
}

@test "RM-RED: the real FR-267 snapshot (author = reviewer, Claude) is refused" {
  seed_snapshot FR-267
  closing_msg FR-267
  run_hook
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL FR-267: VERDICT=EQUAL reviewer=inherit:claude-fable-5 authors=inherit:claude-fable-5"* ]] \
    || { echo "$output"; return 1; }
  [[ "$output" == *"IGRIS_BYPASS_REVIEW_MODEL_GATE=1 git commit"* ]] || { echo "$output"; return 1; }
  # §2 and §3 pass on this brief: the refusal is §4's alone.
  [[ "$output" != *"AC-GATE"* && "$output" != *"EVENT-GATE"* ]] || { echo "$output"; return 1; }
}

@test "RM-RED self-negative: a hook copy with §4 deleted lets the same world through" {
  sed '/\[\[ FR-277 REVIEW-MODEL GATE BEGIN \]\]/,/\[\[ FR-277 REVIEW-MODEL GATE END \]\]/d' "$HOOK_SRC" > "$SCRATCH/hook-no-s4"
  [ "$(grep -c 'rm_has_table' "$HOOK_SRC")" -ge 1 ] || return 1
  [ "$(grep -c 'rm_has_table' "$SCRATCH/hook-no-s4")" -eq 0 ] || return 1
  seed_snapshot FR-267
  closing_msg FR-267
  run bash -c "cd \"$REPO\" && HOME='$FAKEHOME' /bin/bash '$SCRATCH/hook-no-s4' '$MSG_FILE' 2>&1"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"REVIEW-MODEL"* ]] || { echo "$output"; return 1; }
}

@test "RM-GREEN: the real TD-497 snapshot (sonnet reviewer, opus author) passes §4 silently" {
  seed_snapshot TD-497
  closing_msg TD-497
  # §2 and §3 are bypassed to isolate §4: the stored TD-497 Agent Log names a
  # `tempo` row with no agent event, which §3 refuses on its own (README).
  run_hook "IGRIS_BYPASS_AC_GATE=1 IGRIS_BYPASS_EVENT_GATE=1"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ -z "$output" ] || { echo "not silent: $output"; return 1; }
  review TD-497
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$output" = "REVIEW-MODEL TD-497: VERDICT=PASS reviewer=sonnet authors=inherit:claude-opus-5-5" ] || { echo "$output"; return 1; }
}

@test "RM-CX: an equal GPT pair is reported (EQUAL_UNPROJECTED), not refused" {
  ev CX-1 forger stop inherit:gpt-6.1-sol
  ev CX-1 warden stop inherit:gpt-6.1-sol
  closing_msg CX-1
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"VERDICT=EQUAL_UNPROJECTED"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"reported, not refused: tiers for this provider are compiled at TD-385"* ]] || { echo "$output"; return 1; }
}

@test "RM-CX mutation: PROJECTED_PROVIDERS including openai refuses the GPT pair" {
  mutate "$REPO/core/scripts/cli-adapters/_common.sh" \
    's/^PROJECTED_PROVIDERS = ("anthropic",)$/PROJECTED_PROVIDERS = ("anthropic", "openai")/' \
    'PROJECTED_PROVIDERS = ("anthropic",)' || return 1
  ev CX-1 forger stop inherit:gpt-6.1-sol
  ev CX-1 warden stop inherit:gpt-6.1-sol
  closing_msg CX-1
  run_hook
  [ "$status" -eq 1 ] || { echo "mutant survived: $output"; return 1; }
}

@test "RM-D: the resolved model wins over the requested one" {
  ev DD-1 forger stop opus
  ev DD-1 warden stop opus claude-sonnet-5-5-20261001
  closing_msg DD-1
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ -z "$output" ] || { echo "$output"; return 1; }
  review DD-1
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$output" = "REVIEW-MODEL DD-1: VERDICT=PASS reviewer=claude-sonnet-5-5-20261001 authors=opus" ] || { echo "$output"; return 1; }
}

@test "RM-U1/U2/U3: no author / an empty inherit: / foo vs bar print UNKNOWN (not a pass), exit 0" {
  ev UU-1 warden stop sonnet
  ev UU-2 forger stop opus
  ev UU-2 warden stop "inherit:"
  ev UU-3 forger stop foo
  ev UU-3 warden stop bar
  local id
  for id in UU-1 UU-2 UU-3; do
    closing_msg "$id"
    run_hook
    [ "$status" -eq 0 ] || { echo "$id: $output"; return 1; }
    [[ "$output" == *"REVIEW-MODEL $id: VERDICT=UNKNOWN"* ]] || { echo "$id: $output"; return 1; }
    [[ "$output" == *"UNKNOWN (not a pass)"* ]] || { echo "$id: $output"; return 1; }
    review "$id"
    [ "$status" -eq 3 ] || { echo "$id checker: $status $output"; return 1; }
  done
}

@test "RM-U mutation: UNKNOWN mapped to a silent pass loses the UNKNOWN line" {
  mutate "$REPO/core/scripts/cli-adapters/_common.sh" \
    's/"PASS": 0, "EQUAL": 1, "UNKNOWN": 3,/"PASS": 0, "EQUAL": 1, "UNKNOWN": 0,/' \
    '"PASS": 0, "EQUAL": 1, "UNKNOWN": 3,' || return 1
  ev UU-3 forger stop foo
  ev UU-3 warden stop bar
  closing_msg UU-3
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"UNKNOWN (not a pass)"* ]] || { echo "mutant survived: $output"; return 1; }
}

@test "RM-O1: an orchestrator author on the reviewer's model is EQUAL" {
  ev OO-1 orchestrator stop opus
  ev OO-1 warden stop opus
  closing_msg OO-1
  run_hook
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL OO-1: VERDICT=EQUAL reviewer=opus authors=opus"* ]] || { echo "$output"; return 1; }
}

@test "RM-L1: the LATEST warden stop/error row is the reviewer" {
  ev LL-1 forger stop opus "" gproj "2026-11-01 10:00:00"
  ev LL-1 warden error opus "" gproj "2026-11-01 11:00:00"
  ev LL-1 warden stop sonnet "" gproj "2026-11-01 12:00:00"
  closing_msg LL-1
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ -z "$output" ] || { echo "$output"; return 1; }
}

@test "RM-L1 mutation: reading the first warden row refuses LL-1" {
  mutate "$REPO/core/scripts/cli-adapters/_common.sh" \
    's/reviewer = (reviews\[-1\]\[2\] or "") if reviews else ""/reviewer = (reviews[0][2] or "") if reviews else ""/' \
    'reviewer = (reviews[-1][2] or "") if reviews else ""' || return 1
  ev LL-1 forger stop opus "" gproj "2026-11-01 10:00:00"
  ev LL-1 warden error opus "" gproj "2026-11-01 11:00:00"
  ev LL-1 warden stop sonnet "" gproj "2026-11-01 12:00:00"
  closing_msg LL-1
  run_hook
  [ "$status" -eq 1 ] || { echo "mutant survived: $output"; return 1; }
}

@test "RM-N1 (S9): no warden row is silent at the hook" {
  ev NN-1 forger stop opus
  closing_msg NN-1
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ -z "$output" ] || { echo "not silent: $output"; return 1; }
  review NN-1
  [ "$status" -eq 4 ] || { echo "$status $output"; return 1; }
  [[ "$output" == *"VERDICT=NO_REVIEW"* ]] || { echo "$output"; return 1; }
}

@test "RM-B1: IGRIS_BYPASS_REVIEW_MODEL_GATE=1 skips §4 only" {
  seed_snapshot FR-267
  closing_msg FR-267
  run_hook "IGRIS_BYPASS_REVIEW_MODEL_GATE=1"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"REVIEW-MODEL"* ]] || { echo "$output"; return 1; }
}

@test "RM-B2a: the AC and event bypasses do not silence §4" {
  seed_snapshot FR-267
  closing_msg FR-267
  run_hook "IGRIS_BYPASS_AC_GATE=1 IGRIS_BYPASS_EVENT_GATE=1"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL FR-267: VERDICT=EQUAL"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"IGRIS_BYPASS_REVIEW_MODEL_GATE=1 git commit"* ]] || { echo "$output"; return 1; }
  [[ "$output" != *"IGRIS_BYPASS_EVENT_GATE=1 git commit"* ]] || { echo "$output"; return 1; }
}

@test "RM-B2b: IGRIS_BYPASS_REVIEW_MODEL_GATE=1 does not silence §3" {
  cat > "$SCRATCH/log.md" <<'MD'
## Acceptance Criteria

- [x] done

### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
MD
  python3 - "$DB" "$PROJECT" "$SCRATCH/log.md" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("INSERT INTO brief_files (project, brief_id, filename, content) VALUES (?,?,?,?)",
            (sys.argv[2], "BB-2", "BB-2.md", open(sys.argv[3], encoding="utf-8").read()))
con.commit()
PY
  ev BB-2 warden stop opus
  closing_msg BB-2
  run_hook "IGRIS_BYPASS_REVIEW_MODEL_GATE=1"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"EVENT-GATE BB-2: VERDICT=FAIL roles=forger missing=forger"* ]] || { echo "$output"; return 1; }
  [[ "$output" != *"IGRIS_BYPASS_REVIEW_MODEL_GATE=1 git commit"* ]] || { echo "$output"; return 1; }
}

@test "RM-F1: no brain DB -> exit 0, silent" {
  rm -f "$DB"
  closing_msg FR-267
  run_hook
  [ "$status" -eq 0 ] && [ -z "$output" ] || { echo "$output"; return 1; }
}

@test "RM-F2: a brain with no agent_events table -> exit 0, silent" {
  rm -f "$DB"
  sqlite3 "$DB" "CREATE TABLE brief_files (id INTEGER PRIMARY KEY, project TEXT, brief_id TEXT, content TEXT);"
  closing_msg FR-267
  run_hook
  [ "$status" -eq 0 ] && [ -z "$output" ] || { echo "$output"; return 1; }
}

@test "RM-F3: no checker in either location -> exit 0, silent (fail-open)" {
  rm -f "$REPO/core/scripts/cli-adapters/model_tier.sh"
  [ ! -e "$FAKEHOME/.igris/core/scripts/cli-adapters/model_tier.sh" ] || return 1
  seed_snapshot FR-267
  closing_msg FR-267
  run_hook
  [ "$status" -eq 0 ] && [ -z "$output" ] || { echo "$output"; return 1; }
}

@test "RM-F3b: with no repo copy, the runtime-mirror checker is used" {
  rm -rf "$REPO/core/scripts/cli-adapters"
  mkdir -p "$FAKEHOME/.igris/core/scripts/cli-adapters"
  cp "$ADAPTERS/model_tier.sh" "$ADAPTERS/_common.sh" "$FAKEHOME/.igris/core/scripts/cli-adapters/"
  seed_snapshot FR-267
  closing_msg FR-267
  run_hook
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL FR-267: VERDICT=EQUAL"* ]] || { echo "$output"; return 1; }
}

@test "RM-F4: an unreadable brain DB -> exit 0 with a WARN" {
  rm -f "$DB"
  printf 'this is not a sqlite database\n' > "$DB"
  closing_msg FR-267
  run_hook
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL FR-267: WARN"* ]] || { echo "$output"; return 1; }
}

@test "RM-P: rows under another project are ignored; NULL-project rows still count" {
  ev PP-1 forger stop opus "" other
  ev PP-1 warden stop opus "" other
  closing_msg PP-1
  run_hook
  [ "$status" -eq 0 ] && [ -z "$output" ] || { echo "$output"; return 1; }
  ev PP-2 forger stop opus "" NULL
  ev PP-2 warden stop opus "" NULL
  closing_msg PP-2
  run_hook
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
}

@test "RM-Q: project it's-proj reaches the checker through bound parameters" {
  PROJECT="it's-proj"
  REPO="$SANDBOX/$PROJECT"
  make_repo
  ev QQ-1 forger stop opus "" "it's-proj"
  ev QQ-1 warden stop opus "" "it's-proj"
  closing_msg QQ-1
  run_hook
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REVIEW-MODEL QQ-1: VERDICT=EQUAL"* ]] || { echo "$output"; return 1; }
}

@test "NZ: the checker direct, one pair per case" {
  local n=0 rev auth want code
  while IFS='|' read -r rev auth want code; do
    n=$((n + 1))
    ev "NZ-$n" forger stop "$auth"
    ev "NZ-$n" warden stop "$rev"
    review "NZ-$n"
    [ "$status" -eq "$code" ] || { echo "NZ-$n $rev/$auth: $status $output"; return 1; }
    [[ "$output" == *"VERDICT=$want "* ]] || { echo "NZ-$n $rev/$auth: $output"; return 1; }
  done <<'EOF'
inherit:claude-opus-5-5|opus|EQUAL|1
sonnet|claude-sonnet-5-5-20261001|EQUAL|1
opus|sonnet|PASS|0
claude-sonnet-5|claude-sonnet-5-5|PASS|0
gpt-6.2-sol|openai/gpt-6.2-sol|EQUAL_UNPROJECTED|6
gpt-6.2-sol|gpt-6.1-sol|PASS|0
m|m|EQUAL_UNPROJECTED|6
EOF
  [ "$n" -eq 7 ] || return 1
  run bash "$REPO/core/scripts/cli-adapters/model_tier.sh" review --brief-id X
  [ "$status" -eq 2 ] || { echo "usage: $status $output"; return 1; }
}
