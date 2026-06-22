#!/usr/bin/env bats

# Canonical phase enum parity guard (TD-238).
#
# CANONICAL_PHASES is dual-sourced — there is no build step generating one copy
# from the other:
#   - bash: scripts/validate_brief_state_reconciliation.sh (TD-257, READ side)
#       CANONICAL_PHASES=(INIT PLANNING ... BLOCKED)
#   - TS:   brain-mcp-server/src/tools/brief-normalize.ts (TD-238, WRITE side)
#       export const CANONICAL_PHASES = [ 'INIT', 'PLANNING', ... ] as const;
#
# A silent fork between the two would let the write boundary and the read
# validator disagree on the valid phase vocabulary. This guard extracts both
# definitions and asserts they are element-identical IN ORDER (the C1 invariant
# pivots on COMPLETE's position relative to the terminal). It hard-fails CI if
# they diverge — neither copy is hand-editable without the other going red
# (the memory #448 validator+pin pattern, riding the existing bats suite — no
# new pre-commit wire needed).

load test_helper

BASH_VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_state_reconciliation.sh"
TS_HELPER="$IGRIS_ROOT/brain-mcp-server/src/tools/brief-normalize.ts"

setup() {
  require_python3
  [ -f "$BASH_VALIDATOR" ] || skip "bash validator missing at $BASH_VALIDATOR"
  [ -f "$TS_HELPER" ] || skip "TS helper missing at $TS_HELPER"
}

# Extract the bash CANONICAL_PHASES array as newline-separated tokens, in order.
extract_bash_phases() {
  python3 - "$BASH_VALIDATOR" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
# Match: CANONICAL_PHASES=(INIT PLANNING ... BLOCKED)
m = re.search(r'^\s*CANONICAL_PHASES=\(([^)]*)\)', src, re.MULTILINE)
if not m:
    sys.stderr.write("bash CANONICAL_PHASES=(...) not found\n")
    sys.exit(3)
print("\n".join(m.group(1).split()))
PY
}

# Extract the TS CANONICAL_PHASES literal as newline-separated tokens, in order.
extract_ts_phases() {
  python3 - "$TS_HELPER" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
# Match: export const CANONICAL_PHASES = [ ... ] as const;
m = re.search(
    r'export\s+const\s+CANONICAL_PHASES\s*=\s*\[(.*?)\]\s*as\s+const',
    src, re.DOTALL,
)
if not m:
    sys.stderr.write("TS CANONICAL_PHASES literal not found\n")
    sys.exit(3)
# Pull every single- or double-quoted string token, in source order.
tokens = re.findall(r"""['"]([^'"]+)['"]""", m.group(1))
if not tokens:
    sys.stderr.write("TS CANONICAL_PHASES had no quoted tokens\n")
    sys.exit(3)
print("\n".join(tokens))
PY
}

@test "both sources define a non-empty CANONICAL_PHASES list" {
  run extract_bash_phases
  assert_success
  [ -n "$output" ]

  run extract_ts_phases
  assert_success
  [ -n "$output" ]
}

@test "bash and TS CANONICAL_PHASES are element-identical and in the same order" {
  local bash_phases ts_phases
  bash_phases="$(extract_bash_phases)"
  ts_phases="$(extract_ts_phases)"

  if [ "$bash_phases" != "$ts_phases" ]; then
    echo "CANONICAL_PHASES drift between bash and TS:" >&2
    echo "--- bash ($BASH_VALIDATOR) ---" >&2
    echo "$bash_phases" >&2
    echo "--- TS ($TS_HELPER) ---" >&2
    echo "$ts_phases" >&2
    return 1
  fi
}

@test "CANONICAL_PHASES contains the terminal phase COMPLETE" {
  run extract_ts_phases
  assert_success
  echo "$output" | grep -qx "COMPLETE"
}
