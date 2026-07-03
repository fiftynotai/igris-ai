#!/usr/bin/env bats

# validate_skill_frontmatter_yaml.test.bash - Tests for
#   scripts/validate_skill_frontmatter_yaml.py (TD-219, #587).
#
# The recurrence guard for the "unquoted mid-scalar `: ` in SKILL.md
# frontmatter that strict parsers (Codex) silently skip" bug.
#
# Covers:
#   1. real_tree_passes — the validator over the actual repo core/skills/
#      exits 0 (proves the Phase-1 fix for archive/hunt/register/sync holds).
#   2. quoted_colon_fixture_passes — a well-formed SKILL.md whose
#      colon-bearing description is double-quoted exits 0.
#   3. unquoted_colon_fixture_fails — the deliberately-bad fixture: an
#      UNQUOTED `description: Foo - usage: /bar` exits 1, names the file, and
#      surfaces the mapping-values error (the Codex-class failure). This is
#      the regression that proves a future bad skill can't slip through.
#   4. register_style_escaped_quotes_pass — a description with escaped inner
#      double-quotes (the `register` shape) exits 0.
#
# Fixtures are injected via the SKILL_GLOB env override so the live repo
# files are never mutated (mirrors the SCHEMA_FILE/PROMPT_FILE pattern in
# validate_brain_stewardship_enums.test.bash).

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_skill_frontmatter_yaml.py"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"
  python3 -c "import yaml" 2>/dev/null || skip "PyYAML not available"

  SCRATCH="$TEST_TEMP_DIR/validate_skill_yaml_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# Helper: write a SKILL.md fixture under $SCRATCH/<name>/SKILL.md whose
# `description:` line is exactly $2 (caller controls quoting).
write_skill_fixture() {
  local name="$1"
  local desc_line="$2"
  mkdir -p "$SCRATCH/$name"
  cat > "$SCRATCH/$name/SKILL.md" <<MD
---
name: $name
$desc_line
disable-model-invocation: false
allowed-tools:
  - Read
---

# $name

Body content here.
MD
}

@test "real_tree_passes: validator over repo core/skills exits 0" {
  # No SKILL_GLOB override -> default scope = repo core/skills/*/SKILL.md.
  run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
  [[ "$output" == *"strict YAML"* ]]
}

@test "quoted_colon_fixture_passes: double-quoted colon description exits 0" {
  write_skill_fixture "good" 'description: "Archive a brief - usage: /archive BR-008"'

  SKILL_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}

@test "unquoted_colon_fixture_fails: unquoted colon description exits 1 and names the file" {
  # The deliberately-bad fixture (AC): unquoted mid-scalar `: ` — the exact
  # shape Codex rejects. The recurrence guard MUST fail here.
  write_skill_fixture "bad" 'description: Archive a brief - usage: /archive BR-008'

  SKILL_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 1 ]
  # Names the offending file.
  [[ "$output" == *"$SCRATCH/bad/SKILL.md"* ]]
  # Surfaces the Codex-class parser error.
  [[ "$output" == *"mapping values"* ]]
}

@test "register_style_escaped_quotes_pass: escaped inner quotes exit 0" {
  # The `register` shape: a quoted scalar whose value contains escaped
  # double-quotes. A botched escape would terminate the scalar early and
  # fail the parse — this proves the chosen escaping round-trips.
  write_skill_fixture "registerish" \
    'description: "Create a new brief - usage: /register bug|feature|debt \"title\""'

  SKILL_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}
