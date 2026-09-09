#!/usr/bin/env bats

# phase_guard.test.bash — FR-186 / G-01R. Tests for the re-pointed PI-004
# phase guard in scripts/git-hooks/pre-commit.
#
# What changed (G-01R): the guard used to read the Active Brief from the
# retired session/CURRENT_SESSION.md. FR-133 archived that file, so the grep
# returned empty and the guard went silently inert. The fix re-points
# brief discovery to the brain `instances` registry (machine-scoped, freshest
# activity), with a per-instance session-file fallback, then a legacy
# CURRENT_SESSION.md fallback. The gate decision still uses brief_status.phase
# (refuse on BUILDING|TESTING) — only the brief-DISCOVERY source changed.
#
# Test isolation
# --------------
# The hook hardcodes $HOME/.igris/memory/knowledge.db and
# $HOME/.igris/projects/<project>/session/... — so a fresh HOME scratch dir
# isolates the whole fixture. The hook derives PROJECT from
# basename(git rev-parse --show-toplevel); each test runs the hook from inside
# a sandbox git repo whose basename we control, and seeds the instances /
# brief_status rows for THAT project slug + THIS machine's hostname.
#
# Why exit code is the contract: when the guard fires it `exit 1` at the top of
# the hook (before any validator). When it does NOT fire, the hook proceeds;
# with no enum/lockfile/harness/skill files staged the remaining validators are
# all skipped and the hook exits 0. So: guard-fires <=> exit 1, otherwise exit 0.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory ID 287: macOS system sqlite3 can't load vec0/FTS5 — we only create
# plain instances + brief_status tables (no vec0 / FTS5).
# Memory ID 29: cover the edge verdicts (fail-open tiers, machine
# disambiguation), not just the happy path.

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/pre-commit"

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"

  HOSTNAME_LOCAL="$(hostname)"

  # Sandbox scratch dir. The project slug is the repo's basename — we name the
  # repo 'gproj' so PROJECT=gproj deterministically.
  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/pg.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO"
  # Initialise a real git repo so `git rev-parse --show-toplevel` resolves.
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  # The hook lives at .git/hooks/pre-commit normally; we invoke the SOURCE hook
  # directly with cwd = repo so REPO_ROOT resolves to $REPO.

  INSTANCES_DIR="$FAKEHOME/.igris/projects/$PROJECT/session/instances"
  mkdir -p "$INSTANCES_DIR"

  # instances + brief_status schema (mirrors brain-mcp-server/src/db.ts).
  sqlite3 "$DB" "
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT,
      project_slug TEXT,
      project_path TEXT,
      current_brief TEXT,
      current_phase TEXT,
      current_task TEXT,
      status TEXT DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
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

# run_guard [extra env...] — invoke the source hook with cwd=$REPO and a fake
# HOME. Captures combined stdout+stderr + exit status via bats `run`.
run_guard() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' 2>&1"
}

# sql_q <text> — single-quote-escape for an SQL literal (TD-453: the seeders
# must be able to plant a hostname that CARRIES a quote). UNQUOTED expansion
# on purpose: under /bin/bash 3.2 the double-quoted form keeps the backslashes
# literal (`it\'\'s`) and corrupts the SQL — the defect (h1)/(h2)/(h6) found in
# the hook itself; same idiom as core/hooks/shared/session_start.sh.
sql_q() {
  local esc
  esc=${1//\'/\'\'}
  printf '%s' "$esc"
}

# seed_instance <brief> <status> <hostname> [phase]
seed_instance() {
  local brief="$1" istatus="$2" host="$3" phase="${4:-BUILDING}"
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, current_brief, current_phase, status, last_activity_at)
      VALUES ('$(sql_q "$brief")-$(sql_q "$host")', '$(sql_q "$host")', '$(sql_q "$PROJECT")', '$(sql_q "$brief")', '$phase', '$istatus', datetime('now'));
  "
}

# seed_brief <brief> <phase> [status-spelling]
# The status spelling is parameterised because the live brain holds MORE THAN
# ONE in-flight spelling ('In Progress' 26 rows, 'InProgress' 4 rows as of
# TD-340). The guard must gate on the STATE, not on one notation of it.
seed_brief() {
  local brief="$1" phase="$2" bstatus="${3:-In Progress}"
  sqlite3 "$DB" "
    INSERT INTO brief_status (project, brief_id, title, status, phase)
      VALUES ('$(sql_q "$PROJECT")', '$brief', 't', '$bstatus', '$phase');
  "
}

# -----------------------------------------------------------------------------
# (a) THE PROVING CASE (G-01R closed): active instance row on THIS machine with
#     current_brief=FR-999, brief_status phase=BUILDING -> guard FIRES (exit 1).
#     Pre-fix the guard read the absent CURRENT_SESSION.md, found no brief, and
#     fail-open'd to exit 0. This test would FAIL on the old code, PASS now.
# -----------------------------------------------------------------------------
@test "(a) active instance + BUILDING phase -> guard refuses commit (exit 1)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-999" "BUILDING"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"phase guard"* ]]
  [[ "$output" == *"FR-999"* ]]
  [[ "$output" == *"BUILDING"* ]]
}

# -----------------------------------------------------------------------------
# (a2) TD-340 THE HOLE: identical fixture to (a) but the brief's status is
#      spelled 'InProgress' (no space) — a spelling that exists in the live
#      brain (4 rows). The pre-TD-340 guard filtered `status='In Progress'`,
#      which cannot match, so the phase lookup returned EMPTY and the guard
#      FAILED OPEN: exit 0 while a BUILDING brief was mid-hunt.
#
#      This test FAILS on the pre-fix hook (observed: exit 0, no output) and
#      passes on the notation-folded predicate.
# -----------------------------------------------------------------------------
@test "(a2) TD-340: status spelled 'InProgress' -> guard still refuses (no fail-open)" {
  seed_instance "FR-997" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-997" "BUILDING" "InProgress"

  run_guard
  [ "$status" -eq 1 ]
  # `|| return 1`: bash does not fire the ERR trap for a `[[ ]]` compound
  # conditional, and bats-core detects mid-test failures via that trap
  # (errexit is OFF inside a test body). A bare non-final `[[ ... ]]` fails
  # SILENTLY. These TD-340 assertions must be able to fail.
  [[ "$output" == *"phase guard"* ]] || return 1
  [[ "$output" == *"FR-997"* ]] || return 1
  [[ "$output" == *"BUILDING"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a3) TD-340 notation generalisation: the fold covers case/space/hyphen/
#      underscore, not just the one extra literal 'InProgress'. A FOURTH
#      notation ('in_progress') must also gate. This is the test that fails if
#      someone "fixes" the hole by hardcoding a second literal instead.
# -----------------------------------------------------------------------------
@test "(a3) TD-340: a fourth notation ('in_progress') also gates the guard" {
  seed_instance "FR-996" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-996" "BUILDING" "in_progress"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-996"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a4) TD-340 ASYMMETRY control: the fold must NOT swallow terminal states.
#      A brief whose status is 'Completed' is finished — the phase guard must
#      NOT fire on it even if a stale phase value says BUILDING. This is the
#      negative control that travels the SAME code path as (a2)/(a3): same
#      instance discovery, same SQL, only the status word differs.
# -----------------------------------------------------------------------------
@test "(a4) TD-340: terminal status 'Completed' is NOT folded into in-flight" {
  seed_instance "FR-995" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-995" "BUILDING" "Completed"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]] || return 1
  [[ "$output" != *"FR-995"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (b) Bypass honored: same fixture, IGRIS_BYPASS_PHASE_GUARD=1 -> exit 0.
#     (The orchestrator's COMMITTING path relies on this — see §8 prereq.)
# -----------------------------------------------------------------------------
@test "(b) IGRIS_BYPASS_PHASE_GUARD=1 -> guard skipped (exit 0)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-999" "BUILDING"

  run_guard "IGRIS_BYPASS_PHASE_GUARD=1"
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# (c) Phase not gated: brief_status.phase=REVIEWING -> guard does NOT fire.
#     The guard only blocks BUILDING|TESTING.
# -----------------------------------------------------------------------------
@test "(c) phase=REVIEWING -> guard does not fire (exit 0)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "REVIEWING"
  seed_brief "FR-999" "REVIEWING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# (d) Fail-open preserved — no brain DB at all: no instances, no DB ->
#     guard skips silently, exit 0 (the documented fail-open contract).
# -----------------------------------------------------------------------------
@test "(d) no brain DB -> fail-open (exit 0, no error)" {
  rm -f "$DB"
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
  [[ "$output" != *"phase guard"* ]]
}

# -----------------------------------------------------------------------------
# (e) Fallback tier: no instances ROW in DB (so tier-1 yields empty), but a
#     per-instance session file carries **Active Brief:** FR-999. The guard
#     resolves the brief via the file tier; the phase lookup then finds the
#     seeded BUILDING brief_status row -> guard FIRES. This proves the
#     per-instance-file fallback wiring resolves the brief.
# -----------------------------------------------------------------------------
@test "(e) fallback to per-instance session file resolves the brief" {
  # No instances row -> tier 1 empty. brief_status row present for the lookup.
  seed_brief "FR-999" "BUILDING"
  cat > "$INSTANCES_DIR/aaaaaaaa-1111-2222-3333-444444444444.md" <<'MD'
## Status
**Mode:** HUNT MODE
**Instance ID:** aaaaaaaa-1111-2222-3333-444444444444
**Machine:** test (darwin)
**Updated:** 2026-06-17
**Active Brief:** FR-999 (some annotation)
MD

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-999"* ]]
  [[ "$output" == *"BUILDING"* ]]
}

# -----------------------------------------------------------------------------
# (e2) Fallback tier resolves a brief with NO claim ("Active Brief: None") ->
#      resolves to empty -> guard skips (a planning session must not gate).
# -----------------------------------------------------------------------------
@test "(e2) per-instance file with 'Active Brief: None' -> guard skips (exit 0)" {
  cat > "$INSTANCES_DIR/bbbbbbbb-1111-2222-3333-444444444444.md" <<'MD'
## Status
**Active Brief:** None — planning only
MD

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# (f) Machine disambiguation: a BUILDING instance row exists but for a DIFFERENT
#     machine_hostname. The local-machine query must NOT pick the foreign row ->
#     no brief discovered -> guard skips, exit 0. Proves the guard won't gate on
#     another machine's session.
# -----------------------------------------------------------------------------
@test "(f) foreign-machine BUILDING instance -> not selected (exit 0)" {
  seed_instance "FR-888" "active" "some-other-host" "BUILDING"
  seed_brief "FR-888" "BUILDING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
  [[ "$output" != *"FR-888"* ]]
}

# -----------------------------------------------------------------------------
# (f2) Disambiguation positive control: same foreign row PLUS a local-machine
#      active row in BUILDING -> the local row IS selected -> guard FIRES.
#      Proves (f)'s exit-0 was the foreign-row exclusion, not a dead query.
# -----------------------------------------------------------------------------
@test "(f2) local + foreign instance rows -> local selected, guard fires" {
  seed_instance "FR-888" "active" "some-other-host" "BUILDING"
  seed_instance "FR-777" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-888" "BUILDING"
  seed_brief "FR-777" "BUILDING"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-777"* ]]
  [[ "$output" != *"FR-888"* ]]
}

# -----------------------------------------------------------------------------
# (f3) Stale instance excluded: a BUILDING row on THIS machine but status='stale'
#      (the registry reaper marks >45min rows stale) -> NOT selected (query
#      filters status='active') -> guard skips, exit 0.
# -----------------------------------------------------------------------------
@test "(f3) stale local instance (status!=active) -> not selected (exit 0)" {
  seed_instance "FR-666" "stale" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-666" "BUILDING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# BR-100 — the machine IDENTITY replaces the bare hostname in tier 1.
#   (g1) a row under a PRIOR hostname (an alias, NULL machine_id) is found;
#   (g2) a row with MY machine_id under a foreign hostname is found;
#   (g3) a row with a FOREIGN machine_id under MY hostname is NOT found;
#   (g4) a brain WITHOUT the column falls back to hostname-in-aliases;
#   (g5) G10 self-negative: a hook copy with the identity section removed
#        flips (g1) back to exit 0 — proves the section is what makes it fire.
# -----------------------------------------------------------------------------

# add_machine_id_column — the instances v5 shape.
add_machine_id_column() {
  sqlite3 "$DB" "ALTER TABLE instances ADD COLUMN machine_id TEXT;"
}

# seed_identity <id> [alias...] — config.json `machine` block in the fake HOME.
seed_identity() {
  local mid="$1"; shift
  local aliases="" a
  for a in "$@"; do
    [ -n "$aliases" ] && aliases="$aliases, "
    aliases="$aliases\"$a\""
  done
  printf '{"machine":{"id":"%s","aliases":[%s]}}\n' "$mid" "$aliases" > "$FAKEHOME/.igris/config.json"
}

# seed_instance_id <brief> <status> <hostname> <machine_id-or-NULL> [phase] [last_activity_at]
# The optional timestamp orders rows for the tier-1 `ORDER BY last_activity_at
# DESC LIMIT 1` (TD-453 h3: the injected predicate would surface the NEWER
# foreign row over my older one).
seed_instance_id() {
  local brief="$1" istatus="$2" host="$3" mid="$4" phase="${5:-BUILDING}" seen="${6:-}"
  local mid_sql="NULL" seen_sql="datetime('now')"
  [ "$mid" != "NULL" ] && mid_sql="'$(sql_q "$mid")'"
  [ -n "$seen" ] && seen_sql="'$seen'"
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, current_brief, current_phase, status, last_activity_at, machine_id)
      VALUES ('$(sql_q "$brief")-$(sql_q "$host")', '$(sql_q "$host")', '$(sql_q "$PROJECT")', '$(sql_q "$brief")', '$phase', '$istatus', $seen_sql, $mid_sql);
  "
}

@test "(g1) BR-100: a row under a PRIOR hostname (alias, NULL id) is this machine -> guard fires" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "MacBookAir"
  seed_instance_id "FR-555" "active" "MacBookAir" "NULL" "BUILDING"
  seed_brief "FR-555" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-555"* ]] || return 1
}

@test "(g2) BR-100: a row with MY machine_id under a foreign hostname is this machine -> guard fires" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine"
  seed_instance_id "FR-444" "active" "renamed-elsewhere" "id-mine" "BUILDING"
  seed_brief "FR-444" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-444"* ]] || return 1
}

@test "(g3) BR-100: a row with a FOREIGN machine_id under MY hostname is NOT this machine -> exit 0" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "$HOSTNAME_LOCAL"
  seed_instance_id "FR-333" "active" "$HOSTNAME_LOCAL" "id-theirs" "BUILDING"
  seed_brief "FR-333" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || return 1
  if printf '%s\n' "$output" | grep -q 'refusing commit'; then return 1; fi
}

@test "(g4) BR-100: a brain WITHOUT the column falls back to hostname-in-aliases -> alias row still found" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  seed_identity "id-mine" "MacBookAir"
  seed_instance "FR-222" "active" "MacBookAir" "BUILDING"
  seed_brief "FR-222" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-222"* ]] || return 1
}

@test "(g5) G10 self-negative: a hook copy WITHOUT the identity section no longer finds the alias row (exit 0)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "MacBookAir"
  seed_instance_id "FR-111" "active" "MacBookAir" "NULL" "BUILDING"
  seed_brief "FR-111" "BUILDING"

  # Same arrangement as (g1) fires on the real hook…
  run_guard
  [ "$status" -eq 1 ] || return 1

  # …and a copy with the identity section deleted reverts to the live-hostname-only query.
  local mutant="$SANDBOX/pre-commit.no-identity"
  sed '/# BR-100 identity: begin/,/# BR-100 identity: end/d' "$HOOK_SRC" > "$mutant"
  grep -q 'IDENTITY_LINE' "$mutant" && return 1   # the section really is gone
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' bash '$mutant' 2>&1"
  [ "$status" -eq 0 ] || return 1
}

# -----------------------------------------------------------------------------
# TD-453 — a hostname, alias or machine id that CARRIES a quote reaches the
# tier-1 query escaped (three sites in the hook: HOSTNAME_SQL, every alias,
# MACHINE_ID_SQL). The hook discards sqlite3's stderr (`2>/dev/null`), so "the
# query errored" is NOT observable; the witness is two-directional and
# behavioural instead. A no-escape MUTANT of the hook — $HOOK_SRC with the
# three escapes replaced by their raw forms, each replacement proven landed —
# reads a quoted alias / hostname / id row as "no active brief" (exit 0, the
# false fail-open: h4, h4c, h4d) AND lets an injected alias match a FOREIGN
# row (exit 1: h4b), while the real hook does neither (h1–h3). h5 is the
# control: a CLEAN name fires identically on both, so h4's red is the quote and
# not the arrangement. The repo hook is never edited (the TD388_WRAPPER_SRC
# idiom); bash 3.2 throughout.
# -----------------------------------------------------------------------------

# stub_hostname <name> — a PATH-first `hostname` printing <name>. Pass
# "PATH='$SANDBOX/stubbin:$PATH'" to run_guard (it accepts env prefixes).
stub_hostname() {
  mkdir -p "$SANDBOX/stubbin"
  { printf '#!/bin/bash\n'; printf 'printf "%%s\\n" %q\n' "$1"; } > "$SANDBOX/stubbin/hostname"
  chmod +x "$SANDBOX/stubbin/hostname"
}

# The three tier-1 escaping sites (post-TD-453 form: UNQUOTED assignment —
# the double-quoted `"${x//\'/\'\'}"` keeps the backslashes literal under
# /bin/bash 3.2), verbatim, and their raw forms.
A_ESC="alias_sql=\${alias//\\'/\\'\\'}"
A_RAW="alias_sql=\$alias"
M_ESC="MACHINE_ID_SQL=\${MACHINE_ID//\\'/\\'\\'}"
M_RAW="MACHINE_ID_SQL=\$MACHINE_ID"
H_ESC="HOSTNAME_SQL=\${HOSTNAME_LOCAL//\\'/\\'\\'}"
H_RAW="HOSTNAME_SQL=\$HOSTNAME_LOCAL"

# count_sites <file> <p1> <p2> <p3> — fixed-string line count over the three patterns.
count_sites() {
  local f="$1" n=0 p
  shift
  for p in "$@"; do
    n=$((n + $(grep -cF -- "$p" "$f" || true)))
  done
  echo "$n"
}

# build_no_escape_mutant — $SANDBOX/pre-commit.no-escape. Asserts each of the
# three replacements LANDED (escaped forms 3 -> 0, raw forms 0 -> 3;
# test_standards: a mutation that did not land is a meaningless green).
build_no_escape_mutant() {
  MUTANT="$SANDBOX/pre-commit.no-escape"
  [ "$(count_sites "$HOOK_SRC" "$A_ESC" "$M_ESC" "$H_ESC")" = "3" ] || { echo "hook: expected 3 escaped sites" >&2; return 1; }
  [ "$(count_sites "$HOOK_SRC" "$A_RAW" "$M_RAW" "$H_RAW")" = "0" ] || { echo "hook: expected 0 raw sites" >&2; return 1; }
  python3 - "$HOOK_SRC" "$MUTANT" "$A_ESC" "$A_RAW" "$M_ESC" "$M_RAW" "$H_ESC" "$H_RAW" <<'PY' || return 1
import sys
src, dst = sys.argv[1], sys.argv[2]
pairs = list(zip(sys.argv[3::2], sys.argv[4::2]))
text = open(src, encoding="utf-8").read()
for esc, raw in pairs:
    if text.count(esc) != 1:
        sys.exit("site not found exactly once: " + esc)
    text = text.replace(esc, raw)
open(dst, "w", encoding="utf-8").write(text)
PY
  [ "$(count_sites "$MUTANT" "$A_ESC" "$M_ESC" "$H_ESC")" = "0" ] || { echo "mutant: escaped sites remain" >&2; return 1; }
  [ "$(count_sites "$MUTANT" "$A_RAW" "$M_RAW" "$H_RAW")" = "3" ] || { echo "mutant: raw sites missing" >&2; return 1; }
  return 0
}

run_mutant() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$MUTANT' 2>&1"
}

@test "(h1) TD-453: an ALIAS carrying a quote (it's;old-host) still finds my NULL-id row -> exit 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "it's;old-host"
  seed_instance_id "FR-451" "active" "it's;old-host" "NULL" "BUILDING"
  seed_brief "FR-451" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-451"* ]] || return 1
}

@test "(h2) TD-453: a LIVE hostname carrying a quote (it's;host, PATH stub, no config.json) still finds my row -> exit 1" {
  stub_hostname "it's;host"
  seed_instance "FR-452" "active" "it's;host" "BUILDING"
  seed_brief "FR-452" "BUILDING"
  run_guard "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-452"* ]] || return 1
}

# (h3)'s arrangement: my OLDER row under a clean alias, a NEWER foreign row
# under a foreign id, both briefs BUILDING, and an injected alias in config.
# The real hook must name MINE (the query ran, the injection widened nothing);
# a query that errored would name nothing (exit 0), and the no-escape mutant
# names the FOREIGN row (the injected predicate admits it, and it is newer).
seed_h3() {
  add_machine_id_column
  seed_identity "id-mine" "clean-host" "x') OR ('1'='1"
  seed_instance_id "FR-456" "active" "clean-host" "NULL" "BUILDING" "2026-01-01 00:00:00"
  seed_instance_id "FR-453" "active" "some-other-host" "id-theirs" "BUILDING" "2026-06-01 00:00:00"
  seed_brief "FR-456" "BUILDING"
  seed_brief "FR-453" "BUILDING"
}

@test "(h3) TD-453: an INJECTED alias (x') OR ('1'='1) widens nothing — the real hook names MY row, not the newer FOREIGN one" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  seed_h3
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-456"* ]] || return 1
  [[ "$output" != *"FR-453"* ]] || return 1
}

@test "(h4) TD-453 RED: the no-escape MUTANT (3 sites raw, each proven landed) reads h1's quoted alias as 'no active brief' -> exit 0; the real hook exits 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id-mine" "it's;old-host"
  seed_instance_id "FR-451" "active" "it's;old-host" "NULL" "BUILDING"
  seed_brief "FR-451" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  run_mutant
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"FR-451"* ]] || return 1
}

@test "(h4b) TD-453 RED: the no-escape MUTANT lets h3's injected alias admit the newer FOREIGN row (names FR-453); the real hook names mine (FR-456)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  seed_h3
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-456"* ]] || return 1
  run_mutant
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-453"* ]] || return 1
  [[ "$output" != *"FR-456"* ]] || return 1
}

@test "(h4c) TD-453 RED: the no-escape MUTANT reads h2's quoted LIVE hostname as 'no active brief' -> exit 0; the real hook exits 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  stub_hostname "it's;host"
  seed_instance "FR-452" "active" "it's;host" "BUILDING"
  seed_brief "FR-452" "BUILDING"
  run_guard "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 1 ] || return 1
  run_mutant "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 0 ] || return 1
}

@test "(h4d) TD-453 RED: a MACHINE ID carrying a quote (id'mine) — real hook finds my id row (exit 1); the no-escape MUTANT reads 'no active brief' (exit 0)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id'mine"
  seed_instance_id "FR-454" "active" "some-other-host" "id'mine" "BUILDING"
  seed_brief "FR-454" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-454"* ]] || return 1
  run_mutant
  [ "$status" -eq 0 ] || return 1
}

@test "(h5) TD-453 control: a CLEAN alias fires on the real hook AND on the no-escape mutant (exit 1 both) — h4's red is the quote" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id-mine" "old-host"
  seed_instance_id "FR-455" "active" "old-host" "NULL" "BUILDING"
  seed_brief "FR-455" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  run_mutant
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-455"* ]] || return 1
}

@test "(h6) TD-453: a PROJECT (repo basename) carrying a quote (it's-proj) reaches both tier-1 queries escaped -> exit 1" {
  # PROJECT_SQL is built at two sites (the instances query and the brief_status
  # phase query); a fail-open at either reads "no active brief" / no phase.
  PROJECT="it's-proj"
  QREPO="$SANDBOX/$PROJECT"
  mkdir -p "$QREPO"
  git -C "$QREPO" init -q
  seed_instance "FR-457" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-457" "BUILDING"
  run bash -c "cd \"$QREPO\" && HOME='$FAKEHOME' bash '$HOOK_SRC' 2>&1"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-457"* ]] || return 1
}
