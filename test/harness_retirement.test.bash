#!/usr/bin/env bats

# harness_retirement.test.bash - FR-152 / FR-159 retirement test for the legacy
# agent-side cli-adapter scripts (sync_claude_agents.sh + sync_codex_agents.sh).
#
# FR-152 retires the legacy `sync_claude_agents.sh` body-refresh adapter (the
# script that powered FR-149's Case C real-file claude back-compat path). Post-
# FR-152, claude + gemini agent targets are atomic symlinks that resolve to a
# single loadout-resident harness.md, assembled at compile/vendor time.
#
# FR-159 retires the legacy `sync_codex_agents.sh` codex TOML converter — the
# emit moves to TS `assembleCodexHarness` (vendor-side) + bash
# `assemble_codex_harness_into_loadout` (compile-side fallback). The
# `.codex/agents/<name>.toml` target is now a symlink to the loadout-resident
# `harness.codex.toml` (parity with claude — codex follows symlinks).
#
# No script-shaped consumer of the deleted files should remain anywhere in
# the repo. This test pins that retirement:
#
#   1. The script files are absent from the repo's core/scripts/cli-adapters/.
#   2. The runtime mirror at ~/.igris/core/scripts/cli-adapters/ is also absent.
#   3. No remaining `sync_claude_agents` or `sync_codex_agents` CALLER
#      references exist under core/, cli/src/, scripts/, or test/ (narrative
#      *.md mentions are validated separately below).
#
# See L-519 (the symlink IS the projection — no body-refresh / converter chain
# remains for the agent surface).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  RUNTIME_BRAIN="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
  RUNTIME_ADAPTERS="$RUNTIME_BRAIN/core/scripts/cli-adapters"
}

@test "FR-152: sync_claude_agents.sh is DELETED from the repo" {
  [ ! -f "$ADAPTERS/sync_claude_agents.sh" ]
}

@test "FR-152: sync_claude_agents.sh is DELETED from the runtime mirror" {
  # FR-152: the runtime mirror is the destination of the TD-096 copy step; the
  # plan's deletion verification is a `! -f` check (no `verify_mirror.sh` for
  # absence — that primitive checks file equality). Skipped only when the
  # runtime brain isn't installed on this machine (a fresh CI box).
  if [ ! -d "$RUNTIME_BRAIN/core" ]; then
    skip "runtime brain not installed at $RUNTIME_BRAIN"
  fi
  [ ! -f "$RUNTIME_ADAPTERS/sync_claude_agents.sh" ]
}

@test "FR-152: no remaining sync_claude_agents references in core/cli/scripts/docs/test" {
  # FR-152: a hidden caller would leave compile silently broken for the claude
  # agent target. This is the load-bearing retirement guard the brief requires:
  # zero matches across the load-bearing source paths. The grep excludes
  #   - .git/ and node_modules/ (obvious),
  #   - agent-memory/ (historical citations, not callers),
  #   - this test file itself (the strings ARE the test).
  run grep -rn 'sync_claude_agents' \
       "$IGRIS_ROOT/core" \
       "$IGRIS_ROOT/cli" \
       "$IGRIS_ROOT/scripts" \
       "$IGRIS_ROOT/docs" \
       "$IGRIS_ROOT/test" \
       --exclude-dir=node_modules \
       --exclude-dir=.git \
       --exclude-dir=agent-memory \
       --exclude=harness_retirement.test.bash
  # `grep` returns 1 (no matches) on success. Treat 0 (hits) and 2 (error) as
  # failures so the test fails loudly when a stray reference appears.
  [ "$status" -eq 1 ]
}

@test "FR-159: sync_codex_agents.sh is DELETED from the repo" {
  [ ! -f "$ADAPTERS/sync_codex_agents.sh" ]
}

@test "FR-159: sync_codex_agents.sh is DELETED from the runtime mirror" {
  if [ ! -d "$RUNTIME_BRAIN/core" ]; then
    skip "runtime brain not installed at $RUNTIME_BRAIN"
  fi
  [ ! -f "$RUNTIME_ADAPTERS/sync_codex_agents.sh" ]
}

@test "FR-159: no live CALLER references to sync_codex_agents in code (narrative comments OK)" {
  # FR-159: a hidden caller (e.g., a `bash ... sync_codex_agents.sh ...` line
  # in a script) would leave compile silently broken. This test asserts:
  #   - ZERO uncommented CALLER references in script-shape files (`.sh`,
  #     `.bash`, `.ts`, `.js`, `.py`, `.json`).
  #   - The only mentions in code are narrative COMMENTS naming the retired
  #     script for grep-archeology (`// FR-159 retires sync_codex_agents.sh`,
  #     etc.), which are validated by a ±2-line narrative-pair check.
  # Mirrors the FR-153 retirement-narrative-pair pattern. Excludes:
  #   - .git/, node_modules/ (obvious),
  #   - agent-memory/ (historical citations, not callers),
  #   - this test file itself (the strings ARE the test).
  run python3 - <<PY
import os, re, sys

ROOT = "$IGRIS_ROOT"
SCAN_DIRS = ["core", "cli/src", "scripts", "test"]
INCLUDE = (".sh", ".bash", ".ts", ".js", ".py", ".json")
SKIP_DIRS = {"node_modules", ".git", "agent-memory", "fixtures"}
SKIP_FILES = {"harness_retirement.test.bash"}
pattern = re.compile(r'sync_codex_agents')
narrative = re.compile(
    r'RETIR|retir|DELETED|deleted|legacy|never applied|did NOT|Matches|matches|'
    r'parity|byte-equivalent|byte-for-byte|former|FR-159|former bash|behavioral|'
    r'Replaces',
    re.IGNORECASE,
)

bad = []
for d in SCAN_DIRS:
    walk_root = os.path.join(ROOT, d)
    if not os.path.isdir(walk_root):
        continue
    for root, dirs, files in os.walk(walk_root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for fn in files:
            if not fn.endswith(INCLUDE):
                continue
            if fn in SKIP_FILES:
                continue
            p = os.path.join(root, fn)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    lines = fh.readlines()
            except OSError:
                continue
            for i, line in enumerate(lines):
                if pattern.search(line):
                    lo, hi = max(0, i - 2), min(len(lines), i + 3)
                    neighborhood = "".join(lines[lo:hi])
                    if not narrative.search(neighborhood):
                        bad.append(f"{p}:{i+1}: {line.rstrip()}")
if bad:
    print("Unexpected CALLER refs (not narrative-paired):", file=sys.stderr)
    for b in bad:
        print(b, file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
  [ "$status" -eq 0 ]
}

@test "FR-159: docs mention sync_codex_agents only in retirement-narrative paragraphs" {
  # docs/ + cli-adapters/README.md + CONTRIBUTING.md + CHANGELOG.md legitimately
  # name the retired script so future readers can grep for "what happened to
  # sync_codex_agents.sh". Every doc mention must be paired with retirement-
  # narrative wording (RETIRED, DELETED, deleted, retires, retired, legacy)
  # within a ±2-line neighborhood. Mirrors the FR-153 retirement-narrative
  # check in harness_skill_retirement.test.bash.
  run python3 - <<PY
import re, sys
paths = [
    "$IGRIS_ROOT/docs/multi-cli.md",
    "$IGRIS_ROOT/core/scripts/cli-adapters/README.md",
    "$IGRIS_ROOT/CONTRIBUTING.md",
    "$IGRIS_ROOT/CHANGELOG.md",
]
pattern = re.compile(r'sync_codex_agents')
narrative = re.compile(r'RETIR|retir|DELETED|deleted|legacy', re.IGNORECASE)
bad = []
for p in paths:
    try:
        with open(p, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        for i, line in enumerate(lines):
            if pattern.search(line):
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
