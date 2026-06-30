#!/usr/bin/env bats

# harness_scope.test.bash — FR-155 scope-aware overlay.
#
# FR-155 introduces a `scope` field on overlay agent + skill entries:
#
#   - absent          → global (default; back-compat with pre-FR-155 overlays)
#   - {type:"global"} → emits unconditionally (same as absent)
#   - {type:"project", paths:[...]}
#                     → emits ONLY when --project-root realpath ∈ realpath'd paths[]
#
# These tests pin the seven scenarios called out in the architect's plan:
#
#   1. scope absent → emits in any --project-root (back-compat).
#   2. scope=global → emits in any --project-root.
#   3. scope=project + path match → emits.
#   4. scope=project + path non-match → SILENT skip (no symlink, no DRIFTED).
#   5. scope=project + multi-path match (any) → emits.
#   6. macOS /tmp ↔ /private/tmp realpath equality → emits.
#   7. drift parity: every emit case → MATCH; every skip case → no verdict
#      (TOTAL accounting consistent: a project-scoped non-matching row is NOT
#      counted in the summary).
#
# Mirrors `harness_target_resolution.test.bash` for setup (HOME-sandbox +
# ISOLATED_BRAIN-per-test). The skills surface gets the same matrix via a
# `surfaces.skills` block carrying `scope`.
#
# L-29: ALL plan-listed cases implemented. The macOS realpath equality case
# is load-bearing for the FR-155 contract — `/tmp` is the realistic CI/local
# default and `/private/tmp` is what realpath resolves to on macOS.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -x "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -x "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  # Isolated brain dir per test — prevents the live loadout/personal overlay
  # from leaking into synthetic-project tests (per FR-146 / harness_skills
  # precedent). MUST be exported so the adapters that resolve
  # BRAIN_DIR=${IGRIS_BRAIN_DIR:-~/.igris} pick this up.
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  # Two distinct project roots so multi-project paths matrices have something
  # real to bind realpath against. PROJ_A is the "registered" project; PROJ_B
  # is the "other" project (used to test the silent-skip case).
  PROJ_A="$TEST_TEMP_DIR/scope_proj_a_$BATS_TEST_NUMBER"
  PROJ_B="$TEST_TEMP_DIR/scope_proj_b_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ_A/canon" "$PROJ_B/canon"

  # A canonical agent prompt (frontmatter + body). The α-assembly extracts
  # frontmatter inline (TD-195 fallback — no FR-151 sidecar present) so the
  # claude target's symlink resolves to a loadout-resident harness.md.
  for proj in "$PROJ_A" "$PROJ_B"; do
    cat > "$proj/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

Canonical body for FR-155 scope tests.
EOF
  done

  # A skills source root for the surfaces.skills matrix. Lives under the
  # isolated brain so the FR-153 / L-515 loadout-containment check passes
  # for the claude/symlink target.
  mkdir -p "$IGRIS_BRAIN_DIR/loadout/skills/widget"
  cat > "$IGRIS_BRAIN_DIR/loadout/skills/widget/SKILL.md" <<'EOF'
---
name: widget
description: a widget skill for scope tests
---

# Widget

Widget skill body.
EOF
}

teardown() {
  [ -d "$PROJ_A" ] && rm -rf "$PROJ_A"
  [ -d "$PROJ_B" ] && rm -rf "$PROJ_B"
}

# ---------------------------------------------------------------------------
# Manifest writers. Each takes the project root + the scope JSON to embed
# (or empty for "scope absent — back-compat case 1"). Emits to
# <root>/harness-manifest.json declaring one claude-target agent.
# ---------------------------------------------------------------------------
write_agent_manifest() {
  local root="$1"
  local scope_json="$2"
  local scope_field=""
  if [ -n "$scope_json" ]; then
    scope_field=",\n      \"scope\": $scope_json"
  fi
  printf "{\n  \"version\": 1,\n  \"agents\": [\n    {\n      \"name\": \"sample\",\n      \"canonical\": { \"dir\": \"canon\", \"file\": \"sample.md\", \"versioned\": false },\n      \"targets\": [\n        { \"type\": \"claude\", \"path\": \".claude/agents/sample.md\" }\n      ]%b\n    }\n  ]\n}\n" "$scope_field" > "$root/harness-manifest.json"
}

write_skills_manifest() {
  # Writes a manifest declaring a `surfaces.skills` block (no agents) whose
  # scope is the caller-provided JSON. The block's `source` points at the
  # isolated brain's skills tree so the FR-153 L-515 containment check passes.
  local root="$1"
  local scope_json="$2"
  local scope_field=""
  if [ -n "$scope_json" ]; then
    scope_field=",\n        \"scope\": $scope_json"
  fi
  printf "{\n  \"version\": 1,\n  \"agents\": [],\n  \"surfaces\": {\n    \"skills\": [\n      {\n        \"source\": \"%s/loadout/skills\",\n        \"targets\": [\n          { \"type\": \"claude\", \"method\": \"symlink\", \"path\": \".claude/skills\" }\n        ]%b\n      }\n    ]\n  }\n}\n" "$IGRIS_BRAIN_DIR" "$scope_field" > "$root/harness-manifest.json"
}

# ---------------------------------------------------------------------------
# Case 1: scope ABSENT — emits everywhere (back-compat).
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope absent → emits unconditionally (back-compat)" {
  write_agent_manifest "$PROJ_A" ""
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/agents/sample.md" ]
}

@test "FR-155 drift: scope absent → MATCH (back-compat)" {
  write_agent_manifest "$PROJ_A" ""
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# Case 2: scope=global — emits everywhere (same as absent).
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope=global → emits unconditionally" {
  write_agent_manifest "$PROJ_A" '{ "type": "global" }'
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/agents/sample.md" ]
}

@test "FR-155 drift: scope=global → MATCH" {
  write_agent_manifest "$PROJ_A" '{ "type": "global" }'
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# Case 3: scope=project + matching --project-root → emits.
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope=project paths=[A] matched by --project-root A → emits" {
  write_agent_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/agents/sample.md" ]
}

@test "FR-155 drift: scope=project paths=[A] matched by --project-root A → MATCH" {
  write_agent_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# Case 4: scope=project + non-matching --project-root → SILENT SKIP.
# No symlink emitted. Drift produces no verdict line for this row, and the
# summary TOTAL line does NOT count it (a project-scoped non-applicable row
# is NOT drift).
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope=project paths=[A] non-match (--project-root B) → silent skip" {
  # Note: the manifest at PROJ_B references PROJ_A in scope.paths so when
  # compiling B, the entry is NOT applicable. No symlink should be emitted
  # under PROJ_B.
  write_agent_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_B" --target claude
  # Compile succeeds (the silent skip is not an error).
  [ "$status" -eq 0 ]
  # No symlink under PROJ_B (the row was filtered).
  [ ! -L "$PROJ_B/.claude/agents/sample.md" ]
  [ ! -e "$PROJ_B/.claude/agents/sample.md" ]
}

@test "FR-155 drift: scope=project paths=[A] non-match (--project-root B) → no verdict, no DRIFTED" {
  # No prior compile under PROJ_B; the manifest declares a project-scoped row
  # that does not apply. Drift MUST NOT emit a MISSING/DRIFTED for it.
  write_agent_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$GUARD" --project-root "$PROJ_B"
  # Exit 0: nothing to check (after filter) is not an error; the adapter
  # falls through to its "no targets matched" success path.
  [ "$status" -eq 0 ]
  [[ "$output" != *"[sample/claude]"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}

@test "FR-155 drift: TOTAL summary excludes filtered project-scoped rows" {
  # Mix one global-scoped row (emits + counts) with one project-scoped row
  # whose paths do not include --project-root. The summary line counts ONE
  # row, not two. This pins the filter-before-TOTAL++ contract.
  #
  # Manifest writer here is hand-rolled to declare two agent entries.
  cat > "$PROJ_B/canon/other.md" <<'EOF'
---
name: other
description: a second canonical
---

# OTHER AGENT

Other body.
EOF
  cat > "$PROJ_B/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ],
      "scope": { "type": "global" }
    },
    {
      "name": "other",
      "canonical": { "dir": "canon", "file": "other.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/other.md" }
      ],
      "scope": { "type": "project", "paths": ["$PROJ_A"] }
    }
  ]
}
EOF
  # Compile first so the global-scoped row gets a real MATCH verdict.
  run bash "$COMPILE" --project-root "$PROJ_B" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_B"
  [ "$status" -eq 0 ]
  # The "1 targets" count is the load-bearing assertion: the project-scoped
  # row was filtered BEFORE the TOTAL++ increment, so the summary counts ONE
  # target, not two.
  [[ "$output" == *"1 targets"* ]]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" != *"[other/claude]"* ]]
}

# ---------------------------------------------------------------------------
# Case 5: scope=project paths=[A,B] — emits for either A or B.
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope=project paths=[A,B] matched by --project-root A → emits" {
  write_agent_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\", \"$PROJ_B\"] }"
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/agents/sample.md" ]
}

@test "FR-155 compile: scope=project paths=[A,B] matched by --project-root B → emits" {
  write_agent_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\", \"$PROJ_B\"] }"
  run bash "$COMPILE" --project-root "$PROJ_B" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ_B/.claude/agents/sample.md" ]
}

@test "FR-155 drift: scope=project paths=[A,B] matched by --project-root B → MATCH" {
  write_agent_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\", \"$PROJ_B\"] }"
  run bash "$COMPILE" --project-root "$PROJ_B" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_B"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# Case 6: macOS /tmp ↔ /private/tmp realpath equality.
# This is the LOAD-BEARING case for the FR-155 contract — on macOS, /tmp is a
# symlink to /private/tmp, and a manifest written by one tool with /tmp/x and
# checked by another with /private/tmp/x MUST agree. Both sides realpath their
# inputs before comparison.
# ---------------------------------------------------------------------------

@test "FR-155 compile: scope.paths uses /tmp; --project-root uses /private/tmp (realpath equality)" {
  # macOS only: /tmp is a symlink to /private/tmp. On Linux they are the same
  # path. Skip when /tmp is not a symlink (Linux).
  if [ ! -L "/tmp" ]; then
    skip "this case is macOS-specific (where /tmp -> /private/tmp)"
  fi
  # Stage a project under /tmp (a path under the macOS /tmp symlink).
  local tmp_proj="/tmp/igris-fr155-realpath-$BATS_TEST_NUMBER"
  rm -rf "$tmp_proj"
  mkdir -p "$tmp_proj/canon"
  cp "$PROJ_A/canon/sample.md" "$tmp_proj/canon/sample.md"
  # Write scope.paths with the /tmp-prefixed path.
  write_agent_manifest "$tmp_proj" "{ \"type\": \"project\", \"paths\": [\"$tmp_proj\"] }"
  # Compile with the /private/tmp-prefixed --project-root (what realpath
  # would resolve $tmp_proj to). The realpath-both-sides logic in the filter
  # MUST match these as equal.
  local private_proj="/private$tmp_proj"
  run bash "$COMPILE" --project-root "$private_proj" --target claude
  [ "$status" -eq 0 ]
  [ -L "$private_proj/.claude/agents/sample.md" ]
  rm -rf "$tmp_proj"
}

@test "FR-155 drift: /tmp vs /private/tmp realpath equality also holds drift-side" {
  if [ ! -L "/tmp" ]; then
    skip "this case is macOS-specific (where /tmp -> /private/tmp)"
  fi
  local tmp_proj="/tmp/igris-fr155-realpath-drift-$BATS_TEST_NUMBER"
  rm -rf "$tmp_proj"
  mkdir -p "$tmp_proj/canon"
  cp "$PROJ_A/canon/sample.md" "$tmp_proj/canon/sample.md"
  write_agent_manifest "$tmp_proj" "{ \"type\": \"project\", \"paths\": [\"$tmp_proj\"] }"
  local private_proj="/private$tmp_proj"
  run bash "$COMPILE" --project-root "$private_proj" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$private_proj"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  rm -rf "$tmp_proj"
}

# ---------------------------------------------------------------------------
# Skills surface mirror cases. The same matrix applied to a surfaces.skills
# block carrying `scope`.
# ---------------------------------------------------------------------------

@test "FR-155 skills compile: scope absent → emits unconditionally (back-compat)" {
  skip "FR-212d: custom skills scope-filter projection retired (skills delegate to the skills CLI)"
  write_skills_manifest "$PROJ_A" ""
  run bash "$COMPILE" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/skills/widget" ]
}

@test "FR-155 skills compile: scope=project paths=[A] matched by A → emits" {
  skip "FR-212d: custom skills scope-filter projection retired (skills delegate to the skills CLI)"
  write_skills_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [ -L "$PROJ_A/.claude/skills/widget" ]
}

@test "FR-155 skills compile: scope=project paths=[A] non-match (B) → silent skip" {
  write_skills_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_B"
  [ "$status" -eq 0 ]
  [ ! -L "$PROJ_B/.claude/skills/widget" ]
  [ ! -e "$PROJ_B/.claude/skills/widget" ]
}

@test "FR-155 skills drift: scope=project paths=[A] non-match → no verdict, no DRIFTED" {
  write_skills_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$GUARD" --project-root "$PROJ_B"
  [ "$status" -eq 0 ]
  [[ "$output" != *"[skills/claude]"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}

@test "FR-155 skills drift: scope=project paths=[A] matched by A → MATCH" {
  skip "FR-212d: custom skills scope-filter projection retired (skills delegate to the skills CLI)"
  write_skills_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  run bash "$COMPILE" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/claude] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# Negative-control: a malformed scope is rejected by validate_manifest at
# compile + drift entry. Pins the schema gate.
# ---------------------------------------------------------------------------

@test "FR-155 schema: scope.type=project WITHOUT paths is a hard error" {
  write_agent_manifest "$PROJ_A" '{ "type": "project" }'
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"paths"* ]] || [[ "$output" == *"scope"* ]]
}

@test "FR-155 schema: scope.type=garbage is a hard error" {
  write_agent_manifest "$PROJ_A" '{ "type": "garbage" }'
  run bash "$COMPILE" --project-root "$PROJ_A" --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"scope"* ]] || [[ "$output" == *"type"* ]]
}

# ===========================================================================
# TD-268: scope-aware cross-block LEAF-collision guard (merge_overlay_manifest).
#
# The merge guard's EXISTING overlay-vs-base root reservation is unchanged
# (harness_skills.test.bash pins it). TD-268 ADDS an overlay-vs-overlay (and
# any base++overlay) pairwise check whose collision unit is the emitted LEAF
# (target-root, basename(source)), gated on scope OVERLAP:
#
#   - same leaf + DISJOINT project scopes → coexist (AC1; the FR-205 fifty-kit
#     enabler — two project-scoped personal skill blocks).
#   - same leaf + OVERLAPPING scope (both global, or project paths that
#     intersect) → HARD REJECT (risk #7 genuine clobber).
#   - DIFFERENT names sharing a root (content-pipeline + doc-pipeline shape) →
#     coexist (back-compat must-not-regress — the live overlay).
#
# Tested directly against `merge_overlay_manifest` (no `skills` binary), per the
# harness_skills.test.bash precedent. §18.1 twin: scopesOverlap /
# skillBlocksCollide in cli/src/verbs/loadout.ts (harness-registry.test.ts).
# ===========================================================================

COMMON_SH() { echo "$ADAPTERS/_common.sh"; }

write_base_empty() {
  cat > "$1/base.json" <<'EOF'
{ "version": 1, "agents": [] }
EOF
}

@test "TD-268 merge: same-leaf blocks on DISJOINT project scopes coexist (exit 0)" {
  write_base_empty "$PROJ_A"
  cat > "$PROJ_A/overlay.json" <<EOF
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "scope": { "type": "project", "paths": ["$PROJ_A"] },
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] },
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "scope": { "type": "project", "paths": ["$PROJ_B"] },
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] }
  ] } }
EOF
  run bash -c "source '$(COMMON_SH)' && merge_overlay_manifest '$PROJ_A/base.json' '$PROJ_A/overlay.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"fifty-kit"* ]]
  # Both blocks survive the merge (no rejection, no silent drop).
  [ "$(printf '%s' "$output" | grep -o 'fifty-kit' | wc -l | tr -d ' ')" -ge 2 ]
}

@test "TD-268 merge: same-leaf blocks both GLOBAL (overlapping) → hard reject" {
  write_base_empty "$PROJ_A"
  cat > "$PROJ_A/overlay.json" <<EOF
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] },
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] }
  ] } }
EOF
  run bash -c "source '$(COMMON_SH)' && merge_overlay_manifest '$PROJ_A/base.json' '$PROJ_A/overlay.json'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* ]]
}

@test "TD-268 merge: same-leaf blocks with INTERSECTING project scopes → hard reject" {
  write_base_empty "$PROJ_A"
  cat > "$PROJ_A/overlay.json" <<EOF
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "scope": { "type": "project", "paths": ["$PROJ_A"] },
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] },
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/fifty-kit", "layer": "personal",
      "scope": { "type": "project", "paths": ["$PROJ_A", "$PROJ_B"] },
      "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] }
  ] } }
EOF
  run bash -c "source '$(COMMON_SH)' && merge_overlay_manifest '$PROJ_A/base.json' '$PROJ_A/overlay.json'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* ]]
}

@test "TD-268 merge: DIFFERENT-name global blocks sharing a root coexist (back-compat)" {
  # content-pipeline + doc-pipeline shape — distinct names → distinct leaves →
  # NO collision even though both are global and share all three roots. This is
  # the live overlay; a literal root-overlap predicate would wrongly reject it.
  write_base_empty "$PROJ_A"
  cat > "$PROJ_A/overlay.json" <<EOF
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/content-pipeline", "layer": "personal",
      "targets": [
        { "type": "claude", "method": "symlink", "path": "~/.claude/skills" },
        { "type": "agents", "method": "symlink", "path": "~/.agents/skills" },
        { "type": "opencode", "method": "command", "path": "~/.config/opencode/command" } ] },
    { "source": "$IGRIS_BRAIN_DIR/loadout/skills/doc-pipeline", "layer": "personal",
      "targets": [
        { "type": "claude", "method": "symlink", "path": "~/.claude/skills" },
        { "type": "agents", "method": "symlink", "path": "~/.agents/skills" },
        { "type": "opencode", "method": "command", "path": "~/.config/opencode/command" } ] }
  ] } }
EOF
  run bash -c "source '$(COMMON_SH)' && merge_overlay_manifest '$PROJ_A/base.json' '$PROJ_A/overlay.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"content-pipeline"* ]]
  [[ "$output" == *"doc-pipeline"* ]]
}

# ---------------------------------------------------------------------------
# TD-268 AC2: compile-dispatch scoping. A project-scoped skills block dispatches
# the `skills` delegate ONLY when compiled from its own --project-root, and is
# silently filtered (NO dispatch) elsewhere. Asserted at DISPATCH granularity
# (the delegate is stubbed so no real `skills` binary / $HOME is touched), NOT
# at physical-file granularity (global `skills add -g` placement can't satisfy
# physical absence — see the plan's AC2 sub-decision).
# ---------------------------------------------------------------------------

@test "TD-268 dispatch: project-scoped block dispatches under its own root, absent elsewhere" {
  local stub="$TEST_TEMP_DIR/cli_stub_$BATS_TEST_NUMBER.sh"
  local calllog="$TEST_TEMP_DIR/dispatch_$BATS_TEST_NUMBER.log"
  cat > "$stub" <<EOF
#!/bin/bash
echo "\$@" >> "$calllog"
exit 0
EOF
  chmod +x "$stub"
  export IGRIS_CLI="bash $stub"

  # Same PROJ_A-scoped skills block written into BOTH project manifests; the
  # only variable is which --project-root we compile from.
  write_skills_manifest "$PROJ_A" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"
  write_skills_manifest "$PROJ_B" "{ \"type\": \"project\", \"paths\": [\"$PROJ_A\"] }"

  # Compile from PROJ_A (its own root): block survives the filter → dispatched.
  : > "$calllog"
  run bash "$COMPILE" --project-root "$PROJ_A"
  [ "$status" -eq 0 ]
  grep -q "project-skills" "$calllog"

  # Compile from PROJ_B (other root): PROJ_A-scoped block is filtered → NO
  # dispatch (AC2 "absent elsewhere" at dispatch granularity).
  : > "$calllog"
  run bash "$COMPILE" --project-root "$PROJ_B"
  [ "$status" -eq 0 ]
  ! grep -q "project-skills" "$calllog"

  unset IGRIS_CLI
}
