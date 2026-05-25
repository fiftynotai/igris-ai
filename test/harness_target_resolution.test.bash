#!/usr/bin/env bats

# harness_target_resolution.test.bash — FR-154 path-shape parity for agent
# target.path resolution.
#
# FR-154 mirrors the FR-137-era skills 3-case resolver onto the AGENT target
# resolver in BOTH compile_harnesses.sh:596 and check_harness_drift.sh:432.
# Before FR-154 an agent target.path was always taken as project-relative
# ($PROJECT_ROOT/$target_path); after, the 3 cases are:
#
#     "~"/*  → $HOME/<rest>          (tilde-rooted, $HOME-anchored)
#     /*     → $target_path          (verbatim absolute)
#     *      → $PROJECT_ROOT/...     (legacy project-relative — unchanged)
#
# These tests pin parity across the two adapters. Compile and drift MUST
# resolve every shape identically, otherwise a manifest written for compile
# would be flagged DRIFTED/MISSING by drift (or vice versa) on the same row.
#
# HOME-sandbox pattern is MANDATORY for every tilde case: HOME is overridden
# to a sandbox dir for the duration of the test, AND a defensive guard
# (`[[ "$HOME" == "$SANDBOX_HOME" ]] || skip`) catches a stale-export leak
# before the test can write outside the sandbox. The IGRIS_BRAIN_DIR isolation
# pattern (per harness_skills.test.bash) keeps a real ~/.igris from polluting
# personal-overlay discovery during the run.
#
# L-515 / containment guarding is OUT OF SCOPE for FR-154 (parity with skills).
# A `~/...` or `/abs/...` target that escapes the project root is permitted by
# the resolver — the next consumer (FR-155 / future) may add a containment
# guard if needed.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -x "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -x "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  # Isolate from the live brain dir so the guard/compile do NOT auto-discover
  # the user's personal overlay manifest at
  # ~/.igris/registry/harness-manifest.personal.json (FR-146 leaves this in
  # place between runs). Matches the harness_skills.test.bash precedent.
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  # Per-test scratch project root.
  PROJ="$TEST_TEMP_DIR/harness_target_resolution_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon"

  # HOME sandbox: every tilde-rooted test re-points HOME to here so a `~/...`
  # target.path can be resolved without writing to the user's real $HOME. The
  # defensive guard `[[ "$HOME" == "$SANDBOX_HOME" ]] || skip` is included in
  # every tilde test so a stale export from a sibling test cannot leak.
  SANDBOX_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$SANDBOX_HOME"

  # A canonical agent prompt (frontmatter + body). Compile-time α-assembly
  # extracts frontmatter inline (TD-195 fallback — no FR-151 sidecar present)
  # and produces a registry-resident harness.md the symlink will point at.
  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

Canonical body for FR-154 path-resolver parity.
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
  [ -d "$SANDBOX_HOME" ] && rm -rf "$SANDBOX_HOME"
}

# write_manifest_for <target-path>
# Echoes nothing; emits a manifest at $PROJ/harness-manifest.json declaring
# a single claude-target agent with the given target.path verbatim.
write_manifest_for() {
  local tpath="$1"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": "$tpath" }
      ]
    }
  ]
}
EOF
}

# ---------------------------------------------------------------------------
# Compile-side: 9 cases exercising the 3-arm resolver.
# ---------------------------------------------------------------------------

@test "FR-154 compile: project-relative target resolves under PROJECT_ROOT" {
  write_manifest_for ".claude/agents/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/agents/sample.md" ]
}

@test "FR-154 compile: nested project-relative target resolves under PROJECT_ROOT" {
  write_manifest_for "nested/dir/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/nested/dir/sample.md" ]
  # The symlink target must reside in the registry under $IGRIS_BRAIN_DIR.
  local resolved
  resolved="$(readlink "$PROJ/nested/dir/sample.md")"
  [[ "$resolved" == "$IGRIS_BRAIN_DIR/registry/agents/sample/harness.md" ]]
}

@test "FR-154 compile: absolute target outside PROJECT_ROOT resolves verbatim" {
  local abs_target="$TEST_TEMP_DIR/abs_outside_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$abs_target"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$abs_target" ]
  # Defensive: the symlink MUST NOT also appear under PROJECT_ROOT (no false
  # double-write — the absolute case is taken verbatim, NOT joined).
  [ ! -e "$PROJ/$abs_target" ]
}

@test "FR-154 compile: tilde-rooted target expands against \$HOME" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/igris-claude/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$SANDBOX_HOME/igris-claude/sample.md" ]
  # Defensive: the symlink MUST NOT appear under PROJECT_ROOT with the literal
  # `~/...` segment (no false project-relative join when the arm matches).
  [ ! -e "$PROJ/~/igris-claude/sample.md" ]
}

@test "FR-154 compile: tilde-rooted nested target expands against \$HOME" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/nested/deeper/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$SANDBOX_HOME/nested/deeper/sample.md" ]
}

@test "FR-154 compile: a path with embedded ~ (not leading) stays project-relative" {
  # `dir/~/sample.md` does NOT match the "~"/* arm (which requires leading
  # tilde-slash). It must fall through to the project-relative case. This pins
  # the case-arm specificity: a literal tilde inside a path is not magic.
  write_manifest_for "dir/~/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/dir/~/sample.md" ]
}

@test "FR-154 compile: project-relative summary line uses the manifest-declared path" {
  # Confirms the SUMMARY OK row echoes the unresolved manifest path (not the
  # resolved abs path). Existing surface — pinned here so a future resolver
  # refactor cannot silently change operator-visible output.
  write_manifest_for ".claude/agents/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK    sample/claude -> .claude/agents/sample.md"* ]]
}

@test "FR-154 compile: absolute target summary line echoes the absolute path" {
  local abs_target="$TEST_TEMP_DIR/abs_summary_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$abs_target"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK    sample/claude -> $abs_target"* ]]
}

@test "FR-154 compile: tilde target summary line echoes the unexpanded ~/... path" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/igris-claude/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK    sample/claude -> ~/igris-claude/sample.md"* ]]
}

# ---------------------------------------------------------------------------
# Drift-side parity: 9 cases mirroring the compile cases. For every shape the
# compile resolver accepts, drift MUST resolve the SAME absolute path so the
# verdict is MATCH (otherwise a manifest-written-for-compile row would be
# flagged DRIFTED/MISSING by drift — the bug FR-154 closes).
# ---------------------------------------------------------------------------

@test "FR-154 drift: project-relative compile -> drift MATCH" {
  write_manifest_for ".claude/agents/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: nested project-relative compile -> drift MATCH" {
  write_manifest_for "nested/dir/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: absolute target compile -> drift MATCH" {
  local abs_target="$TEST_TEMP_DIR/abs_drift_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$abs_target"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: tilde-rooted target compile -> drift MATCH (same HOME sandbox)" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/igris-claude-drift/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: tilde-rooted nested compile -> drift MATCH" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/deeper/nest/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: never-compiled absolute target reports MISSING (not phantom DRIFTED)" {
  # Drift MUST classify an uncompiled absolute target as MISSING with the same
  # symlink-absent verdict it produces for project-relative — proving the abs
  # arm reaches the same downstream path-existence check.
  local abs_target="$TEST_TEMP_DIR/abs_missing_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$abs_target"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}

@test "FR-154 drift: never-compiled tilde target reports MISSING" {
  HOME="$SANDBOX_HOME"
  [[ "$HOME" == "$SANDBOX_HOME" ]] || skip "HOME sandbox guard failed"
  write_manifest_for "~/never-compiled/sample.md"
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
}

@test "FR-154 drift: drift reports MISSING when target.path was CHANGED between compile and drift" {
  # NEGATIVE CONTROL (per L-29). Compile with one shape, change the manifest
  # to a DIFFERENT shape, drift. Without the resolver fix, drift would resolve
  # the changed path under PROJECT_ROOT and find no symlink → MISSING; with
  # the fix, the changed absolute path also yields MISSING but for the right
  # reason (the resolver path doesn't exist), NOT a phantom DRIFTED on a
  # mis-resolved sibling. This pins the resolver as non-no-op: it has to
  # produce verdicts that depend on the path SHAPE, not just the literal
  # string concatenation.
  #
  # Step 1: compile with project-relative shape. Symlink lands at PROJ/X.
  write_manifest_for ".claude/agents/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/agents/sample.md" ]
  # Step 2: change the manifest target.path to a NEW absolute path that
  # nothing has been compiled to.
  local new_abs="$TEST_TEMP_DIR/negctl_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$new_abs"
  # Step 3: drift now sees a MISSING verdict at the NEW path (resolved
  # absolutely), NOT a MATCH at the OLD symlink location.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  # And the report MUST reference the new absolute path, NOT the stale
  # project-relative join. Pins behavior: drift consults the manifest, not the
  # filesystem residue from the prior compile.
  [[ "$output" == *"$new_abs"* ]] || [[ "$output" == *"absent"* ]]
}

@test "FR-154 parity: compile + drift both treat an embedded-tilde path as project-relative" {
  # CASE-ARM PARITY pin. The compile-side already accepted `dir/~/sample.md`
  # as project-relative; drift must agree (no special-casing the embedded
  # tilde). Pre-FR-154 this was de facto true (drift had no tilde arm at
  # all); post-FR-154 the leading-`~`/* arm in BOTH adapters must NOT match
  # `dir/~/sample.md` — only a literal-tilde-slash prefix triggers the
  # $HOME-expanding arm.
  write_manifest_for "dir/~/sample.md"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/dir/~/sample.md" ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "FR-154 drift: an absolute target outside PROJECT_ROOT reports MATCH after compile" {
  # Sanity check that the abs-outside-PROJ_ROOT shape survives drift's
  # registry-containment check on the symlink TARGET (the symlink TARGET is
  # still the registry harness.md; only the symlink LOCATION is outside
  # PROJ). This guards against a future drift-side regression that confuses
  # "containment of the link path" with "containment of the link target".
  local abs_target="$TEST_TEMP_DIR/abs_outside_match_$BATS_TEST_NUMBER/sample.md"
  write_manifest_for "$abs_target"
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}
