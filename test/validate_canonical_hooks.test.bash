#!/usr/bin/env bats

# validate_canonical_hooks.test.bash - Tests for
#   scripts/validate_canonical_hooks.sh (TD-110).
#
# Covers all four documented exit-code paths:
#   0 — green path (real repo state, installer-emitted hooks block matches
#       canonical-settings.json after jq -S canonicalization).
#   1 — drift detected (synthetic mutation of the canonical file's hooks).
#   2 — canonical file missing (CANONICAL_FILE=/nonexistent).
#   2 — installer script missing (INSTALLER_SCRIPT=/nonexistent).
#   2 — installer script present but exits non-zero.
#
# These cases use CANONICAL_FILE / INSTALLER_SCRIPT env-var overrides
# (built into the validator for test injection) so they never mutate the
# live repo files. Placement at test/ matches the existing repo convention
# (validate_memory_agency_enums.test.bash etc.); plan AC originally
# specified bats/ but the repo's existing test runner globs from test/.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_canonical_hooks.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  require_jq

  SCRATCH="$TEST_TEMP_DIR/validate_canonical_hooks_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

@test "canonical_hooks_green_path: unmodified repo state passes with OK" {
  # No env overrides — exercises the canonical pair shipped in this repo.
  # The validator builds its own sandbox; we don't need to stage anything.
  run bash "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
  [[ "$output" == *"matches canonical-settings.json"* ]]
}

@test "canonical_hooks_synthetic_drift: mutated canonical yields exit 1 with diff" {
  # Copy the real canonical, mutate one command's timeout, point the
  # validator at the mutated copy. Real installer runs against real
  # canonical-shape commands but the canonical now disagrees -> drift.
  cp "$IGRIS_ROOT/core/hooks/canonical-settings.json" "$SCRATCH/canonical.json"
  # Add a timeout to SessionStart that the installer doesn't emit.
  jq '.hooks.SessionStart[0].hooks[0].timeout = 99' \
    "$SCRATCH/canonical.json" > "$SCRATCH/canonical_mutated.json"

  CANONICAL_FILE="$SCRATCH/canonical_mutated.json" \
    run bash "$VALIDATOR"

  [ "$status" -eq 1 ]
  # Diagnostic must mention the divergence and the §13 fix path.
  [[ "$output" == *"diverges from canonical-settings.json"* ]]
  [[ "$output" == *"unified diff"* ]]
  [[ "$output" == *"lockstep"* ]]
}

@test "canonical_hooks_missing_canonical: CANONICAL_FILE=/nonexistent yields exit 2" {
  CANONICAL_FILE="$SCRATCH/does-not-exist.json" \
    run bash "$VALIDATOR"

  [ "$status" -eq 2 ]
  [[ "$output" == *"canonical file not found"* ]]
}

@test "canonical_hooks_missing_installer: INSTALLER_SCRIPT=/nonexistent yields exit 2" {
  INSTALLER_SCRIPT="$SCRATCH/does-not-exist.sh" \
    run bash "$VALIDATOR"

  [ "$status" -eq 2 ]
  [[ "$output" == *"installer script not found"* ]]
}

@test "canonical_hooks_installer_crashes: broken installer script yields exit 2" {
  cat > "$SCRATCH/broken_installer.sh" <<'EOF'
#!/bin/bash
echo "synthetic installer failure" >&2
exit 1
EOF
  chmod +x "$SCRATCH/broken_installer.sh"

  INSTALLER_SCRIPT="$SCRATCH/broken_installer.sh" \
    run bash "$VALIDATOR"

  [ "$status" -eq 2 ]
  [[ "$output" == *"installer script failed"* ]]
}
