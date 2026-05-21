#!/usr/bin/env bats

# harness_drift_gate.test.bash - Tests for the FR-135 harness drift gate.
#
# FR-135 wires the TD-021 drift guard (core/scripts/cli-adapters/
# check_harness_drift.sh) into the quality gates. These tests exercise the
# guard's three load-bearing verdicts against a self-contained temp project,
# built with the real adapters (compile_harnesses.sh) so the fixtures are
# byte-identical to what the production path produces:
#
#   1. DRIFTED      — a mutated harness body -> guard exits 1, report DRIFTED.
#   2. MATCH        — freshly compiled, in-sync harness -> guard exits 0.
#   3. MISSING      — generated harness never compiled -> guard exits 1, with
#                     a "MISSING" verdict (NOT a false "DRIFTED"); the wrapper
#                     surfaces a compile hint.
#
# We drive the CLAUDE target type (a .md whose body sha is compared) because
# it is self-contained — codex targets require the D1-gated emitter. The
# guard's MATCH/DRIFTED/MISSING logic is target-type-agnostic, so the claude
# path fully exercises the verdict machinery FR-135 depends on.
#
# The wrapper (scripts/validate_harness_drift.sh) adds a STOPGAP tolerance ON
# TOP of the strict guard: DRIFTED is always fatal (exit 1), but MISSING-only
# is a non-blocking NOTICE (exit 0) while the codex targets are D1-gated and
# uncompiled. FR-138 reverts that. The wrapper-level tests below build a
# synthetic git repo whose manifest uses a CORE_AGENTS name (`forger`) so the
# wrapper's hardcoded per-agent loop actually checks it.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  WRAPPER="$IGRIS_ROOT/scripts/validate_harness_drift.sh"

  [ -x "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  [ -x "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  require_python3

  # Per-test scratch project root.
  PROJ="$TEST_TEMP_DIR/harness_drift_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  # A canonical agent prompt (frontmatter + body). The guard compares the
  # BODY sha, so the body is what matters.
  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

This is the canonical body. It must match the harness body exactly.

- rule one
- rule two
EOF

  # A pre-existing harness file with its own frontmatter (sync, not create).
  cat > "$PROJ/.claude/agents/sample.md" <<'EOF'
---
name: sample
description: harness frontmatter (authored by hand, preserved on sync)
tools: Read, Edit
---

placeholder body — will be overwritten by compile
EOF

  # A project-local manifest declaring one claude-target agent. Canonical is
  # unversioned (a literal file), so no glob resolution is involved.
  MANIFEST="$PROJ/harness-manifest.json"
  cat > "$MANIFEST" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

@test "in-sync compiled harness yields exit 0 and MATCH" {
  # Compile first so the harness body == canonical body.
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" == *"1 targets — 1 in sync, 0 drifted/missing"* ]]
}

@test "drifted harness body yields exit 1 and DRIFTED" {
  # Compile to a clean MATCH state, then mutate the harness body.
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]

  # Append a stray line to the harness body -> body sha diverges from canon.
  printf '\n- injected drift line\n' >> "$PROJ/.claude/agents/sample.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] DRIFTED"* ]]
  [[ "$output" == *"body sha mismatch"* ]]
  [[ "$output" == *"1 targets — 0 in sync, 1 drifted/missing"* ]]
}

@test "never-compiled harness yields exit 1 and MISSING, not a false DRIFTED" {
  # Remove the harness file entirely (simulates a gitignored harness on a
  # fresh clone that was never compiled). OD-4: this must be MISSING, not
  # DRIFTED, so the operator is told to COMPILE rather than chase a phantom
  # body diff.
  rm -f "$PROJ/.claude/agents/sample.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  [[ "$output" == *"harness file absent"* ]]
  # Crucially NOT reported as DRIFTED.
  [[ "$output" != *"DRIFTED"* ]]
  [[ "$output" == *"1 targets — 0 in sync, 1 drifted/missing"* ]]
}

@test "wrapper exits 0 cleanly when the adapter layer is absent (fail-open)" {
  # A repo-root with no core/scripts/cli-adapters at all: the wrapper must
  # skip rather than hard-crash the commit hook on a partial checkout.
  local bare="$TEST_TEMP_DIR/bare_repo_$BATS_TEST_NUMBER"
  mkdir -p "$bare"
  ( cd "$bare" && git init -q )

  run bash -c "cd '$bare' && bash '$WRAPPER'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping drift check"* ]]
}

# ---------------------------------------------------------------------------
# Wrapper-level STOPGAP tests (FR-135). The wrapper resolves its repo root via
# `git rev-parse --show-toplevel` and looks for the guard + manifest under
# core/scripts/cli-adapters/, checking the hardcoded CORE_AGENTS list. To
# exercise its DRIFTED/MISSING/MATCH discrimination in isolation we build a
# synthetic git repo: copy the real cli-adapters in (so the guard + _common.sh
# resolve), drop in a manifest that declares ONE core-agent name (`forger`)
# with a self-contained CLAUDE target, and copy the wrapper alongside so it
# resolves the synthetic root rather than the live repo.
# ---------------------------------------------------------------------------

# build_wrapper_repo <state>  where state is: match | drifted | missing
# Echoes the synthetic repo root.
build_wrapper_repo() {
  local state="$1"
  local root="$TEST_TEMP_DIR/wrap_${state}_$BATS_TEST_NUMBER"
  mkdir -p "$root/core/scripts/cli-adapters" "$root/scripts" \
           "$root/canon" "$root/.claude/agents"
  ( cd "$root" && git init -q )

  # Real adapters (guard + compiler + helpers) so the guard runs for real.
  cp "$ADAPTERS"/*.sh "$root/core/scripts/cli-adapters/"
  # body-exceptions/ is referenced relative to the adapter dir; copy if present.
  [ -d "$ADAPTERS/body-exceptions" ] \
    && cp -R "$ADAPTERS/body-exceptions" "$root/core/scripts/cli-adapters/"

  # The wrapper under test, copied so it resolves THIS root.
  cp "$WRAPPER" "$root/scripts/validate_harness_drift.sh"

  # Canonical prompt for `forger` (a CORE_AGENTS name the wrapper checks).
  cat > "$root/canon/forger.md" <<'EOF'
---
name: forger
description: synthetic canonical for the wrapper test
---

# FORGER (synthetic)

Canonical body the harness must match.
EOF

  # Manifest at the path the wrapper expects (FR-136: repo root), declaring
  # forger -> claude.
  cat > "$root/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "forger",
      "canonical": { "dir": "canon", "file": "forger.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/forger.md" }
      ]
    }
  ]
}
EOF

  if [ "$state" = "missing" ]; then
    # No harness file at all -> guard reports MISSING.
    :
  else
    # Pre-existing harness with its own frontmatter, then compile to MATCH.
    cat > "$root/.claude/agents/forger.md" <<'EOF'
---
name: forger
description: harness frontmatter preserved on sync
tools: Read, Edit
---

placeholder
EOF
    bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" \
      --project-root "$root" \
      --manifest "$root/harness-manifest.json" \
      --target claude >/dev/null
    if [ "$state" = "drifted" ]; then
      printf '\n- injected drift\n' >> "$root/.claude/agents/forger.md"
    fi
  fi

  echo "$root"
}

@test "wrapper: DRIFTED harness is FATAL -> exit 1" {
  local root
  root="$(build_wrapper_repo drifted)"

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[forger/claude] DRIFTED"* ]]
  [[ "$output" == *"FATAL"* ]]
  # A drifted (existing-but-diverged) harness must NOT be excused as MISSING.
  [[ "$output" != *"NOTICE:"* ]]
}

@test "wrapper: MISSING-only (gated, never compiled) -> exit 0 + NOTICE" {
  local root
  root="$(build_wrapper_repo missing)"

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[forger/claude] MISSING"* ]]
  # STOPGAP NOTICE present and references the revert brief.
  [[ "$output" == *"NOTICE:"* ]]
  [[ "$output" == *"STOPGAP"* ]]
  [[ "$output" == *"FR-138"* ]]
  # MISSING is not drift — must not be reported FATAL.
  [[ "$output" != *"FATAL"* ]]
}

@test "wrapper: all-MATCH compiled harness -> exit 0, no NOTICE, no FATAL" {
  local root
  root="$(build_wrapper_repo match)"

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[forger/claude] MATCH"* ]]
  [[ "$output" != *"NOTICE:"* ]]
  [[ "$output" != *"FATAL"* ]]
}
