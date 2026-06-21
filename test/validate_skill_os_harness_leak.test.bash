#!/usr/bin/env bats

# validate_skill_os_harness_leak.test.bash - Tests for
#   scripts/validate_skill_os_harness_leak.py (TD-248).
#
# The recurrence guard for HARNESS LEAKS in skills + the OS core: a
# harness-specific env var / flag / per-harness config-path target / runtime
# subagent API hardcoded into a skill or OS doc instead of being routed through
# the harness-agnostic adapter boundary.
#
# Covers every verdict class (L-29 — not just the happy path):
#   real_tree_passes               — validator over the actual repo exits 0.
#   T1 planted_leak_fails          — fenced harness command -> exit 1, names file+token.
#   T1b planted_path_target_fails  — `.claude/agents/` instruction -> exit 1.
#   T1c planted_subagent_api_fails — `define_subagent` in a fence -> exit 1.
#   T1d planted_codex_home_path    — `~/.codex/` write target -> exit 1 (warden M1).
#   T2 clean_tree_passes           — abstract subagent_type + prose -> exit 0.
#   T3 allowlisted_file_passes     — allowlisted path full of tokens -> exit 0.
#   T4 doc_mention_not_flagged     — `~/.claude.json` prose mention -> exit 0.
#   T5 subagent_type_never_flagged — `subagent_type:` in a fence -> exit 0.
#   T6 setup_error                 — empty/missing scan glob -> exit 2.
#
# Fixtures are injected via the LEAK_SCAN_GLOB env override so the live repo
# files are never mutated (mirrors the SKILL_GLOB pattern in
# validate_skill_frontmatter_yaml.test.bash).

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_skill_os_harness_leak.py"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/validate_skill_os_leak_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

@test "real_tree_passes: validator over repo skills/OS exits 0" {
  # No LEAK_SCAN_GLOB override -> default scope = the real tree. Proves the
  # scan/SKILL.md fix + the allowlist keep the gate green.
  run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
  [[ "$output" == *"no harness leak"* ]]
}

@test "T1 planted_leak_fails: fenced harness flag exits 1 and names the file" {
  mkdir -p "$SCRATCH/leaky"
  cat > "$SCRATCH/leaky/SKILL.md" <<'MD'
---
name: leaky
description: "A leaky skill"
---

# leaky

## Prerequisites

Set the experimental flag:
```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"$SCRATCH/leaky/SKILL.md"* ]]
  [[ "$output" == *"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"* ]]
  [[ "$output" == *"Harness leak detected"* ]]
}

@test "T1b planted_path_target_fails: .claude/agents/ create instruction exits 1" {
  mkdir -p "$SCRATCH/digi"
  cat > "$SCRATCH/digi/SKILL.md" <<'MD'
---
name: digi
description: "Agent CRUD"
---

# digi

4. Create `.claude/agents/{name}.md` from template
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"$SCRATCH/digi/SKILL.md"* ]]
  [[ "$output" == *".claude/agents/"* ]]
}

@test "T1c planted_subagent_api_fails: define_subagent in a fence exits 1" {
  mkdir -p "$SCRATCH/dyndeleg"
  cat > "$SCRATCH/dyndeleg/SKILL.md" <<'MD'
---
name: dyndeleg
description: "Dynamic delegation recipe"
---

# dyndeleg

On a dynamic-agent harness, seed the role at runtime:
```bash
define_subagent --name forger --prompt "$(cat ~/.igris/core/agents/forger.md)"
invoke_subagent forger
```
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"$SCRATCH/dyndeleg/SKILL.md"* ]]
  [[ "$output" == *"define_subagent"* ]]
}

@test "T1d planted_codex_home_path_fails: ~/.codex/ write target exits 1 (warden M1)" {
  mkdir -p "$SCRATCH/codexleak"
  cat > "$SCRATCH/codexleak/SKILL.md" <<'MD'
---
name: codexleak
description: "Codex config write"
---

# codexleak

Set the MCP trust in `~/.codex/config.toml`:
```bash
echo 'trust = true' >> ~/.codex/config.toml
```
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"$SCRATCH/codexleak/SKILL.md"* ]]
  [[ "$output" == *".codex/"* ]]
}

@test "T2 clean_tree_passes: abstract delegation + prose exits 0" {
  mkdir -p "$SCRATCH/clean"
  cat > "$SCRATCH/clean/SKILL.md" <<'MD'
---
name: clean
description: "A clean skill"
---

# clean

Delegate to the architect role via the Agent tool. The roster is discovered
from the agent definitions; the per-harness directory is adapter-owned.
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}

@test "T3 allowlisted_file_passes: allowlisted path full of tokens exits 0" {
  # Reproduce the allowlisted repo-relative suffix under the scratch dir so the
  # basename-suffix allowlist match fires. onboard-harness is by-design full of
  # harness tokens.
  mkdir -p "$SCRATCH/core/skills/onboard-harness"
  cat > "$SCRATCH/core/skills/onboard-harness/SKILL.md" <<'MD'
---
name: onboard-harness
description: "Adapter authoring guide"
---

# onboard-harness

Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1` in `~/.claude/settings.json`.
Create `.claude/agents/{name}.md`. The dynamic-define recipe uses
`define_subagent` / `invoke_subagent`.
MD

  LEAK_SCAN_GLOB="$SCRATCH/core/skills/onboard-harness/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"allowlisted"* ]]
}

@test "T4 doc_mention_not_flagged: prose ~/.claude.json mention exits 0" {
  mkdir -p "$SCRATCH/proseos"
  cat > "$SCRATCH/proseos/SKILL.md" <<'MD'
---
name: proseos
description: "Prose only"
---

# proseos

The MCP server is registered as a stdio binary in `~/.claude.json` — it spawns
per Claude. You ARE Igris AI, not Claude using Igris AI.
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}

@test "T5 subagent_type_never_flagged: subagent_type in a fence exits 0" {
  mkdir -p "$SCRATCH/deleg"
  cat > "$SCRATCH/deleg/SKILL.md" <<'MD'
---
name: deleg
description: "Delegation contract"
---

# deleg

Invoke via the Agent tool:
```yaml
subagent_type: "forger"
```
MD

  LEAK_SCAN_GLOB="$SCRATCH/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"* ]]
}

@test "T6 setup_error: empty scan glob exits 2" {
  # A glob that matches nothing -> setup error (no files to scan).
  LEAK_SCAN_GLOB="$SCRATCH/nonexistent/*/SKILL.md" run python3 "$VALIDATOR"

  [ "$status" -eq 2 ]
  [[ "$output" == *"no skill/OS files found"* ]]
}
