#!/usr/bin/env bats

# Canonical brief_type vocabulary parity guard (TD-330).
#
# CANONICAL_BRIEF_TYPES is dual-sourced — there is no build step generating one
# copy from the other:
#   - TS:   brain-mcp-server/src/tools/brief-normalize.ts (TD-328, the OWNER —
#             imported by the v22 migration and by scripts/normalize_brief_types.ts,
#             so it is the copy the executable path uses)
#             export const CANONICAL_BRIEF_TYPES = [ 'Feature', ... ] as const;
#   - bash: scripts/validate_brief_type_vocabulary.sh (the OBSERVER)
#             CANONICAL_BRIEF_TYPES=( "Feature" ... )
#
# WHY THIS GUARD EXISTS, measured rather than assumed. TD-328 fixed brief_type
# drift in the DATA and got the executable path right — no hand-copy there. But
# it left the canonical list restated BY HAND in the bash validator, and that
# copy is FUNCTIONAL: it decides the validator's verdict. The only thing
# coupling the two was `test/validate_brief_type_vocabulary.test.bash`, which
# greps a THIRD hardcoded list of 12 names into the bash validator and then
# checks only THREE of them against the TS file. Sentinel measured the
# consequences during TD-328's validation pass:
#
#   - add a 13th canonical type to the TS array  -> NOTHING FAILS. The bash
#     validator reports it NON-CANONICAL forever, so the operator sees a
#     permanent false positive in a gate whose whole job is to be believed.
#   - delete `Feature` from the TS array         -> the pin test still passes.
#   - add a bogus entry to the bash array        -> nothing fails.
#
# That is the same defect class TD-328 exists to fix, one layer out: a
# vocabulary with two copies drifts, and tolerance without observation has no
# gradient. The observer TD-328 built had acquired a second, unobserved copy of
# the vocabulary it observes.
#
# WHY THE PIN AND NOT A GENERATOR (TD-330 scope item 1, argued not assumed).
# The two candidate fixes were (a) generate the bash array from the TS source at
# build/test time, or (b) make a guard enumerate BOTH and assert set-equality.
# (b) is chosen: it is the smaller change, it needs no build step, and the repo
# already contains the right answer to this exact question applied to a sibling
# field — `CANONICAL_PHASES` has the identical shape (TS array + a bash array in
# scripts/validate_brief_state_reconciliation.sh) and TD-257 solved it with
# exactly this pattern in test/validate_canonical_phase_parity.test.bash. A
# generator would also put a build step between an operator editing a list and
# the validator honouring it, which is a worse failure mode than a red test.
#
# ORDER IS ASSERTED, not just set membership. The TS array's order is not
# arbitrary — the nine pre-TD-328 types come first and the three TD-328
# additions follow under a comment marking them as such. A reordering is not a
# correctness bug today, but it is a review signal worth keeping, and an
# order-sensitive comparison produces a far more readable diff than a set one.
#
# WHAT THIS GUARD DOES NOT COVER — READ THE NEXT PARAGRAPH BEFORE THIS ONE.
#
# TD-330 scope item 3 exempted "the PROSE copies" from guarding, and named three:
# the MCP tool-schema descriptions, `/register`'s prefix table, and
# core/enforcement/brief-type-vocabulary.md. **TD-331 falsified that list.**
# `/register`'s prefix table is now GUARDED — eight of this file's twelve checks
# read it (see THE PREFIX MAP and THE KIND -> PREFIX AXIS below). The exemption
# as it now stands covers TWO copies:
#
#   - core/enforcement/brief-type-vocabulary.md's derivation table  (TD-357)
#   - scripts/validate_brief_type_vocabulary.sh's header prefix map (TD-357)
#     ...plus the MCP tool-schema `description` strings.
#
# The original exemption also contained a CATEGORY ERROR that is worth keeping
# visible rather than quietly correcting: it said those copies restate "the
# canonical list". `/register` §2 restates the **prefix map** — a different
# mapping, with different members. Conflating the two is why the mint surface
# went unguarded through TD-328 and TD-330 and only got a pin in TD-331.
#
# What survives of the argument: free-form CODE COMMENTS drift visibly enough
# that pinning them costs more than it saves. What does not survive: applying
# that to STRUCTURED, RUNTIME-READ prose. `/register`'s table is executed
# instructions, not documentation — which is exactly how it shipped a live
# defect (see THE KIND -> PREFIX AXIS). TD-357 carries the census of all six
# copies and the decision for each.

load test_helper

BASH_VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_type_vocabulary.sh"
TS_HELPER="$IGRIS_ROOT/brain-mcp-server/src/tools/brief-normalize.ts"

setup() {
  require_python3
  [ -f "$BASH_VALIDATOR" ] || skip "bash validator missing at $BASH_VALIDATOR"
  [ -f "$TS_HELPER" ] || skip "TS helper missing at $TS_HELPER"
}

# Extract the bash CANONICAL_BRIEF_TYPES array as newline-separated values, in
# order. The array is multi-line and its elements are double-quoted and contain
# SPACES ("Technical Debt", "Dependency Update", "Process Improvement"), so this
# reads quoted tokens rather than splitting on whitespace the way the
# CANONICAL_PHASES twin can.
extract_bash_types() {
  python3 - "$BASH_VALIDATOR" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'^\s*CANONICAL_BRIEF_TYPES=\((.*?)^\)', src, re.MULTILINE | re.DOTALL)
if not m:
    sys.stderr.write("bash CANONICAL_BRIEF_TYPES=( ... ) not found\n")
    sys.exit(3)
body = m.group(1)
# Strip comment lines so a commented-out element can never be read as live.
body = "\n".join(l for l in body.split("\n") if not l.strip().startswith("#"))
tokens = re.findall(r'"([^"]+)"', body)
if not tokens:
    sys.stderr.write("bash CANONICAL_BRIEF_TYPES had no quoted tokens\n")
    sys.exit(3)
print("\n".join(tokens))
PY
}

# Extract the TS CANONICAL_BRIEF_TYPES literal as newline-separated values, in
# order. Comment lines are stripped first — the array carries a
# `// --- TD-328 additions ---` marker between its ninth and tenth elements.
extract_ts_types() {
  python3 - "$TS_HELPER" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(
    r'export\s+const\s+CANONICAL_BRIEF_TYPES\s*=\s*\[(.*?)\]\s*as\s+const',
    src, re.DOTALL,
)
if not m:
    sys.stderr.write("TS CANONICAL_BRIEF_TYPES literal not found\n")
    sys.exit(3)
body = m.group(1)
body = "\n".join(l for l in body.split("\n") if not l.strip().startswith("//"))
tokens = re.findall(r"""['"]([^'"]+)['"]""", body)
if not tokens:
    sys.stderr.write("TS CANONICAL_BRIEF_TYPES had no quoted tokens\n")
    sys.exit(3)
print("\n".join(tokens))
PY
}

@test "both sources define a non-empty CANONICAL_BRIEF_TYPES list" {
  run extract_bash_types
  assert_success
  [ -n "$output" ]

  run extract_ts_types
  assert_success
  [ -n "$output" ]
}

@test "bash and TS CANONICAL_BRIEF_TYPES are element-identical and in the same order" {
  local bash_types ts_types
  bash_types="$(extract_bash_types)"
  ts_types="$(extract_ts_types)"

  if [ "$bash_types" != "$ts_types" ]; then
    echo "CANONICAL_BRIEF_TYPES drift between bash and TS:" >&2
    echo "--- bash ($BASH_VALIDATOR) ---" >&2
    echo "$bash_types" >&2
    echo "--- TS ($TS_HELPER) ---" >&2
    echo "$ts_types" >&2
    echo "" >&2
    echo "The TS array is the OWNER (the executable path imports it); the bash" >&2
    echo "array is the observer and must follow it. Edit both in one change." >&2
    return 1
  fi
}

# The extractors are the load-bearing part of this guard: if either silently
# returned an empty list, the equality assertion above would compare "" to ""
# and pass while measuring nothing. These two checks are the ARMED assertion for
# the instrument itself (coding_guidelines.md §12 — a test-harness safety guard
# MUST assert that it is armed).
@test "the extractors actually found the full vocabulary, not an empty list" {
  local bash_count ts_count
  bash_count="$(extract_bash_types | wc -l | tr -d ' ')"
  ts_count="$(extract_ts_types | wc -l | tr -d ' ')"

  # A floor, not a pin: this must not need editing every time a type is added,
  # or it becomes a second hand-maintained copy of the list — the exact defect
  # this file exists to prevent.
  [ "$bash_count" -ge 9 ]
  [ "$ts_count" -ge 9 ]
}

# `Refactor` is the ONE canonical type with no mint prefix (promoted on measured
# evidence in TD-328; the operator declined an `RF-` prefix). It is the rule's
# single documented exception, so its presence is worth naming explicitly —
# a future reader applying "every canonical type has a mint prefix" would
# otherwise be entitled to delete it.
@test "CANONICAL_BRIEF_TYPES contains the prefix-less exception Refactor" {
  run extract_ts_types
  assert_success
  echo "$output" | grep -qx "Refactor"
}

# ─────────────────────────────────────────────────────────────────────────────
# THE PREFIX MAP — a DIFFERENT vocabulary from the canonical list above
# ─────────────────────────────────────────────────────────────────────────────
# TD-330 exempted the PROSE copies of the vocabulary from guarding, on the
# argument that documentation drifts VISIBLY. TD-331's own validation falsified
# that for one specific mapping: updating the prefix map touched five prose
# copies, three were missed, and one file was left flatly self-contradictory
# (`core/enforcement/brief-type-vocabulary.md` said the collision "deserves its
# own brief" in the same commit as the brief that fixed it).
#
# The exemption also contained a CATEGORY ERROR worth naming, because it is the
# reason the miss was invisible: it said the prose copies restate "the canonical
# list". They do not. `/register` §2 restates the **prefix map** — a different
# mapping, with different members, which had no guard and no owner at all.
#
# So this section pins the PREFIX MAP, not the canonical list. Two copies:
#   - PROSE  : `core/skills/register/SKILL.md` §2's table (the MINT surface —
#              what /register actually does when it creates a brief)
#   - CODE   : `BRIEF_ID_PREFIX_TYPES` in brain-mcp-server/src/tools/brief-normalize.ts
#              (the DECODE table — fills NULL types from an existing brief ID)
#
# IT CANNOT BE NAIVE SET-EQUALITY, and the asymmetry IS the point. The decode
# table deliberately has NO `BR` key: it is applied to every NULL-type row with
# no date gate (db.ts's v22 UPDATE and normalize_brief_types.ts, which is
# re-runnable on demand), and all 17 NULL `BR-` rows predate TD-331, so adding
# the key would retro-assign exactly the rows TD-331 forbids touching. The pin
# therefore asserts the DOCUMENTED RELATIONSHIP: every mint row except `BR`
# appears in the decode table with the same canonical type, and `BR`'s absence
# is deliberate.

REGISTER_SKILL="$IGRIS_ROOT/core/skills/register/SKILL.md"

# Extract `/register` §2's prefix table as `PREFIX<TAB>Canonical Type` rows.
extract_mint_map() {
  python3 - "$REGISTER_SKILL" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
rows = []
for line in src.split("\n"):
    # | bug | BR | `Bug` |   — skip the header and the no-prefix rows.
    m = re.match(r'^\|\s*([a-z ,]+?)\s*\|\s*([A-Z]{2})\s*\|\s*`([^`]+)`\s*\|', line)
    if m:
        rows.append(f"{m.group(2)}\t{m.group(3)}")
if not rows:
    sys.stderr.write("no prefix rows parsed from /register SKILL.md\n")
    sys.exit(3)
print("\n".join(sorted(set(rows))))
PY
}

# Extract BRIEF_ID_PREFIX_TYPES as `PREFIX<TAB>Canonical Type` rows.
extract_decode_map() {
  python3 - "$TS_HELPER" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'export\s+const\s+BRIEF_ID_PREFIX_TYPES[^=]*=\s*\{(.*?)\};', src, re.DOTALL)
if not m:
    sys.stderr.write("BRIEF_ID_PREFIX_TYPES literal not found\n")
    sys.exit(3)
body = "\n".join(l for l in m.group(1).split("\n") if not l.strip().startswith("//"))
rows = [f"{k}\t{v}" for k, v in re.findall(r"(\w+)\s*:\s*'([^']+)'", body)]
if not rows:
    sys.stderr.write("BRIEF_ID_PREFIX_TYPES had no entries\n")
    sys.exit(3)
print("\n".join(sorted(set(rows))))
PY
}

@test "both prefix-map copies parse to a non-empty mapping" {
  run extract_mint_map
  assert_success
  [ -n "$output" ]

  run extract_decode_map
  assert_success
  [ -n "$output" ]
}

@test "every mint prefix EXCEPT BR decodes to the same canonical type" {
  local mint decode
  # Exclude ONLY the documented asymmetry — the exact row `BR<TAB>Bug` — and NOT
  # every row whose prefix happens to be BR.
  #
  # A first draft filtered `^BR\t` wholesale. That silently re-opened the very
  # defect TD-331 closed: restoring `| feature | BR |` at the mint surface emits
  # `BR<TAB>Feature`, which a wholesale filter strips, so the pin went GREEN on
  # the exact regression it exists to catch. Caught by planting it. Filtering by
  # the full row means any OTHER meaning attached to BR survives into the
  # comparison, fails to match the decode table, and reddens.
  mint="$(extract_mint_map | grep -v '^BR	Bug$')"
  decode="$(extract_decode_map)"

  if [ "$mint" != "$decode" ]; then
    echo "PREFIX MAP drift between the mint surface and the decode table:" >&2
    echo "--- /register SKILL.md §2 (minus BR) ---" >&2
    echo "$mint" >&2
    echo "--- BRIEF_ID_PREFIX_TYPES ---" >&2
    echo "$decode" >&2
    echo "" >&2
    echo "These are TWO copies of ONE mapping. TD-331 changed it and three prose" >&2
    echo "copies were missed; this pin exists so that cannot recur silently." >&2
    return 1
  fi
}

@test "BR is present at the mint surface and DELIBERATELY absent from the decode table" {
  # Both halves matter. If BR vanished from the mint table, /register would have
  # no way to create a bug brief. If BR appeared in the decode table, the v22
  # UPDATE and the re-runnable backfill would retro-assign the 17 historical
  # NULL BR- rows that TD-331 scope item 2 forbids touching.
  extract_mint_map | grep -q '^BR	Bug'
  ! extract_decode_map | grep -q '^BR	'
}

@test "the prefix-map extractors found the full mapping, not a truncated one" {
  # ARMED check, same rationale as the canonical-list one above: two empty
  # extractions compare equal and would pass while measuring nothing.
  local mint_count decode_count
  mint_count="$(extract_mint_map | wc -l | tr -d ' ')"
  decode_count="$(extract_decode_map | wc -l | tr -d ' ')"
  [ "$mint_count" -ge 8 ]
  [ "$decode_count" -ge 7 ]
}

# ─────────────────────────────────────────────────────────────────────────────
# THE KIND -> PREFIX AXIS — the one TD-331 actually changed
# ─────────────────────────────────────────────────────────────────────────────
# The checks above guard PREFIX -> TYPE. TD-331's subject was KIND -> PREFIX
# (`bug` and `feature` both minting `BR-`), and that is a different axis.
#
# THIS BLIND SPOT WAS DEMONSTRATED, NOT ANTICIPATED. The first draft of the
# prefix-map pin captured the kind column in its regex and then never used it.
# Restoring the collision in its original compact form —
#
#     | bug, feature | BR | `Bug` |
#
# — left the extracted PREFIX -> TYPE mapping BYTE-IDENTICAL to the clean run
# (that row emits `BR<TAB>Bug`, the documented asymmetry the comparison filters,
# while `FR<TAB>Feature` still arrives from the `| request | FR |` row). The
# whole root suite stayed at 502 ok. A pin that goes green on the exact line
# TD-331 deleted is not guarding TD-331.
#
# It also missed a LIVE defect: `## Arguments`' bullet list still read
# "`bug` or `feature` → BR-XXX" in the shipped tree, contradicting §2's table
# eighteen lines below it. That one is FUNCTIONAL, not cosmetic — §Arguments
# comes FIRST in the file, so an agent executing `/register feature "..."` reads
# it before the table and mints `BR-XXX`, re-creating the collision.
#
# So this section pins the kind column, in BOTH representations, and asserts the
# rule TD-331 actually established: **a kind names exactly one prefix.**

# Extract kind->prefix from §2's markdown TABLE as `kind<TAB>PREFIX`.
extract_kind_prefix_table() {
  python3 - "$REGISTER_SKILL" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
rows = []
for line in src.split("\n"):
    m = re.match(r'^\|\s*([a-z][a-z ,]*?)\s*\|\s*([A-Z]{2})\s*\|', line)
    if m:
        rows.append(f"{m.group(1)}\t{m.group(2)}")
if not rows:
    sys.stderr.write("no kind->prefix rows parsed from the §2 table\n")
    sys.exit(3)
print("\n".join(sorted(set(rows))))
PY
}

# Extract kind->prefix from the §Arguments BULLET list as `kind<TAB>PREFIX`.
extract_kind_prefix_bullets() {
  python3 - "$REGISTER_SKILL" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
rows = []
for line in src.split("\n"):
    # - `bug` → BR-XXX      (also tolerates "or"-joined kinds so a regression
    #                        is CAPTURED and fails loudly, not skipped silently)
    m = re.match(r'^-\s*`([^`]+)`(?:\s+or\s+`([^`]+)`)?\s*(?:→|->)\s*([A-Z]{2})-', line)
    if m:
        for kind in (m.group(1), m.group(2)):
            if kind:
                rows.append(f"{kind}\t{m.group(3)}")
if not rows:
    sys.stderr.write("no kind->prefix bullets parsed from §Arguments\n")
    sys.exit(3)
print("\n".join(sorted(set(rows))))
PY
}

@test "a KIND names exactly one prefix — no cell joins two kinds (TD-331)" {
  # The rule TD-331 established, asserted directly rather than inferred from the
  # prefix->type mapping. This single check reddens both the compact collision
  # (`| bug, feature | BR |`) and the bullet form (`\`bug\` or \`feature\` →`).
  local offenders
  offenders="$(extract_kind_prefix_table | cut -f1 | grep -nE ',| or ' || true)"
  if [ -n "$offenders" ]; then
    echo "§2 table has a kind cell naming MORE THAN ONE kind:" >&2
    echo "$offenders" >&2
    echo "TD-331 retired that: a prefix names exactly one kind." >&2
    return 1
  fi

  # The bullet extractor SPLITS an "or" pair into two rows rather than skipping
  # it, so a restored collision shows up as two kinds sharing one prefix below.
  local dupes
  dupes="$(extract_kind_prefix_bullets | cut -f2 | sort | uniq -d | grep -v '^FR$' || true)"
  if [ -n "$dupes" ]; then
    echo "§Arguments has a prefix claimed by more than one kind: $dupes" >&2
    echo "(FR is exempt: 'feature' and 'request' both mint FR- by TD-331.)" >&2
    return 1
  fi
}

@test "bug mints BR and feature mints FR, in BOTH representations (TD-331)" {
  # The decision itself, pinned in the two places it is written down. If these
  # ever disagree, the one that comes FIRST in the file wins at runtime — an
  # agent reads §Arguments before §2 — which is why both are asserted.
  extract_kind_prefix_table    | grep -qx 'bug	BR'
  extract_kind_prefix_table    | grep -qx 'feature	FR'
  extract_kind_prefix_bullets  | grep -qx 'bug	BR'
  extract_kind_prefix_bullets  | grep -qx 'feature	FR'

  # And the retired mapping is absent from both.
  ! extract_kind_prefix_table   | grep -qx 'feature	BR'
  ! extract_kind_prefix_bullets | grep -qx 'feature	BR'
}

@test "the §2 table and the §Arguments bullets agree on every shared kind" {
  # Two copies of one mapping in one file. The table carries kinds the bullets
  # do not (the no-prefix rows), so this compares the INTERSECTION.
  local table bullets kind t_prefix b_prefix mismatches=""
  table="$(extract_kind_prefix_table)"
  bullets="$(extract_kind_prefix_bullets)"

  while IFS=$'\t' read -r kind b_prefix; do
    t_prefix="$(echo "$table" | awk -F'\t' -v k="$kind" '$1==k {print $2}')"
    [ -n "$t_prefix" ] || continue
    [ "$t_prefix" = "$b_prefix" ] || mismatches+="  $kind: table=$t_prefix bullets=$b_prefix"$'\n'
  done <<< "$bullets"

  if [ -n "$mismatches" ]; then
    echo "§2 table and §Arguments disagree on kind->prefix:" >&2
    echo "$mismatches" >&2
    return 1
  fi
}

@test "the kind->prefix extractors found both representations, not an empty one" {
  # ARMED. Two empty extractions agree trivially; the intersection loop above
  # would iterate zero times and pass while measuring nothing.
  [ "$(extract_kind_prefix_table   | wc -l | tr -d ' ')" -ge 9 ]
  [ "$(extract_kind_prefix_bullets | wc -l | tr -d ' ')" -ge 9 ]
}
