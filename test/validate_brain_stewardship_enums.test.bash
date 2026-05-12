#!/usr/bin/env bats

# validate_brain_stewardship_enums.test.bash - Tests for
#   scripts/validate_brain_stewardship_enums.sh (TD-072 F1+F2 regression;
#   script + test renamed from validate_memory_agency_enums in TD-148).
#
# Covers:
#   1. scope_enum_divergence_detected — same field declared with diverging
#      enum arrays in the schema must exit 2 with the field name in stderr.
#   2. scope_enum_agreement_passes — same field declared with identical
#      arrays passes (the common, expected case for `scope`).
#   3. schema_shrinkage_detected — a backticked enum-value-shaped token in
#      brain_stewardship that is NOT in any current schema enum must trip
#      exit 1 with the orphan token named.
#
# These cases use SCHEMA_FILE / PROMPT_FILE env-var overrides (added in
# TD-072 F1) to inject minimal fixtures rather than mutating the live repo
# files.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_brain_stewardship_enums.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/validate_enums_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# Helper: build a minimal brain_stewardship fixture that backticks every
# value in the (canonical) enums. Used by Cases 1 + 2 so the forward pass
# is satisfied; the failure path under test is the dedup pass (or its
# absence). Pass extra backticks via $1 (e.g., to seed Case 3's orphan).
write_minimal_stewardship() {
  local extra="${1:-}"
  cat > "$SCRATCH/stewardship.md" <<'MD'
# Brain Stewardship fixture

<!-- SECTION: brain_stewardship -->

## Memory enums

| field | values |
|---|---|
| `category` | `pattern`, `decision`, `discovery`, `mistake`, `optimization` |
| `scope` | `local`, `global` |
| `provenance` | `observed`, `inferred`, `synthesized`, `ambiguous`, `human_asserted` |

MD
  if [ -n "$extra" ]; then
    printf '%s\n' "$extra" >> "$SCRATCH/stewardship.md"
  fi
  cat >> "$SCRATCH/stewardship.md" <<'MD'

<!-- /SECTION: brain_stewardship -->
MD
}

@test "scope_enum_divergence_detected: diverging scope arrays in schema yield exit 2" {
  # Two scope blocks with DIFFERENT enum arrays — the kind of drift TD-072 F1
  # exists to catch. Pre-fix the script silently overwrote the first block
  # with the second.
  cat > "$SCRATCH/schema.ts" <<'TS'
const memoryStore = {
  inputSchema: {
    properties: {
      category: {
        type: 'string',
        enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
      },
      scope: {
        type: 'string',
        enum: ['local', 'global'],
      },
      provenance: {
        type: 'string',
        enum: ['observed', 'inferred', 'synthesized', 'ambiguous', 'human_asserted'],
      },
    },
  },
};
const memorySearch = {
  inputSchema: {
    properties: {
      scope: {
        type: 'string',
        enum: ['local', 'global', 'session'],
      },
    },
  },
};
TS

  write_minimal_stewardship

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    run bash "$VALIDATOR"

  [ "$status" -eq 2 ]
  # The diagnostic must name the divergent field.
  [[ "$output" == *"scope"* ]]
  # And explicitly say enums diverge.
  [[ "$output" == *"diverging"* ]] || [[ "$output" == *"diverge"* ]]
}

@test "scope_enum_agreement_passes: identical scope arrays pass with OK" {
  # Two scope blocks with the SAME enum array — the common, expected
  # configuration (memory_store + memory_search both ['local', 'global']).
  cat > "$SCRATCH/schema.ts" <<'TS'
const memoryStore = {
  inputSchema: {
    properties: {
      category: {
        type: 'string',
        enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
      },
      scope: {
        type: 'string',
        enum: ['local', 'global'],
      },
      provenance: {
        type: 'string',
        enum: ['observed', 'inferred', 'synthesized', 'ambiguous', 'human_asserted'],
      },
    },
  },
};
const memorySearch = {
  inputSchema: {
    properties: {
      scope: {
        type: 'string',
        enum: ['local', 'global'],
      },
    },
  },
};
TS

  write_minimal_stewardship

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    run bash "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}

@test "schema_shrinkage_detected: orphan backticked enum-value-shaped token yields exit 1" {
  # Schema with a SHRUNKEN scope enum (only 'local'). brain_stewardship
  # still backticks `global` (in the enum table) AND seeds an obsolete
  # `session` reference in a scope-mentioning sentence — that's the
  # schema-shrinkage case TD-072 F2 catches.
  cat > "$SCRATCH/schema.ts" <<'TS'
const memoryStore = {
  inputSchema: {
    properties: {
      category: {
        type: 'string',
        enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
      },
      scope: {
        type: 'string',
        enum: ['local'],
      },
      provenance: {
        type: 'string',
        enum: ['observed', 'inferred', 'synthesized', 'ambiguous', 'human_asserted'],
      },
    },
  },
};
TS

  cat > "$SCRATCH/stewardship.md" <<'MD'
# Brain Stewardship fixture

<!-- SECTION: brain_stewardship -->

## Memory enums

| field | values |
|---|---|
| `category` | `pattern`, `decision`, `discovery`, `mistake`, `optimization` |
| `scope` | `local`, `global` |
| `provenance` | `observed`, `inferred`, `synthesized`, `ambiguous`, `human_asserted` |

Use `scope` of `global` to promote across projects.

<!-- /SECTION: brain_stewardship -->
MD

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    run bash "$VALIDATOR"

  [ "$status" -eq 1 ]
  # The error must mention `global` — the orphan token.
  [[ "$output" == *"global"* ]]
  # And label it as schema-shrinkage drift.
  [[ "$output" == *"shrinkage"* ]] || [[ "$output" == *"orphan"* ]] || [[ "$output" == *"missing from schema"* ]]
}
