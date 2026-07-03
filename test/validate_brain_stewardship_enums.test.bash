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

# ----------------------------------------------------------------------------
# TD-171 M4: tool-name drift validator (forward + reverse)
# ----------------------------------------------------------------------------
#
# These tests cover the new tool-name parity block added in M4. The block
# scans `name: 'igris_*'` tokens from a COMPONENTS_GLOB (test-overridable)
# and backticked `igris_*` tokens from PROMPT_FILE; mismatches in either
# direction must surface a clear, actionable error.
#
# Strategy: build a self-consistent fixture trio (schema enums OK, no
# schema shrinkage) so the new block is the only failing surface, then
# inject the drift case under test.

# Helper: write a schema fixture with the canonical enums (passes the
# enum-divergence + forward + shrinkage checks). Used as the baseline
# for the tool-name drift tests so the only thing under test is the
# new tool-name parity block.
write_canonical_schema() {
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
TS
}

# Helper: write a stewardship fixture that satisfies the enum forward
# pass AND backticks every tool name passed in $1 (space-separated).
# Used by the tool-name drift tests so we can include or exclude
# specific tool names independently.
write_stewardship_with_tools() {
  local tools="$1"
  cat > "$SCRATCH/stewardship.md" <<'MD'
# Brain Stewardship fixture

<!-- SECTION: brain_stewardship -->

## Memory enums

| field | values |
|---|---|
| `category` | `pattern`, `decision`, `discovery`, `mistake`, `optimization` |
| `scope` | `local`, `global` |
| `provenance` | `observed`, `inferred`, `synthesized`, `ambiguous`, `human_asserted` |

## Tools mentioned

MD
  # Embed each tool in a backticked list line. We use a sed-substitution
  # over a placeholder rather than heredoc/printf/echo to keep backticks
  # literal without triggering command substitution or backslash
  # interpretation by any shell-version differences.
  local btick='`'
  for tool in $tools; do
    echo "- ${btick}${tool}${btick}" >> "$SCRATCH/stewardship.md"
  done
  cat >> "$SCRATCH/stewardship.md" <<'MD'

<!-- /SECTION: brain_stewardship -->
MD
}

# Helper: write a minimal component fixture in $SCRATCH/components/<name>/index.ts
# that registers the tool names passed in $2 (space-separated). $1 is the
# component-directory name.
write_component_fixture() {
  local name="$1"
  local tools="$2"
  mkdir -p "$SCRATCH/components/$name"
  : > "$SCRATCH/components/$name/index.ts"
  for tool in $tools; do
    printf "  name: '%s',\n" "$tool" >> "$SCRATCH/components/$name/index.ts"
  done
}

@test "tool_drift_happy_path: aligned doc + components yields exit 0" {
  write_canonical_schema
  write_stewardship_with_tools "igris_real_tool"
  write_component_fixture "real" "igris_real_tool"

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    COMPONENTS_GLOB="$SCRATCH/components/*/index.ts" \
    run bash "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"tool-name parity"* ]]
}

@test "tool_drift_forward: doc references missing tool yields exit 1 with FORWARD message" {
  # Doc backticks `igris_nonexistent_tool` but no component registers it.
  # This is the FR-120-class drift TD-171 was filed to prevent.
  write_canonical_schema
  write_stewardship_with_tools "igris_nonexistent_tool"
  write_component_fixture "real" "igris_real_tool"
  # Also include igris_real_tool's mention in the doc to keep reverse-pass
  # clean — we want only the forward drift to fire.
  printf -- '\nAlso `igris_real_tool` is here.\n' >> "$SCRATCH/stewardship.md"

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    COMPONENTS_GLOB="$SCRATCH/components/*/index.ts" \
    run bash "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FORWARD"* ]]
  [[ "$output" == *"igris_nonexistent_tool"* ]]
  [[ "$output" == *"NOT registered"* ]]
}

@test "tool_drift_reverse: gateway tool not documented yields exit 1 with REVERSE message" {
  # Component registers `igris_secret_tool` but the doc never mentions it.
  # This catches "we shipped a tool but forgot to advertise it" drift.
  write_canonical_schema
  write_stewardship_with_tools ""  # empty list — no tools mentioned
  write_component_fixture "secret" "igris_secret_tool"

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    COMPONENTS_GLOB="$SCRATCH/components/*/index.ts" \
    run bash "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"REVERSE"* ]]
  [[ "$output" == *"igris_secret_tool"* ]]
  [[ "$output" == *"NOT mentioned"* ]]
}

@test "tool_drift_internal_allowlist_works: live repo tools (allowlisted) skip the reverse check" {
  # Sanity: a tool in the seeded INTERNAL_TOOL_ALLOWLIST (e.g.,
  # igris_event_log) registered in a fixture component must NOT
  # trip reverse drift. This proves the allowlist mechanism wires
  # through and isn't bypassed.
  write_canonical_schema
  write_stewardship_with_tools ""  # docs do not mention it
  write_component_fixture "monitoring" "igris_event_log"

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    COMPONENTS_GLOB="$SCRATCH/components/*/index.ts" \
    run bash "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"tool-name parity"* ]]
}

@test "tool_drift_count_in_ok_message: OK message echoes registered count" {
  # The success print should report the number of registered tools so
  # operators can eyeball "did the surface change?" without re-running
  # the gateway-tool-count vitest.
  write_canonical_schema
  write_stewardship_with_tools "igris_alpha igris_beta"
  write_component_fixture "alpha" "igris_alpha"
  write_component_fixture "beta" "igris_beta"

  SCHEMA_FILE="$SCRATCH/schema.ts" PROMPT_FILE="$SCRATCH/stewardship.md" \
    COMPONENTS_GLOB="$SCRATCH/components/*/index.ts" \
    run bash "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"2 registered"* ]]
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
