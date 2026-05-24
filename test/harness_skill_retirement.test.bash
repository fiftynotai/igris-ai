#!/usr/bin/env bats

# harness_skill_retirement.test.bash - FR-153 retirement test for the legacy
# skill-projection scripts (md_to_agents_md.sh + md_to_gemini_toml.sh).
#
# FR-153 unifies all three skill harnesses (claude/codex/gemini) onto the
# FR-149 claude/symlink primitive. The legacy AGENTS.md aggregator + per-skill
# TOML converter are deleted from the repo + runtime mirror, and the schema's
# pair allowlist is tightened to {claude/symlink, codex/symlink,
# gemini/symlink}. This test pins that retirement:
#
#   1. Both script files are absent from the repo's core/scripts/cli-adapters/.
#   2. The runtime mirror at ~/.igris/core/scripts/cli-adapters/ is also absent.
#   3. No remaining `md_to_agents_md` or `md_to_gemini_toml` references exist
#      under core/, cli/src/, scripts/, docs/, or test/ (with .git/,
#      node_modules/, agent-memory/, the from-source test fixture, and this
#      test file itself excluded).
#
# See L-519 (the symlink IS the projection — no body-refresh / aggregator chain
# remains for the skills surface).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  RUNTIME_BRAIN="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
  RUNTIME_ADAPTERS="$RUNTIME_BRAIN/core/scripts/cli-adapters"
}

@test "FR-153: md_to_agents_md.sh is DELETED from the repo" {
  [ ! -f "$ADAPTERS/md_to_agents_md.sh" ]
}

@test "FR-153: md_to_gemini_toml.sh is DELETED from the repo" {
  [ ! -f "$ADAPTERS/md_to_gemini_toml.sh" ]
}

@test "FR-153: md_to_agents_md.sh is DELETED from the runtime mirror" {
  if [ ! -d "$RUNTIME_BRAIN/core" ]; then
    skip "runtime brain not installed at $RUNTIME_BRAIN"
  fi
  [ ! -f "$RUNTIME_ADAPTERS/md_to_agents_md.sh" ]
}

@test "FR-153: md_to_gemini_toml.sh is DELETED from the runtime mirror" {
  if [ ! -d "$RUNTIME_BRAIN/core" ]; then
    skip "runtime brain not installed at $RUNTIME_BRAIN"
  fi
  [ ! -f "$RUNTIME_ADAPTERS/md_to_gemini_toml.sh" ]
}

@test "FR-153: no remaining md_to_agents_md|md_to_gemini_toml caller references in core/cli/scripts/test" {
  # FR-153: a hidden CALLER would leave the compile path broken when a
  # downstream consumer's old config still has the legacy pair. This is the
  # load-bearing retirement guard the brief requires: zero CALLER matches
  # across load-bearing source paths.
  #
  # Excluded:
  #   - .git/, node_modules/ (obvious),
  #   - agent-memory/ (historical citations, not callers),
  #   - cli/src/__tests__/from-source.test.ts (uses md_to_agents_md as a
  #     filename LITERAL for a copier path-preservation test — not a caller),
  #   - *.md (retirement-narrative documentation legitimately names the
  #     deleted scripts so future readers can grep for "what happened to X"
  #     — verified below in a separate narrative-paired assertion),
  #   - this test file itself (the strings ARE the test).
  run grep -rn 'md_to_agents_md\|md_to_gemini_toml' \
       "$IGRIS_ROOT/core" \
       "$IGRIS_ROOT/cli/src" \
       "$IGRIS_ROOT/scripts" \
       "$IGRIS_ROOT/test" \
       --include='*.sh' --include='*.ts' --include='*.js' --include='*.bash' \
       --include='*.json' --include='*.py' \
       --exclude-dir=node_modules \
       --exclude-dir=.git \
       --exclude-dir=agent-memory \
       --exclude=from-source.test.ts \
       --exclude=harness_skill_retirement.test.bash
  # `grep` returns 1 (no matches) on success. Treat 0 (hits) and 2 (error) as
  # failures so the test fails loudly when a stray reference appears.
  [ "$status" -eq 1 ]
}

@test "FR-153: docs mention the retired scripts only in retirement-narrative paragraphs" {
  # docs/ + cli-adapters/README.md legitimately name the retired scripts so
  # future readers can grep for "what happened to md_to_agents_md.sh". This
  # test asserts every doc mention is paired with retirement-narrative
  # wording (RETIRED, DELETED, deleted, retires, retired) within a ±2-line
  # neighborhood — preventing a stray mid-prose reference that doesn't
  # carry the retirement context.
  run python3 - <<PY
import re, sys
paths = [
    "$IGRIS_ROOT/docs/multi-cli.md",
    "$IGRIS_ROOT/core/scripts/cli-adapters/README.md",
    "$IGRIS_ROOT/CONTRIBUTING.md",
]
pattern = re.compile(r'md_to_agents_md|md_to_gemini_toml')
narrative = re.compile(r'RETIR|retir|DELETED|deleted', re.IGNORECASE)
bad = []
for p in paths:
    try:
        with open(p, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        for i, line in enumerate(lines):
            if pattern.search(line):
                # Check current line + 2 lines before and after.
                lo, hi = max(0, i - 2), min(len(lines), i + 3)
                neighborhood = "".join(lines[lo:hi])
                if not narrative.search(neighborhood):
                    bad.append(f"{p}:{i+1}: {line.rstrip()}")
    except FileNotFoundError:
        pass
if bad:
    print("\n".join(bad))
    sys.exit(1)
sys.exit(0)
PY
  [ "$status" -eq 0 ]
}
