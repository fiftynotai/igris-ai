#!/usr/bin/env bats

# release-audit-bypass-ids.bats — BR-091 regression test for the /release
# Step 0 AUDIT=BYPASS arm (coding_guidelines §17.2, executor in
# core/skills/release/SKILL.md).
#
# SIBLING FILE: release-audit-brief-type.bats pins the §17.2 PREDICATE (TD-289
# brief_type half + TD-340 status half). This file pins how the predicate's
# RESULT is turned into the durable CHANGELOG audit record. A future reader of
# either file should read both — the §17.2 pin set is split across the two, and
# "the pin covered one half so the other rotted" is literally the TD-289 →
# TD-340 lesson.
#
# THIS FILE ADDS NO FOURTH COPY OF THE PREDICATE. The copy count stays at
# THREE (coding_guidelines §17.2, core/skills/release/SKILL.md, and the sibling
# file's two pinned halves); setup() EXTRACTS the predicate from the shipped
# skill rather than restating it. Stated precisely, because a bare "holds no
# copy" claim would be false: the counting guard at the bottom greps for the
# PREFIX `brief_type IN ('Bug','BR'`. That fragment is deliberately short, so a
# widening that APPENDS types still matches it, while a change that reorders or
# drops 'BR' reddens this file loudly instead of drifting silently. It is a
# guard pattern, not a lockstep copy.
#
# THE DEFECT (BR-091). Step 0 used to derive the bypassed brief-id list by
# re-parsing its own human-rendered output:
#
#     BYPASSED_IDS="$(printf '%s\n' "$ROWS" | awk '{print $1}' | paste -sd, -)"
#
# and the skill REQUIRES that string to be written into CHANGELOG.md as
# `> RELEASE AUDIT BYPASSED (IGRIS_BYPASS_RELEASE_AUDIT=1): <ids>`, where it
# ships as the durable record of which briefs a release waived.
#
# THE TRIGGER IS DOUBLE QUOTES IN A TITLE, PLUS RE-SHAPING — NOT A NEWLINE.
# Get this wrong in prose and you repeat the defect the brief is about.
# TD-345's title contains `into "no match",`. Run the snippet VERBATIM in one
# shell and the pipeline is CORRECT — `printf '%s\n' "$ROWS"` receives one
# argument. Splice $ROWS into the script text of a nested `bash -c` (how it was
# actually invoked while cutting v7.2.1 on 2026-08-12) and the title's own
# quotes close the printf argument early; printf receives MULTIPLE arguments
# and repeats its format per argument, one line each, so `awk '{print $1}'`
# reads a title fragment's first word as a brief id:
#
#     verbatim   -> FR-236,FR-243,TD-345,FR-251          (correct)
#     re-shaped  -> FR-236,FR-243,TD-345,match,,FR-251   (corrupt)
#
# WHY THAT IS A DEFECT IN THE SKILL AND NOT ONLY IN ONE INVOCATION: Step 0 is
# bash embedded in a document whose executor is a MODEL, not a script run by a
# scheduler. It gets re-typed, re-quoted, wrapped in `bash -c` or pasted into a
# subshell as a matter of course. "Correct under exact quoting" is a weaker
# guarantee than it looks. A DB-derived value has no rendered intermediate and
# survives every re-shaping — which is what the fix buys, and what the
# both-invocation-forms test below is the assertion for.
#
# NEWLINES ARE DEFENCE IN DEPTH ONLY, AND THE FIXTURE FOR THEM IS SYNTHETIC.
# BR-091 was originally filed asserting a newline in TD-345's title. That was
# INFERRED from the corrupt output's shape, not observed: TD-345's title is 144
# characters with no 0A/0D/09 byte, and 0 of 1966 brief titles across 35
# projects contain a newline. The newline test below is labelled SYNTHETIC and
# seeds its own row; do not rewrite it as if it modelled an observed brief.
#
# NO TEST HERE FOR A TWO-SPACE DELIMITER IN A TITLE. `awk '{print $1}'` takes
# the first whitespace-delimited field, so intra-title spacing was structurally
# irrelevant to the OLD pipeline too — that case has no red state and a test
# for it could only ever be green.
#
# LIMITATION (same as the sibling file's): Step 0 is a skill-only markdown
# procedure with an inline sqlite3 query — no CLI verb, no extracted script, no
# entry point a test can invoke. Extracting the whole fenced block and eval'ing
# it was considered and rejected: the block hard-codes
# DB="$HOME/.igris/memory/knowledge.db" and shells out to `igris detect`, so it
# would need a stubbed `igris` on PATH plus a HOME override, and it would be
# testing the whole Step 0 procedure rather than the contract BR-091 breaks.
# Instead this file (a) source-guards the committed skill so the shipped bytes
# are the ones exercised, and (b) runs both the buggy and the fixed derivations
# verbatim against a seeded temp DB. Both are self-contained pipelines, so the
# red/green here is a genuine execution. What it CANNOT prove is that a model
# running a real /release produces the right string — nothing executes the
# markdown. That last mile is closed by the manual reproduction recorded in the
# BR-091 hunt log, not by any assertion below.
#
# HARNESS NOTE: every substring assertion below is written `[[ ... ]] ||
# return 1`. bash does NOT fire the ERR trap for a `[[ ]]` compound
# conditional and bats-core detects mid-test failures via that trap (errexit is
# OFF inside a test body), so a bare non-final `[[ ... ]]` fails SILENTLY and
# the test still reports ok. Single-bracket `[ ... ]` IS trapped. (TD-341)

load _helpers.bash

# The correct list for the seeded fixture — the same list that had to be
# substituted BY HAND while cutting v7.2.1. The corruption was caught by eye
# before anything was written, so no shipped record was ever wrong. (Do not
# grep this branch's CHANGELOG for it: 7.2.1 was cut on a hotfix branch off
# v7.2.0, and the entry there already carries the corrected list.)
EXPECTED_IDS="FR-236, FR-243, FR-251, TD-345"

# The exact corruption measured on 2026-08-12 and reproduced by the red control
# below. `match,` is ONE token (the comma is part of it) and `paste` then adds
# its own separator — that is where the apparent "empty entry" comes from.
CORRUPT_IDS="FR-236,FR-243,TD-345,match,,FR-251"

# TD-345's title, VERBATIM and UNMODIFIED from the live brain (hex-verified:
# 144 chars, zero control bytes). The load-bearing bytes are the two DOUBLE
# QUOTES in `into "no match",`. Frozen here on purpose — this test never reads
# the live brain, whose blocker set and titles move.
TD345_TITLE='The contract checker silently drops ~10% of its warnings — SIGPIPE plus pipefail turns a grep MATCH into "no match", a different subset each run'

# extract_audit_where — lift the multi-line AUDIT_WHERE binding out of the
# shipped skill and resolve its one variable ($SLUG) to the fixture's project.
# Reads from the first line matching the binding through the first following
# line that CLOSES the double quote.
#
# The opening line is handled separately: it always contains a `"` (the one that
# OPENS the binding), so "ends with a quote" can only be judged on what follows
# `AUDIT_WHERE="`. A naive `$0 !~ /AUDIT_WHERE="/` exit condition instead
# over-reads past a one-line binding and swallows unrelated lines — caught by
# the arm check in the harness self-check test, which truncates the binding to
# one line on purpose.
extract_audit_where() {
  awk '
    /^  AUDIT_WHERE="/ {
      f = 1
      print
      tail = $0
      sub(/^  AUDIT_WHERE="/, "", tail)
      if (tail ~ /"$/) exit
      next
    }
    f { print; if ($0 ~ /"$/) exit }
  ' "$SKILL_MD" \
    | sed -e '1s/^  AUDIT_WHERE="//' -e '$s/"$//' \
    | sed 's/[$]SLUG/igris-ai/'
}

setup() {
  # Repo skill path — the committed executor artifact. Derived from CLI_DIST
  # (=<repo>/cli/dist, exported by _helpers) because under bats
  # ${BASH_SOURCE[0]} points at a preprocessed temp file, not this file.
  SKILL_MD="$CLI_DIST/../../core/skills/release/SKILL.md"

  # The §17.2 predicate is EXTRACTED from the shipped skill, never copied here.
  # A copy would be a FOURTH one (after coding_guidelines §17.2, the skill, and
  # the sibling file's two pinned halves) — precisely the DRY hazard the
  # counting guard below exists to forbid — and it would let these behavioural
  # tests keep passing against a STALE predicate after a future widening.
  # Extracting also means every assertion below provably exercises the
  # committed executor bytes. Trade-off, stated: a future edit to the skill's
  # predicate changes what these tests query. That is intended — a narrowing
  # reddens the exact-string tests and a widening reddens the out-of-scope
  # control. The predicate's SEMANTICS remain pinned by the sibling file.
  AUDIT_WHERE="$(extract_audit_where)"

  # Harness self-check: an extraction that silently returned nothing would make
  # every query below match no rows, and several assertions would still pass.
  [ -n "$AUDIT_WHERE" ]
  [[ "$AUDIT_WHERE" == *"brief_type IN ("* ]] || return 1
  [[ "$AUDIT_WHERE" == *"replace(replace(replace(lower(status)"* ]] || return 1
  [[ "$AUDIT_WHERE" != *'$SLUG'* ]] || return 1

  DB="$BATS_TEST_TMPDIR/knowledge.db"
  sqlite3 "$DB" "CREATE TABLE brief_status (
    brief_id TEXT, project TEXT, priority TEXT, status TEXT,
    brief_type TEXT, title TEXT
  );"

  # The four rows that blocked the v7.2.1 tag, with their real titles. Only
  # TD-345's carries the quote trigger; the other three are ordinary.
  sqlite3 "$DB" <<SQL
INSERT INTO brief_status VALUES
  ('FR-236','igris-ai','P1-High','Ready','Feature','Research: ceremony tiering — a low-ceremony hunt and how to route work to it'),
  ('FR-243','igris-ai','P1-High','Ready','Feature','Project git-level gates into consumer projects — and make a half-installed gate fail loudly'),
  ('TD-345','igris-ai','P1-High','Ready','Bug','$TD345_TITLE'),
  ('FR-251','igris-ai','P1-High','Ready','Feature','A stated rationale is a claim — register the obligation and move its countermeasure from review-time to build-time');
SQL

  # Out-of-scope control: P0 but 'Technical Debt' is not the §17.2 class.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('TD-100','igris-ai','P0-Critical','Ready','Technical Debt','tech-debt — not §17.2 class');"
}

# --------------------------------------------------------------------------
# The two derivations, each in BOTH invocation forms.
# --------------------------------------------------------------------------

# rendered_rows — the human-facing BLOCK listing (unchanged by BR-091).
rendered_rows() {
  sqlite3 -noheader "$DB" "
    SELECT brief_id || '  ' || priority || '  ' || status || '  ' || brief_type || '  ' || title
    FROM brief_status
    WHERE $AUDIT_WHERE;"
}

# id_sql — the replacement derivation: brief_id ONLY, over the same predicate.
# ORDER BY sits in a SUBQUERY, not beside group_concat: the in-aggregate form
# needs SQLite >= 3.44 and macOS system sqlite3 is older. SQLite's flattener
# refuses to flatten an ORDER BY subquery into an aggregate outer query, so the
# ordering survives.
id_sql() {
  echo "SELECT group_concat(brief_id, ', ') FROM (
      SELECT brief_id FROM brief_status
      WHERE $AUDIT_WHERE
      ORDER BY brief_id);"
}

# --- OLD (pre-BR-091) derivation: parse the rendered rows ---

old_ids_verbatim() {
  local rows
  rows="$(rendered_rows)"
  printf '%s\n' "$rows" | awk '{print $1}' | paste -sd, -
}

# The 2026-08-12 invocation: $ROWS interpolated into the SCRIPT TEXT of a
# nested bash -c, so the title's quotes reach the shell's tokenizer.
old_ids_reshaped() {
  local rows
  rows="$(rendered_rows)"
  bash -c 'printf "%s\n" "'"$rows"'" | awk "{print \$1}" | paste -sd, -'
}

# --- NEW derivation: ask the DB for the column ---

new_ids_verbatim() {
  sqlite3 -noheader "$DB" "$(id_sql)"
}

# The derivation itself re-shaped into a nested bash -c.
new_ids_reshaped() {
  local sql
  sql="$(id_sql)"
  bash -c 'sqlite3 -noheader "'"$DB"'" "'"$sql"'"'
}

# The DERIVED VALUE spliced into a nested bash -c — the same splice that broke
# the old pipeline, applied to the new one's output.
new_ids_value_reshaped() {
  local ids
  ids="$(new_ids_verbatim)"
  bash -c 'printf "%s\n" "'"$ids"'"'
}

# --------------------------------------------------------------------------
# Shape predicates, applied to BOTH derivations so neither can be vacuous.
# --------------------------------------------------------------------------

# tokens_all_brief_ids <comma-separated list> — 0 iff every token is a brief id.
tokens_all_brief_ids() {
  local re='^[A-Z]{2}-[0-9]{3}$' tok toks
  IFS=',' read -ra toks <<< "$1"
  [ "${#toks[@]}" -gt 0 ] || return 1
  for tok in "${toks[@]}"; do
    tok="${tok# }"
    [[ "$tok" =~ $re ]] || return 1
  done
  return 0
}

# count_tokens <comma-separated list> — how many fields the list carries.
count_tokens() {
  local toks
  IFS=',' read -ra toks <<< "$1"
  echo "${#toks[@]}"
}

# --------------------------------------------------------------------------
# Red controls — kept PERMANENTLY. They are what prove the fix is load-bearing
# rather than cosmetic, matching the OLD_TYPE_LIST / OLD_STATUS_LIST convention
# of the sibling file.
# --------------------------------------------------------------------------

@test "red control: the OLD awk pipeline CORRUPTS the id list when re-shaped" {
  run old_ids_reshaped
  [ "$status" -eq 0 ]
  [ "$output" = "$CORRUPT_IDS" ]
  # The phantom token is a fragment of TD-345's title, not a brief id.
  [[ "$output" == *"match"* ]] || return 1
  # ...and FR-251 survived only by luck of where the split fell.
  [[ "$output" == *"FR-251"* ]] || return 1
}

@test "red control's discriminator: the OLD pipeline is CORRECT run VERBATIM" {
  # THE POINT: the trigger is the RE-SHAPING, not the data. Without this arm
  # the red control above would look like a data problem, and the obvious
  # "fix" (sanitise titles) would look sufficient. It is not — the skill is
  # executed by a model, so re-shaping is the normal case, not the exception.
  run old_ids_verbatim
  [ "$status" -eq 0 ]
  [ "$output" = "FR-236,FR-243,TD-345,FR-251" ]
  [[ "$output" != *"match"* ]] || return 1
}

# --------------------------------------------------------------------------
# Behaviour of the fix.
# --------------------------------------------------------------------------

@test "the NEW derivation is immune under BOTH invocation forms" {
  # This is the assertion that actually distinguishes the new design from the
  # old one: the old pipeline passes one form and fails the other.
  run new_ids_verbatim
  [ "$status" -eq 0 ]
  [ "$output" = "$EXPECTED_IDS" ]

  run new_ids_reshaped
  [ "$status" -eq 0 ]
  [ "$output" = "$EXPECTED_IDS" ]

  run new_ids_value_reshaped
  [ "$status" -eq 0 ]
  [ "$output" = "$EXPECTED_IDS" ]
}

@test "every token in the id list is a brief id" {
  # The check the brief says was missing: nothing validated that the tokens
  # coming out of the old pipeline were brief ids at all.
  run tokens_all_brief_ids "$(new_ids_verbatim)"
  [ "$status" -eq 0 ]

  # ARM CHECK — the same predicate REJECTS the old re-shaped output. Without
  # this arm a broken tokens_all_brief_ids (one that accepts everything) would
  # pass the assertion above and the test would be vacuous.
  run tokens_all_brief_ids "$(old_ids_reshaped)"
  [ "$status" -ne 0 ]
}

@test "id list and rendered rows agree — the two consumers cannot diverge" {
  # Counted with a SELECT count(*) over the SAME predicate, deliberately NOT
  # `wc -l` of the rendered rows — the rendered rows are the very thing that
  # lies once a title is re-split.
  local n_rows
  n_rows="$(sqlite3 -noheader "$DB" "SELECT count(*) FROM brief_status WHERE $AUDIT_WHERE;")"
  [ "$n_rows" -eq 4 ]
  [ "$(count_tokens "$(new_ids_verbatim)")" -eq "$n_rows" ]

  # ARM CHECK — the old re-shaped derivation does NOT agree (6 tokens for 4
  # rows). Both consumers reading one bound predicate is what closes this.
  [ "$(count_tokens "$(old_ids_reshaped)")" -ne "$n_rows" ]
}

@test "out-of-scope rows stay out of the audit record" {
  run new_ids_verbatim
  [ "$status" -eq 0 ]
  [ -n "$output" ]                           # a `!= *TD-100*` passes on empty
  [[ "$output" != *"TD-100"* ]] || return 1  # Technical Debt — not §17.2 class
}

@test "SYNTHETIC newline title is handled correctly (defence in depth)" {
  # SYNTHETIC FIXTURE — NOT AN OBSERVED ROW. 0 of 1966 brief titles across 35
  # projects contain a newline; BR-091's original newline claim was inferred
  # from the corrupt output's shape and is refuted in that brief's Correction
  # section. Kept because a DB-derived value should be immune to ANY title
  # content, and a newline is the strongest available probe of that. Seeded
  # in-test rather than in setup() so it cannot perturb the exact-string
  # assertions above.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('BR-900','igris-ai','P1-High','Blocked','Bug','synthetic' || char(10) || 'newline in a title');"

  run new_ids_verbatim
  [ "$status" -eq 0 ]
  [ "$output" = "BR-900, FR-236, FR-243, FR-251, TD-345" ]
  [[ "$output" != *"newline"* ]] || return 1   # no title fragment leaked in

  # ...and still immune once re-shaped.
  run new_ids_reshaped
  [ "$status" -eq 0 ]
  [ "$output" = "BR-900, FR-236, FR-243, FR-251, TD-345" ]
}

# --------------------------------------------------------------------------
# Source guards — tie these assertions to the SHIPPED executor bytes.
# --------------------------------------------------------------------------

@test "harness self-check: the predicate under test is the SHIPPED predicate" {
  # Arms every behavioural test above. If extract_audit_where silently returned
  # a truncated or empty predicate, the queries would match nothing and several
  # assertions would still pass. Asserts shape (four lines, one per clause) and
  # that all four clauses came through.
  #
  # STRUCTURAL ONLY, DELIBERATELY. The BYTE-level pin on the two §17.2 halves
  # belongs to the sibling file. Asserting the full literals here would make
  # this file a FOURTH lockstep site and contradict the copy-count-of-three
  # rule in the header — a future widening would have to remember one more
  # place, which is the failure mode, not the guard.
  [ "$(printf '%s\n' "$AUDIT_WHERE" | wc -l | tr -d ' ')" -eq 4 ]
  [[ "$AUDIT_WHERE" == "project='igris-ai'"* ]] || return 1
  [[ "$AUDIT_WHERE" == *"AND priority IN ("* ]] || return 1
  [[ "$AUDIT_WHERE" == *"AND replace(replace(replace(lower(status)"* ]] || return 1
  [[ "$AUDIT_WHERE" == *"AND brief_type IN ("* ]] || return 1

  # ARM CHECK — a REAL one. Truncate the binding in a COPY of the shipped skill,
  # run the actual extractor against that copy, and assert the shape check
  # rejects what comes back.
  #
  # The previous version of this arm compared `wc -l` of a local one-line
  # constant to 4. That proved only that 1 is not 4: it could not redden for any
  # change to the skill, to the predicate, or to extract_audit_where. This brief
  # DROPPED an acceptance criterion for exactly that property (a two-space test
  # with no red state), so shipping a green-only arm inside the fix was the one
  # thing this file must not do.
  local real="$SKILL_MD"
  local broken="$BATS_TEST_TMPDIR/SKILL-truncated.md"
  # Drop the three AND-clauses and close the quote, leaving a one-line binding.
  # `^      AND ` occurs ONLY inside the binding — both consumers read
  # `WHERE $AUDIT_WHERE`, so nothing else in the file matches.
  awk '
    /^      AND / { next }
    /^  AUDIT_WHERE="/ { print $0 "\""; next }
    { print }
  ' "$real" > "$broken"

  # Prove the mutation landed — a no-op edit would make the arm vacuous again.
  run cmp -s "$real" "$broken"
  [ "$status" -ne 0 ]

  SKILL_MD="$broken"
  local truncated
  truncated="$(extract_audit_where)"
  SKILL_MD="$real"

  # The extractor ran and returned the truncated binding, exactly...
  [ "$truncated" = "project='igris-ai'" ]
  # ...and every clause the shape check looks for is now missing, so the
  # assertions at the top of this test would FAIL on it.
  [ "$(printf '%s\n' "$truncated" | wc -l | tr -d ' ')" -ne 4 ]
  [[ "$truncated" != *"AND priority IN ("* ]] || return 1
  [[ "$truncated" != *"AND replace(replace(replace(lower(status)"* ]] || return 1
  [[ "$truncated" != *"AND brief_type IN ("* ]] || return 1
}

@test "source guard: the shipped skill sources ids from the DB, not from \$ROWS" {
  run grep -F "group_concat(brief_id, ', ')" "$SKILL_MD"
  [ "$status" -eq 0 ]

  run grep -F "awk '{print \$1}'" "$SKILL_MD"
  [ "$status" -ne 0 ]                # the rendered-row parse must be gone
  run grep -F "paste -sd" "$SKILL_MD"
  [ "$status" -ne 0 ]
}

@test "source guard: the §17.2 predicate is bound ONCE and consumed TWICE" {
  # THE DRY HAZARD. The obvious implementation pastes the WHERE clause into the
  # new query, giving the skill two copies. The sibling file's source guards are
  # whole-file `grep -F` substring tests, so if a future TD widened only the
  # FIRST copy those guards would still return 0 while the audit record silently
  # gated on a NARROWER predicate than the listing that produced it — the
  # TD-289 → TD-340 failure shape one level down. This counting guard is the
  # thing the substring pins provably cannot do.
  run grep -c "brief_type IN ('Bug','BR'" "$SKILL_MD"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]                # exactly one copy of the predicate

  run grep -c 'AUDIT_WHERE="' "$SKILL_MD"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]                # exactly one binding

  run grep -c 'WHERE \$AUDIT_WHERE' "$SKILL_MD"
  [ "$status" -eq 0 ]
  [ "$output" -eq 2 ]                # both consumers read the SAME binding
}

@test "source guard: the human-facing BLOCK listing was not narrowed" {
  # AC-4. The operator must still see full rows; only the machine-facing
  # derivation changed.
  run grep -F "|| title" "$SKILL_MD"
  [ "$status" -eq 0 ]
  run grep -F 'echo "$ROWS"' "$SKILL_MD"
  [ "$status" -eq 0 ]
}
