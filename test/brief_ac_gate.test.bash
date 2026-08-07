#!/usr/bin/env bats

# brief_ac_gate.test.bash — TD-325. Tests for the acceptance-criteria gate:
#   the shared parser  core/scripts/brief_ac_check.sh
#   the L2 gate        scripts/git-hooks/commit-msg
#   the L3 observer    scripts/validate_brief_ac_completion.sh
#
# RED-FIRST, ON REAL BRIEFS
# ------------------------
# The four RED fixtures under test/fixtures/ac-gate/ are byte-for-byte snapshots
# of four briefs the operator closed on 2026-08-06 — TD-347, TD-330, TD-331,
# TD-327 — every one of them status=Done / phase=COMPLETE with ZERO ticked
# criteria. The GREEN fixture is FR-241, which shipped with its eighth criterion
# deliberately unmet and recorded as `- [~]`; that line is where the deferral
# syntax comes from in the first place. Five real cases, none written for the
# test, and nothing in TD-325 edits their stored content — the retroactive
# ticking is TD-075's job.
#
# Test isolation
# --------------
# The hook reads $HOME/.igris/memory/knowledge.db and derives the project slug
# from basename(git rev-parse --show-toplevel). Each hook test therefore runs
# inside a sandbox git repo named 'gproj' with HOME pointed at a scratch dir, so
# the real brain is never opened, let alone written.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory 287: macOS system sqlite3 cannot load vec0/FTS5 — the fixture DB uses
#   PLAIN tables only.
# Memory "Bats [[ ]] assertions are vacuous": bash does not fire the ERR trap for
#   a `[[ ]]` compound conditional and errexit is off inside a test body, so a
#   bare non-final `[[ ... ]]` fails SILENTLY. Every one below carries
#   `|| return 1`.

load test_helper

AC_CHECK="$IGRIS_ROOT/core/scripts/brief_ac_check.sh"
HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"
VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_ac_completion.sh"
FIXTURES="$IGRIS_ROOT/test/fixtures/ac-gate"

setup() {
  [ -f "$AC_CHECK" ] || { echo "parser not found at $AC_CHECK"; return 1; }
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/acg.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  SCRATCH="$SANDBOX/scratch"
  mkdir -p "$SCRATCH"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t

  # The hook prefers $REPO_ROOT/core/scripts/brief_ac_check.sh. Placing the
  # parser there means the sandbox exercises the SAME resolution branch the real
  # repo uses, rather than the runtime-mirror fallback.
  mkdir -p "$REPO/core/scripts"
  cp "$AC_CHECK" "$REPO/core/scripts/brief_ac_check.sh"

  MSG_FILE="$SANDBOX/COMMIT_EDITMSG"

  # brief_files + brief_status, PLAIN tables (mirrors brain-mcp-server/src/db.ts
  # minus the FTS5/vec0 shadow tables the system sqlite3 cannot create).
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
  "
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# --- helpers -----------------------------------------------------------------

# write_md <path> — content on stdin. Keeps heredocs out of the assertions.
write_md() { cat > "$1"; }

# seed_brief_file <brief_id> <content-file> — insert into the fixture brain.
# python3 does the insert so markdown containing quotes, backticks and em dashes
# never has to survive shell interpolation into SQL.
seed_brief_file() {
  python3 - "$DB" "$PROJECT" "$1" "$2" <<'PY'
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

# seed_brief_status <brief_id> <status> [phase]
seed_brief_status() {
  sqlite3 "$DB" "INSERT INTO brief_status (project, brief_id, title, status, phase)
                 VALUES ('$PROJECT', '$1', 't', '$2', '${3:-COMPLETE}');"
}

# run_parser <args...>
run_parser() { run bash "$AC_CHECK" "$@"; }

# run_hook [extra env assignments...] — invoke commit-msg with cwd=$REPO and the
# fake HOME, against the current $MSG_FILE.
run_hook() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' '$MSG_FILE' 2>&1"
}

# closing_msg <brief_id> — write a well-formed closing commit message.
closing_msg() {
  printf 'fix(x): a change\n\nbody line\n\ncloses #%s\n' "$1" > "$MSG_FILE"
}

# =============================================================================
# PART 1 — the parser, against the five REAL briefs
# =============================================================================

# -----------------------------------------------------------------------------
# (R1a-d) THE RED CASES. Four briefs the operator closed with every box open.
#         Each must be refused as it stands, byte-unmodified.
# -----------------------------------------------------------------------------
@test "(R1a) TD-347 as closed -> FAIL, 6 unticked, every criterion echoed" {
  run_parser --brief-id TD-347 "$FIXTURES/TD-347.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"total=6 ticked=0 deferred=0 unticked=6"* ]] || return 1
  [[ "$output" == *"The initial chunk is materially below the limit"* ]] || return 1
  [[ "$output" == *"The ledger records the new composition"* ]] || return 1
}

@test "(R1b) TD-330 as closed -> FAIL, 4 unticked" {
  run_parser --brief-id TD-330 "$FIXTURES/TD-330.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"total=4 ticked=0 deferred=0 unticked=4"* ]] || return 1
}

@test "(R1c) TD-331 as closed -> FAIL, 5 unticked" {
  run_parser --brief-id TD-331 "$FIXTURES/TD-331.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"total=5 ticked=0 deferred=0 unticked=5"* ]] || return 1
}

@test "(R1d) TD-327 as closed -> FAIL, 5 unticked" {
  run_parser --brief-id TD-327 "$FIXTURES/TD-327.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"total=5 ticked=0 deferred=0 unticked=5"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (G1) THE GREEN CASE. FR-241 shipped 7 ticked + 1 deferred, and its deferral
#      syntax is where `- [~]` comes from. It must pass byte-unmodified — if it
#      did not, the gate would be refusing the very shape it asks people to use.
# -----------------------------------------------------------------------------
@test "(G1) FR-241 as shipped -> PASS (7 ticked, 1 deferred, 0 unticked)" {
  run_parser --brief-id FR-241 "$FIXTURES/FR-241.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS"* ]] || return 1
  [[ "$output" == *"total=8 ticked=7 deferred=1 unticked=0"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (G1-arm-a) FR-241's PASS is carried by the DEFERRED token, not by luck.
#            Same fixture with `DEFERRED` renamed -> FAIL. Without this arm,
#            (G1) would pass identically if the reason rule were never applied.
# -----------------------------------------------------------------------------
@test "(G1-arm-a) FR-241 minus the DEFERRED token -> FAIL (deferral without a reason)" {
  sed 's/\*\*DEFERRED, with reason/**Not done, reason/' "$FIXTURES/FR-241.md" > "$SCRATCH/a.md"
  # The mutation must actually have landed, or this arm proves nothing.
  ! grep -q 'DEFERRED' "$SCRATCH/a.md" || return 1

  run_parser --brief-id FR-241-arm "$SCRATCH/a.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_reason=1"* ]] || return 1
  [[ "$output" == *"DEFERRAL WITHOUT A REASON"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (G1-arm-b) ...and by the FOLLOW-UP BRIEF rule (operator decision D2). Same
#            fixture with every brief id stripped -> FAIL. FR-241 names TD-325
#            as the destination of its deferral; a deferral with nowhere to go
#            is indistinguishable from one that was forgotten.
# -----------------------------------------------------------------------------
@test "(G1-arm-b) FR-241 with every brief id stripped -> FAIL (no follow-up)" {
  sed -E 's/[A-Z][A-Z][A-Z]?-[0-9]+/XX/g' "$FIXTURES/FR-241.md" > "$SCRATCH/b.md"
  grep -q 'DEFERRED' "$SCRATCH/b.md" || return 1

  run_parser --brief-id FR-241-arm "$SCRATCH/b.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_followup=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (G1-arm-c) ...and specifically by the DEFERRAL SECTION, since FR-241's own AC
#            line carries no brief id — it says "see below" and the section
#            names TD-325. Rename that heading and the fallback must stop
#            applying, or the rule is really "any brief id anywhere", which
#            would be satisfied by an unrelated `Related:` note.
# -----------------------------------------------------------------------------
@test "(G1-arm-c) FR-241 with the deferral SECTION renamed -> FAIL (no follow-up)" {
  sed 's/^## The deferred AC, and why/## The unmet AC, and why/' "$FIXTURES/FR-241.md" > "$SCRATCH/c.md"
  ! grep -q '^## The deferred AC' "$SCRATCH/c.md" || return 1
  grep -q '^## The unmet AC' "$SCRATCH/c.md" || return 1

  run_parser --brief-id FR-241-arm "$SCRATCH/c.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_followup=1"* ]] || return 1
}

# =============================================================================
# PART 2 — the parser's edge battery
# =============================================================================

@test "(E1) no Acceptance Criteria heading -> NO_AC, exit 0 (fail-open)" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000: a legacy brief

## Problem
It has no criteria section at all.

## Notes
- [ ] this checkbox is not a criterion
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=NO_AC"* ]] || return 1
}

@test "(E2) a checkbox inside a fenced block is an EXAMPLE, not a criterion" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [x] the real one is met

```
- [ ] this is a fenced example of the syntax
```

## Notes
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=1 ticked=1"* ]] || return 1
}

@test "(E3) a checkbox BEFORE the AC heading is out of scope" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Scope
- [ ] a task, not a criterion

## Acceptance Criteria
- [x] met
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=1"* ]] || return 1
}

@test "(E4) a checkbox AFTER the block's closing heading is out of scope" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [x] met

## Out of scope
- [ ] a non-goal, not a criterion
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E5) THE `LIKE` FALSE POSITIVE, made a test. TD-325's own body contains
#      `- [ ]` twice inside inline code spans while describing the problem.
#      `content LIKE '%- [ ]%'` counts both; a line-anchored parse counts
#      neither. This is the single biggest reason the audit population must be
#      driven off this parser and not off the substring.
# -----------------------------------------------------------------------------
@test "(E5) an inline-code '- [ ]' in prose is not a criterion (the TD-325-body case)" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-325

## Problem
acceptance-criteria checkboxes are still `- [ ]` when the brief closes, and
the query counts a brief while `- [ ]` remains anywhere in its text.

## Acceptance Criteria
- [x] met
MD
  run_parser --brief-id TD-325 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=1 ticked=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E5b) LINE ANCHORING, pinned on its own — TD-325 validation advisory A1.
#
#   E5 above puts its inline spans under `## Problem`, so it passes even with
#   the `^[[:space:]]*` anchor removed: BLOCK SCOPING alone rejects them. That
#   makes E5 a second test of E3, not a test of anchoring, and sentinel showed
#   the anchor could be deleted with all 49 tests still green.
#
#   This fixture puts the inline span INSIDE the AC block, on a continuation
#   line of a real criterion — the one place scoping cannot help. Anchored, the
#   span is prose and there is 1 criterion; unanchored it is counted and there
#   are 2. Live impact is currently zero of 447 briefs and the mutation
#   over-counts (refuses more, the safe direction), which is exactly why it
#   needs a test rather than a reader noticing.
# -----------------------------------------------------------------------------
@test "(E5b) an inline-code '- [ ]' on a CONTINUATION line inside the AC block is not a criterion" {
  write_md "$SCRATCH/anchor.md" <<'MD'
# TD-999

## Acceptance Criteria
- [x] the parser counts a criterion only when the marker starts the line,
      so a span like `- [ ]` quoted mid-sentence here is prose, not a box
MD
  run_parser --brief-id TD-999 "$SCRATCH/anchor.md"
  [ "$status" -eq 0 ]
  # Anchored: exactly ONE criterion, ticked. Unanchored this reads total=2.
  [[ "$output" == *"VERDICT=PASS total=1 ticked=1"* ]] || return 1
}

@test "(E6) '[~]' with no DEFERRED token -> FAIL (the marker alone is not the hatch)" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [~] I did not get to this one. -> TD-999
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_reason=1"* ]] || return 1
}

@test "(E7) '[~]' with a reason but NO follow-up brief -> FAIL (operator D2)" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [~] **DEFERRED: the upstream API is not ready.**
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_followup=1"* ]] || return 1
  [[ "$output" == *"DEFERRAL WITHOUT A FOLLOW-UP BRIEF"* ]] || return 1
}

@test "(E8) '[~]' with reason + follow-up brief -> PASS" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [x] met
- [~] **DEFERRED: the upstream API is not ready.** -> TD-999
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=2 ticked=1 deferred=1 unticked=0"* ]] || return 1
}

@test "(E9) uppercase '[X]' counts as ticked" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [X] met, written with a capital X
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=1 ticked=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E10) A wrapped deferral: the DEFERRED token and the follow-up id sit on the
#       CONTINUATION lines, not the marker line. Every real brief wraps its
#       criteria, so an item's extent must include its continuation lines or the
#       hatch would only work for one-line criteria.
# -----------------------------------------------------------------------------
@test "(E10) a wrapped '[~]' whose reason and follow-up are on continuation lines -> PASS" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-000

## Acceptance Criteria
- [~] The migration runs against production data.
      DEFERRED: the maintenance window moved to next quarter.
      -> TD-999
- [x] everything else
MD
  run_parser --brief-id TD-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=PASS total=2 ticked=1 deferred=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E11) ORDERED markers. Measured by running the parser against a hyphen-only
#       variant of itself over the 447 terminal igris-ai briefs: 37 read
#       differently and 32 of those went from FAIL to a VACUOUS PASS — a green
#       light earned by parsing nothing. They write their criteria as `1. [ ]`,
#       the v4-era template. This is the notation fold that recovered them.
# -----------------------------------------------------------------------------
@test "(E11) ordered markers '1. [ ]' are criteria too (the v4-template population)" {
  write_md "$SCRATCH/m.md" <<'MD'
# BR-000

## Acceptance Criteria

**The fix is complete when:**

1. [ ] the script contains zero references to the removed dashboard
2. [x] the sync exits 0
3. [ ] no stale cron entries remain
MD
  run_parser --brief-id BR-000 "$SCRATCH/m.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"total=3 ticked=1 deferred=0 unticked=2"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E12) An AC block whose criteria are PROSE is not a pass. FR-120 is the real
#       case: a numbered list with no boxes at all. Reporting PASS there would
#       be the "gate that goes green because what it measured moved somewhere it
#       cannot see" defect. It still exits 0 — refusing a commit because a
#       legacy brief wrote prose would be inventing a rule nobody agreed to.
# -----------------------------------------------------------------------------
@test "(E12) an AC block with no parseable checkbox -> NO_ITEMS, exit 0, NOT a PASS" {
  write_md "$SCRATCH/m.md" <<'MD'
# FR-000

## Acceptance Criteria

1. The entry switches from http to stdio.
2. All tools verified against the local DB.
MD
  run_parser --brief-id FR-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=NO_ITEMS"* ]] || return 1
  [[ "$output" != *"VERDICT=PASS"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E13) TWO AC blocks. MG-013 and FR-120 both carry a second one, and a
#       first-block-only reader silently ignored it — in FR-120's case reading
#       the wrong block entirely. The union can only find MORE open boxes.
# -----------------------------------------------------------------------------
@test "(E13) criteria in a SECOND Acceptance Criteria block are counted too" {
  write_md "$SCRATCH/m.md" <<'MD'
# MG-000

## Acceptance Criteria
- [x] the first block's criterion is met

## Notes
prose in between.

## Acceptance Criteria — registry drift test cases
- [ ] the second block's criterion is NOT met
MD
  run_parser --brief-id MG-000 "$SCRATCH/m.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"total=2 ticked=1 deferred=0 unticked=1"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (E14) A qualifier-PREFIXED heading still names the same section. FR-170 uses
#       `## Epic-level acceptance criteria`; a `^acceptance` anchor missed it
#       and reported NO_AC on a brief with 7 open boxes.
# -----------------------------------------------------------------------------
@test "(E14) a qualifier-prefixed AC heading is still the AC block" {
  write_md "$SCRATCH/m.md" <<'MD'
# FR-000

## Epic-level acceptance criteria

- [ ] the roster is invocable as subagents
MD
  run_parser --brief-id FR-000 "$SCRATCH/m.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"total=1 ticked=0 deferred=0 unticked=1"* ]] || return 1
}

@test "(E15) a heading saying only 'Acceptance' is a DIFFERENT heading (no vocabulary drift)" {
  write_md "$SCRATCH/m.md" <<'MD'
# FR-000

### Acceptance (as shipped)
- [ ] not a criteria block
MD
  run_parser --brief-id FR-000 "$SCRATCH/m.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=NO_AC"* ]] || return 1
}

@test "(E16) unreadable input -> DEGRADED, exit 0 (fail-open)" {
  run_parser --brief-id TD-000 "$SCRATCH/does-not-exist.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VERDICT=DEGRADED"* ]] || return 1
}

@test "(E17) content on stdin is parsed identically to a file path" {
  run bash -c "cat '$FIXTURES/TD-347.md' | bash '$AC_CHECK' --brief-id TD-347 -"
  [ "$status" -eq 1 ]
  [[ "$output" == *"total=6 ticked=0 deferred=0 unticked=6"* ]] || return 1
}

# =============================================================================
# PART 3 — L2, the commit-msg gate
# =============================================================================

# -----------------------------------------------------------------------------
# (R2) THE RED. TD-347's real content in the store, a real closing footer ->
#      the hook refuses, names the brief, echoes the unmet criteria, and shows
#      the paste-ready deferral line FIRST.
# -----------------------------------------------------------------------------
@test "(R2) closing commit for a brief with unticked ACs -> hook refuses (exit 1)" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-347"* ]] || return 1
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"The initial chunk is materially below the limit"* ]] || return 1
  [[ "$output" == *"- [~] **DEFERRED:"* ]] || return 1
  [[ "$output" == *"IGRIS_BYPASS_AC_GATE=1"* ]] || return 1
}

@test "(R3) same brief with every box ticked -> hook allows (exit 0)" {
  sed 's/^- \[ \]/- [x]/' "$FIXTURES/TD-347.md" > "$SCRATCH/ticked.md"
  ! grep -q '^- \[ \]' "$SCRATCH/ticked.md" || return 1
  seed_brief_file TD-347 "$SCRATCH/ticked.md"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing to close"* ]] || return 1
}

@test "(R4) same brief with every box deferred (reason + follow-up) -> hook allows" {
  sed 's/^- \[ \]/- [~] **DEFERRED: superseded by the split.** -> TD-999 —/' \
    "$FIXTURES/TD-347.md" > "$SCRATCH/deferred.md"
  ! grep -q '^- \[ \]' "$SCRATCH/deferred.md" || return 1
  seed_brief_file TD-347 "$SCRATCH/deferred.md"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing to close"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R5) THE ANTI-FORGERY CONTROL. `[~]` alone is one keystroke, exactly like
#      `[x]`. If the marker without a reason were accepted, the hatch would be
#      a cheaper lie than the tick it exists to prevent.
# -----------------------------------------------------------------------------
@test "(R5) boxes changed to '[~]' with NO reason -> hook still refuses (exit 1)" {
  sed 's/^- \[ \]/- [~]/' "$FIXTURES/TD-347.md" > "$SCRATCH/bare.md"
  ! grep -q '^- \[ \]' "$SCRATCH/bare.md" || return 1
  grep -q '^- \[~\]' "$SCRATCH/bare.md" || return 1
  seed_brief_file TD-347 "$SCRATCH/bare.md"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"deferred_no_reason=6"* ]] || return 1
}

@test "(R6) IGRIS_BYPASS_AC_GATE=1 -> hook allows the same refused commit (exit 0)" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  closing_msg TD-347

  run_hook "IGRIS_BYPASS_AC_GATE=1"
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing to close"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (P2) THE /hunt COMMIT SEQUENCE. Two WIP commits then the closing one. This is
#      AC #4's other half: the gate must be silent for every commit that is not
#      the close, which it achieves by keying on the footer rather than on a
#      phase that lags.
# -----------------------------------------------------------------------------
@test "(P2) WIP commits are untouched; only the closing commit is gated" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"

  printf 'feat(x): wip\n' > "$MSG_FILE"
  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1

  printf 'feat(x): more wip\n\nstill building against TD-347\n' > "$MSG_FILE"
  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1

  closing_msg TD-347
  run_hook
  [ "$status" -eq 1 ]

  # ...and the same closing message passes once the record is complete.
  sqlite3 "$DB" "DELETE FROM brief_files WHERE brief_id='TD-347';"
  sed 's/^- \[ \]/- [x]/' "$FIXTURES/TD-347.md" > "$SCRATCH/ticked.md"
  seed_brief_file TD-347 "$SCRATCH/ticked.md"
  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# (P2b) A bare brief id in the body is NOT a closing footer. The gate's whole
#       exemption story for mid-hunt commits rests on this: `closes` is the
#       token, not the id.
# -----------------------------------------------------------------------------
@test "(P2b) a bare brief id with no 'closes' verb does not trigger the gate" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  printf 'feat(x): wip\n\nprogress on TD-347, more to come\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

@test "(N1) footer notation folds: 'Closes #ID', 'closes ID', 'closed: #ID' all gate" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"

  printf 'fix(x): y\n\nCloses #TD-347\n' > "$MSG_FILE"
  run_hook
  [ "$status" -eq 1 ]

  printf 'fix(x): y\n\ncloses TD-347\n' > "$MSG_FILE"
  run_hook
  [ "$status" -eq 1 ]

  printf 'fix(x): y\n\nclosed: #TD-347\n' > "$MSG_FILE"
  run_hook
  [ "$status" -eq 1 ]
}

@test "(N2) a 'closes #' inside a git COMMENT line is not a closing footer" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  printf 'feat(x): wip\n\n# closes #TD-347\n# On branch develop\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

@test "(N3) a commit closing TWO briefs is gated on BOTH" {
  sed 's/^- \[ \]/- [x]/' "$FIXTURES/TD-347.md" > "$SCRATCH/ticked.md"
  seed_brief_file TD-347 "$SCRATCH/ticked.md"
  seed_brief_file TD-330 "$FIXTURES/TD-330.md"
  printf 'fix(x): y\n\ncloses #TD-347\ncloses #TD-330\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-330"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (N3b) THE COMPLEMENTARY ORDERING — TD-325 validation advisory A2.
#
#   N3 above seeds TD-347 ticked and TD-330 unticked. The hook `sort -u`s the
#   ids, so TD-330 sorts FIRST — which means a `| head -1` mutant still refuses
#   and N3 stays green. Sentinel demonstrated exactly that: the multi-id loop
#   could be truncated to one id with all 49 tests passing.
#
#   This is the same test with the ordering reversed: the DIRTY brief sorts
#   SECOND. A truncating mutant reads only the clean TD-330 and exits 0
#   silently, letting a commit close a brief with six unmet criteria. Together
#   the pair pins the loop from both directions; either alone does not.
# -----------------------------------------------------------------------------
@test "(N3b) a commit closing TWO briefs is gated on the one that sorts SECOND" {
  sed 's/^- \[ \]/- [x]/' "$FIXTURES/TD-330.md" > "$SCRATCH/ticked330.md"
  seed_brief_file TD-330 "$SCRATCH/ticked330.md"
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  printf 'fix(x): y\n\ncloses #TD-330\ncloses #TD-347\n' > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-347"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (L1) The ≤72 length check runs FIRST and is unaffected. A too-long summary on
#      an otherwise-clean closing commit still fails on length, with the length
#      message — not the AC one.
# -----------------------------------------------------------------------------
@test "(L1) the TD-180 length check still fires first on a clean closing commit" {
  sed 's/^- \[ \]/- [x]/' "$FIXTURES/TD-347.md" > "$SCRATCH/ticked.md"
  seed_brief_file TD-347 "$SCRATCH/ticked.md"
  long="$(printf '%*s' 80 '' | tr ' ' 'x')"
  printf '%s\n\ncloses #TD-347\n' "$long" > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"max 72"* ]] || return 1
  [[ "$output" != *"AC gate"* ]] || return 1
}

# =============================================================================
# PART 4 — the fail-open matrix. Every tier, because this hook runs on every
# commit in every repo that installs it.
# =============================================================================

@test "(F1) no brain DB -> exit 0, silent" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  rm -f "$DB"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

@test "(F2) no brief_files row for that id -> exit 0, silent" {
  closing_msg TD-999
  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

@test "(F3) brief content with no AC heading -> exit 0, silent" {
  write_md "$SCRATCH/m.md" <<'MD'
# TD-500: a legacy brief with no criteria section

## Problem
nothing to gate here.
MD
  seed_brief_file TD-500 "$SCRATCH/m.md"
  closing_msg TD-500

  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

@test "(F4) parser missing from repo AND runtime mirror -> exit 0, silent" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  rm -f "$REPO/core/scripts/brief_ac_check.sh"
  closing_msg TD-347

  # HOME is the sandbox, so $HOME/.igris/core/scripts/... does not exist either.
  run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == "" ]] || return 1
}

# -----------------------------------------------------------------------------
# (F4b) POSITIVE CONTROL for (F4): the runtime-mirror fallback is real. With the
#       repo copy gone but a mirror present under the fake HOME, the gate fires
#       again — so (F4)'s silence was "no parser anywhere", not a dead branch.
# -----------------------------------------------------------------------------
@test "(F4b) parser missing from repo but present in the runtime mirror -> still gates" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  rm -f "$REPO/core/scripts/brief_ac_check.sh"
  mkdir -p "$FAKEHOME/.igris/core/scripts"
  cp "$AC_CHECK" "$FAKEHOME/.igris/core/scripts/brief_ac_check.sh"
  closing_msg TD-347

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"VERDICT=FAIL"* ]] || return 1
}

@test "(F5) sqlite3 absent from PATH -> exit 0, silent" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"
  closing_msg TD-347

  # A PATH holding only a shell/coreutils stub dir: git and sqlite3 both vanish,
  # so the guard order matters — the hook must not error before its own checks.
  mkdir -p "$SANDBOX/emptybin"
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' PATH='$SANDBOX/emptybin:/usr/bin:/bin' \
               command -v sqlite3 >/dev/null 2>&1 && echo STILL_THERE || echo GONE"
  if [ "$output" = "STILL_THERE" ]; then
    skip "sqlite3 lives in /usr/bin on this machine; cannot hide it without breaking the shell"
  fi
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' PATH='$SANDBOX/emptybin:/usr/bin:/bin' \
               bash '$HOOK_SRC' '$MSG_FILE' 2>&1"
  [ "$status" -eq 0 ]
}

@test "(F6) empty message file -> exit 0 (pass-through, unchanged from TD-180)" {
  : > "$MSG_FILE"
  run_hook
  [ "$status" -eq 0 ]
}

# =============================================================================
# PART 5 — L3 observer + AC #7, the PROHIBITION
# =============================================================================

# -----------------------------------------------------------------------------
# (S1) AC #7 made PARTLY checkable. The 396 pending gap suggestions on igris-ai
#      (734 across ALL projects — a different scope; do not conflate them, that
#      conflation is what TD-325 exists to stop) are the standing
#      reminder until the retroactive ticks are done; dismissing them is the
#      LAST step of the audit (TD-075), not the first step of the fix. The
#      validator is the only new surface that could plausibly reach that queue,
#      so it must not so much as name it.
# -----------------------------------------------------------------------------
#      SCOPE OF THIS ASSERTION: S1 greps the VALIDATOR FILE only. It does NOT
#      assert anything about the change set as a whole — that grep is a real
#      but separate, unautomated check. Stating the limit is the point.
@test "(S1) the AC validator never references the suggestions queue (AC #7)" {
  [ -f "$VALIDATOR" ] || { echo "validator not found at $VALIDATOR"; return 1; }
  ! grep -qi 'suggestion' "$VALIDATOR" || return 1
}

@test "(S2) validator reports unticked and reason-less deferrals separately" {
  # Three terminal briefs: one clean, one unticked, one [~]-without-reason.
  write_md "$SCRATCH/clean.md" <<'MD'
# TD-601

## Acceptance Criteria
- [x] met
MD
  write_md "$SCRATCH/open.md" <<'MD'
# TD-602

## Acceptance Criteria
- [ ] not met
MD
  write_md "$SCRATCH/bad.md" <<'MD'
# TD-603

## Acceptance Criteria
- [~] no reason given here
MD
  seed_brief_file TD-601 "$SCRATCH/clean.md"; seed_brief_status TD-601 Done
  seed_brief_file TD-602 "$SCRATCH/open.md";  seed_brief_status TD-602 Done
  seed_brief_file TD-603 "$SCRATCH/bad.md";   seed_brief_status TD-603 Archived

  # ...plus an IN-FLIGHT brief with open boxes, which must NOT be reported: the
  # invariant only binds at a terminal state.
  seed_brief_file TD-604 "$SCRATCH/open.md";  seed_brief_status TD-604 "In Progress" BUILDING

  run bash -c "BRAIN_DB='$DB' PROJECT='$PROJECT' bash '$VALIDATOR' 2>&1"
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-602"* ]] || return 1
  [[ "$output" == *"TD-603"* ]] || return 1
  [[ "$output" != *"TD-601"* ]] || return 1
  [[ "$output" != *"TD-604"* ]] || return 1
}

@test "(S3) validator --list emits bare brief ids (the TD-075 worklist driver)" {
  write_md "$SCRATCH/open.md" <<'MD'
# TD-602

## Acceptance Criteria
- [ ] not met
MD
  seed_brief_file TD-602 "$SCRATCH/open.md"; seed_brief_status TD-602 Done

  run bash -c "BRAIN_DB='$DB' PROJECT='$PROJECT' bash '$VALIDATOR' --list 2>&1"
  [ "$status" -eq 1 ]
  [ "$output" = "TD-602" ]
}

@test "(S4) validator with no DB -> exit 0 (fail-open)" {
  rm -f "$DB"
  run bash -c "BRAIN_DB='$DB' PROJECT='$PROJECT' bash '$VALIDATOR' 2>&1"
  [ "$status" -eq 0 ]
}

@test "(S5) validator on a clean corpus -> exit 0 and says so" {
  write_md "$SCRATCH/clean.md" <<'MD'
# TD-601

## Acceptance Criteria
- [x] met
MD
  seed_brief_file TD-601 "$SCRATCH/clean.md"; seed_brief_status TD-601 Done

  run bash -c "BRAIN_DB='$DB' PROJECT='$PROJECT' bash '$VALIDATOR' 2>&1"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (S6) The validator and the gate must never disagree about who is affected —
#      that identity is the whole architecture. Both read the same parser, so
#      the proof is that the brief the validator NAMES is the brief the hook
#      REFUSES, on the same fixture, in the same sandbox.
# -----------------------------------------------------------------------------
@test "(S6) the validator's population and the gate's refusal set agree" {
  seed_brief_file TD-347 "$FIXTURES/TD-347.md"; seed_brief_status TD-347 Done

  run bash -c "BRAIN_DB='$DB' PROJECT='$PROJECT' bash '$VALIDATOR' --list 2>&1"
  [ "$status" -eq 1 ]
  [ "$output" = "TD-347" ]

  closing_msg TD-347
  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-347"* ]] || return 1
}
