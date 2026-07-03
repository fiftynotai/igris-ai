#!/usr/bin/env bats

# onboard_harness_skill.test.bash - FR-172 presence + completeness guard for the
# /onboard-harness skill.
#
# The skill's whole value is COMPLETENESS — it is the executable checklist that
# CATCHES a dropped harness-onboarding touchpoint. This test pins that the
# checklist still names every one of the 9 authoritative anchors. A future
# schema/topology rename that silently orphans a checklist step (the #448/#463
# parity-validator failure mode) trips this guard.
#
# Three assertions:
#   1. The canonical SKILL.md exists in the repo.
#   2. Frontmatter has `name: onboard-harness` + a non-empty `allowed-tools`
#      block (and passes the strict-YAML validator — TD-219/#587).
#   3. The body mentions all 9 authoritative anchors (one per checklist step).
#
# See FR-172 plan §5, FR-171 plan (the proven contract walk).

load test_helper

setup() {
  SKILL="$IGRIS_ROOT/core/skills/onboard-harness/SKILL.md"
}

@test "FR-172: onboard-harness SKILL.md exists in the repo" {
  assert_file_exists "$SKILL"
}

@test "FR-172: frontmatter declares name: onboard-harness" {
  assert_file_contains "$SKILL" "name: onboard-harness"
}

@test "FR-172: frontmatter has a non-empty allowed-tools block" {
  # allowed-tools is a YAML list; assert the header + at least one list item.
  assert_file_contains "$SKILL" "allowed-tools:"
  run grep -cE '^\s+-\s+(Read|Grep|Glob|Bash|Edit|Write)\b' "$SKILL"
  assert_success
  [ "$output" -ge 1 ]
}

@test "FR-172: SKILL.md frontmatter passes strict YAML (TD-219/#587)" {
  require_python3
  # Point the validator at this one SKILL.md via SKILL_GLOB; exit 0 required.
  run env SKILL_GLOB="$SKILL" python3 "$IGRIS_ROOT/scripts/validate_skill_frontmatter_yaml.py"
  assert_success
}

@test "FR-172: body names all 9 authoritative checklist anchors" {
  # One anchor per onboarding step — the completeness contract. If any is
  # renamed in the topology, the skill must be updated in lockstep, and this
  # test is the lockstep guard.
  local anchors=(
    "types.ts"                 # Step 1 — CLI catalog
    "mcp-shape"                # Step 2 — MCP surface
    "manifest.schema.json"     # Step 3 — schema enums + manifests
    "surfaces-manifest.json"   # Step 4 — core skills surface
    "compile_harnesses.sh"     # Step 5 — compiler passes
    "hooks/bridges"            # Step 6 — hooks / bridge
    "cli_targets"              # Step 7 — runtime config (descriptive)
    "check_harness_drift.sh"   # Step 8 — drift checker
    "docs/multi-cli.md"        # Step 9 — tests + docs / cross-link
  )
  for anchor in "${anchors[@]}"; do
    if ! grep -qF "$anchor" "$SKILL"; then
      echo "Missing authoritative anchor in onboard-harness SKILL.md: $anchor" >&2
      return 1
    fi
  done
}

@test "FR-172: body flags cli_targets.target as DESCRIPTIVE (the §0.1 finding)" {
  # The skill must not mislead a reader into editing cli_targets.target expecting
  # a projection change — it is unread by the compiler (FR-172 §0.1).
  run grep -iE 'descriptive|not read by the projection' "$SKILL"
  assert_success
}
