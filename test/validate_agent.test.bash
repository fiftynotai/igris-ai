#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# validate_agent.test.bash — TD-497. scripts/validate_agent.sh checks an agent
# definition against the mechanical subset of the agent-prompt standard (the
# 2026-10-01 reassessment, REPORT §3.5 rule 12a): portable frontmatter keys
# only, no `memory:`, name = file stem, a body of at most 6,144 B (WARN over
# 4,096 B), a machine-parseable verdict line, emphasis density, no slogan, and
# no project literals.
#
#   V1/V2  the rewritten warden and sentinel pass
#   V3a-i  planted fixtures FAIL with a named message
#   V4     a 4,200 B body WARNs and passes
#   V5     an old-shape prompt fails (synthetic; plus the real 7301f39 warden
#          when that commit is reachable — CI checks out one commit)
#   V6     control: a `~/.igris/core/os/...` pointer is not a project literal
#   V7     AC8: no mirror or igris-ai repo literal in warden or sentinel
#   VM     mutation: a validator copy without the memory branch loses the
#          memory-specific message, so V3a can fail
#
# Every fixture lives under TEST_TEMP_DIR; HOME is fenced there too.

load test_helper

VA="$IGRIS_ROOT/scripts/validate_agent.sh"

setup() {
  [ -f "$VA" ] || { echo "validator not found at $VA"; return 1; }
  export HOME="$TEST_TEMP_DIR/home"
  mkdir -p "$HOME"
  FX="$TEST_TEMP_DIR/fx"
  mkdir -p "$FX"
}

# fixture <extra-frontmatter-line-or-empty> <body> — writes $FX/probe.md.
fixture() {
  {
    printf -- '---\nname: probe\ndescription: A probe agent for the validator tests.\ntools: Read, Grep\nmodel: sonnet\n'
    [ -n "$1" ] && printf '%s\n' "$1"
    printf -- '---\n'
    printf '%s' "$2"
  } > "$FX/probe.md"
}

GOOD_BODY='
# Probe

You probe a change you did not write.

## Report
First line, exactly one of:
`VERDICT: PASS`
`VERDICT: FAIL`

Then the findings.
'

# pad_to <file> <n> — append filler to <file> until its body is exactly n bytes
# (64-byte lines, then single bytes). Appends to the file directly: a $(...)
# capture would strip a trailing newline and miss the target by one.
pad_to() {
  local f="$1" n line
  n=$(( $2 - $(body_bytes "$1") ))
  line="$(printf '%63s' '' | tr ' ' 'y')"
  while [ "$n" -ge 64 ]; do printf '%s\n' "$line" >> "$f"; n=$((n - 64)); done
  while [ "$n" -gt 0 ]; do printf 'x' >> "$f"; n=$((n - 1)); done
}

# body_bytes <file> — the bytes after the closing frontmatter `---` line, exact.
body_bytes() {
  local close
  close="$(awk 'NR == 1 && /^---$/ { next } /^---$/ { print NR; exit }' "$1")"
  tail -n +"$((close + 1))" "$1" | wc -c | tr -d ' '
}

@test "(V1) the rewritten warden passes" {
  run bash "$VA" "$IGRIS_ROOT/core/agents/warden.md"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "(V2) the rewritten sentinel passes" {
  run bash "$VA" "$IGRIS_ROOT/core/agents/sentinel.md"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "(V0) control: the good fixture passes, so every V3 failure is the planted defect" {
  fixture "" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "(V3a) a memory: key FAILS with its own message" {
  fixture "memory: project" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: frontmatter key 'memory'"*"hidden prompt"* ]] || { echo "$output"; return 1; }
}

@test "(V3b) an effort: key with a tier-map value PASSES (FR-277: compile stamps it)" {
  fixture "effort: medium" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"FAIL: frontmatter key 'effort'"* ]] || { echo "$output"; return 1; }
}

@test "(V3b2) an effort: value outside low/medium/high FAILS; color: still FAILS (control)" {
  fixture "effort: extreme" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: frontmatter effort 'extreme' is not one of low, medium, high"* ]] || { echo "$output"; return 1; }
  fixture "color: red" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: frontmatter key 'color' is outside the portable set"* ]] || { echo "$output"; return 1; }
}

@test "(V3c) a color: key FAILS as outside the portable set" {
  fixture "color: red" "$GOOD_BODY"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: frontmatter key 'color' is outside the portable set"* ]] || { echo "$output"; return 1; }
}

@test "(V3d) a 6,145 B body FAILS the cap" {
  fixture "" "$GOOD_BODY"
  pad_to "$FX/probe.md" 6145
  [ "$(body_bytes "$FX/probe.md")" -eq 6145 ] || { echo "fixture body: $(body_bytes "$FX/probe.md")"; return 1; }
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: body is 6145 bytes, over the 6144 B cap"* ]] || { echo "$output"; return 1; }
}

@test "(V3d-edge) a body of exactly 6,144 B is under the cap (WARN only)" {
  fixture "" "$GOOD_BODY"
  pad_to "$FX/probe.md" 6144
  [ "$(body_bytes "$FX/probe.md")" -eq 6144 ] || return 1
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(V3e) a verify_mirror mention FAILS as a project literal" {
  fixture "" "$GOOD_BODY
Run verify_mirror before you report."
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: project literal"*"verify_mirror"* ]] || { echo "$output"; return 1; }
}

@test "(V3f) a repo path (cli/src/x) FAILS as a project literal" {
  fixture "" "$GOOD_BODY
See cli/src/x for the seam."
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: project literal"*"cli/src/x"* ]] || { echo "$output"; return 1; }
}

@test "(V3g) no First-line verdict contract FAILS" {
  fixture "" '
# Probe

You probe.

## Report
Write whatever you like.
'
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: no verdict line"* ]] || { echo "$output"; return 1; }
}

@test "(V3h) four emphasis words FAIL; three only WARN" {
  fixture "" "$GOOD_BODY
You MUST do this. NEVER do that. ALWAYS check. IMPORTANT: stop."
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: 4 emphasis words"* ]] || { echo "$output"; return 1; }
  fixture "" "$GOOD_BODY
You MUST do this. NEVER do that. ALWAYS check."
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"WARN: 3 emphasis words"* ]] || { echo "$output"; return 1; }
  # whole words, case-sensitive: these are not emphasis
  fixture "" "$GOOD_BODY
must never always MUSTER NEVERTHELESS critical important"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"PASS: no emphasis words"* ]] || { echo "$output"; return 1; }
}

@test "(V3i) a slogan as the last line FAILS" {
  fixture "" "$GOOD_BODY
---

**TEST EVERYTHING. TRUST NOTHING.**
"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: slogan"* ]] || { echo "$output"; return 1; }
}

@test "(V3j) name must match the file stem; description and tools must be non-empty" {
  fixture "" "$GOOD_BODY"
  cp "$FX/probe.md" "$FX/other.md"
  run bash "$VA" "$FX/other.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: name 'probe' does not match the file stem 'other'"* ]] || { echo "$output"; return 1; }
  sed 's/^tools: .*/tools:/' "$FX/probe.md" > "$FX/t" && mv "$FX/t" "$FX/probe.md"
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL: empty tools"* ]] || { echo "$output"; return 1; }
}

@test "(V4) a 4,200 B body WARNs over the 4,096 B target and still passes" {
  fixture "" "$GOOD_BODY"
  pad_to "$FX/probe.md" 4200
  [ "$(body_bytes "$FX/probe.md")" -eq 4200 ] || return 1
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"WARN: body is 4200 bytes, over the 4096 B target"* ]] || { echo "$output"; return 1; }
}

@test "(V5) an old-shape prompt FAILS the new validator for each of its old-shape reasons" {
  # The 7301f39 warden's shape, reduced: step-script sections, a decorated
  # verdict, a CAPS constraint list, a repo path and a slogan.
  cat > "$FX/warden.md" <<'MD'
---
name: warden
description: Code review, quality guardian, and auditor.
tools: Read, Grep, Glob
model: inherit
---

# WARDEN

## CORE IDENTITY
- **Mode:** Read-only

## OUTPUT FORMAT
**VERDICT:** APPROVE | REJECT

## CONSTRAINTS
1. **NEVER modify code** - Review only
2. **NEVER approve with security issues** - Always REJECT
3. **ALWAYS explain why**
4. **ALWAYS suggest fixes**

See `docs/operations/secret-scanning.md`.

---

**GUARD THE CODE. PROTECT THE QUALITY.**
MD
  run bash "$VA" "$FX/warden.md"
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FAIL: no verdict line"* ]] || return 1
  [[ "$output" == *"FAIL: 4 emphasis words"* ]] || return 1
  [[ "$output" == *"FAIL: slogan"* ]] || return 1
  [[ "$output" == *"FAIL: project literal"* ]] || return 1
  # The real pre-TD-497 warden, where that commit is reachable.
  if git -C "${IGRIS_ROOT:?}" cat-file -e '7301f39:core/agents/warden.md' 2>/dev/null; then
    git -C "${IGRIS_ROOT:?}" show '7301f39:core/agents/warden.md' > "$FX/warden.md"
    run bash "$VA" "$FX/warden.md"
    [ "$status" -eq 1 ] || { echo "the 7301f39 warden passed: $output"; return 1; }
  else
    echo "# 7301f39 not reachable (shallow checkout): synthetic arm only" >&3
  fi
}

@test "(V6) control: an ~/.igris/core/os/ pointer and a plain word 'test' are not project literals" {
  fixture "" "$GOOD_BODY
The rules are \`~/.igris/core/os/standards.md\` → Claims and Evidence. Write a test, run the tests/ you need."
  run bash "$VA" "$FX/probe.md"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"FAIL: project literal"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"PASS: no project literals"* ]] || { echo "$output"; return 1; }
}

@test "(V7, AC8) warden and sentinel carry no mirror check and no igris-ai repo literal" {
  run grep -nE 'verify_mirror|igris-ai|(^|[^A-Za-z0-9_./~-])(core|cli|brain-mcp-server|scripts|docs|test)/' \
    "$IGRIS_ROOT/core/agents/warden.md" "$IGRIS_ROOT/core/agents/sentinel.md"
  [ "$status" -eq 1 ] || { echo "hits: $output"; return 1; }
  [ -z "$output" ]
}

@test "(VM) mutation: a validator without the memory branch loses the memory message, so V3a can fail" {
  local m="$TEST_TEMP_DIR/va-mut.sh"
  sed '/hidden prompt/d' "$VA" > "$m"
  [ "$(grep -c 'hidden prompt' "$VA")" -ge 1 ] || return 1
  [ "$(grep -c 'hidden prompt' "$m")" -eq 0 ] || return 1
  fixture "memory: project" "$GOOD_BODY"
  run bash "$m" "$FX/probe.md"
  [[ "$output" != *"hidden prompt"* ]] || { echo "$output"; return 1; }
}
