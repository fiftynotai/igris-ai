#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# agent_memory_export_prompts.test.bash — TD-496 Part 1 prose wiring.
#
# Prompt/protocol regression checks (the test/context_doc_workflow_prompt.test.bash
# pattern): /harvest Mode B runs core/scripts/agent_memory_export.sh, /hunt puts
# a byte-capped role digest into the architect, forger, sentinel and warden
# delegations, and the orchestrator (not the read-only architect) writes the
# plan file. Every needle is a LITERAL (grep -F): test_helper's
# assert_output_contains is a regex.

load test_helper

HARVEST="$IGRIS_ROOT/core/skills/harvest/SKILL.md"
HUNT="$IGRIS_ROOT/core/skills/hunt/SKILL.md"
TEMPLATE="$IGRIS_ROOT/core/skills/hunt/workflow-template.md"
MEMORY_OS="$IGRIS_ROOT/core/os/memory.md"
ROLES="architect forger sentinel warden"

# section <file> <heading-prefix> — the lines from the first `## <prefix>`
# heading up to (not including) the next `## ` heading.
section() {
  awk -v h="$2" '
    index($0, "## " h) == 1 { on = 1; print; next }
    on && /^## / { exit }
    on { print }
  ' "$1"
}

# delegation_block <role> — the fenced block of /hunt that delegates to <role>.
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

has_not() {
  if grep -Fq -- "$2" <<<"$1"; then
    echo "expected NOT to find the literal: $2" >&2
    return 1
  fi
}

@test "harvest Mode B names the export script, the tokens, the curation bar, the replies and the no-delete rule" {
  local b
  b="$(section "$HARVEST" "Mode B")"
  [ -n "$b" ] || { echo "no '## Mode B' section in $HARVEST"; return 1; }
  has "$b" "agent_memory_export.sh"
  has "$b" '`role:<agent>`'
  has "$b" '`agent-memory`'
  has "$b" '`amx:<id>`'
  # the curation bar
  has "$b" "KEEP a rule, pitfall, pattern or durable code fact"
  has "$b" "DROP brief status or progress"
  # the reply grammar
  for reply in '`ok`' '`ok except 3,7`' '`keep 3`' '`drop 5 <reason>`' '`tag 4`' '`new 4`' \
               '`cat 4=mistake`' '`global 4`' '`project 6=<slug>`' '`title 2=<text>`' '`show 8`' '`stop`'; do
    has "$b" "$reply"
  done
  # bulk stores only through decide --commit; the skill never writes the brain itself
  has "$b" "decide --accept --commit"
  has "$b" "never composes store arguments"
  has "$b" "without \`--dry-run\`"
  # the no-delete rule and the unavailable-brain stop
  has "$b" "never writes, moves or deletes a source file"
  has "$b" "stop before \`next\`"
  has "$b" "igris lessons audit --ledger"
  has "$b" "igris sync push"
}

@test "harvest names no .claude/ path and no brain tool in Mode B" {
  run grep -n '\.claude/' "$HARVEST"
  [ "$status" -eq 1 ] || { echo "harness path in harvest: $output"; return 1; }
  local b
  b="$(section "$HARVEST" "Mode B")"
  [ -n "$b" ]
  # Mode B reaches the brain only through the CLI verbs (TD-324 ledger untouched).
  run grep -n 'igris_[a-z_]*' <<<"$b"
  [ "$status" -eq 1 ] || { echo "brain tool named in Mode B: $output"; return 1; }
}

@test "harvest constraint 4 is scoped to Mode A, and Mode B has a trigger phrase" {
  run grep -n '^4\. \*\*Curate, don'"'"'t dump\*\*' "$HARVEST"
  [ "$status" -eq 0 ]
  [[ "$output" == *"(Mode A)"* ]] || { echo "constraint 4 not scoped: $output"; return 1; }
  local fm
  fm="$(awk 'NR == 1 && /^---$/ { on = 1; next } on && /^---$/ { exit } on' "$HARVEST")"
  has "$fm" '"harvest agent memory"'
  has "$(section "$HARVEST" "Modes")" "Mode A"
}

@test "hunt carries the Role-lesson digest recipe: the command, the unavailable line and the 4,096 B cap" {
  local r
  r="$(section "$HUNT" "Role-Lesson Digest")"
  [ -n "$r" ] || { echo "no '## Role-Lesson Digest' section in $HUNT"; return 1; }
  has "$r" 'igris lessons digest --role <role> --project {project} --context "{safe title}" 2>/dev/null'
  has "$r" '|| echo "Role lessons (<role>): unavailable — igris lessons digest failed or is not installed; proceeding without them."'
  has "$r" "4,096 B"
  has "$r" "never blocks"
  has "$r" "verbatim"
}

@test "hunt never puts raw brain text in a --context argument: every one is {safe title}, built by the stated rule" {
  local r
  r="$(section "$HUNT" "Role-Lesson Digest")"
  [ -n "$r" ]
  # The rule, stated once in the recipe.
  has "$r" '`{safe title}` is the brief title with every character outside `[A-Za-z0-9 .,_-]` replaced by a space'
  # Every --context value in the skill is the sanitised placeholder: the
  # recipe plus the four call sites, and no raw {brief title} or {title}.
  run grep -oE -- '--context "[^"]*"' "$HUNT"
  [ "${#lines[@]}" -eq 5 ] || { echo "--context sites: $output"; return 1; }
  local l
  for l in "${lines[@]}"; do
    [ "$l" = '--context "{safe title}"' ] || { echo "unsanitised --context: $l"; return 1; }
  done
  run grep -nE -- '--context[^|]*\{(brief title|title|brief_title|BRIEF_TITLE)\}' "$HUNT"
  [ "$status" -eq 1 ] || { echo "raw title in --context: $output"; return 1; }
  # The stated class is shell-inert inside double quotes: a hostile title,
  # sanitised by exactly that class, comes back from bash unexpanded.
  local cls
  cls="$(grep -oE 'outside `\[[^]]*\]`' <<<"$r" | sed -E 's/^outside `\[//; s/\]`$//')"
  [ "$cls" = 'A-Za-z0-9 .,_-' ] || { echo "class: $cls"; return 1; }
  local hostile safe got
  hostile='Fix "quote" $(touch '"$TEST_TEMP_DIR"'/pwned) `id` ${HOME} \ and ! in titles'
  safe="$(printf '%s' "$hostile" | LC_ALL=C tr -c "$cls" ' ')"
  got="$(bash -c "printf '%s' \"$safe\"")"
  [ "$got" = "$safe" ] || { echo "expanded: $got"; return 1; }
  [ ! -e "$TEST_TEMP_DIR/pwned" ]
  [[ "$safe" == *"Fix  quote    touch "* ]] || { echo "safe: $safe"; return 1; }
}

@test "hunt runs the digest for architect, forger, sentinel and warden at column-0 sub-steps" {
  local role
  for role in $ROLES; do
    run grep -n -F "igris lessons digest --role $role --project {project}" "$HUNT"
    [ "$status" -eq 0 ] || { echo "no digest call for $role"; return 1; }
    [ "${#lines[@]}" -eq 1 ] || { echo "expected one digest call for $role: $output"; return 1; }
  done
  # each call site is a numbered sub-step at column 0, so it closes every
  # `igris_agent_event` window above it (validate_hunt_agent_event_sites.sh)
  run grep -cE '^[0-9]+\.[0-9]+\. \*\*Role-lesson digest \(TD-496\)' "$HUNT"
  [ "$output" -eq 4 ] || { echo "column-0 digest sub-steps: $output"; return 1; }
  run bash "$IGRIS_ROOT/scripts/validate_hunt_agent_event_sites.sh" "$HUNT"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "each of the four delegation blocks carries exactly one Role lessons: line" {
  local role blk n
  for role in $ROLES; do
    blk="$(delegation_block "$role")"
    [ -n "$blk" ] || { echo "no delegation block for $role"; return 1; }
    n="$(grep -c 'Role lessons:' <<<"$blk")"
    [ "$n" -eq 1 ] || { echo "$role block has $n 'Role lessons:' lines"; return 1; }
  done
}

@test "the architect returns the plan and the orchestrator writes it" {
  local blk
  blk="$(delegation_block architect)"
  has_not "$blk" "Write plan to"
  has "$blk" "Return the complete plan as your final message; do not write files."
  run grep -c 'Write plan to' "$HUNT"
  [ "$output" -eq 0 ]
  run grep -F 'write the returned plan verbatim to `~/.igris/projects/{project}/plans/{BRIEF_ID}-plan.md`' "$HUNT"
  [ "$status" -eq 0 ]
  run grep -F 'Save to ~/.igris/projects/{project}/plans/{BRIEF_ID}-plan.md (the orchestrator writes it; the architect is read-only)' "$TEMPLATE"
  [ "$status" -eq 0 ]
}

@test "the pre-forger recall note no longer claims recall lacks a category filter" {
  run grep -F 'does NOT currently accept a `category=mistake` filter' "$HUNT"
  [ "$status" -eq 1 ]
  run grep -F 'accepts an optional `category` filter' "$HUNT"
  [ "$status" -eq 0 ]
}

@test "memory.md names the role token and igris lessons digest under How to Tag" {
  local s
  s="$(awk '/^### How to Tag a Stored Memory/ { on = 1; print; next } on && /^### / { exit } on { print }' "$MEMORY_OS")"
  [ -n "$s" ]
  has "$s" '`role:<agent>`'
  has "$s" "igris lessons digest"
}
