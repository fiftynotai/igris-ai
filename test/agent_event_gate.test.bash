#!/usr/bin/env bats

# agent_event_gate.test.bash — FR-267. Tests for the agent-event coverage gate:
#   the shared parser  core/scripts/brief_agent_log_roles.sh
#   the L2 gate        scripts/git-hooks/commit-msg  (§3)
#
# RED-FIRST, ON A REAL BRIEF
# --------------------------
# test/fixtures/event-gate/FR-256.md is a byte-for-byte snapshot of the igris-ai
# brief FR-256 (Done 2026-08-14) whose Agent Log names architect, forger and
# sentinel while the brain holds ZERO agent_events rows for it — a real
# omitted emission, not one written for the test. The live refusal of the
# shipped hook against the real brain (read-only, 2026-08-26) is quoted in
# test/fixtures/event-gate/README.md:
#   EVENT-GATE FR-256: VERDICT=FAIL roles=architect,forger,sentinel missing=architect,forger,sentinel
#   exit=1
# G1 reproduces it in a sandboxed brain; G10 deletes §3 from a copy of the hook
# and shows G1 turning green, which is what proves G1 exercises §3.
#
# Test isolation
# --------------
# Sandbox copied from test/brief_ac_gate.test.bash: a git repo named 'gproj'
# with HOME pointed at a scratch dir holding a PLAIN-table brain (brief_files,
# brief_status, agent_events in the FR-267 v3 shape). The real brain is never
# opened. Both parsers are copied into the sandbox repo so the hook takes the
# same repo-first resolution branch it takes for real.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory 287: macOS system sqlite3 cannot load vec0/FTS5 — PLAIN tables only.
# TD-341: a bare non-final `[[ ... ]]` cannot fail a bats test. Every one below
#   carries `|| return 1`.
# "Prove the mutation landed": every sed/awk mutation is followed by a check
#   that the copy actually changed.

load test_helper

ROLES="$IGRIS_ROOT/core/scripts/brief_agent_log_roles.sh"
AC_CHECK="$IGRIS_ROOT/core/scripts/brief_ac_check.sh"
HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"
FIXTURES="$IGRIS_ROOT/test/fixtures/event-gate"
AC_FIXTURES="$IGRIS_ROOT/test/fixtures/ac-gate"

setup() {
  [ -f "$ROLES" ] || { echo "parser not found at $ROLES"; return 1; }
  [ -f "$AC_CHECK" ] || { echo "AC parser not found at $AC_CHECK"; return 1; }
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  [ -f "$FIXTURES/FR-256.md" ] || { echo "fixture not found"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/aeg.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  SCRATCH="$SANDBOX/scratch"
  mkdir -p "$SCRATCH"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO/core/scripts"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  cp "$ROLES" "$REPO/core/scripts/brief_agent_log_roles.sh"
  cp "$AC_CHECK" "$REPO/core/scripts/brief_ac_check.sh"

  MSG_FILE="$SANDBOX/COMMIT_EDITMSG"

  sqlite3 "$DB" "
    CREATE TABLE brief_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, filename TEXT, content TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT, effort TEXT, phase TEXT,
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

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# --- helpers -----------------------------------------------------------------

write_md() { cat > "$1"; }

# seed_brief_file <brief_id> <content-file> [project]
seed_brief_file() {
  python3 - "$DB" "${3:-$PROJECT}" "$1" "$2" <<'PY'
import sqlite3, sys
db, project, brief_id, path = sys.argv[1:5]
con = sqlite3.connect(db)
con.execute(
    "INSERT INTO brief_files (project, brief_id, filename, content) VALUES (?,?,?,?)",
    (project, brief_id, brief_id + ".md", open(path, encoding="utf-8").read()),
)
con.commit()
PY
}

# seed_event <brief_id> <agent> <event_type> [project | NULL]
seed_event() {
  local proj="'${4:-$PROJECT}'"
  [ "${4:-}" = "NULL" ] && proj="NULL"
  sqlite3 "$DB" "INSERT INTO agent_events (instance_id, agent, event_type, brief_id, project, model_requested)
                 VALUES ('inst-1', '$2', '$3', '$1', $proj, 'm');"
}

# seed_pair <brief_id> <agent> [project | NULL] — one start + one stop.
seed_pair() {
  seed_event "$1" "$2" start "${3:-}"
  seed_event "$1" "$2" stop "${3:-}"
}

run_parser() { run bash "$ROLES" "$@"; }

# run_hook [extra env assignments...] — cwd=$REPO, fake HOME, current $MSG_FILE.
run_hook() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' '$MSG_FILE' 2>&1"
}

closing_msg() {
  printf 'fix(x): a change\n\nbody line\n\ncloses #%s\n' "$1" > "$MSG_FILE"
}

# an FR-267-shaped log: orchestrator rows + one architect row
fr267_log() {
  write_md "$1" <<'MD'
# FR-900: a brief

## Acceptance Criteria

- [x] done

## Workflow State

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-08-26 16:27 | orchestrator | INIT — claim FR-900 | SUCCESS |
| 2026-08-26 16:30 | architect | Create implementation plan | SUCCESS |
| 2026-08-26 16:56 | orchestrator | Phase → APPROVAL | SUCCESS |
MD
}

# =============================================================================
# PART 1 — the parser
# =============================================================================

@test "(P1) an FR-267-shaped log -> architect only (orchestrator excluded)" {
  fr267_log "$SCRATCH/p1.md"
  run_parser --brief-id FR-900 "$SCRATCH/p1.md"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "AGENT-LOG FR-900: VERDICT=OK roles=architect" ] || return 1
  run_parser --roles "$SCRATCH/p1.md"
  [ "$output" = "architect" ] || return 1
}

@test "(P2) '/document skill' -> document" {
  write_md "$SCRATCH/p2.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | /document skill | Update documentation | SUCCESS |
MD
  run_parser --roles "$SCRATCH/p2.md"
  [ "$output" = "document" ] || return 1
}

@test "(P3) '**forger**' and '\`warden\`' normalize to forger, warden" {
  write_md "$SCRATCH/p3.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | **forger** | build | SUCCESS |
| t | `warden` | review | APPROVE |
MD
  run_parser --brief-id X "$SCRATCH/p3.md"
  [ "$output" = "AGENT-LOG X: VERDICT=OK roles=forger,warden" ] || return 1
}

@test "(P4) 'warden (round 2)' -> warden" {
  write_md "$SCRATCH/p4.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | warden (round 2) | re-review | APPROVE |
MD
  run_parser --roles "$SCRATCH/p4.md"
  [ "$output" = "warden" ] || return 1
}

@test "(P5) no Agent Log -> NO_LOG, --roles prints nothing" {
  write_md "$SCRATCH/p5.md" <<'MD'
# TD-500: a legacy brief

## Problem
nothing here.
MD
  run_parser --brief-id TD-500 "$SCRATCH/p5.md"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "AGENT-LOG TD-500: VERDICT=NO_LOG roles=" ] || return 1
  run_parser --roles "$SCRATCH/p5.md"
  [ "$output" = "" ] || return 1
}

@test "(P6) a table inside a fence is an EXAMPLE, not a log -> NO_ROWS" {
  write_md "$SCRATCH/p6.md" <<'MD'
### Agent Log

The log looks like this:

```markdown
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
```
MD
  run_parser --brief-id X "$SCRATCH/p6.md"
  [ "$output" = "AGENT-LOG X: VERDICT=NO_ROWS roles=" ] || return 1
}

@test "(P7) repeated rows -> distinct roles in first-seen order" {
  write_md "$SCRATCH/p7.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
| t | sentinel | test | FAIL |
| t | forger | fix | SUCCESS |
| t | sentinel | retest | PASS |
MD
  run_parser --roles "$SCRATCH/p7.md"
  [ "$output" = $'forger\nsentinel' ] || return 1
}

@test "(P8) the REAL FR-256 fixture -> architect, forger, sentinel" {
  run_parser --brief-id FR-256 "$FIXTURES/FR-256.md"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "AGENT-LOG FR-256: VERDICT=OK roles=architect,forger,sentinel" ] || return 1
}

@test "(P9) the measured folds: dash placeholder, count suffix, orchestrator compound, split, agent suffix" {
  write_md "$SCRATCH/p9.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | — | Brief loaded | — |
| t | forger x4 | Batch 1 | IN PROGRESS |
| t | hunt-orchestrator | wrap | SUCCESS |
| t | forger + sentinel | pair | SUCCESS |
| t | mender agent | diagnose | SUCCESS |
| t | Orchestrator | close | SUCCESS |
MD
  run_parser --roles "$SCRATCH/p9.md"
  [ "$output" = $'forger\nsentinel\nmender' ] || return 1
}

@test "(P10) stdin '-' parses identically to a file path; empty input -> DEGRADED" {
  fr267_log "$SCRATCH/p10.md"
  run bash -c "cat '$SCRATCH/p10.md' | bash '$ROLES' --roles -"
  [ "$output" = "architect" ] || return 1
  run bash -c "printf '' | bash '$ROLES' --brief-id E -"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"VERDICT=DEGRADED"* ]] || return 1
}

@test "(P11) a second Agent Log heading's rows are counted too; the block closes at the next same-level heading" {
  write_md "$SCRATCH/p11.md" <<'MD'
### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | architect | plan | SUCCESS |

### Not the log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | warden | should not count | x |

### Agent Log (round 2)
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
MD
  run_parser --roles "$SCRATCH/p11.md"
  [ "$output" = $'architect\nforger' ] || return 1
}

# =============================================================================
# PART 2 — the gate (§3 of commit-msg)
# =============================================================================

@test "(G1) RED: the real FR-256 fixture with an empty agent_events -> exit 1, missing= names all three" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE FR-256: VERDICT=FAIL roles=architect,forger,sentinel missing=architect,forger,sentinel"* ]] || return 1
  [[ "$output" == *"IGRIS_BYPASS_EVENT_GATE=1"* ]] || return 1
  # FR-256's eight criteria are ticked: the AC gate is silent and the bypass
  # hint names ONLY the gate that refused.
  [[ "$output" != *"IGRIS_BYPASS_AC_GATE=1"* ]] || return 1
  [[ "$output" != *"AC-GATE"* ]] || return 1
}

@test "(G2) GREEN: the same brief with a start+stop per named role -> exit 0, silent" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  seed_pair FR-256 architect
  seed_pair FR-256 forger
  seed_pair FR-256 sentinel
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G2b) one role covered by an ERROR row only (crashed agent) still counts" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  seed_pair FR-256 architect
  seed_pair FR-256 forger
  seed_event FR-256 sentinel error
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G3) an S brief whose log names only forger+sentinel, rows for both -> exit 0 (no architect demanded)" {
  write_md "$SCRATCH/s.md" <<'MD'
# TD-901: small

## Acceptance Criteria

- [x] done

### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | orchestrator | INIT | SUCCESS |
| t | forger | build | SUCCESS |
| t | sentinel | test | PASS |
MD
  seed_brief_file TD-901 "$SCRATCH/s.md"
  seed_pair TD-901 forger
  seed_pair TD-901 sentinel
  closing_msg TD-901

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G3-arm) the same S brief with the sentinel rows removed -> exit 1 naming sentinel only" {
  write_md "$SCRATCH/s.md" <<'MD'
## Acceptance Criteria

- [x] done

### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
| t | sentinel | test | PASS |
MD
  seed_brief_file TD-901 "$SCRATCH/s.md"
  seed_pair TD-901 forger
  closing_msg TD-901

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE TD-901: VERDICT=FAIL roles=forger,sentinel missing=sentinel"* ]] || return 1
}

@test "(G4) a start-only role -> exit 0 with a 'WARN unpaired' line" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  seed_pair FR-256 architect
  seed_pair FR-256 forger
  seed_event FR-256 sentinel start
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WARN unpaired: sentinel"* ]] || return 1
  [[ "$output" != *"VERDICT=FAIL"* ]] || return 1
}

@test "(G5) IGRIS_BYPASS_EVENT_GATE=1 -> G1's world passes (exit 0)" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  closing_msg FR-256

  run_hook "IGRIS_BYPASS_EVENT_GATE=1"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"EVENT-GATE"* ]] || return 1
}

@test "(G6a) IGRIS_BYPASS_AC_GATE=1 does NOT silence the event gate -> exit 1 on G1's world" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  closing_msg FR-256

  run_hook "IGRIS_BYPASS_AC_GATE=1"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE FR-256: VERDICT=FAIL"* ]] || return 1
}

@test "(G6b) IGRIS_BYPASS_EVENT_GATE=1 does NOT silence the AC gate -> exit 1 on an unmet-AC brief" {
  seed_brief_file TD-347 "$AC_FIXTURES/TD-347.md"
  closing_msg TD-347

  run_hook "IGRIS_BYPASS_EVENT_GATE=1"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"AC-GATE TD-347: VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"IGRIS_BYPASS_AC_GATE=1"* ]] || return 1
  [[ "$output" != *"IGRIS_BYPASS_EVENT_GATE=1"* ]] || return 1
}

@test "(G6c) both gates refusing -> both verdict blocks print, the hint names both" {
  write_md "$SCRATCH/both.md" <<'MD'
## Acceptance Criteria

- [ ] not done

### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | forger | build | SUCCESS |
MD
  seed_brief_file TD-902 "$SCRATCH/both.md"
  closing_msg TD-902

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"AC-GATE TD-902: VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"EVENT-GATE TD-902: VERDICT=FAIL roles=forger missing=forger"* ]] || return 1
  [[ "$output" == *"IGRIS_BYPASS_AC_GATE=1 git commit"* ]] || return 1
  [[ "$output" == *"IGRIS_BYPASS_EVENT_GATE=1 git commit"* ]] || return 1
}

# --- (G7) the fail-open matrix, per tier ------------------------------------

@test "(G7a) no agent_events table (a brain older than FR-267) -> exit 0, silent" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  sqlite3 "$DB" "DROP TABLE agent_events;"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G7b) no stored content for that id -> exit 0, silent" {
  closing_msg FR-256
  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G7c) no brain DB -> exit 0, silent" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  rm -f "$DB"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G7d) roles parser missing from repo AND runtime mirror -> exit 0, silent" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  rm -f "$REPO/core/scripts/brief_agent_log_roles.sh"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G7d-arm) parser missing from repo but present in the runtime mirror -> still gates" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  rm -f "$REPO/core/scripts/brief_agent_log_roles.sh"
  mkdir -p "$FAKEHOME/.igris/core/scripts"
  cp "$ROLES" "$FAKEHOME/.igris/core/scripts/brief_agent_log_roles.sh"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE FR-256: VERDICT=FAIL"* ]] || return 1
}

@test "(G7e) a log with no roles (NO_ROWS: orchestrator only) -> nothing demanded, exit 0" {
  write_md "$SCRATCH/orch.md" <<'MD'
## Acceptance Criteria

- [x] done

### Agent Log
| Time | Agent | Action | Result |
|---|---|---|---|
| t | orchestrator | did it all | SUCCESS |
MD
  seed_brief_file TD-903 "$SCRATCH/orch.md"
  closing_msg TD-903

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G7f) pre-v3 agent_events (no project column) -> the project predicate is dropped, rows still count" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  sqlite3 "$DB" "DROP TABLE agent_events;
    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, agent TEXT NOT NULL,
      event_type TEXT NOT NULL, phase TEXT, brief_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agent_events (instance_id, agent, event_type, brief_id) VALUES
      ('i','architect','start','FR-256'), ('i','architect','stop','FR-256'),
      ('i','forger','start','FR-256'),    ('i','forger','stop','FR-256'),
      ('i','sentinel','start','FR-256'),  ('i','sentinel','stop','FR-256');"
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

# --- (G8) the project predicate ------------------------------------------------

@test "(G8a) rows for the same brief id under ANOTHER project -> still FAIL" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  seed_pair FR-256 architect other
  seed_pair FR-256 forger other
  seed_pair FR-256 sentinel other
  closing_msg FR-256

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"missing=architect,forger,sentinel"* ]] || return 1
}

@test "(G8b) NULL-project legacy rows count -> exit 0" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  seed_pair FR-256 architect NULL
  seed_pair FR-256 forger NULL
  seed_pair FR-256 sentinel NULL
  closing_msg FR-256

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G9) no 'closes' footer -> silent exit 0 even on G1's world" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  printf 'feat(x): wip\n\nprogress on FR-256, more to come\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "" ] || return 1
}

@test "(G9b) a commit closing TWO briefs is gated on the one that sorts SECOND" {
  fr267_log "$SCRATCH/ok.md"
  seed_brief_file FR-100 "$SCRATCH/ok.md"
  seed_pair FR-100 architect
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  printf 'fix(x): y\n\ncloses #FR-100\ncloses #FR-256\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE FR-256: VERDICT=FAIL"* ]] || return 1
  [[ "$output" != *"EVENT-GATE FR-100"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (G10) SELF-NEGATIVE CONTROL. A copy of the hook with §3 deleted (by its
#       markers) must let G1's world through. If it did not, G1's red would be
#       coming from somewhere other than the gate under test.
# -----------------------------------------------------------------------------
@test "(G10) a hook copy with §3 removed turns G1 green — G1 exercises §3" {
  sed '/\[\[ FR-267 EVENT GATE BEGIN \]\]/,/\[\[ FR-267 EVENT GATE END \]\]/d' "$HOOK_SRC" > "$SCRATCH/hook-no-s3"
  # The mutation must actually have landed, or this arm proves nothing.
  [ "$(grep -c 'EVENT-GATE' "$SCRATCH/hook-no-s3")" -eq 0 ] || return 1
  [ "$(grep -c 'EVENT-GATE' "$HOOK_SRC")" -gt 0 ] || return 1
  # ...and the only thing the deletion removed is §3 (event_failed is still
  # read at the single exit, so a stray reference would error, not exit 0).
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  closing_msg FR-256

  run bash -c "cd '$REPO' && HOME='$FAKEHOME' bash '$SCRATCH/hook-no-s3' '$MSG_FILE' 2>&1"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"EVENT-GATE"* ]] || return 1

  # Positive control in the SAME sandbox: the unmutated hook still refuses.
  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"EVENT-GATE FR-256: VERDICT=FAIL"* ]] || return 1
}

@test "(L1) the TD-180 length check still fires first, before either gate" {
  seed_brief_file FR-256 "$FIXTURES/FR-256.md"
  long="$(printf '%*s' 80 '' | tr ' ' 'x')"
  printf '%s\n\ncloses #FR-256\n' "$long" > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"max 72"* ]] || return 1
  [[ "$output" != *"EVENT-GATE"* ]] || return 1
}
