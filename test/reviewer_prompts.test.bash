#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# reviewer_prompts.test.bash — TD-497. Prompt, frontmatter and /hunt wiring
# guards for the rewritten reviewers (core/agents/warden.md, sentinel.md) and
# the review-worktree steps in core/skills/hunt/SKILL.md.
#
#   P1  (AC7) every verdict token a reviewer can print has a named branch in
#       its /hunt phase, the phase names a no-verdict branch, and every
#       DONE-class token is in the agent-event roll-up's DONE list
#       (brain-mcp-server/src/tools/agent_events.ts, handleAgentEventList)
#   P2  both delegation blocks carry the review worktree, the env prefix and
#       the project-checks line
#   P3  both phases open a review worktree, and close it before the first
#       verdict branch
#   P4  (AC1/AC2/AC4) tools Read, Grep, Glob, Bash; model: and effort: equal
#       the harness-manifest.json model tier map's claude column (FR-277)
#   P5  the prompts' load-bearing text, and no TS- brief or mirror instruction
#   P6  (FR-277) all twelve core-role event sites (architect, forger,
#       sentinel, mender, warden) request the per-run model, else the model the
#       loaded definition names, else `inherit:`; the two document sites keep
#       the old form (control)
#   P7  the APPROVE-WITH-EDITS branch exists, reviewers no longer write paths
#       into the close set, and warden's item 7 (TD-325) keeps its number
#   PM  mutation: deleting the APPROVE-WITH-EDITS branch turns P1 red
#   P8  both phases read the verdict word with every `*` and backtick removed
#       and trailing punctuation dropped (the prompts print the verdict line
#       in backticks)
#   P9  (FR-277, AC5) Phases 2, 3 and 5 run `<model_tier> resolve`, name its
#       refusal branch, and Phase 5 passes `--differ-from`; PM9 mutation:
#       deleting Phase 3's step turns P9 red
#
# Every needle is a LITERAL (grep -F) unless stated.

load test_helper

HUNT="$IGRIS_ROOT/core/skills/hunt/SKILL.md"
WARDEN="$IGRIS_ROOT/core/agents/warden.md"
SENTINEL="$IGRIS_ROOT/core/agents/sentinel.md"
AE_TS="$IGRIS_ROOT/brain-mcp-server/src/tools/agent_events.ts"

setup() {
  export HOME="$TEST_TEMP_DIR/home"
  mkdir -p "$HOME"
}

# phase <file> <"4: TESTING"> — the lines of one /hunt phase.
phase() {
  awk -v h="### Phase $2" '
    index($0, h) == 1 { on = 1; print; next }
    on && /^### Phase / { exit }
    on { print }
  ' "$1"
}

# delegation_block <role> — the fenced block of /hunt that delegates to <role>
# (the same reader test/agent_memory_export_prompts.test.bash uses).
delegation_block() {
  awk -v want="subagent_type: \"$1\"" '
    /^```/ { if (inb) { if (hit) { printf "%s", buf; exit } inb = 0; buf = ""; hit = 0; next } inb = 1; buf = ""; next }
    inb { buf = buf $0 "\n"; if (index($0, want)) hit = 1 }
  ' "$HUNT"
}

has() {
  if ! grep -Fq -- "$2" <<<"$1"; then
    echo "expected to find the literal: $2" >&2
    return 1
  fi
}

# tokens <agent file> — the backticked `VERDICT: X` lines, one token per line.
tokens() { grep -oE '^`VERDICT: [A-Z][A-Z-]*`$' "$1" | sed -e 's/^`VERDICT: //' -e 's/`$//'; }

# p1_check <hunt> <warden> <sentinel> <agent_events.ts>
p1_check() {
  local hunt="$1" in_list role f want sec toks n tok
  in_list="$(grep -oE "result IN \([^)]*\)" "$4")"
  [ -n "$in_list" ] || { echo "no 'result IN (...)' list in $4"; return 1; }
  for role in warden sentinel; do
    if [ "$role" = warden ]; then f="$2"; want=3; sec="$(phase "$hunt" "5: REVIEWING")"
    else f="$3"; want=2; sec="$(phase "$hunt" "4: TESTING")"; fi
    [ -n "$sec" ] || { echo "no phase section for $role"; return 1; }
    toks="$(tokens "$f")"
    n="$(printf '%s\n' "$toks" | grep -c .)"
    [ "$n" -eq "$want" ] || { echo "$role has $n backticked verdict tokens, expected $want"; return 1; }
    for tok in $toks; do
      grep -qF -- "**If $tok:**" <<<"$sec" || grep -qF -- "**If $tok and" <<<"$sec" \
        || { echo "$role prints $tok but its phase names no branch for it"; return 1; }
      case "$tok" in
        REJECT|FAIL) ;;
        *) grep -qF -- "'$tok'" <<<"$in_list" \
             || { echo "DONE-class token $tok is not in $in_list"; return 1; } ;;
      esac
    done
    grep -qF -- "no listed verdict" <<<"$sec" || { echo "$role's phase names no no-verdict branch"; return 1; }
  done
}

# event_models — one `agent<TAB>model_requested line` per igris_agent_event
# site (window rule of scripts/validate_hunt_agent_event_sites.sh).
event_models() {
  awk '
    function ind(s) { match(s, /^[ \t]*/); return RLENGTH }
    insite && ($0 ~ /^[ \t]*$/ || ind($0) <= sind) { print agent "\t" model; insite = 0 }
    insite {
      if (match($0, /agent: "[a-z_-]+"/)) agent = substr($0, RSTART + 8, RLENGTH - 9)
      if ($0 ~ /model_requested:/) model = $0
      next
    }
    index($0, "`igris_agent_event` with:") { insite = 1; sind = ind($0); agent = ""; model = "" }
    END { if (insite) print agent "\t" model }
  ' "$HUNT"
}

@test "(P1, AC7) every reviewer verdict token has a branch, a no-verdict branch exists, DONE tokens roll up" {
  run p1_check "$HUNT" "$WARDEN" "$SENTINEL" "$AE_TS"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(PM) mutation: delete the APPROVE-WITH-EDITS branch in a copy and P1 goes red" {
  local m="$TEST_TEMP_DIR/hunt-mut.md"
  grep -vF '**If APPROVE-WITH-EDITS:**' "$HUNT" > "$m"
  [ "$(grep -cF '**If APPROVE-WITH-EDITS:**' "$HUNT")" -ge 1 ] || return 1
  [ "$(grep -cF '**If APPROVE-WITH-EDITS:**' "$m")" -eq 0 ] || return 1
  run p1_check "$m" "$WARDEN" "$SENTINEL" "$AE_TS"
  [ "$status" -ne 0 ] || return 1
  [[ "$output" == *"APPROVE-WITH-EDITS but its phase names no branch"* ]] || { echo "$output"; return 1; }
}

@test "(P2) both delegation blocks carry the review worktree, the env prefix and the project-checks line" {
  local s w
  s="$(delegation_block sentinel)"
  w="$(delegation_block warden)"
  [ -n "$s" ] && [ -n "$w" ] || { echo "a delegation block is missing"; return 1; }
  has "$s" "Review worktree:"
  has "$s" "{REVIEW_ENV}"
  has "$s" "{REVIEW_DIFF}"
  has "$s" "Project checks:"
  has "$s" "First line of your report is the verdict."
  has "$w" "Review worktree:"
  has "$w" "{REVIEW_ENV}"
  has "$w" "{REVIEW_DIFF}"
  has "$w" "Project review items:"
  has "$w" "First line of your report is the verdict."
}

@test "(P3) TESTING and REVIEWING each open a review worktree and close it before the first verdict branch" {
  local p sec o c b
  for p in "4: TESTING" "5: REVIEWING"; do
    sec="$(phase "$HUNT" "$p")"
    o="$(grep -nF '<review_worktree> open --id' <<<"$sec" | head -1 | cut -d: -f1)"
    c="$(grep -nF '<review_worktree> close' <<<"$sec" | head -1 | cut -d: -f1)"
    b="$(grep -nE '\*\*If (PASS|FAIL|APPROVE|REJECT)' <<<"$sec" | head -1 | cut -d: -f1)"
    [ -n "$o" ] && [ -n "$c" ] && [ -n "$b" ] || { echo "$p: open=$o close=$c branch=$b"; return 1; }
    [ "$o" -lt "$c" ] && [ "$c" -lt "$b" ] || { echo "$p: open=$o close=$c branch=$b"; return 1; }
  done
}

# map_claude <role> — "model: X" and "effort: Y" from the tier map's claude
# column for <role>, as the compile stamp writes them.
map_claude() {
  python3 - "$IGRIS_ROOT/harness-manifest.json" "$1" <<'PY'
import json, sys
mt = json.load(open(sys.argv[1], encoding="utf-8"))["model_tiers"]
role = mt["roles"][sys.argv[2]]
t = mt["tiers"][role["tier"]]["claude"]
print("model: %s" % t["model"])
print("effort: %s" % (role.get("effort") or t["effort"]))
PY
}

@test "(P4, AC1/AC2/AC4) both reviewers: tools Read, Grep, Glob, Bash; model: and effort: equal the tier map" {
  local f fm role want
  for role in warden sentinel; do
    f="$IGRIS_ROOT/core/agents/$role.md"
    fm="$(awk 'NR == 1 && /^---$/ { on = 1; next } on && /^---$/ { exit } on' "$f")"
    grep -qx 'tools: Read, Grep, Glob, Bash' <<<"$fm" || { echo "$f tools: $fm"; return 1; }
    want="$(map_claude "$role")" || { echo "no tier map for $role"; return 1; }
    [ "$(grep -E '^(model|effort):' <<<"$fm")" = "$want" ] || { echo "$f: $fm"; echo "want: $want"; return 1; }
  done
}

@test "(P5) the prompts carry their load-bearing text and no TS- brief or mirror instruction" {
  local w s
  w="$(cat "$WARDEN")"
  s="$(cat "$SENTINEL")"
  has "$w" '`mechanism`'
  has "$w" '`behavior-claim`'
  has "$w" '`record`'
  has "$w" '**R1:**'
  has "$w" '**R4:**'
  has "$w" '**Red-first proof.**'
  has "$w" '**Security**'
  has "$w" 'Name the exploit path'
  has "$w" 'Statements elsewhere in the tree that this change makes false are defects of this change'
  has "$w" 'standards, not advisory prose.'
  has "$w" 'Do not stash, check out, reset, add or commit'
  has "$w" 'diff the members across all of them'
  has "$w" 'open a `~/.igris` file with Read at its absolute path'
  has "$s" '`mechanism`'
  has "$s" '`claim`'
  has "$s" 'unless you show the same failure at HEAD in the worktree'
  has "$s" 'reverse-applying the diff file'
  has "$s" 'Do not stash, reset, check out, add or commit'
  run grep -nE 'TS-|verify_mirror' "$WARDEN" "$SENTINEL"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
}

@test "(P6, FR-277) all twelve core-role event sites carry one wording; the document sites keep the old form (control)" {
  local rows rv n
  local want='{the per-run model you requested for this agent, else the model named by the agent definition your harness loaded for it, else "inherit:<your own model id>"}'
  rows="$(event_models)"
  [ -n "$rows" ] || return 1
  rv="$(awk -F'\t' '$1 == "architect" || $1 == "forger" || $1 == "sentinel" || $1 == "mender" || $1 == "warden"' <<<"$rows")"
  n="$(grep -c . <<<"$rv")"
  [ "$n" -eq 12 ] || { echo "core-role sites: $n"; echo "$rv"; return 1; }
  [ "$(grep -cF -- "model_requested: $want" <<<"$rv")" -eq 12 ] || { echo "$rv"; return 1; }
  rv="$(awk -F'\t' '$1 == "document"' <<<"$rows")"
  [ "$(grep -c . <<<"$rv")" -eq 2 ] || { echo "document sites: $rv"; return 1; }
  [ "$(grep -cF -- 'model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}' <<<"$rv")" -eq 2 ] \
    || { echo "$rv"; return 1; }
}

@test "(P7) the APPROVE-WITH-EDITS branch exists, reviewers add no close paths, warden's item 7 keeps its number" {
  local sec w
  sec="$(phase "$HUNT" "5: REVIEWING")"
  has "$sec" '**If APPROVE-WITH-EDITS:**'
  run grep -cF 'every path sentinel or warden reported writing' "$HUNT"
  [ "$output" -eq 0 ] || return 1
  has "$(phase "$HUNT" "7: COMMITTING")" 'every path you edited applying APPROVE-WITH-EDITS'
  w="$(delegation_block warden)"
  has "$w" '7. ACCEPTANCE CRITERIA (TD-325)'
}

# verdict_rule <phase> — the "Read the verdict" bullet of one /hunt phase.
verdict_rule() {
  phase "$HUNT" "$1" | awk '
    index($0, "**Read the verdict:**") { on = 1; print; next }
    on && /^[ \t]*- \*\*/ { exit }
    on { print }
  '
}

@test "(P8) both phases read the verdict word with every * and backtick removed and trailing punctuation dropped" {
  local p r
  for p in "4: TESTING" "5: REVIEWING"; do
    r="$(verdict_rule "$p" | tr -s ' \n' ' ')"
    [ -n "$r" ] || { echo "$p: no Read the verdict bullet"; return 1; }
    has "$r" 'every `*` and backtick removed' || { echo "$p: $r"; return 1; }
    has "$r" 'trailing punctuation' || { echo "$p: $r"; return 1; }
  done
}

# p9_check <hunt> — P9's assertions over a hunt file.
p9_check() {
  local p sec
  for p in "2: PLANNING" "3: BUILDING" "5: REVIEWING"; do
    sec="$(phase "$1" "$p")"
    [ -n "$sec" ] || { echo "no phase $p"; return 1; }
    grep -qE '^2\.5\. ' <<<"$sec" || { echo "$p: no step 2.5 at column 0"; return 1; }
    grep -qF 'bash <model_tier> resolve --agent ' <<<"$sec" || { echo "$p: no <model_tier> resolve"; return 1; }
    grep -qF 'On exit 1' <<<"$sec" || { echo "$p: no refusal branch"; return 1; }
  done
  sec="$(phase "$1" "5: REVIEWING")"
  grep -qF -- '--differ-from' <<<"$sec" || { echo "5: no --differ-from"; return 1; }
  grep -qF 'a change is reviewed by a model other than its author' <<<"$sec" || { echo "5: lost the row-25 sentence"; return 1; }
  grep -qF '`<model_tier>` is `core/scripts/cli-adapters/model_tier.sh`' "$1" || { echo "no <model_tier> definition"; return 1; }
}

@test "(P9, FR-277 AC5) Phases 2, 3 and 5 resolve the model tier and name the refusal branch; Phase 5 passes --differ-from" {
  run p9_check "$HUNT"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(PM9) mutation: delete Phase 3's model-tier step in a copy and P9 goes red" {
  local m="$TEST_TEMP_DIR/hunt-mut9.md"
  awk '
    /^### Phase 3: BUILDING/ { in3 = 1 }
    /^### Phase 4:/ { in3 = 0 }
    in3 && /^2\.5\. / { skip = 1; next }
    skip && /^[0-9]+(\.[0-9]+)?\. / { skip = 0 }
    skip { next }
    { print }
  ' "$HUNT" > "$m"
  [ "$(phase "$HUNT" "3: BUILDING" | grep -cF 'bash <model_tier> resolve')" -ge 1 ] || return 1
  [ "$(phase "$m" "3: BUILDING" | grep -cF 'bash <model_tier> resolve')" -eq 0 ] || return 1
  run p9_check "$m"
  [ "$status" -ne 0 ] || return 1
  [[ "$output" == *"3: BUILDING"* ]] || { echo "$output"; return 1; }
}
