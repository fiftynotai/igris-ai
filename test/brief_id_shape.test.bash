#!/usr/bin/env bats

# brief_id_shape.test.bash — TD-468. The source-scan guard for the brief-id
# SHAPE across every file that spells it: `[A-Z]{2,3}-[0-9]+[a-z]?` — a
# 2-3 letter prefix, digits, and ONE optional lowercase letter for a
# sub-brief (`FR-003e` is a different brief from `FR-003`).
#
# THE DEFECT. `core/git-hooks/commit-msg` extracted closing ids with a shape
# that stopped at the digits, so `closes #FR-003e` gated FR-003 — the parent
# — on both the AC gate and the event gate (mbrgea-ai, 2026-09-09/14). The
# brief's own warning: `grep -F` for the canonical string found ONE of the
# sites; the others spell the class differently (`[A-Z][A-Z][A-Z]?-[0-9]`,
# `[A-Z]+-[0-9]+`, `\d+`, a template literal's `\\d+`). A literal sweep is not
# a sweep of the class (this session paid for that five times). This file
# sweeps the SHAPE, mechanically, with the predicate recorded here.
#
# THE PREDICATE (BSD 2.6.0 and GNU 3.8 grep agree, measured 2026-09-14):
#   \[A-Z\][^[:space:]]{0,14}-(\\+d|\[0-9\]|\[\[:digit:\]\])
# i.e. a literal `[A-Z]`, up to 14 non-space characters (a quantifier, a
# group, `[A-Z]` again), a `-`, then a digit class written as `\d`, `\\d`
# (inside a JS template literal — the plan's `\d`-only form MISSED that
# site), `[0-9]` or `[[:digit:]]`. A WIDENED site is the predicate followed
# by `+[a-z]?`.
#
# SCOPE: core/ scripts/ brain-mcp-server/{src,scripts} test/ cli/tests cli/src,
# minus node_modules, dist, .d.ts, __snapshots__, and this file (it spells
# every token it looks for). docs/ and MAINTAINING.md are prose and out.
#
# WHAT THIS FILE PROVES:
#   SH1  the population (files with any hit) equals the ledger below — a NEW
#        file spelling the shape reds until it joins the ledger (14 files,
#        2026-09-14);
#   SH2  every ADMIT site carries the widened form on its CODE lines: the
#        predicate count equals the widened count equals the pinned count;
#   SH3  every LEAVE site still carries its recorded token exactly once, so
#        a change there re-opens the decision;
#   SH4  self-negative: a copy of commit-msg carrying the 505499d extractor
#        (the ACTUAL defect, both stages) is reported; so is the minimal
#        form (stage 2 alone);
#   SH5  the comment exemption is proved, not assumed;
#   SH6  cli/src spells the shape nowhere (the ledger's "none" row).
# The BEHAVIOURAL witnesses live in test/brief_ac_gate.test.bash PART 6,
# test/agent_event_gate.test.bash PART 3, test/phase_guard.test.bash (e3),
# test/validate_brief_state_reconciliation.test.bash and the two vitest
# files named in the ledger. bash 3.2 throughout; keyed on file + literal
# token, never on a line number (TD-324).

load test_helper

PRED='\[A-Z\][^[:space:]]{0,14}-(\\+d|\[0-9\]|\[\[:digit:\]\])'
WIDENED="${PRED}\\+\\[a-z\\]\\?"
SELF="test/brief_id_shape.test.bash"

# --- THE LEDGER (2026-09-14) --------------------------------------------------
# ADMIT — extractors and filters, widened by TD-468; <path> <code-line hits>.
ADMIT="core/git-hooks/commit-msg 3
core/git-hooks/pre-commit 1
core/hooks/shared/session_start.sh 1
core/hooks/shared/pre_compact.sh 1
scripts/validate_brief_state_reconciliation.sh 1
brain-mcp-server/src/tools/briefs.ts 1
brain-mcp-server/scripts/backfill_brief_edges.ts 3"

# LEAVE — a recorded token per site (checked in SH3 by exact substring):
#   core/scripts/brief_ac_check.sh          has_followup: a PRESENCE test,
#     unanchored at the end — FR-003e contains FR-0 and passes by construction;
#     nothing reads which id matched (D-3).
#   brain-mcp-server/src/engine/components/subconscious/actions/kinds.ts
#     the TD-439 specifics carry grammar: `\d{2,4}\b` never truncates a
#     lettered id, it declines to carry it; changing it moves TD-439's
#     carry-text/hash contract.
#   cli/tests/integration/release-audit-bypass-ids.bats   a shape predicate
#     over a FIXTURE id list, not an extractor.
#   test/brief_ac_gate.test.bash   G1-arm-b's mutation sed strips ids from
#     FR-241 (`FR-003e` -> `XXe`, still not id-shaped); PART 6 quotes the
#     hook's tokens as mutant anchors.
# PROSE-ONLY (hits in comments/docblocks, no consumer):
#   brain-mcp-server/scripts/__tests__/backfill_brief_edges.test.ts
#   brain-mcp-server/src/tools/__tests__/extract-parent-brief-id.test.ts
#   test/validate_brief_state_reconciliation.test.bash
POPULATION="brain-mcp-server/scripts/__tests__/backfill_brief_edges.test.ts
brain-mcp-server/scripts/backfill_brief_edges.ts
brain-mcp-server/src/engine/components/subconscious/actions/kinds.ts
brain-mcp-server/src/tools/__tests__/extract-parent-brief-id.test.ts
brain-mcp-server/src/tools/briefs.ts
cli/tests/integration/release-audit-bypass-ids.bats
core/git-hooks/commit-msg
core/git-hooks/pre-commit
core/hooks/shared/pre_compact.sh
core/hooks/shared/session_start.sh
core/scripts/brief_ac_check.sh
scripts/validate_brief_state_reconciliation.sh
test/brief_ac_gate.test.bash
test/validate_brief_state_reconciliation.test.bash"

setup() {
  SCRATCH="$TEST_TEMP_DIR/shape_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# population — every in-scope file with at least one predicate hit, as a
# sorted list of repo-relative paths. `find -exec grep -l {} +` so one
# unreadable file cannot abort the census (a census that dies undercounts).
population() {
  ( cd "$IGRIS_ROOT" && find core scripts brain-mcp-server/src brain-mcp-server/scripts test cli/tests cli/src \
      -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.d.ts' \
      -not -path '*/__snapshots__/*' -not -path "$SELF" \
      -exec grep -lE "$PRED" {} + 2>/dev/null | sort )
  return 0
}

# code_lines <file> — non-comment lines (`#` for bash, `//` `*` `/*` for TS).
code_lines() {
  grep -vE '^[[:space:]]*(#|//|\*|/\*)' "$1"
  return 0
}

# count_pred <file> / count_widened <file> — OCCURRENCES (not lines) on code
# lines; `grep -o` prints one per match, so a line carrying two counts two.
count_pred()    { code_lines "$1" | grep -oE "$PRED" | wc -l | tr -d ' '; }
count_widened() { code_lines "$1" | grep -oE "$WIDENED" | wc -l | tr -d ' '; }

# check_admit_site <file> <expected> — 0 iff every code-line occurrence of the
# shape is the widened form AND the count is the pinned one. Prints the
# verdict either way (the self-negative reads it).
check_admit_site() {
  local f="$1" want="$2" n w
  n="$(count_pred "$f")"
  w="$(count_widened "$f")"
  printf '%s: shape=%s widened=%s pinned=%s\n' "${f#"$IGRIS_ROOT"/}" "$n" "$w" "$want"
  [ "$n" = "$w" ] && [ "$n" = "$want" ]
}

@test "(SH1) the population of files spelling the shape equals the ledger (14 files, 2026-09-14)" {
  local got
  got="$(population)"
  printf '%s\n' "$got" >&2
  [ "$(printf '%s\n' "$got" | grep -c .)" -ge 10 ] || { echo "population too small (root=$IGRIS_ROOT)"; return 1; }
  diff <(printf '%s\n' "$POPULATION") <(printf '%s\n' "$got") || {
    echo "population drift (< ledger, > tree): a NEW file spelling the shape joins the ledger in the same commit"; return 1; }
}

@test "(SH2) every ADMIT site carries the widened shape on its code lines (predicate = widened = pinned)" {
  local f n bad=0
  while read -r f n; do
    [ -n "$f" ] || continue
    check_admit_site "$IGRIS_ROOT/$f" "$n" >&2 || bad=$((bad + 1))
  done <<< "$ADMIT"
  [ "$bad" -eq 0 ] || { echo "$bad ADMIT site(s) carry an un-widened or unpinned shape"; return 1; }
}

@test "(SH3) every LEAVE site still carries its recorded token exactly once (a change re-opens the decision)" {
  local n
  n="$(grep -cF '[[ "$t" =~ [A-Z][A-Z][A-Z]?-[0-9] ]]' "$IGRIS_ROOT/core/scripts/brief_ac_check.sh")"
  [ "$n" = "1" ] || { echo "brief_ac_check.sh has_followup token: $n"; return 1; }
  n="$(grep -cF '/\b(?:[A-Z]{2}|L)-\d{2,4}\b/g' "$IGRIS_ROOT/brain-mcp-server/src/engine/components/subconscious/actions/kinds.ts")"
  [ "$n" = "1" ] || { echo "kinds.ts specifics token: $n"; return 1; }
  n="$(grep -cF "local re='^[A-Z]{2}-[0-9]{3}\$' tok toks" "$IGRIS_ROOT/cli/tests/integration/release-audit-bypass-ids.bats")"
  [ "$n" = "1" ] || { echo "release-audit-bypass-ids.bats fixture predicate: $n"; return 1; }
  n="$(grep -cF "sed -E 's/[A-Z][A-Z][A-Z]?-[0-9]+/XX/g'" "$IGRIS_ROOT/test/brief_ac_gate.test.bash")"
  [ "$n" = "1" ] || { echo "brief_ac_gate G1-arm-b mutation sed: $n"; return 1; }
}

# -----------------------------------------------------------------------------
# (SH4) SELF-NEGATIVE: the scanner FIRES on the ACTUAL defect. A copy of the
#       fixed hook with its two extractor lines replaced by the 505499d text
#       (both stages digits-terminated) reads shape=2 widened=0 — reported.
#       Then the minimal form: stage 2 alone un-widened -> shape=3 widened=2.
# -----------------------------------------------------------------------------
@test "(SH4) a copy of commit-msg carrying the 505499d extractor IS reported; so is stage 2 alone" {
  local src="$IGRIS_ROOT/core/git-hooks/commit-msg" both="$SCRATCH/commit-msg.505499d" one="$SCRATCH/commit-msg.stage2"
  check_admit_site "$src" 3 >&2 || { echo "precondition: the real hook must pass"; return 1; }
  python3 - "$src" "$both" "$one" <<'PY' || return 1
import sys
src, both, one = sys.argv[1:4]
t = open(src, encoding="utf-8").read()
s1_new = "  | grep -iowE '(clos(e|es|ed)|fix(es|ed))[[:space:]]*:?[[:space:]]*#?[A-Z]{2,3}-[0-9]+[a-z]?([[:space:]]*,[[:space:]]*#?[A-Z]{2,3}-[0-9]+[a-z]?)*' 2>/dev/null \\\n"
s2_new = "  | grep -owE '[A-Z]{2,3}-[0-9]+[a-z]?' 2>/dev/null \\\n"
s1_old = "  | grep -ioE 'clos(e|es|ed)[[:space:]]*:?[[:space:]]*#?[A-Z]{2,3}-[0-9]+' 2>/dev/null \\\n"
s2_old = "  | grep -oE '[A-Z]{2,3}-[0-9]+' 2>/dev/null \\\n"
for needle in (s1_new, s2_new):
    if t.count(needle) != 1:
        sys.exit("extractor line not found exactly once: %r" % needle[:40])
open(both, "w", encoding="utf-8").write(t.replace(s1_new, s1_old).replace(s2_new, s2_old))
open(one, "w", encoding="utf-8").write(t.replace(s2_new, s2_old))
PY
  # The plants LANDED: the copies differ from the source and carry the old text.
  ! cmp -s "$src" "$both" || return 1
  ! cmp -s "$src" "$one" || return 1
  [ "$(grep -cF "grep -oE '[A-Z]{2,3}-[0-9]+' " "$both")" = "1" ] || { echo "505499d plant did not land"; return 1; }
  [ "$(grep -cF "grep -oE '[A-Z]{2,3}-[0-9]+' " "$one")" = "1" ] || { echo "stage-2 plant did not land"; return 1; }

  run check_admit_site "$both" 3
  echo "$output" >&2
  [ "$status" -ne 0 ] || { echo "the 505499d extractor was NOT reported"; return 1; }
  [[ "$output" == *"shape=2 widened=0"* ]] || return 1

  run check_admit_site "$one" 3
  echo "$output" >&2
  [ "$status" -ne 0 ] || { echo "the stage-2-only defect was NOT reported"; return 1; }
  [[ "$output" == *"shape=3 widened=2"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (SH5) THE COMMENT EXEMPTION, PROVED. The old shape inside `#` / `//` / ` *`
#       lines is documentation of the defect, not a site. A file whose ONLY
#       digits-terminated occurrences sit in comments reads clean.
# -----------------------------------------------------------------------------
@test "(SH5) the old shape ONLY inside comment lines is NOT reported" {
  local f="$SCRATCH/comment-only.sh"
  {
    printf '#!/bin/bash\n'
    printf '# the extractor used to read [A-Z]{2,3}-[0-9]+ and stop at the digits\n'
    printf '  # indented too: ([A-Z]+-[0-9]+)\n'
    printf "ids=\$(grep -owE '[A-Z]{2,3}-[0-9]+[a-z]?' \"\$f\")\n"
  } > "$f"
  local ts="$SCRATCH/comment-only.ts"
  {
    printf '/**\n * Matches [A-Z]{2,3}-\\d+ (the old shape).\n */\n'
    printf '// also here: [A-Z]{2,3}-\\\\d+\n'
    printf 'const ID_RE = /[A-Z]{2,3}-\\d+[a-z]?\\b/g;\n'
  } > "$ts"
  # The planted comment lines really carry the token (else SH5 proves nothing).
  [ "$(grep -cE "$PRED" "$f")" = "3" ] || { echo "bash plant did not land"; cat "$f"; return 1; }
  [ "$(grep -cE "$PRED" "$ts")" = "3" ] || { echo "ts plant did not land"; cat "$ts"; return 1; }
  check_admit_site "$f" 1 >&2 || { echo "a bash comment line was reported as a site"; return 1; }
  check_admit_site "$ts" 1 >&2 || { echo "a ts comment line was reported as a site"; return 1; }
}

@test "(SH6) cli/src spells the shape nowhere" {
  local hits
  hits="$( (cd "$IGRIS_ROOT" && find cli/src -type f -not -path '*/node_modules/*' -not -name '*.d.ts' -exec grep -lE "$PRED" {} + 2>/dev/null) || true)"
  [ -z "$hits" ] || { echo "cli/src now spells the brief-id shape — add it to the ledger: $hits"; return 1; }
}
