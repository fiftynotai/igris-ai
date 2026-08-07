#!/bin/bash
set -e

# Description: The ONE acceptance-criteria checkbox parser (TD-325). Reads a
#              brief's markdown content, isolates its `## Acceptance Criteria`
#              block(s), and reports how many criteria are ticked, deferred, or
#              still open. Pure and read-only: it opens no database, runs no
#              SQL, and writes nothing. Callers hand it content on stdin or a
#              file path.
#
#              THREE consumers share this one implementation, deliberately:
#                L1  core/skills/hunt/SKILL.md          (authoring-time check)
#                L2  scripts/git-hooks/commit-msg       (the closing-commit gate)
#                L3  scripts/validate_brief_ac_completion.sh (observer + the
#                    TD-075 retroactive worklist driver)
#              Because they share the parser, the gate's refusal set and the
#              audit's population are IDENTICAL BY CONSTRUCTION. That identity
#              is the specific failure TD-325 exists to prevent: the cognition
#              gap-candidate queue was a lossy index of the real signal (45%
#              coverage, 2.5x duplication, 194 affected briefs never indexed at
#              all), so a cleared queue read as "handled" while most of the
#              population was invisible. A SECOND checkbox-parsing
#              implementation re-opens that hole. Change this file; never fork
#              it.
#
#              It is also why `content LIKE '%- [ ]%'` is NOT the population.
#              That substring matches inline code spans in prose — TD-325's own
#              body contains `- [ ]` twice inside backticks, neither a checkbox
#              — and it matches checkboxes outside the AC block entirely. It
#              also MISSES whole populations (see the ordered-marker note
#              below). Measured over the 447 terminal igris-ai briefs on
#              2026-08-07: LIKE 379, this parser 388 — 2 LIKE-only, 11
#              parser-only. The two numbers differ in BOTH directions.
#
# THE THREE BOX STATES (the contract this file owns):
#   - [ ]   open      — the criterion is neither met nor consciously deferred.
#   - [x]   ticked    — met, and VERIFIED. `[X]` counts too.
#   - [~]   deferred  — knowingly unmet at close, WITH a recorded reason and a
#                       named follow-up brief.
#
#   `[ ]` -> `[x]` and `[ ]` -> `[~]` are BOTH a one-character edit. That
#   symmetry is load-bearing: if deferring cost more keystrokes than ticking,
#   the gate would breed false ticks and be worse than no gate at all.
#
# WHAT A DEFERRAL MUST CARRY (operator decision D2):
#   The literal token `DEFERRED` inside the item's extent, AND a follow-up brief
#   id. A reason alone is not enough — "deferred, no brief" is indistinguishable
#   from "deferred and forgotten". The follow-up id is accepted from either of
#   two places:
#     (a) the item's own extent — the canonical form the refusal message
#         teaches:  - [~] **DEFERRED: <why it is unmet>** -> TD-XXX
#     (b) a DEFERRAL SECTION — a heading whose text contains "deferr" (e.g.
#         FR-241's `## The deferred AC, and why`), which is where the operator's
#         own shipped precedent put the prose. FR-241's AC line says "see below"
#         and the section names TD-325. Writing a deferral section is itself a
#         deliberate act, so this is a narrow fallback, not a loophole.
#
#   THE LIMIT OF THIS CHECK, stated plainly: it verifies that a follow-up id is
#   NAMED, not that the brief EXISTS or is the right one. This file opens no
#   database by contract, so referential integrity is a review-layer question.
#   It is a tripwire for the forgotten deferral, not a proof of follow-through.
#
# A TICK IS AN ASSERTION OF EVIDENCE, and no regex can check it (TD-311).
#   Ticking a box on genuinely-complete work is a RECORD CORRECTION: the closing
#   commit, the tests and the diff are independent evidence, so the tick ADDS
#   information. Resolving a status<->phase contradiction has no such evidence —
#   "fixing" it means CHOOSING which recorded state is true, which is the move
#   TD-311 forbids. The line between them is verification, so:
#     a tick made without per-AC verification IS the forbidden move.
#   This parser cannot detect one. Tick-evidence is a review-layer obligation
#   (warden + the coding_guidelines §17 checklist row), and the retroactive
#   sweep (TD-075) must be per-brief, per-AC, evidence-cited — never a bulk
#   UPDATE, never a `sed`.
#
# Usage:
#   brief_ac_check.sh [--brief-id <ID>] [--guidance] <file>
#   brief_ac_check.sh [--brief-id <ID>] [--guidance] -      # content on stdin
#
#   --brief-id <ID>  labels the output line only. It does not change parsing.
#   --guidance       append the paste-ready deferral form after a FAIL. The
#                    caller owns any tool-specific escape-hatch line (the
#                    commit-msg hook prints its own bypass), so this script
#                    stays harness- and tool-agnostic.
#
# Output — one machine line, then human detail:
#   AC-GATE <id>: VERDICT=FAIL total=6 ticked=0 deferred=0 unticked=6 \
#       deferred_no_reason=0 deferred_no_followup=0
#     - [ ] <the first line of each offending criterion>
#
# Verdicts and exit codes:
#   PASS      0   at least one criterion parsed, unticked == 0, and every [~]
#                 carries DEFERRED + a follow-up id
#   NO_AC     0   no Acceptance Criteria heading (fail-open: many legacy briefs
#                 have no AC section at all, and inventing one is not this
#                 script's job)
#   NO_ITEMS  0   an AC heading exists but the block holds no parseable checkbox
#                 (prose-only criteria, or a notation this parser does not know)
#   DEGRADED  0   unreadable or empty input (fail-open at every tier)
#   FAIL      1   any [ ] remains, or a [~] is missing DEFERRED or a follow-up
#
# WHY `NO_ITEMS` IS ITS OWN VERDICT AND NOT A PASS:
#   A "pass" earned by parsing nothing is the defect class this repo keeps
#   filing — a gate that goes green because what it measured moved somewhere it
#   cannot see. Measured while building TD-325, by running this parser against
#   a HYPHEN-ONLY variant of itself over the 447-brief corpus: 37 briefs read
#   differently, and 32 of those the hyphen-only regex turned from FAIL into a
#   vacuous pass, because they write their criteria with ORDERED markers
#   (`1. [ ]`, the v4-era template). Folding the marker notation recovered them;
#   this verdict makes the residue — a block whose criteria are prose (FR-120 is
#   the real case), or in a notation nobody has taught this file — VISIBLE
#   instead of green. It still exits 0: refusing a commit because a legacy brief
#   wrote its criteria as prose would be the gate inventing a rule nobody
#   agreed to.
#
# PERFORMANCE IS PART OF THE CONTRACT. The L3 validator runs this over the whole
#   terminal corpus (447 briefs on igris-ai today) inside a pre-commit hook. An
#   earlier draft used command substitution — `lvl="$(heading_level "$ln")"` —
#   on every line of every brief, which forks a subshell per line and took
#   79.5s for that corpus. Everything on the per-line path below is now builtin
#   only: `[[ ]]`, parameter expansion, and helpers that return through globals.
#   Do not reintroduce `$( )`, `grep`, `sed` or `tr` inside the line loops.

usage() {
  sed -n '4,33p' "$0" | sed 's/^# \{0,1\}//'
}

# --- Tokens that LOOK like a brief id but are not ----------------------------
# The follow-up test matches `[A-Z]{2,3}-[0-9]+` case-sensitively. That shape is
# shared by a handful of standards/encoding names which do appear in deferral
# prose, and a `DEFERRED ... UTF-8` naming no brief would otherwise read as
# "follow-up named". These are SHAPE COLLISIONS, not a vocabulary: the brief-id
# prefix space is open (17 distinct prefixes across the brain, including
# consumer projects), so an allowlist of prefixes is not available — a denylist
# of collisions is. Add to it only when a real false pass is observed.
NON_BRIEF_TOKENS=(
  UTF-8 UTF-16 UTF-32
  SHA-1 SHA-256 SHA-512
  MD-5
  ISO-8601
  RFC-1918 RFC-2119
  AES-128 AES-256
  X-509
  TLS-1
  ES-2015 ES-2020
  WCAG-2
  IPV-4 IPV-6
  HTTP-1 HTTP-2 HTTP-3
)

BRIEF_ID=""
GUIDANCE=0
INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --brief-id)
      BRIEF_ID="${2:-}"
      shift 2
      ;;
    --brief-id=*)
      BRIEF_ID="${1#*=}"
      shift
      ;;
    --guidance)
      GUIDANCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -)
      INPUT="-"
      shift
      ;;
    -*)
      echo "brief_ac_check.sh: unknown option '$1'" >&2
      exit 2
      ;;
    *)
      INPUT="$1"
      shift
      ;;
  esac
done

LABEL="${BRIEF_ID:-<unlabelled>}"

# --- Read the content (fail-open on anything unreadable) ---------------------
content=""
if [ -z "$INPUT" ] || [ "$INPUT" = "-" ]; then
  content="$(cat || true)"
else
  if [ ! -r "$INPUT" ]; then
    echo "AC-GATE $LABEL: VERDICT=DEGRADED reason=unreadable-input path=$INPUT"
    exit 0
  fi
  content="$(cat "$INPUT" || true)"
fi

if [ -z "$content" ]; then
  echo "AC-GATE $LABEL: VERDICT=DEGRADED reason=empty-input"
  exit 0
fi

# `<<<` appends a trailing newline, so a plain read loop sees every line.
lines=()
while IFS= read -r ln; do
  lines+=("$ln")
done <<< "$content"
line_count=${#lines[@]}

# --- Helpers. All builtin-only: no forks on any per-line path -----------------

# scan_heading <line> — sets _LVL (1..6, or 0 when the line is not an ATX
# heading) and _HTEXT (the heading text with the #s and following space
# stripped). Returns through globals rather than stdout precisely so callers
# never need `$( )`.
_LVL=0
_HTEXT=""
scan_heading() {
  local l="$1"
  if [[ "$l" =~ ^(#{1,6})([[:space:]]|$) ]]; then
    _LVL=${#BASH_REMATCH[1]}
    l="${l#"${BASH_REMATCH[1]}"}"
    _HTEXT="${l#"${l%%[![:space:]]*}"}"
  else
    _LVL=0
    _HTEXT=""
  fi
}

# heading_is_ac <text> — case-insensitive "acceptance criteria" ANYWHERE in the
# heading. nocasematch is toggled around the single test rather than set
# globally, because the DEFERRED token and the follow-up id are checked
# CASE-SENSITIVELY a few lines down and a global flag would quietly loosen both.
heading_is_ac() {
  local r=1
  shopt -s nocasematch
  [[ "$1" =~ acceptance[[:space:]]+criteria ]] && r=0
  shopt -u nocasematch
  return "$r"
}

# heading_is_deferral <text> — case-insensitive "deferr" anywhere.
heading_is_deferral() {
  local r=1
  shopt -s nocasematch
  [[ "$1" == *deferr* ]] && r=0
  shopt -u nocasematch
  return "$r"
}

# has_followup <text> — 0 when the text names something brief-id-shaped that is
# not a known shape collision. Parameter-expansion substitution is always
# case-sensitive, so the strip below cannot be loosened by a stray nocasematch.
has_followup() {
  local t="$1" x
  for x in "${NON_BRIEF_TOKENS[@]}"; do
    t="${t//$x/}"
  done
  [[ "$t" =~ [A-Z][A-Z][A-Z]?-[0-9] ]]
}

# --- Pass 1: does any DEFERRAL SECTION name a follow-up brief? ----------------
# A deferral section is a heading whose text contains "deferr" — FR-241's
# `## The deferred AC, and why` is the shipped precedent. Its body runs to the
# next heading at the same-or-shallower level. Code fences are tracked so a `#`
# line inside one cannot be mistaken for a heading.
deferral_section_followup=0
in_fence=0
in_section=0
section_level=0
i=0
while [ "$i" -lt "$line_count" ]; do
  ln="${lines[$i]}"

  if [[ "$ln" =~ ^[[:space:]]*(\`\`\`|~~~) ]]; then
    in_fence=$(( 1 - in_fence ))
    i=$((i + 1))
    continue
  fi
  if [ "$in_fence" -eq 1 ]; then
    i=$((i + 1))
    continue
  fi

  scan_heading "$ln"
  if [ "$_LVL" -gt 0 ]; then
    if [ "$in_section" -eq 1 ] && [ "$_LVL" -le "$section_level" ]; then
      in_section=0
    fi
    if heading_is_deferral "$_HTEXT"; then
      in_section=1
      section_level=$_LVL
    fi
    i=$((i + 1))
    continue
  fi

  if [ "$in_section" -eq 1 ] && has_followup "$ln"; then
    deferral_section_followup=1
  fi
  i=$((i + 1))
done

# --- Pass 2: collect the criteria from EVERY Acceptance Criteria block -------
# ONE pass, because a brief may carry more than one AC block and the criteria in
# the second one are still criteria. Measured on the terminal igris-ai corpus:
# MG-013 has `## Acceptance Criteria` followed by
# `## Acceptance Criteria — registry drift test cases`, and FR-120 has
# `## In-Scope Acceptance Criteria` followed by `## Acceptance Criteria Mapping`.
# A first-block-only reader silently ignored the second block in both, and in
# FR-120's case read the WRONG one. The union can only ever find MORE unticked
# boxes, never fewer, so it is the conservative reading as well as the correct
# one.
#
# HEADING MATCH — a notation fold, not a vocabulary widening. The text must
# still contain the two words `acceptance criteria` (case-insensitive); what is
# tolerated is a QUALIFIER around them:
#   `## Acceptance Criteria`                      430 of the 447 terminal briefs
#   `## Acceptance Criteria (epic-level)` / `— all resolved` / `Mapping`
#   `## In-Scope Acceptance Criteria` / `## Epic-level acceptance criteria`
# A heading that says only `Acceptance` (`### Acceptance (as shipped)`) is a
# DIFFERENT heading and is deliberately NOT matched — folding that far would
# reach a different word. If a qualifier-bearing heading turns out to be prose,
# its block simply contributes no items; the cost of a loose match is zero,
# while the cost of a tight one was two mis-read briefs.
#
# ITEM LINES: a LIST MARKER followed by a box `[ ]` / `[x]` / `[X]` / `[~]`,
# LINE-ANCHORED (leading whitespace allowed, nothing else). The anchoring is
# what makes an inline code span in prose — `- [ ]` mid-sentence — invisible
# here; TD-325's own body carries two of those, and `LIKE '%- [ ]%'` counts both.
#
# The marker set FOLDS NOTATION too: `-`, `*`, `+` (the three markdown bullets)
# and `1.` / `1)` (ordered). The ordered forms are not hypothetical: running this
# parser against a hyphen-only variant of itself over the 447 terminal igris-ai
# briefs, 37 read differently and 32 of those went from FAIL to a vacuous pass —
# they write their criteria as `1. [ ]`, from the v4-era template. The BOX is
# still required: a numbered list with no `[ ]` is prose, not a criterion.
#
# An item's EXTENT runs to the next item line or the end of its block, so a
# wrapped criterion (every real brief wraps them) keeps its continuation lines
# and a `DEFERRED` token on line two still belongs to its item.
item_states=()
item_firsts=()
item_extents=()

ac_found=0
in_ac=0
ac_level=0
in_fence=0
cur=-1
i=0
while [ "$i" -lt "$line_count" ]; do
  ln="${lines[$i]}"

  if [[ "$ln" =~ ^[[:space:]]*(\`\`\`|~~~) ]]; then
    # A checkbox shown as an EXAMPLE inside a fenced block is documentation,
    # not a criterion — and a `#` line inside one is not a heading.
    in_fence=$(( 1 - in_fence ))
    i=$((i + 1))
    continue
  fi
  if [ "$in_fence" -eq 1 ]; then
    i=$((i + 1))
    continue
  fi

  scan_heading "$ln"
  if [ "$_LVL" -gt 0 ]; then
    # A heading at the same-or-shallower level closes the block we are in.
    if [ "$in_ac" -eq 1 ] && [ "$_LVL" -le "$ac_level" ]; then
      in_ac=0
      cur=-1
    fi
    if heading_is_ac "$_HTEXT"; then
      in_ac=1
      ac_level=$_LVL
      ac_found=1
      cur=-1
    fi
    i=$((i + 1))
    continue
  fi

  if [ "$in_ac" -eq 1 ]; then
    if [[ "$ln" =~ ^[[:space:]]*([-*+]|[0-9]+[.\)])[[:space:]]+\[([\ xX~])\] ]]; then
      state="${BASH_REMATCH[2]}"
      first="${ln#"${ln%%[![:space:]]*}"}"
      item_states+=("$state")
      item_firsts+=("${first%"${first##*[![:space:]]}"}")
      item_extents+=("$ln")
      cur=$(( ${#item_states[@]} - 1 ))
    elif [ "$cur" -ge 0 ]; then
      item_extents[cur]="${item_extents[cur]}"$'\n'"$ln"
    fi
  fi
  i=$((i + 1))
done

if [ "$ac_found" -eq 0 ]; then
  echo "AC-GATE $LABEL: VERDICT=NO_AC total=0 ticked=0 deferred=0 unticked=0 deferred_no_reason=0 deferred_no_followup=0"
  exit 0
fi

total=${#item_states[@]}
ticked=0
deferred=0
unticked=0
deferred_no_reason=0
deferred_no_followup=0
detail=""

idx=0
while [ "$idx" -lt "$total" ]; do
  state="${item_states[$idx]}"
  first="${item_firsts[$idx]}"
  extent="${item_extents[$idx]}"

  # Truncate the echoed line so a wrapped criterion stays one report line; the
  # first ~100 chars are always enough to find the criterion in the brief.
  shown="$first"
  if [ "${#shown}" -gt 100 ]; then
    shown="${shown:0:100}..."
  fi

  case "$state" in
    x|X)
      ticked=$((ticked + 1))
      ;;
    '~')
      deferred=$((deferred + 1))
      # CASE-SENSITIVE on purpose: the token is `DEFERRED`, not the ordinary
      # English word. Parameter-expansion substitution never folds case, so this
      # cannot be loosened by a stray `shopt`. "deferred, we ran out of time" is
      # prose; `DEFERRED:` is a declaration.
      if [ "${extent//DEFERRED/}" = "$extent" ]; then
        deferred_no_reason=$((deferred_no_reason + 1))
        detail+="  DEFERRAL WITHOUT A REASON: $shown"$'\n'
      elif ! has_followup "$extent" && [ "$deferral_section_followup" -eq 0 ]; then
        deferred_no_followup=$((deferred_no_followup + 1))
        detail+="  DEFERRAL WITHOUT A FOLLOW-UP BRIEF: $shown"$'\n'
      fi
      ;;
    *)
      unticked=$((unticked + 1))
      detail+="  $shown"$'\n'
      ;;
  esac
  idx=$((idx + 1))
done

verdict="PASS"
if [ "$total" -eq 0 ]; then
  # An AC heading with nothing this parser can read. NOT a pass — see the header.
  verdict="NO_ITEMS"
elif [ "$unticked" -gt 0 ] || [ "$deferred_no_reason" -gt 0 ] || [ "$deferred_no_followup" -gt 0 ]; then
  verdict="FAIL"
fi

echo "AC-GATE $LABEL: VERDICT=$verdict total=$total ticked=$ticked deferred=$deferred unticked=$unticked deferred_no_reason=$deferred_no_reason deferred_no_followup=$deferred_no_followup"

if [ "$verdict" = "PASS" ]; then
  exit 0
fi

if [ "$verdict" = "NO_ITEMS" ]; then
  echo "  the Acceptance Criteria block holds no parseable checkbox item."
  echo "  criteria written as prose (or in an unknown notation) cannot be gated;"
  echo "  rewrite them as '- [ ] <criterion>' to bring them under the gate."
  exit 0
fi

printf '%s' "$detail"

if [ "$GUIDANCE" -eq 1 ]; then
  # The paste-ready deferral form comes FIRST, before anything about ticking.
  # This ordering is the anti-false-tick lever: the healthy path must be the
  # visible one, or the gate teaches people to tick what they have not verified.
  echo ""
  echo "  To close with a criterion unmet — the healthy path — change its box to"
  echo "  [~], give the reason, and name where the work went:"
  echo ""
  echo "      - [~] **DEFERRED: <why it is unmet>** -> TD-XXX"
  echo ""
  echo "  A tick means you VERIFIED it. Cite the evidence (a test name, a"
  echo "  file:line, a measured figure, a commit) in the hunt log. A tick you"
  echo "  cannot evidence is the record-invention TD-311 forbids."
fi

exit 1
