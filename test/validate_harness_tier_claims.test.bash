#!/usr/bin/env bats
#
# TD-367 — the harness-count claim guard (scripts/validate_harness_tier_claims.sh).
#
# Every assertion here is RED-FIRST in the sense that matters: each one was
# demonstrated to fail against a deliberately-defective input (a fixture doc
# carrying the count, a fixture manifest, a stripped PATH) rather than only
# against the healthy tree. A scanner whose only observed outcome is "clean"
# is indistinguishable from one that is scanning nothing, so the corpus-size
# line and the SKIP branches are asserted too.
#
# Fixtures live OUTSIDE the repo (TIER_DOC_SET accepts an absolute path) so a
# test can never leave a doc carrying "all five harnesses" inside the tree the
# validator scans.

load test_helper

VALIDATOR="$IGRIS_ROOT/scripts/validate_harness_tier_claims.sh"

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  FIXTURE_DIR="$TEST_TEMP_DIR/tier-claims"
  mkdir -p "$FIXTURE_DIR"
}

# --- The defect the guard exists to catch ------------------------------------

@test "validate_harness_tier_claims: a doc saying 'all five harnesses' is REPORTED" {
  cat > "$FIXTURE_DIR/dirty.md" <<'EOF'
# Fixture
The brain MCP server is projected to all five harnesses at init.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/dirty.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hand-written count\(s\) found"
  assert_output_contains "dirty\.md:2"
  # The report must state the descriptor's real count, or the reader has no way
  # to tell a stale numeral from a correct one.
  assert_output_contains "descriptor declares 6 harness\(es\)"
}

@test "validate_harness_tier_claims: every spelling of the count is caught, not just the one that bit us" {
  # Each line is its own hit. The point is that the guard folds CASE, the
  # hyphenated form, the bare numeral and the interposed 'igris' — folding
  # NOTATION rather than chasing one literal.
  cat > "$FIXTURE_DIR/spellings.md" <<'EOF'
Four harnesses ship today.
It reaches all SIX harnesses.
A 5-harness matrix.
The 4 igris harnesses agree.
seven harnesses is the ceiling.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/spellings.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "5 hand-written count\(s\) found"
}

@test "validate_harness_tier_claims: the COMPOUND-ADJECTIVE spelling 'all-four-harness' is caught" {
  # The word half of the pattern accepts a HYPHEN as its leading boundary; the
  # digit half does not (brief ids). Before that asymmetry existed, both live
  # instances of this spelling — core/docs/ADD-SURFACES.md and
  # core/os/surfaces-detail.md, 'all-four-harness α-assembly' — were invisible
  # to a guard whose entire job is to see them, and were found by hand at
  # TD-367's round-3 review instead.
  cat > "$FIXTURE_DIR/compound.md" <<'EOF'
The all-four-harness α-assembly runs at vendor time.
A five-harness matrix would be the same defect.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/compound.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hand-written count\(s\) found"
  assert_output_contains "compound\.md:1"
  assert_output_contains "compound\.md:2"
}

@test "validate_harness_tier_claims: relaxing the hyphen for WORDS does not relax it for brief-id DIGITS" {
  # The paired negative for the test above, and the reason the two halves are
  # written separately rather than as one class. If the hyphen were dropped from
  # the digit half too, '-136 Harness' and '-367 harness' would both match and
  # the guard would report brief ids as support counts — the over-fire that its
  # oldest negative test pins.
  cat > "$FIXTURE_DIR/compound_briefids.md" <<'EOF'
- FR-136 Harness manifest schema, superseded in part by TD-367 harness tiers.
- See FR-217 harness descriptor and FR-192 harness onboarding.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/compound_briefids.md" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
}

# --- The over-fire the guard must NOT commit ---------------------------------

@test "validate_harness_tier_claims: an open digit class catches 2 / 8 / 10, not just a roster-sized numeral" {
  # The class was [3-7] on the first cut, which silently ignored every count
  # outside the then-plausible roster band. A count is a copy of the descriptor
  # whatever its value, so the class is [0-9]+.
  cat > "$FIXTURE_DIR/widedigits.md" <<'EOF'
It registers into 2 harnesses.
All 8 harnesses agree on the shape.
A 10-harness matrix would still be a hand-written count.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/widedigits.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "3 hand-written count\(s\) found"
}

@test "validate_harness_tier_claims: a brief id ending in a digit next to 'Harness' is NOT a hit" {
  # TWO distinct over-fires, both observed on real lines, both foreclosed by the
  # leading boundary class:
  #   1. 'FR-136 Harness manifest schema' matched on the FIRST run of this
  #      validator, because the trailing 6 of the brief id sat next to a
  #      capitalised Harness. The non-alphanumeric half forecloses that.
  #   2. The SAME line came back when the digit class widened to [0-9]+, this
  #      time matching '-136 Harness' whole — the hyphen was a legal boundary.
  #      Excluding the hyphen from the class forecloses that. It is a live line
  #      in the scanned corpus (docs/multi-cli.md), not a hypothetical.
  cat > "$FIXTURE_DIR/briefids.md" <<'EOF'
- Brief: FR-136 Harness manifest schema + per-project model
- See also TD-367 harness tier work and FR-217 harness descriptor.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/briefids.md" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
}

@test "validate_harness_tier_claims: the boundary guard is ARMED — the same file with a real count IS reported" {
  # The negative test above passes trivially if the pattern stopped matching
  # anything at all. Adding ONE real count to the same fixture must flip it.
  cat > "$FIXTURE_DIR/briefids_armed.md" <<'EOF'
- Brief: FR-136 Harness manifest schema + per-project model
- See also TD-367 harness tier work and FR-217 harness descriptor.
- It ships to all six harnesses.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/briefids_armed.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hand-written count\(s\) found"
  assert_output_contains "briefids_armed\.md:3"
}

@test "validate_harness_tier_claims: a count of something OTHER than harnesses is not a hit" {
  cat > "$FIXTURE_DIR/othercounts.md" <<'EOF'
A harness is onboarded across the four material surfaces.
Claude runs all 6 portable hook events.
The four DISTINCT wire-shapes are emitted by three emitters.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/othercounts.md" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
}

# --- The INTERVENING ADJECTIVE: a limit DECLINED at 101 files, ADOPTED at 203 --
#
# THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED. Until round 6 a test here
# asserted that "All three agent harnesses" must NOT be reported, pinning limit
# #5's round-4 decline. That decline was measured over the 101-file corpus of the
# time and was correct THEN; the corpus doubled to 203 when the cli/src walk
# landed and the decline was carried forward without being re-run. Re-measured at
# 203 the trade inverts (5 hits: 3 stale shipped counts, 1 correct, 1 filename),
# so the widening ships and this pin inverts with it.

@test "validate_harness_tier_claims: an INTERVENING ADJECTIVE is caught (limit #5, adopted at 203 files)" {
  # 'All three agent harnesses' is the exact spelling that sat FALSE on two
  # contract rows of core/scripts/cli-adapters/README.md (agentTargetTypes()
  # returns four). 'the 4 DELEGATED harnesses' is the shape that shipped into
  # cli/dist from three separate files while this limit was still declined.
  cat > "$FIXTURE_DIR/adjective.md" <<'EOF'
- All three agent harnesses project from loadout-resident files.
- For the 4 DELEGATED harnesses route per-row placement to add-mcp.
- The four material surfaces are compiled per harness by the same orchestrator.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/adjective.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hand-written count\(s\) found"
  assert_output_contains "adjective\.md:1"
  assert_output_contains "adjective\.md:2"

  # Line 3 is the paired negative in the SAME run: the adjective slot must not
  # have widened the NOUN. 'four material surfaces' counts something else.
  case "$output" in
    *adjective.md:3*)
      echo "OVER-FIRE: 'four material surfaces' (line 3) was reported." >&2
      echo "The adjective slot must not reach a different NOUN. Actual: $output" >&2
      return 1
      ;;
  esac
}

# --- DELIBERATE NON-DETECTIONS (stated limits) --------------------------------
#
# The tests below assert that the guard does NOT report something. They are NOT
# bug reports — they pin trades recorded by number in the validator's header. A
# prose limit is invisible to the next person holding a regex; these make it
# executable.
#
# IF YOU ARE READING THIS BECAUSE ONE OF THEM WENT RED: you have not fixed a bug,
# you have TRADED THE LIMIT AWAY. Re-read the numbered limit each one cites and
# re-run its measurement before re-pinning any number.
#
# Each fixture is SELF-ARMING: it carries the non-detected line AND one real
# count, and asserts exactly ONE hit citing the real-count line. A pattern that
# had quietly stopped matching anything would fail the exit-1/count half rather
# than pass as a "clean" non-detection.

@test "validate_harness_tier_claims: the noun as a FILE NAME is deliberately NOT a hit (limit #5)" {
  # '3 personal harness.claude.md symlinks' counts SYMLINKS, and it is the ONE
  # false positive the adjective widening could not separate from the defect by
  # adjective shape. It is answered by NOTATION rather than by a per-line
  # carve-out: COUNT_NOT_FILENAME drops 'harness' glued to a dot + alphanumeric.
  # Measured over the real 203-file corpus: 5 -> 4 hits, no other verdict moved.
  #
  # LINE 2 PINS THE EXCLUSION'S STATED RESIDUAL. The rule keys on a dot followed
  # by an ALPHANUMERIC, so a BRACE-EXPANSION filename ('harness.{claude,gemini}')
  # puts a '{' where the rule looks for a letter and IS reported. That shape
  # exists only inside cli/src/__tests__, which limit #6 prunes from the corpus,
  # so it costs nothing on the real tree (the guard is green at 203) — but it is
  # asserted here rather than left for the next person to trip over.
  cat > "$FIXTURE_DIR/filename.md" <<'EOF'
- core agents + 3 personal harness.claude.md symlinks are kept in the BEFORE set.
- FR-159: all three harness.{claude,gemini,codex} materialize in one vendor.
- It ships to all six harnesses.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/filename.md" bash "$VALIDATOR"

  # ARMED: the real count on line 3 is reported, so the pattern is alive here.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hand-written count\(s\) found"
  assert_output_contains "filename\.md:2"
  assert_output_contains "filename\.md:3"

  case "$output" in
    *filename.md:1*)
      echo "REGRESSION OF INTENT: a count next to a FILE NAME was reported." >&2
      echo "'harness.claude.md' is a path component, not the noun (limit #5)." >&2
      echo "Actual output: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: the filename exclusion does NOT eat a SENTENCE-FINAL count" {
  # The paired positive for the test above, and the reason COUNT_NOT_FILENAME
  # carries a `\.$` arm: excluding 'harness' + dot outright would silence every
  # count that ENDS a sentence, gutting the guard while looking tighter.
  #
  # LINES 3-4 ARE THE ONES THAT MAKE THIS NON-VACUOUS, and they are here because
  # the first draft of this test was vacuous. A PLURAL sentence-final count is
  # protected by accident — `harness(es)?` can match just 'harness' and let the
  # 'e' satisfy the `[^.]` arm — so deleting `\.$` leaves lines 1-2 passing. Only
  # the SINGULAR form puts the dot immediately after the noun and actually
  # exercises the arm. Verified by mutation: with `\.$` removed this test stays
  # green on lines 1-2 alone and goes red on 3-4.
  cat > "$FIXTURE_DIR/sentencefinal.md" <<'EOF'
The brain MCP server is projected to all five harnesses.
It reaches six harnesses.
The registration touches every 5 harness.
Skills reach a six harness.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/sentencefinal.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "4 hand-written count\(s\) found"
  assert_output_contains "sentencefinal\.md:1"
  assert_output_contains "sentencefinal\.md:2"
  assert_output_contains "sentencefinal\.md:3"
  assert_output_contains "sentencefinal\.md:4"
}

@test "validate_harness_tier_claims: an ORDINAL is deliberately NOT a hit, and a naive adjective slot would eat it" {
  # The header states by name that ordinals about EVENTS are left in place
  # ('6th declared harness'). They survive because the pattern wants the noun or
  # a separator where the 't' of 'th' sits.
  #
  # This test now guards the SHAPE OF THE ADOPTED WIDENING rather than the
  # decline it used to justify. Relaxing COUNT_TAIL to a naive
  # '([a-z]+[ -])?harness(es)?' lets the adjective slot swallow the ORDINAL
  # SUFFIX, so every ordinal reports and the stated exemption is repealed
  # SILENTLY — this was one of round 4's two reasons for declining. Round 6
  # adopted the widening with a >=3-LETTER floor on the adjective, which excludes
  # th/st/nd/rd. If this test goes red the floor has been dropped: the widening
  # is still there but it has quietly repealed the ordinal exemption.
  cat > "$FIXTURE_DIR/ordinal.md" <<'EOF'
- antigravity is gemini-lineage but a 5th harness: its emitted JSON is distinct.
- Cursor is the 6th declared harness, onboarded end-to-end.
- It ships to all six harnesses.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/ordinal.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hand-written count\(s\) found"
  assert_output_contains "ordinal\.md:3"

  case "$output" in
    *ordinal.md:1*|*ordinal.md:2*)
      echo "REGRESSION OF INTENT: an ORDINAL was reported as a support count." >&2
      echo "The adjective slot has eaten th/st/nd/rd — limit #5, second reason." >&2
      echo "Actual output: $output" >&2
      return 1
      ;;
  esac
}

# --- ARM 2: the ROSTER GRAMMAR ------------------------------------------------
#
# The numeral-free half of this defect class. Arm 1 is blind to it BY
# CONSTRUCTION — there is no number on the line — which is why it survived every
# round that only tuned the count pattern.

@test "validate_harness_tier_claims: a value grammar naming MOST of the roster is caught (arm 2)" {
  # Both wrapper notations, and both live shapes. The `<...>` line is the exact
  # spelling of loadout.ts's project-mcp REQUIRED-argument error, whose validator
  # four lines below it accepted mcpTargetTypes() — six — so one function shipped
  # two contradictory rosters. The `{...}` line is its doc-comment twin.
  cat > "$FIXTURE_DIR/roster.md" <<'EOF'
loadout project-mcp: --harness <claude|codex|gemini|opencode> is required
`type` is one of {claude, codex, gemini, opencode} and method is merge
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/roster.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hardcoded roster grammar\(s\) found"
  assert_output_contains "roster\.md:1"
  assert_output_contains "roster\.md:2"

  # Arm 2 must be REPORTED AS ITSELF. If a roster grammar were folded into the
  # count report the reader would go looking for a numeral that is not there.
  case "$output" in
    *"hand-written count(s) found"*)
      echo "MIS-ROUTED: a numeral-free roster grammar was reported as a COUNT." >&2
      echo "Actual output: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: arm 2's roster is DERIVED from the descriptor, not hardcoded" {
  # The property that makes this arm re-arm itself at the next onboarding. Point
  # the validator at a fixture descriptor declaring a DIFFERENT roster: a grammar
  # naming the REAL harnesses must go quiet, and one naming the FIXTURE's
  # harnesses must report. A hardcoded alternation fails the second half.
  cat > "$FIXTURE_DIR/other-manifest.json" <<'EOF'
{ "harnesses": {
  "alpha": {}, "bravo": {}, "charlie": {}, "delta": {}, "echo": {}, "foxtrot": {}
} }
EOF
  cat > "$FIXTURE_DIR/derived.md" <<'EOF'
--harness <claude|codex|gemini|opencode> is required
--harness <alpha|bravo|charlie|delta> is required
EOF

  run env HARNESS_MANIFEST="$FIXTURE_DIR/other-manifest.json" \
    TIER_DOC_SET="$FIXTURE_DIR/derived.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "descriptor declares 6 harness\(es\)"
  assert_output_contains "1 hardcoded roster grammar\(s\) found"
  assert_output_contains "derived\.md:2"

  case "$output" in
    *derived.md:1*)
      echo "NOT DERIVED: the real roster was matched against a fixture descriptor." >&2
      echo "Arm 2's alternation must come from .harnesses. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: arm 2 counts DISTINCT ids, and an exhaustive grammar is NOT a hit" {
  # Two independent properties of the same `present` computation:
  #
  # LINE 1 — EXHAUSTIVE IS NOT A HIT. A wrapper naming every declared harness is
  # not a hand-maintained subset, and reporting it would make the only correct
  # spelling of a value grammar impossible to write. Pinned by `present < n`.
  #
  # LINE 3 — DISTINCTNESS. The regex only guarantees that many ELEMENTS, which a
  # REPEAT satisfies: `<claude|claude|claude|claude>` is four elements and ONE
  # harness. Re-counting distinct ids in the matched run is what refuses it, and
  # without this line that recount is vacuous — mutation-checked.
  cat > "$FIXTURE_DIR/whole.md" <<'EOF'
--harness <antigravity|claude|codex|cursor|gemini|opencode> is required
--harness <claude|codex|gemini|opencode> is required
--harness <claude|claude|claude|claude> is required
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/whole.md" bash "$VALIDATOR"

  # ARMED: line 2 IS reported in the same run, so the arm is demonstrably alive.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hardcoded roster grammar\(s\) found"
  assert_output_contains "whole\.md:2"

  case "$output" in
    *whole.md:1*)
      echo "OVER-FIRE: an EXHAUSTIVE roster grammar was reported." >&2
      echo "Arm 2 fires only when >= 1 declared harness is OMITTED. Actual: $output" >&2
      return 1
      ;;
  esac
  case "$output" in
    *whole.md:3*)
      echo "OVER-FIRE: a REPEATED id was counted as four distinct harnesses." >&2
      echo "Arm 2 must re-count DISTINCT ids in the matched run. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: the arm-2 threshold is a MEASURED choice, and TIER_ROSTER_MIN proves it" {
  # Limit #8's numbers, executable. At the shipped threshold of 4 the hook-surface
  # trio {claude, opencode, antigravity} is silent — it is a correct 3-member
  # surface (hookTargetTypes()), and lowering the threshold to 3 is what turns
  # that class of correct line into noise. Measured over the real corpus: N=3
  # reports 10 lines where N=4 reports 3.
  cat > "$FIXTURE_DIR/threshold.md" <<'EOF'
loadout project-hook: --harness <claude|opencode|antigravity> is required
loadout project-mcp: --harness <claude|codex|gemini|opencode> is required
EOF

  # Shipped threshold: only the 4-id grammar reports.
  run env TIER_DOC_SET="$FIXTURE_DIR/threshold.md" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hardcoded roster grammar\(s\) found"
  assert_output_contains "threshold\.md:2"
  case "$output" in
    *threshold.md:1*)
      echo "The 3-id hook-surface grammar reported at the shipped threshold." >&2
      echo "TIER_ROSTER_MIN is meant to be 4 — see limit #8. Actual: $output" >&2
      return 1
      ;;
  esac

  # ARMED downward: at 3 the same scanner reports both, which is the measurement.
  run env TIER_DOC_SET="$FIXTURE_DIR/threshold.md" TIER_ROSTER_MIN=3 bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hardcoded roster grammar\(s\) found"

  # And OFF: arm 2 is a choice, not an accident of the corpus being clean.
  run env TIER_DOC_SET="$FIXTURE_DIR/threshold.md" TIER_ROSTER_MIN=0 bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
}

@test "validate_harness_tier_claims: a roster enumerated in PROSE is deliberately NOT a hit (limit #8)" {
  # THE DECLINE, MADE EXECUTABLE. The broader predicate — roster ids anywhere on
  # the line — was built and measured over the real 203-file corpus and declined:
  # a contiguous 4-id run reports 18 lines, 9 true and 9 false, and the false ones
  # are THE SAME FOUR TOKENS as the true ones ({claude,codex,gemini,opencode} is a
  # stale mcpTargetTypes() in one file and a correct agentTargetTypes() in five
  # others). After fixing all 9 true positives it still reported 7, so it would
  # sit red on a clean tree forever. Arm 2's wrapper unit reported 0.
  #
  # Line 1 is a REAL defect that shipped in init.ts and had to be fixed BY HAND
  # because no pattern here can see it. Line 2 is a numerically CORRECT line of
  # the identical shape — the reason no pattern here should try.
  cat > "$FIXTURE_DIR/prose_roster.md" <<'EOF'
- init wires it into ALL supported harnesses (Claude, Gemini, Codex, OpenCode).
- Restrict to one target type (claude|codex|gemini|opencode). Default: all.
- loadout project-mcp: --harness <claude|codex|gemini|opencode> is required
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/prose_roster.md" bash "$VALIDATOR"

  # ARMED: line 3 wraps its roster in a value grammar and IS reported, so arm 2
  # is demonstrably alive in the very run that proves lines 1-2 stay silent.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hardcoded roster grammar\(s\) found"
  assert_output_contains "prose_roster\.md:3"

  case "$output" in
    *prose_roster.md:1*|*prose_roster.md:2*)
      echo "REGRESSION OF INTENT: a PROSE roster enumeration was reported." >&2
      echo "That is limit #8 traded away. The predicate that sees line 1 also" >&2
      echo "sees line 2, which is CORRECT — re-run the 203-file measurement" >&2
      echo "before adopting it. Actual output: $output" >&2
      return 1
      ;;
  esac
}

# --- ARM 3: the DISPLAY-NAME ENUMERATION --------------------------------------
#
# The THIRD notation, and the one that survived SEVEN rounds. Arm 1 needs a
# numeral; arm 2's alternation is built from lowercase manifest ids and its unit
# is a CLI value-grammar wrapper. A prose sentence spelling the roster in DISPLAY
# names — "Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI" — has
# neither, so both existing arms are blind to it by construction. The line that
# forced this arm was byte-identical to HEAD across all six previous rounds while
# sitting eleven lines above a paragraph that had just been corrected, so the
# published doc contradicted itself.

@test "validate_harness_tier_claims: a roster spelled in DISPLAY NAMES is caught (arm 3)" {
  # Line 1 is the exact byte sequence that survived six rounds in
  # docs/substitution.md. Line 2 is its slash-joined twin — the same notation
  # with a different delimiter, folded rather than chased as a second literal.
  cat > "$FIXTURE_DIR/display.md" <<'EOF'
- Work jumps between Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI.
- Projected to Claude Code/OpenCode/Antigravity/Codex/Gemini CLI at install.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/display.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 display-name roster enumeration\(s\) found"
  assert_output_contains "display\.md:1"
  assert_output_contains "display\.md:2"

  # Arm 3 must be REPORTED AS ITSELF, for the same reason arm 2 is: a reader sent
  # to the count report goes looking for a numeral that is not on the line.
  case "$output" in
    *"hand-written count(s) found"*|*"hardcoded roster grammar(s) found"*)
      echo "MIS-ROUTED: a display-name enumeration was reported as another arm." >&2
      echo "Actual output: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: arm 3's DISPLAY NAMES are derived from agent_id, not hardcoded" {
  # THE PROPERTY THAT MAKES THIS ARM RE-ARM ITSELF. There is no display_name
  # field in the descriptor, so the spellings are derived from the id AND the
  # agent_id, with a hyphen relaxed to an optional space — which is exactly how
  # `claude-code` and `gemini-cli` become "Claude Code" and "Gemini CLI".
  #
  # The fixture descriptor declares a DIFFERENT roster whose agent_ids are
  # hyphenated. A sentence in the REAL display names must go quiet and one in the
  # FIXTURE's must report; a hardcoded name list fails the second half, and a
  # version that read only `.key` fails it too, because the fixture sentence
  # spells the AGENT_ID form with a space.
  #
  # `delta-four` carries the hyphen in the KEY while its agent_id is a DIFFERENT,
  # unhyphenated word. That combination is what arms the id-half relaxation, and
  # it took two mutation runs to get right: a hyphenated key whose agent_id is
  # the SAME string leaves the id half dead, because the agent half is relaxed
  # first and the (agent == id) test then falls through to an alternation that
  # already contains the relaxed spelling. The safety class admits a hyphenated
  # id, so the half has to be reachable or deleted.
  cat > "$FIXTURE_DIR/named-manifest.json" <<'EOF'
{ "harnesses": {
  "alpha":      { "agent_id": "alpha-one" },
  "bravo":      { "agent_id": "bravo-two" },
  "charlie":    { "agent_id": "charlie" },
  "delta-four": { "agent_id": "quebec" },
  "echo":       { "agent_id": "echo" },
  "foxtrot":    { "agent_id": "foxtrot" }
} }
EOF
  cat > "$FIXTURE_DIR/names.md" <<'EOF'
- Work jumps between Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI.
- Work jumps between Alpha One, Bravo Two, Charlie, Delta Four, or Echo.
EOF

  run env HARNESS_MANIFEST="$FIXTURE_DIR/named-manifest.json" \
    TIER_DOC_SET="$FIXTURE_DIR/names.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "descriptor declares 6 harness\(es\)"
  assert_output_contains "1 display-name roster enumeration\(s\) found"
  assert_output_contains "names\.md:2"

  case "$output" in
    *names.md:1*)
      echo "NOT DERIVED: the real display names matched a fixture descriptor." >&2
      echo "Arm 3's alternation must come from .harnesses. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: arm 3 folds CASE and the name SEPARATOR, and an exhaustive list is NOT a hit" {
  # Three properties of one computation, asserted in one run so each is armed by
  # the others.
  #
  # LINE 1 — EXHAUSTIVE IS NOT A HIT. Naming every declared harness is the thing
  # being asked for, not the defect. Pinned by `present < n`.
  #
  # LINE 2 — NOTATION FOLDING. Upper case, the hyphenated form and the fused form
  # are ONE spelling of one notation, not three vocabulary entries. If this line
  # stops reporting, someone narrowed the fold to the literal that bit us.
  #
  # LINE 3 — DISTINCTNESS. The run regex guarantees that many ELEMENTS, which a
  # REPEAT satisfies; five copies of one name is ONE harness. Re-counting
  # distinct names inside the matched run is what refuses it.
  cat > "$FIXTURE_DIR/fold.md" <<'EOF'
- Reaches Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, and Cursor.
- Reaches CLAUDE-CODE, codex, geminicli, OpenCode, or Antigravity.
- Reaches Cursor, Cursor, Cursor, Cursor, or Cursor.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/fold.md" bash "$VALIDATOR"

  # ARMED: line 2 IS reported in the same run, so the arm is demonstrably alive
  # in the very invocation that proves lines 1 and 3 stay silent.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 display-name roster enumeration\(s\) found"
  assert_output_contains "fold\.md:2"

  case "$output" in
    *fold.md:1*)
      echo "OVER-FIRE: an EXHAUSTIVE display-name list was reported." >&2
      echo "Arm 3 fires only when >= 1 declared harness is OMITTED. Actual: $output" >&2
      return 1
      ;;
  esac
  case "$output" in
    *fold.md:3*)
      echo "OVER-FIRE: a REPEATED name was counted as five distinct harnesses." >&2
      echo "Arm 3 must re-count DISTINCT names in the matched run. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: arm 3's recount is scoped to the RUN, not the LINE (the property that separates it from the declined broad unit)" {
  # ROUND 7, FINDING F1. The distinctness assertion above is REAL but it is
  # BLIND to the one edit that would turn arm 3 into the broad predicate limit
  # #10 measured and declined: changing the recount's subject from the matched
  # RUN (`seg`) to the whole LINE. Demonstrated, not reasoned — with that single
  # token changed the guard still scans the real tree at exit 0, `bash -n` is
  # clean, and every other assertion in this file stays green. A silent FALSE
  # NEGATIVE with a 44/44 twin.
  #
  # Neither existing fixture can see it. fold.md:3's five copies of one name
  # count 1 distinct whether you look at the run or the line; dprose.md:2 never
  # reaches the recount at all, because its run is four elements and the match
  # gate rejects it first. The discriminator has to MATCH the run regex and then
  # disagree between the two scopes, which needs a name placed OUTSIDE the run.
  #
  # LINE 1 — the FALSE-NEGATIVE direction, and the dangerous one. A genuine
  #          5-name run that omits Cursor, with "Cursor" sitting elsewhere on
  #          the same line. Scoped to the run: 5 present, 1 omitted -> REPORTED.
  #          Scoped to the line: all 6 present, so `present < n` is false and the
  #          real defect goes SILENT.
  # LINE 2 — the OVER-FIRE direction. A 5-ELEMENT run carrying only 4 distinct
  #          names (Codex twice), with the fifth name outside it. Scoped to the
  #          run: 4 present, below the threshold -> quiet, correctly. Scoped to
  #          the line: 5 present -> reported, which is limit #10's decline
  #          traded away by accident.
  cat > "$FIXTURE_DIR/runscope.md" <<'EOF'
- Cursor is exempt; the rest — Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI — are projected at install.
- Gemini CLI is excluded because Claude Code, OpenCode, Antigravity, Codex, or Codex already carry it.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/runscope.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 display-name roster enumeration\(s\) found"
  assert_output_contains "runscope\.md:1"

  case "$output" in
    *runscope.md:2*)
      echo "SCOPE WIDENED: a run of 4 DISTINCT names was reported because a 5th" >&2
      echo "name sits elsewhere on the LINE. Arm 3 must recount inside the" >&2
      echo "matched run — counting on the whole line IS the broad predicate" >&2
      echo "limit #10 measured (7 hits, 6 false) and declined. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: the arm-3 threshold is a MEASURED choice, and TIER_DISPLAY_MIN proves it" {
  # Limit #10's numbers, executable. The threshold is 5 rather than arm 2's 4,
  # and THE GROUND IS EMPIRICAL OVER THIS CORPUS — not the structural property
  # this comment asserted for a round. It said that five
  # "sits strictly above every declared subset" — DELIBERATELY QUOTED ON ONE LINE,
  # so the sweep that re-derives the sites carrying this claim can see this file
  # and read it as a RETRACTION. It is FALSE, and the guard header (limit #10) and
  # the MAINTAINING.md row were corrected a round before this comment was:
  # `mcp.projected` is a DECLARED five-member proper subset — antigravity is the
  # FR-179 carve-out — and not an internal detail either, since the shipped exported
  # `mcpProjectedHarnesses()` reads exactly it. So the threshold sits ON a
  # declared subset rather than above one. Declared sizes, re-derived rather than
  # recalled: agents 4, supported hooks 3, non-covered grant 4, projected mcp 5,
  # mcp block 6.
  #
  # WHAT JUSTIFIES 5 IS THE MEASUREMENT, re-run over the repaired tree (re-run,
  # never subtracted — limit #8 records making that error):
  #   - N=5 ..... 0 hits
  #   - N=4 ..... 5 hits, ALL FIVE CORRECT — an evidence claim in README.md, two
  #               wrapped per-surface subsets in docs/multi-cli.md, the
  #               MAINTAINING.md row describing this guard, and a
  #               cli-adapters/README.md gloss that already names its accessor.
  # No 4-name roster in this corpus SHOULD be caught, so dropping to 4 buys
  # nothing and costs five false positives — one of them the documentation of the
  # decline itself. That is the WEAKER guarantee, and saying so is the point:
  # it is unverified the moment the roster changes AND the moment the corpus
  # changes, so re-run both arms before trusting either number.
  #
  # THE FIXTURE IS UNCHANGED BY THAT RETRACTION, because the data was never the
  # false part — only the justification was. Line 1 is a genuinely CORRECT
  # per-surface subset at a DECLARED size — the harnesses carrying an `agents`
  # block, which `jq` reports as four — sitting one below the shipped threshold,
  # so it must stay quiet; line 2 is the defect. What the pair pins is the
  # MEASURED boundary (quiet at 5, both reported at 4), which is exactly the
  # claim above, rather than a structural gap that does not exist.
  #
  # An earlier draft used the `${VAR}` indirection set here and called it four.
  # It is FIVE (every harness except codex, which resolves neither refs nor
  # inherited env), so the fixture was asserting the threshold's own
  # justification with a stale count — round 7's finding F3. The agents block is
  # used instead because its size is DECLARED and re-derivable:
  #   jq '[.harnesses|to_entries[]|select(.value.agents)|.key]|length'
  cat > "$FIXTURE_DIR/dthreshold.md" <<'EOF'
- Claude Code, Codex, Gemini CLI and OpenCode declare an agents block.
- Work jumps between Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/dthreshold.md" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 display-name roster enumeration\(s\) found"
  assert_output_contains "dthreshold\.md:2"
  case "$output" in
    *dthreshold.md:1*)
      echo "The 4-name per-surface subset reported at the shipped threshold." >&2
      echo "TIER_DISPLAY_MIN is meant to be 5 — see limit #10. Actual: $output" >&2
      return 1
      ;;
  esac

  # ARMED downward: at 4 the same scanner reports both. That is the measurement
  # the decline rests on, not a recollection of it.
  run env TIER_DOC_SET="$FIXTURE_DIR/dthreshold.md" TIER_DISPLAY_MIN=4 bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 display-name roster enumeration\(s\) found"

  # And OFF: arm 3 is a choice, not an accident of the corpus being clean.
  run env TIER_DOC_SET="$FIXTURE_DIR/dthreshold.md" TIER_DISPLAY_MIN=0 bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
}

@test "validate_harness_tier_claims: a display name merely PRESENT on the line is deliberately NOT a hit (limit #10)" {
  # THE DECLINE, MADE EXECUTABLE — the display-name mirror of limit #8. The broad
  # predicate (names anywhere on the line, >= 5, omitting >= 1) was built and
  # measured over the real corpus before arm 3's unit was chosen: it reported 7
  # lines, of which SIX are correct. The contiguous-run unit reported 1, and that
  # 1 was the genuine defect.
  #
  # These three are the shapes those six false positives take, so a future red
  # run here reads as "you traded the limit away", not "you found a bug":
  #   LINE 1 — an EVIDENCE claim. README.md says the handoff was proven across
  #            four named tools. That is a statement about what was TESTED; it
  #            does not become false when a harness is onboarded.
  #   LINE 2 — a WRAPPED enumeration whose names are scattered across the line
  #            around an accessor that already states the exception.
  #   LINE 3 — a TABLE header row. The bash surfaces-block projector genuinely
  #            has no cursor column: `cursor` appears ZERO times in that adapter,
  #            so adding one would make the table false.
  cat > "$FIXTURE_DIR/dprose.md" <<'EOF'
The handoff is proven end-to-end across four tools: Claude, OpenCode, Codex, and Antigravity.
Every id in mcpAgentIds() except antigravity — claude-code, codex, gemini-cli, opencode
| # | Axis | claude | gemini | antigravity | opencode | codex |
- Work jumps between Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/dprose.md" bash "$VALIDATOR"

  # ARMED: line 4 IS reported, so the arm is alive in the run that proves 1-3
  # stay silent. Without this the whole test passes on a dead scanner.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 display-name roster enumeration\(s\) found"
  assert_output_contains "dprose\.md:4"

  case "$output" in
    *dprose.md:1*|*dprose.md:2*|*dprose.md:3*)
      echo "REGRESSION OF INTENT: a CORRECT display-name line was reported." >&2
      echo "That is limit #10 traded away — the broad 'names anywhere on the" >&2
      echo "line' predicate reports 7 with 6 false. Re-run the measurement" >&2
      echo "before adopting it. Actual output: $output" >&2
      return 1
      ;;
  esac
}

# --- The real tree ------------------------------------------------------------

@test "validate_harness_tier_claims: the shipped corpus is clean, and says how much it scanned" {
  run bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "OK: no hand-written harness count"
  # A scan over zero files also prints OK. The corpus-size line is what
  # distinguishes 'clean' from 'measured nothing'.
  assert_output_contains "[0-9]+ doc\(s\) scanned"
}

@test "validate_harness_tier_claims: the corpus is the explicit list PLUS core/ PLUS cli/src" {
  # DERIVED, never pinned. A literal count here would have to be re-typed every
  # time someone adds a core/ doc or a cli/src module, and a number people re-pin
  # without reading is how the scan set silently stops covering what it claims to.
  #
  # Non-vacuous in BOTH directions that matter: drop the markdown walk and the
  # validator prints ~108; drop the SOURCE walk and it prints ~101; either way
  # this expectation FAILS rather than quietly passing. The three halves are
  # deduped, so an overlap makes this test fail loudly rather than mis-measure.
  #
  # The source count re-derives the PRUNE as well as the extension — if someone
  # deletes `-name __tests__ -prune` from the validator the real corpus jumps to
  # 203 while this still expects ~203-101... no: it expects the pruned figure, so
  # the test goes RED. That is the intent; limit #6 is a measured choice and a
  # silent un-pruning must not pass.
  local default_set n_files n_tree n_src expected
  default_set="$(grep '^DEFAULT_DOC_SET=' "$VALIDATOR" | sed 's/^DEFAULT_DOC_SET=//; s/"//g')"
  n_files="$(printf '%s\n' $default_set | grep -c .)"
  n_tree="$(find "$IGRIS_ROOT/core" -type f -name '*.md' | grep -c .)"
  n_src="$(find "$IGRIS_ROOT/cli/src" -type d -name '__tests__' -prune -o \
    -type f -name '*.ts' -print | grep -c .)"
  expected=$(( n_files + n_tree + n_src ))

  [ "$n_files" -gt 0 ] || return 1
  [ "$n_tree" -gt 50 ] || return 1
  [ "$n_src" -gt 50 ] || return 1

  run bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "$expected doc\(s\) scanned"
}

@test "validate_harness_tier_claims: cli/src is walked as a SOURCE tree, and that is a declared default" {
  # The dual of the core/ default test below. Names WHICH tree and pins it as a
  # default rather than something a caller has to opt into — cli/src is the
  # SHIPPED CLI, whose `--help` strings users read and whose doc comments are
  # carried verbatim into cli/dist (`removeComments` is unset).
  run grep -c '^DEFAULT_SRC_TREE="cli/src"$' "$VALIDATOR"
  [ "$output" = "1" ] || return 1

  # And the files that motivated it are inside the walk.
  [ -f "$IGRIS_ROOT/cli/src/index.ts" ] || return 1
  [ -f "$IGRIS_ROOT/cli/src/verbs/remove.ts" ] || return 1
}

@test "validate_harness_tier_claims: a stale count in a SHIPPED .ts string is caught — the gap this widening closed" {
  # THE ARM-CHECK FOR THE WHOLE ROUND-5 WIDENING. A *.md-only scanner is not
  # merely weaker here, it is structurally incapable: the extension never
  # matched, so every shipped `--help` string and doc comment in the CLI was
  # invisible no matter what the pattern said. Both halves are asserted — the
  # count IS reported when the tree is walked as source, and is NOT reported by
  # the markdown walk over the same directory.
  mkdir -p "$FIXTURE_DIR/srctree/verbs"
  cat > "$FIXTURE_DIR/srctree/verbs/remove.ts" <<'EOF'
/**
 * Doc-comment twin: un-projects from all four harnesses.
 */
export const help = "UN-PROJECTS from every harness: projects to all 5 harnesses";
EOF
  printf '# Not a source file\n' > "$FIXTURE_DIR/srctree/README.md"

  # The markdown walk over the SAME directory sees the .md and not the .ts.
  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/srctree" TIER_SRC_TREE="" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"

  # The SOURCE walk reads the .ts and reports both the doc comment and the
  # shipped string.
  run env TIER_DOC_SET="" TIER_DOC_TREE="" TIER_SRC_TREE="$FIXTURE_DIR/srctree" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"
  assert_output_contains "remove\.ts:2"
  assert_output_contains "remove\.ts:4"
}

@test "validate_harness_tier_claims: the __tests__ prune is a CHOICE, not an inability (limit #6)" {
  # Limit #6 was MEASURED: all of cli/src/**/*.ts is 203 files / 23 hits, and
  # excluding __tests__ is 102 files / 12 hits with zero false positives. The 11
  # dropped hits are test titles scoping a fixture plus one UNIX FILE MODE
  # ("a 644 harness config"). Assert the exclusion is deliberate the same way the
  # changelog exclusion is: pointed at the pruned tree explicitly, the SAME
  # scanner reports it.
  mkdir -p "$FIXTURE_DIR/pruned/__tests__"
  printf 'export const a = 1; // clean\n' > "$FIXTURE_DIR/pruned/real.ts"
  cat > "$FIXTURE_DIR/pruned/__tests__/thing.test.ts" <<'EOF'
it("T12: a 644 harness config (gemini) WARNs in the read pass", () => {});
EOF

  # Pruned (the shipped default): the test file is neither scanned nor reported.
  run env TIER_DOC_SET="" TIER_DOC_TREE="" TIER_SRC_TREE="$FIXTURE_DIR/pruned" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"

  # ARMED: with the prune turned off, the same scanner reads it and reports the
  # file-mode false positive — which is the measurement, executable.
  run env TIER_DOC_SET="" TIER_DOC_TREE="" TIER_SRC_TREE="$FIXTURE_DIR/pruned" \
    TIER_SRC_EXCLUDE="" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 doc\(s\) scanned"
  assert_output_contains "thing\.test\.ts:1"
}

@test "validate_harness_tier_claims: the HYPHEN-LED DIGIT compound 'all-6-harness' is caught" {
  # The digit mirror of the 'all-four-harness' compound the word half catches.
  # It was invisible because the digit half excludes a leading hyphen for brief
  # ids — but the two shapes are separable by their SEPARATOR: a brief id puts a
  # SPACE before the noun ("FR-136 Harness"), a compound puts a HYPHEN. Measured
  # over the real 203-file corpus before it was written: 12 -> 12 hits, i.e. it
  # adds ZERO false positives. Fixed rather than stated as a limit because the
  # measurement said it was free.
  cat > "$FIXTURE_DIR/hyphendigit.md" <<'EOF'
The all-6-harness matrix is regenerated at vendor time.
An all-4-harness sweep would be the same defect.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/hyphendigit.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 hand-written count\(s\) found"
  assert_output_contains "hyphendigit\.md:1"
  assert_output_contains "hyphendigit\.md:2"
}

@test "validate_harness_tier_claims: the hyphen-digit relaxation does NOT re-open the brief-id over-fire" {
  # The paired negative, and the reason the relaxation keys on the SEPARATOR
  # rather than simply dropping the hyphen from the digit half. Dropping it
  # would match '-136 Harness' whole and report every brief id as a support
  # count — the over-fire this guard's oldest negative test pins, which already
  # came back once when the digit class widened to [0-9]+.
  cat > "$FIXTURE_DIR/hyphendigit_neg.md" <<'EOF'
- FR-136 Harness manifest schema, superseded in part by TD-367 harness tiers.
- See FR-217 harness descriptor and FR-192 harness onboarding.
- The all-6-harness matrix is the compound the relaxation DOES catch.
EOF

  run env TIER_DOC_SET="$FIXTURE_DIR/hyphendigit_neg.md" bash "$VALIDATOR"

  # ARMED: exactly ONE hit, and it is the compound on line 3 — so the pattern is
  # demonstrably alive in the same run that proves the brief ids stay silent.
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "1 hand-written count\(s\) found"
  assert_output_contains "hyphendigit_neg\.md:3"

  case "$output" in
    *hyphendigit_neg.md:1*|*hyphendigit_neg.md:2*)
      echo "REGRESSION: a BRIEF ID was reported as a support count." >&2
      echo "The hyphen-digit relaxation must key on the SEPARATOR (hyphen tail)," >&2
      echo "not on dropping the leading-hyphen exclusion. Actual: $output" >&2
      return 1
      ;;
  esac
}

@test "validate_harness_tier_claims: a source tree that is not on disk is named, not silently skipped" {
  mkdir -p "$FIXTURE_DIR/srcpresent"
  printf 'export const a = 1;\n' > "$FIXTURE_DIR/srcpresent/ok.ts"

  run env TIER_DOC_SET="" TIER_DOC_TREE="" \
    TIER_SRC_TREE="$FIXTURE_DIR/srcpresent does/not/exist" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "not on disk \(src tree\): does/not/exist"
  assert_output_contains "1 doc\(s\) scanned"
}

@test "validate_harness_tier_claims: the tree walk READS what a list could not — armed inside core/'s own shape" {
  # The arm-check for blind spot #3. A fixture TREE stands in for core/ so the
  # repo never has a doc carrying a count written into it, but the shape is the
  # one that bit us: a count in a nested subdirectory that no list names.
  mkdir -p "$FIXTURE_DIR/tree/os" "$FIXTURE_DIR/tree/docs"
  printf 'Projected to all four harnesses.\n' > "$FIXTURE_DIR/tree/docs/ADD.md"
  printf 'Nothing to see here.\n' > "$FIXTURE_DIR/tree/os/clean.md"

  # List-only (the pre-widening shape): the nested doc is structurally invisible.
  run env TIER_DOC_SET="$FIXTURE_DIR/tree/os/clean.md" TIER_DOC_TREE="" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"

  # Same corpus root, walked: the count is reported.
  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/tree" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "2 doc\(s\) scanned"
  assert_output_contains "ADD\.md:1"
}

@test "validate_harness_tier_claims: the walk does NOT follow symlinks out of the tree" {
  # core/ is TD-096-mirrored to ~/.igris/core/. If any of it were ever a symlink
  # to the runtime mirror, a following walk would either escape the repo or
  # report every hit twice under two paths. `find -P -type f` declines both.
  mkdir -p "$FIXTURE_DIR/symtree/nested" "$FIXTURE_DIR/symoutside"
  printf 'It reaches all five harnesses.\n' > "$FIXTURE_DIR/symoutside/leak.md"
  printf 'Nothing to see here.\n' > "$FIXTURE_DIR/symtree/real.md"
  ln -sf "$FIXTURE_DIR/symoutside/leak.md" "$FIXTURE_DIR/symtree/nested/leak-link.md"
  ln -sfn "$FIXTURE_DIR/symoutside" "$FIXTURE_DIR/symtree/nested/outside-dir"

  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/symtree" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"

  # ARMED: the skipped file is not merely clean — pointed at directly, the same
  # scanner reports it. Without this the test above passes for a doc that has
  # no count in it at all.
  run env TIER_DOC_SET="$FIXTURE_DIR/symoutside/leak.md" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "leak\.md:1"
}

@test "validate_harness_tier_claims: the corpus order is deterministic across runs" {
  # `find` returns directory order, which differs by filesystem and by the order
  # files were created. An unsorted corpus makes the REPORT reorder between
  # machines, so a reviewer diffing two runs sees churn that means nothing.
  mkdir -p "$FIXTURE_DIR/order/b" "$FIXTURE_DIR/order/a"
  printf 'all six harnesses\n' > "$FIXTURE_DIR/order/b/two.md"
  printf 'all six harnesses\n' > "$FIXTURE_DIR/order/a/one.md"
  printf 'all six harnesses\n' > "$FIXTURE_DIR/order/c.md"

  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/order" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  local first="$output"

  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/order" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  [ "$output" = "$first" ] || return 1
  assert_output_contains "3 hand-written count\(s\) found"
}

@test "validate_harness_tier_claims: a doc named in BOTH the list and the tree is scanned once" {
  # The corpus-size line is the guard's own evidence that it measured something;
  # double-counting would inflate it while scanning no more prose.
  mkdir -p "$FIXTURE_DIR/dedup"
  printf 'Nothing to see here.\n' > "$FIXTURE_DIR/dedup/only.md"

  run env TIER_DOC_SET="$FIXTURE_DIR/dedup/only.md" TIER_DOC_TREE="$FIXTURE_DIR/dedup" \
    bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "1 doc\(s\) scanned"
}

@test "validate_harness_tier_claims: a tree that is not on disk is named, not silently skipped" {
  mkdir -p "$FIXTURE_DIR/present"
  printf 'Nothing to see here.\n' > "$FIXTURE_DIR/present/ok.md"

  run env TIER_DOC_SET="" TIER_DOC_TREE="$FIXTURE_DIR/present does/not/exist" bash "$VALIDATOR"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "not on disk \(tree\): does/not/exist"
  assert_output_contains "1 doc\(s\) scanned"
}

@test "validate_harness_tier_claims: MAINTAINING.md is SCANNED, not merely a trigger" {
  # scripts/git-hooks/pre-commit triggers this validator on MAINTAINING.md
  # (it is the contract home and carries the tier row). Staging the contract
  # home must not run a scanner that structurally cannot see the contract home.
  run grep -c 'MAINTAINING\.md' <<< "$(grep '^DEFAULT_DOC_SET=' "$VALIDATOR")"
  [ "$output" = "1" ] || return 1

  # And the trigger list that makes this matter is still there.
  run grep -c 'MAINTAINING' <<< "$(grep -A2 'validate_harness_tier_claims\.sh' "$IGRIS_ROOT/scripts/git-hooks/pre-commit")"
  [ "$output" -ge 1 ] || return 1
}

@test "validate_harness_tier_claims: staging a core/ doc TRIGGERS the guard that now scans core/" {
  # The dual of the test above. Widening the corpus to core/ buys nothing at the
  # commit boundary if the hook still only runs on the six explicit docs: the
  # scanner would be able to see the file and never be asked. Both halves —
  # scanned AND triggered — have to hold, and TD-367 has already shipped a
  # version of this gap in each direction.
  local trigger
  trigger="$(grep -E "^  if echo \"\\\$staged\" \| grep -qE .*validate|^  if echo \"\\\$staged\"" \
    "$IGRIS_ROOT/scripts/git-hooks/pre-commit" | grep 'docs/substitution')"
  [ -n "$trigger" ] || return 1

  # The pattern must admit a markdown file anywhere under core/.
  run grep -c 'core/\.\*\\\.md' <<< "$trigger"
  [ "$output" = "1" ] || return 1

  # ARMED against the regex itself, not just its text: run the real trigger
  # pattern over a core/ path and over a path it must NOT claim.
  local pat
  pat="$(printf '%s\n' "$trigger" | sed "s/.*grep -qE '//; s/'; then.*//")"
  printf '%s\n' 'core/os/surfaces-detail.md' | grep -qE "$pat" || return 1
  printf '%s\n' 'core/os/surfaces-detail.txt' | grep -qE "$pat" && return 1
  printf '%s\n' 'core/os/surfaces-detail.md.bak' | grep -qE "$pat" && return 1
  return 0
}

@test "validate_harness_tier_claims: staging a cli/src SOURCE file TRIGGERS the guard that now scans cli/src" {
  # THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED. Until TD-367's round-5
  # widening this same test asserted `cli/src/index.ts` must NOT match the
  # trigger — a correct pin of the scanner's then-real *.md-only corpus, and
  # simultaneously the pin of the blind spot that let `igris remove --help` ship
  # "UN-PROJECTS from every harness" while both of its prose twins were hedged in
  # the same diff. The corpus moved, so the pin inverts.
  local trigger pat
  trigger="$(grep -E "^  if echo \"\\\$staged\"" \
    "$IGRIS_ROOT/scripts/git-hooks/pre-commit" | grep 'docs/substitution')"
  [ -n "$trigger" ] || return 1
  pat="$(printf '%s\n' "$trigger" | sed "s/.*grep -qE '//; s/'; then.*//")"

  # The shipped `--help` strings and the doc-comment twins that motivated it.
  printf '%s\n' 'cli/src/index.ts' | grep -qE "$pat" || return 1
  printf '%s\n' 'cli/src/verbs/remove.ts' | grep -qE "$pat" || return 1
  printf '%s\n' 'cli/src/lib/mcp-register.ts' | grep -qE "$pat" || return 1

  # Trigger WIDE, scan NARROW: a test file is not in the CORPUS (limit #6) but IS
  # in the trigger on purpose — firing a 0.5s WARN-only scan too often is cheap,
  # firing it too rarely is the failure this brief exists to end.
  printf '%s\n' 'cli/src/__tests__/doctor.test.ts' | grep -qE "$pat" || return 1

  # And it must not over-claim: a non-TS file under cli/src, or a TS file in a
  # tree the scanner does not walk, is NOT a trigger.
  printf '%s\n' 'cli/src/README.md' | grep -qE "$pat" && return 1
  printf '%s\n' 'brain-mcp-server/src/index.ts' | grep -qE "$pat" && return 1
  printf '%s\n' 'cli/dashboard/src/main.ts' | grep -qE "$pat" && return 1
  return 0
}

@test "validate_harness_tier_claims: core/ is walked as a TREE, and that is a declared default" {
  # The count-derived test above proves the walk happened; this names WHICH tree
  # and pins it as a default rather than something a caller has to opt into.
  # core/ is the TD-096-mirrored OS prose the agent reads at Boot on every
  # install — a count there is shipped text, and it is where six of them
  # accumulated while the scan set was a list.
  run grep -c '^DEFAULT_DOC_TREE="core"$' "$VALIDATOR"
  [ "$output" = "1" ] || return 1

  # And the mirrored files that motivated it are inside the walk.
  [ -f "$IGRIS_ROOT/core/os/surfaces-detail.md" ] || return 1
  [ -f "$IGRIS_ROOT/core/docs/ADD-SURFACES.md" ] || return 1
}

@test "validate_harness_tier_claims: the default doc set EXCLUDES both changelogs by design" {
  # A shipped changelog is a historical record — TD-367 corrects 7.1.0 by
  # appending a note, never by editing the entry. Assert the exclusion is a
  # deliberate SET choice, not an inability: pointed at a changelog explicitly,
  # the same scanner reports it.
  run grep -c 'CHANGELOG' <<< "$(grep '^DEFAULT_DOC_SET=' "$VALIDATOR")"
  [ "$output" = "0" ] || return 1

  run env TIER_DOC_SET="CHANGELOG.md" bash "$VALIDATOR"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "CHANGELOG\.md:"
}

# --- Fail-open, LOUDLY --------------------------------------------------------

@test "validate_harness_tier_claims: an unreadable descriptor SKIPs with exit 0 and says so" {
  run env HARNESS_MANIFEST="$FIXTURE_DIR/nope.json" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "SKIP"
  assert_output_contains "could not read \.harnesses"
}

@test "validate_harness_tier_claims: a doc set with nothing on disk SKIPs with exit 0 and names what was missing" {
  run env TIER_DOC_SET="does/not/exist.md" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "SKIP — none of the scanned docs exist"
  assert_output_contains "not on disk: does/not/exist\.md"
}

@test "validate_harness_tier_claims: with jq absent it falls back to python3 and still reports" {
  # The plan asked for 'a jq-absent run exits 0'. The stronger property is that
  # a jq-absent run still WORKS — python3 is a required Igris dependency, jq is
  # the optional one (coding_guidelines §3). So the fallback must not silently
  # turn the guard into a no-op.
  local sandbox="$FIXTURE_DIR/bin-nojq"
  mkdir -p "$sandbox"
  for tool in bash dirname grep sed wc tr python3; do
    local real
    real="$(command -v "$tool" || true)"
    [ -n "$real" ] || skip "required tool not on PATH: $tool"
    ln -sf "$real" "$sandbox/$tool"
  done
  [ ! -e "$sandbox/jq" ] || return 1

  cat > "$FIXTURE_DIR/nojq.md" <<'EOF'
It reaches all five harnesses.
EOF

  run env -i PATH="$sandbox" HOME="$HOME" \
    TIER_DOC_SET="$FIXTURE_DIR/nojq.md" bash "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  assert_output_contains "descriptor declares 6 harness\(es\)"
  assert_output_contains "1 hand-written count\(s\) found"
}

@test "validate_harness_tier_claims: with neither jq nor python3 it SKIPs with exit 0 and says which reader is missing" {
  local sandbox="$FIXTURE_DIR/bin-none"
  mkdir -p "$sandbox"
  for tool in bash dirname grep sed wc tr; do
    local real
    real="$(command -v "$tool" || true)"
    [ -n "$real" ] || skip "required tool not on PATH: $tool"
    ln -sf "$real" "$sandbox/$tool"
  done

  run env -i PATH="$sandbox" HOME="$HOME" bash "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  assert_output_contains "neither jq nor python3"
}
