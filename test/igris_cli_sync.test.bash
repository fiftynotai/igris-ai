#!/usr/bin/env bats

# Test suite for igris_cli_sync.sh and the cli-adapters/ converters.
#
# Maps to the 8 acceptance criteria in FR-103.
# Runs fully isolated: each test uses TEST_TEMP_DIR for skills-root and
# target paths, with a scratch config.json. The live ~/.igris tree is not
# touched by any test.

load test_helper

# =============================================================================
# SETUP / TEARDOWN
# =============================================================================

FIXTURE_SKILLS_DIR="$BATS_TEST_DIRNAME/fixtures/skills"
SYNC_SCRIPT="$SCRIPTS_DIR/igris_cli_sync.sh"
GEMINI_ADAPTER="$SCRIPTS_DIR/cli-adapters/md_to_gemini_toml.sh"
CODEX_ADAPTER="$SCRIPTS_DIR/cli-adapters/md_to_agents_md.sh"
COMMON_HELPERS="$SCRIPTS_DIR/cli-adapters/_common.sh"

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  export TEST_BRAIN_DIR="$TEST_TEMP_DIR/brain"
  export TEST_SKILLS_ROOT="$TEST_BRAIN_DIR/core/skills"
  export TEST_PROJECT_DIR="$TEST_TEMP_DIR/proj"
  export TEST_CLAUDE_TARGET="$TEST_TEMP_DIR/claude-skills"
  export TEST_GEMINI_TARGET="$TEST_TEMP_DIR/gemini-commands"

  mkdir -p "$TEST_BRAIN_DIR" "$TEST_PROJECT_DIR" "$TEST_SKILLS_ROOT"

  # Clone fixtures into the scratch skills root so tests always work on
  # fresh copies. Use cp -R to preserve SKILL.md and nested files.
  cp -R "$FIXTURE_SKILLS_DIR/"* "$TEST_SKILLS_ROOT/"

  # Write a scratch config with targets pointing at the TEST_TEMP_DIR.
  cat > "$TEST_BRAIN_DIR/config.json" <<EOF
{
  "cli_targets": {
    "claude":   { "method": "symlink",   "target": "$TEST_CLAUDE_TARGET/",    "note": "test-claude" },
    "opencode": { "method": "none",      "target": "$TEST_TEMP_DIR/opencode/", "note": "OpenCode reads Claude skills natively" },
    "gemini":   { "method": "converter", "target": "$TEST_GEMINI_TARGET/",    "converter": "scripts/cli-adapters/md_to_gemini_toml.sh" },
    "codex":    { "method": "compiler",  "target": "./AGENTS.md",              "compiler":  "scripts/cli-adapters/md_to_agents_md.sh" }
  }
}
EOF
}

teardown() {
  # Base test_helper teardown removes TEST_TEMP_DIR.
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# Helper: run sync with scratch brain + skills root.
run_sync() {
  IGRIS_BRAIN_DIR="$TEST_BRAIN_DIR" \
  IGRIS_SKILLS_ROOT="$TEST_SKILLS_ROOT" \
    run bash "$SYNC_SCRIPT" "$@"
}

# =============================================================================
# AC#1: Config block supports four CLIs, parses without errors
# =============================================================================

@test "AC#1: config block supports four CLIs (claude, opencode, gemini, codex)" {
  require_python3

  # Parse via python — verify all 4 keys + required fields.
  run python3 -c "
import json, sys
cfg = json.load(open('$TEST_BRAIN_DIR/config.json'))
targets = cfg['cli_targets']
expected = {'claude', 'opencode', 'gemini', 'codex'}
assert expected == set(targets.keys()), f'keys: {set(targets.keys())}'
for name, entry in targets.items():
    assert 'method' in entry, f'{name} missing method'
    assert 'target' in entry, f'{name} missing target'
print('OK')
"
  assert_success
  assert_output_contains "OK"
}

@test "AC#1: live ~/.igris/config.json has cli_targets block" {
  require_python3
  # Guard against regression on the real installed config.
  if [ ! -f "$HOME/.igris/config.json" ]; then
    skip "No installed config to check"
  fi
  run python3 -c "
import json
cfg = json.load(open('$HOME/.igris/config.json'))
assert 'cli_targets' in cfg
print('OK')
"
  assert_success
}

# =============================================================================
# AC#2: --cli=claude produces symlinks identical to current behavior
# =============================================================================

@test "AC#2: --cli=claude creates symlinks for every fixture skill" {
  run_sync --cli=claude --project-dir="$TEST_PROJECT_DIR"
  assert_success

  assert_dir_exists "$TEST_CLAUDE_TARGET"

  # All 3 fixtures must be linked.
  for skill in simple-skill nested-skill claude-only-skill; do
    if [ ! -L "$TEST_CLAUDE_TARGET/$skill" ]; then
      echo "Expected symlink missing: $TEST_CLAUDE_TARGET/$skill" >&2
      return 1
    fi
    # Readlink should point at the canonical fixture directory.
    local link_target
    link_target=$(readlink "$TEST_CLAUDE_TARGET/$skill")
    if [ "$link_target" != "$TEST_SKILLS_ROOT/$skill" ]; then
      echo "Unexpected link target for $skill: $link_target" >&2
      return 1
    fi
  done
}

@test "AC#2: re-running --cli=claude is idempotent (no duplicate symlinks)" {
  run_sync --cli=claude --project-dir="$TEST_PROJECT_DIR"
  assert_success

  local first_snapshot
  first_snapshot=$(ls -la "$TEST_CLAUDE_TARGET" | sort)

  run_sync --cli=claude --project-dir="$TEST_PROJECT_DIR"
  assert_success

  local second_snapshot
  second_snapshot=$(ls -la "$TEST_CLAUDE_TARGET" | sort)

  if [ "$first_snapshot" != "$second_snapshot" ]; then
    echo "Symlink set changed between identical runs" >&2
    echo "First:"; echo "$first_snapshot"
    echo "Second:"; echo "$second_snapshot"
    return 1
  fi
}

# =============================================================================
# AC#3: --cli=gemini produces valid TOML files
# =============================================================================

@test "AC#3: --cli=gemini produces valid TOML with description + prompt keys" {
  require_python3

  run_sync --cli=gemini --project-dir="$TEST_PROJECT_DIR"
  assert_success

  assert_file_exists "$TEST_GEMINI_TARGET/simple-skill.toml"
  assert_file_exists "$TEST_GEMINI_TARGET/nested-skill.toml"
  assert_file_exists "$TEST_GEMINI_TARGET/claude-only-skill.toml"

  # Parse each with tomllib — invalid TOML would raise.
  run python3 -c "
import tomllib, sys
for name in ['simple-skill', 'nested-skill', 'claude-only-skill']:
    with open(f'$TEST_GEMINI_TARGET/{name}.toml', 'rb') as fh:
        data = tomllib.load(fh)
    assert set(data.keys()) == {'description', 'prompt'}, f'{name}: keys={set(data.keys())}'
    assert isinstance(data['description'], str) and data['description']
    assert isinstance(data['prompt'], str) and data['prompt']
print('OK')
"
  assert_success
}

@test "AC#3: gemini TOML escapes triple quotes cleanly" {
  require_python3

  # Create a stress fixture with triple quotes in body.
  mkdir -p "$TEST_SKILLS_ROOT/stress-triple"
  cat > "$TEST_SKILLS_ROOT/stress-triple/SKILL.md" << 'EOF'
---
name: stress-triple
description: Stress test for triple quotes
---

# Stress

Here is a triple quote: """ and four: """" and a backslash: \ and another \\.

Also a "normal" quoted string.
EOF

  run bash "$GEMINI_ADAPTER" \
    "$TEST_SKILLS_ROOT/stress-triple/SKILL.md" \
    "$TEST_GEMINI_TARGET/stress-triple.toml"
  assert_success

  # Must parse and round-trip the body intact.
  run python3 -c "
import tomllib
with open('$TEST_GEMINI_TARGET/stress-triple.toml', 'rb') as fh:
    d = tomllib.load(fh)
assert '\"\"\"' in d['prompt'], 'missing triple quotes after round-trip'
assert '\\\\' in d['prompt'] or '\\\\\\\\' in d['prompt'], 'missing backslashes'
print('OK')
"
  assert_success
}

# =============================================================================
# AC#4: --cli=codex produces AGENTS.md under 32KB with exclusions respected
# =============================================================================

@test "AC#4: --cli=codex produces AGENTS.md under 32KB with generator marker" {
  run_sync --cli=codex --project-dir="$TEST_PROJECT_DIR"
  assert_success

  local agents_md="$TEST_PROJECT_DIR/AGENTS.md"
  assert_file_exists "$agents_md"

  # Size <= 32KB + small marker allowance.
  local size
  size=$(wc -c < "$agents_md" | tr -d ' ')
  if [ "$size" -gt 33792 ]; then  # 32KB + 1KB marker budget
    echo "AGENTS.md is $size bytes, exceeds cap + marker budget" >&2
    return 1
  fi

  # Must contain the generator marker.
  assert_file_contains "$agents_md" "Generated by igris_cli_sync.sh"
}

@test "AC#4: --cli=codex excludes claude-only-skill via Agent() heuristic" {
  run_sync --cli=codex --project-dir="$TEST_PROJECT_DIR"
  assert_success

  local agents_md="$TEST_PROJECT_DIR/AGENTS.md"

  # claude-only-skill body must NOT appear in AGENTS.md output.
  assert_file_not_contains "$agents_md" "Claude-Only Fixture"
  # But simple-skill and nested-skill should.
  assert_file_contains "$agents_md" "Simple Test Skill"
  assert_file_contains "$agents_md" "Nested Skill Fixture"

  # Trailing marker must list claude-only-skill as excluded.
  assert_file_contains "$agents_md" "Claude-only:"
  assert_file_contains "$agents_md" "claude-only-skill"
}

# =============================================================================
# AC#5: --cli=opencode exits 0 with "No-op" notice and no filesystem writes
# =============================================================================

@test "AC#5: --cli=opencode is no-op with note and no writes" {
  # Pre-check: no pre-existing writes in the target dir.
  local opencode_dir="$TEST_TEMP_DIR/opencode"
  mkdir -p "$opencode_dir"
  local pre_count
  pre_count=$(find "$opencode_dir" -mindepth 1 | wc -l | tr -d ' ')

  run_sync --cli=opencode --project-dir="$TEST_PROJECT_DIR"
  assert_success
  assert_output_contains "method=none"

  # No new writes.
  local post_count
  post_count=$(find "$opencode_dir" -mindepth 1 | wc -l | tr -d ' ')
  if [ "$pre_count" != "$post_count" ]; then
    echo "Expected no writes under $opencode_dir; pre=$pre_count post=$post_count" >&2
    return 1
  fi
}

# =============================================================================
# AC#6: Awaken step 3.6.3.a invokes CLI sync after definition pull
# =============================================================================

@test "AC#6: awaken/SKILL.md contains step 3.6.3.a CLI refresh section" {
  skip "Pending awaken §3.6.3.a integration — see TD-106 for context"
  # Integration-level test: verify the prose instruction exists so /awaken
  # agents can route correctly. Mocking the brain MCP is out of scope.
  local awaken_file="$HOME/.igris/core/skills/awaken/SKILL.md"
  if [ ! -f "$awaken_file" ]; then
    skip "awaken SKILL.md not present in brain"
  fi

  assert_file_contains "$awaken_file" "3.6.3.a"
  assert_file_contains "$awaken_file" "Refresh CLI Targets"
  assert_file_contains "$awaken_file" "igris_cli_sync.sh"
  assert_file_contains "$awaken_file" "cli_targets"
}

# =============================================================================
# AC#7: docs/multi-cli.md exists with required sections
# =============================================================================

@test "AC#7: docs/multi-cli.md exists with required sections" {
  local doc="$IGRIS_ROOT/docs/multi-cli.md"
  assert_file_exists "$doc"
  assert_file_contains "$doc" "Supported CLIs"
  assert_file_contains "$doc" "platform_overrides"
  assert_file_contains "$doc" "32KB"
  assert_file_contains "$doc" "How to Add a New CLI Adapter"
}

# =============================================================================
# AC#8: Gemini TOML output does not contain Claude-specific frontmatter keys
# =============================================================================

@test "AC#8: gemini TOML does NOT contain Claude-specific frontmatter keys" {
  run_sync --cli=gemini --project-dir="$TEST_PROJECT_DIR"
  assert_success

  for name in simple-skill nested-skill claude-only-skill; do
    local toml="$TEST_GEMINI_TARGET/${name}.toml"
    assert_file_exists "$toml"
    # These Claude-specific keys must be absent from the TOML.
    assert_file_not_contains "$toml" "allowed-tools"
    assert_file_not_contains "$toml" "triggers"
    assert_file_not_contains "$toml" "platform_overrides"
    assert_file_not_contains "$toml" "disable-model-invocation"
  done
}

# =============================================================================
# Additional guards (coding guidelines §12 — error handling, edge cases)
# =============================================================================

@test "--cli=all expands to every configured entry" {
  run_sync --cli=all --project-dir="$TEST_PROJECT_DIR"
  assert_success
  assert_output_contains "claude"
  assert_output_contains "opencode"
  assert_output_contains "gemini"
  assert_output_contains "codex"
}

@test "missing --cli flag fails with usage" {
  IGRIS_BRAIN_DIR="$TEST_BRAIN_DIR" \
  IGRIS_SKILLS_ROOT="$TEST_SKILLS_ROOT" \
    run bash "$SYNC_SCRIPT" --project-dir="$TEST_PROJECT_DIR"
  assert_failure
  assert_output_contains "cli"
}

@test "unknown CLI name exits non-zero" {
  run_sync --cli=nonexistent --project-dir="$TEST_PROJECT_DIR"
  assert_failure
  assert_output_contains "Unknown CLI"
}

@test "_common.sh helpers parse both flat and platform_overrides frontmatter" {
  # Sanity check: ensure both fixtures produce a non-empty description via the
  # same helper, regardless of frontmatter style.
  # shellcheck disable=SC1090
  source "$COMMON_HELPERS"

  run get_skill_field "$TEST_SKILLS_ROOT/simple-skill/SKILL.md" "description"
  assert_success
  if [ -z "$output" ]; then
    echo "Flat fixture description empty" >&2
    return 1
  fi

  run get_skill_field "$TEST_SKILLS_ROOT/nested-skill/SKILL.md" "description"
  assert_success
  if [ -z "$output" ]; then
    echo "Nested fixture description empty" >&2
    return 1
  fi
}

@test "is_claude_only correctly identifies Agent() body pattern" {
  # shellcheck disable=SC1090
  source "$COMMON_HELPERS"

  # Should detect Agent() in claude-only-skill.
  if ! is_claude_only "$TEST_SKILLS_ROOT/claude-only-skill/SKILL.md" codex; then
    echo "claude-only-skill not detected as claude-only" >&2
    return 1
  fi

  # Should NOT flag simple-skill.
  if is_claude_only "$TEST_SKILLS_ROOT/simple-skill/SKILL.md" codex; then
    echo "simple-skill incorrectly flagged as claude-only" >&2
    return 1
  fi
}

@test "gemini converter skips nested helper.sh (reads only SKILL.md)" {
  run_sync --cli=gemini --project-dir="$TEST_PROJECT_DIR"
  assert_success

  # No helper.toml should be produced for the nested script.
  if [ -f "$TEST_GEMINI_TARGET/helper.toml" ]; then
    echo "Unexpected helper.toml emitted" >&2
    return 1
  fi
  # Exactly one toml per SKILL.md.
  local toml_count
  toml_count=$(find "$TEST_GEMINI_TARGET" -maxdepth 1 -name '*.toml' | wc -l | tr -d ' ')
  if [ "$toml_count" != "3" ]; then
    echo "Expected 3 TOML files, got $toml_count" >&2
    return 1
  fi
}

@test "codex compiler emits deterministic alphabetical order" {
  run_sync --cli=codex --project-dir="$TEST_PROJECT_DIR"
  assert_success

  local agents_md="$TEST_PROJECT_DIR/AGENTS.md"

  # nested-skill must appear before simple-skill in alphabetical order.
  local line_nested line_simple
  line_nested=$(grep -n "^# nested-skill" "$agents_md" | head -1 | cut -d: -f1)
  line_simple=$(grep -n "^# simple-skill" "$agents_md" | head -1 | cut -d: -f1)

  if [ -z "$line_nested" ] || [ -z "$line_simple" ]; then
    echo "Could not find expected headers" >&2
    cat "$agents_md" >&2
    return 1
  fi
  if [ "$line_nested" -ge "$line_simple" ]; then
    echo "Expected nested-skill before simple-skill (got $line_nested vs $line_simple)" >&2
    return 1
  fi
}
