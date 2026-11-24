#!/bin/bash
# Description: Checks an Igris AI agent definition against the mechanical
#              subset of the agent-prompt standard (TD-497; the 2026-10-01
#              reassessment, REPORT §3.5 rule 12a). What it checks:
#                (a) frontmatter keys are only name, description, tools,
#                    model and effort (low, medium or high — the FR-277 tier
#                    map's stamp); a `memory:` key fails with its own message
#                    (no hidden prompts);
#                (b) name equals the file stem; description and tools are
#                    non-empty;
#                (c) the body (everything after the closing `---`) is at most
#                    6,144 bytes; over 4,096 bytes is a warning;
#                (d) a verdict line: a line starting `First line`, followed
#                    within 3 lines by a line starting with a backtick and an
#                    uppercase letter (the machine-parseable verdict token);
#                (e) at most 3 whole-word, case-sensitive emphasis words
#                    (MUST, NEVER, ALWAYS, CRITICAL, IMPORTANT); 1-3 warn;
#                (f) no slogan: the last non-blank line is not a bold line
#                    with no lowercase letter;
#                (g) no project literals: verify_mirror, gitleaks, igris-ai,
#                    knowledge.db, MAINTAINING.md, or a repo path under core/,
#                    cli/, brain-mcp-server/, scripts/, docs/ or test/ (a
#                    `~/.igris/core/...` pointer is not one);
#                (h) kept from the v7 validator: no igris_tree.json, no legacy
#                    ai/ paths, no igris_os.md load, no identity-breaking text.
#              It judges none of the prose; a reviewer does.
#
#              Not wired into pre-commit (TD-497 decision D6). The seven core
#              agents that have not been rewritten yet fail it until TD-502
#              and the forger/architect rewrites land; warden and sentinel
#              pass. test/validate_agent.test.bash is its bats twin.
# Usage: validate_agent.sh <agent_file.md>
# Exit codes:
#   0 - Validation passed (warnings allowed)
#   1 - Validation failed (details on stderr), or usage error

AGENT_FILE="${1:-}"

if [ -z "$AGENT_FILE" ] || [ ! -f "$AGENT_FILE" ]; then
  echo "Usage: validate_agent.sh <agent_file.md>" >&2
  exit 1
fi

ERRORS=0
WARNINGS=0
AGENT_NAME=$(basename "$AGENT_FILE" .md)
BODY_CAP=6144
BODY_TARGET=4096
EMPHASIS_MAX=3

echo "Validating agent: $AGENT_NAME ($AGENT_FILE)"
echo "---"

fail() {
  echo "  FAIL: $1" >&2
  ERRORS=$((ERRORS + 1))
}

warn() {
  echo "  WARN: $1" >&2
  WARNINGS=$((WARNINGS + 1))
}

pass() {
  echo "  PASS: $1"
}

# Line number of the closing frontmatter `---`, or empty.
CLOSE_LINE=""
if head -n 1 "$AGENT_FILE" | grep -qx -- '---'; then
  CLOSE_LINE="$(awk 'NR == 1 { next } /^---$/ { print NR; exit }' "$AGENT_FILE")"
fi

if [ -z "$CLOSE_LINE" ]; then
  fail "Missing YAML frontmatter (a '---' block at the top of the file)"
  FRONTMATTER=""
  BODY_FILE_START=1
else
  pass "Frontmatter present"
  FRONTMATTER="$(sed -n "2,$((CLOSE_LINE - 1))p" "$AGENT_FILE")"
  BODY_FILE_START=$((CLOSE_LINE + 1))
fi
BODY="$(tail -n +"$BODY_FILE_START" "$AGENT_FILE")"

# (a) + (b) frontmatter keys and values. A top-level key is `key:` at column 0;
# indented or `- ` lines continue the key above them (a YAML list counts as a
# non-empty value).
KEYS="$(printf '%s\n' "$FRONTMATTER" | awk '
  /^[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*:/ {
    key = $0; sub(/[[:space:]]*:.*/, "", key)
    val = $0; sub(/^[^:]*:[[:space:]]*/, "", val)
    print key "\t" val
    next
  }
  /^[[:space:]]+[^[:space:]]/ || /^-[[:space:]]/ { print "+\tcontinued"; next }
')"
key_value() {
  printf '%s\n' "$KEYS" | awk -F'\t' -v k="$1" '
    $1 == k { v = $2; found = 1; next }
    found == 1 && $1 == "+" { if (v == "") v = $2; next }
    found == 1 { exit }
    END { print v }
  '
}
bad_key=0
while IFS="$(printf '\t')" read -r k _; do
  [ -n "$k" ] || continue
  [ "$k" = "+" ] && continue
  case "$k" in
    name|description|tools|model) ;;
    effort)
      # FR-277: compile stamps the tier map's effort (low, medium, high).
      ev="$(key_value effort)"
      case "$ev" in
        low|medium|high) ;;
        *) fail "frontmatter effort '$ev' is not one of low, medium, high (FR-277 tier map)"; bad_key=1 ;;
      esac ;;
    memory)
      fail "frontmatter key 'memory' — no hidden prompts: lessons reach an agent through its delegation (rule 8)"
      bad_key=1 ;;
    *)
      fail "frontmatter key '$k' is outside the portable set {name, description, tools, model, effort} (rule 7)"
      bad_key=1 ;;
  esac
done <<EOF
$KEYS
EOF
[ -z "$CLOSE_LINE" ] || [ "$bad_key" -eq 1 ] || pass "Frontmatter keys are portable"

if [ -n "$CLOSE_LINE" ]; then
  FM_NAME="$(key_value name)"
  if [ "$FM_NAME" = "$AGENT_NAME" ]; then
    pass "name matches the file stem"
  else
    fail "name '$FM_NAME' does not match the file stem '$AGENT_NAME'"
  fi
  for field in description tools; do
    if [ -n "$(key_value "$field" | tr -d '[:space:]')" ]; then
      pass "$field present"
    else
      fail "empty $field"
    fi
  done
fi

# (c) body size, exact bytes after the closing `---` line.
BODY_BYTES="$(tail -n +"$BODY_FILE_START" "$AGENT_FILE" | wc -c | tr -d ' ')"
if [ "$BODY_BYTES" -gt "$BODY_CAP" ]; then
  fail "body is $BODY_BYTES bytes, over the $BODY_CAP B cap (rule 9)"
elif [ "$BODY_BYTES" -gt "$BODY_TARGET" ]; then
  warn "body is $BODY_BYTES bytes, over the $BODY_TARGET B target (rule 9)"
else
  pass "body is $BODY_BYTES bytes"
fi

# (d) verdict line.
if printf '%s\n' "$BODY" | awk '
     /^First line/ { want = NR + 3; next }
     want && NR <= want && /^`[A-Z]/ { found = 1; exit }
     END { exit found ? 0 : 1 }
   '; then
  pass "verdict line present"
else
  fail "no verdict line: a line starting 'First line' followed within 3 lines by a line starting with a backticked uppercase token (rule 4)"
fi

# (e) emphasis density.
EMPHASIS="$(printf '%s\n' "$BODY" | grep -owE 'MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT' | wc -l | tr -d ' ')"
if [ "$EMPHASIS" -gt "$EMPHASIS_MAX" ]; then
  fail "$EMPHASIS emphasis words (MUST/NEVER/ALWAYS/CRITICAL/IMPORTANT), more than $EMPHASIS_MAX (rule 2)"
elif [ "$EMPHASIS" -gt 0 ]; then
  warn "$EMPHASIS emphasis words (MUST/NEVER/ALWAYS/CRITICAL/IMPORTANT); each needs its reason (rule 2)"
else
  pass "no emphasis words"
fi

# (f) slogan.
LAST_LINE="$(awk 'NF { last = $0 } END { print last }' "$AGENT_FILE")"
if printf '%s\n' "$LAST_LINE" | grep -qE '^\*\*[^a-z]*\*\*$'; then
  fail "slogan as the last line (rule 2): $LAST_LINE"
else
  pass "no slogan"
fi

# (g) project literals, anywhere in the file.
LITERALS="$(grep -nE 'verify_mirror|gitleaks|igris-ai|knowledge\.db|MAINTAINING\.md|(^|[^A-Za-z0-9_./~-])(core|cli|brain-mcp-server|scripts|docs|test)/[A-Za-z0-9_.-]' "$AGENT_FILE")"
if [ -n "$LITERALS" ]; then
  while IFS= read -r hit; do
    fail "project literal (rule 5; project checks arrive through the delegation): $hit"
  done <<EOF
$LITERALS
EOF
else
  pass "no project literals"
fi

# (h) kept checks.
if grep -q "igris_tree.json" "$AGENT_FILE"; then
  fail "references the retired igris_tree.json (FR-187/FR-213)"
else
  pass "no igris_tree.json reference"
fi
if grep -q "ai/prompts\|ai/context\|ai/briefs\|ai/session\|ai/masks" "$AGENT_FILE"; then
  fail "contains legacy ai/ path references"
else
  pass "no legacy ai/ path references"
fi
if grep -q "Read.*igris_os\.md\|Load.*igris_os\.md" "$AGENT_FILE"; then
  fail "loads igris_os.md (orchestrator-only)"
else
  pass "does not load igris_os.md"
fi
if grep -q "You are Claude\|As an AI" "$AGENT_FILE"; then
  fail "contains identity-breaking language"
else
  pass "no identity-breaking language"
fi

echo "---"
echo "Results: $ERRORS error(s), $WARNINGS warning(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo "VALIDATION FAILED" >&2
  exit 1
else
  echo "VALIDATION PASSED"
  exit 0
fi
