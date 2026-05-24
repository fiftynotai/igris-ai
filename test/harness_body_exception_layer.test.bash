#!/usr/bin/env bats

# harness_body_exception_layer.test.bash - Tests for FR-144 layer-keyed
# body-exception sidecar resolution in BOTH harness adapters
# (compile_harnesses.sh + check_harness_drift.sh).
#
# FR-144 relocates the Layer-2 personal body-exception sidecar OUT of the
# public repo (core/scripts/cli-adapters/body-exceptions/) into the runtime
# registry (<brain>/registry/body-exceptions/), and teaches both adapters to
# resolve a `layer:"personal"` agent's body_exception from the registry while
# core agents keep resolving from the in-repo dir. Resolution is LAYER-KEYED,
# not a fallback — a re-introduced repo sidecar must never serve a personal
# agent (the L-498 leak this brief closes).
#
# These tests drive the REAL adapters (L-159: never a mock) against a
# self-contained temp project, with IGRIS_BRAIN_DIR scoped to a per-test dir so
# the registry resolution is deterministic and machine-independent. The real
# content-designer agent is not registered in an overlay until FR-146, so a
# FIXTURE personal agent isolates exactly the FR-144 seam.
#
#   A — personal agent resolves its sidecar from the REGISTRY dir
#       (compile renders the inserted paragraph; drift exits 0, MATCH).
#   B — core agent still resolves its sidecar from the IN-REPO dir
#       (regression guard: the new branch did not redirect core sidecars).
#   C — personal sidecar absent from the registry is a hard FAIL/MISSING that
#       names the REGISTRY path (proving the personal branch was taken).
#   D — IGRIS_BRAIN_DIR is honored (moving the seam moves where the sidecar is
#       sought) — folded into A via the per-test brain dir.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -x "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -x "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  PROJ="$TEST_TEMP_DIR/be_layer_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  # IGRIS_BRAIN_DIR seam scoped to a per-test dir. The personal-sidecar branch
  # resolves <brain>/registry/body-exceptions/<name>.json, so this directly
  # exercises Scenario D (honoring the seam) for every personal-agent test.
  export IGRIS_BRAIN_DIR="$PROJ/brain"
  REGISTRY_BE="$IGRIS_BRAIN_DIR/registry/body-exceptions"
  mkdir -p "$REGISTRY_BE"

  # A canonical agent prompt with a UNIQUE anchor line the sidecar targets.
  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

This is the canonical body. The next line is the unique body-exception anchor.

ANCHOR-LINE-FOR-BODY-EXCEPTION

- rule one
- rule two
EOF

  # FR-152: claude target is a registry-anchored symlink the compiler creates
  # at compile time. The FR-149-era pre-authored real harness file is now an
  # error (refuse-to-clobber); we just leave the target dir empty.
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# write_personal_manifest <body_exception-name>
write_personal_manifest() {
  local be="$1"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "layer": "personal",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "body_exception": "$be",
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
}

# write_core_manifest <body_exception-name>
write_core_manifest() {
  local be="$1"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "layer": "core",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "body_exception": "$be",
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
}

# write_sidecar <abs-json-path>
# A valid {anchor, insert} sidecar whose anchor matches the canonical line.
write_sidecar() {
  cat > "$1" <<'EOF'
{
  "anchor": "ANCHOR-LINE-FOR-BODY-EXCEPTION",
  "insert": [
    "",
    "INSERTED-PERSONAL-PARAGRAPH from the runtime registry sidecar."
  ]
}
EOF
}

@test "A: personal agent resolves sidecar from the registry dir (compile renders, drift MATCH)" {
  write_personal_manifest "para-fixture"
  write_sidecar "$REGISTRY_BE/para-fixture.json"

  # Compile drives the REAL adapter; the inserted paragraph must land in the
  # generated harness body, proving the personal branch resolved the registry
  # sidecar (under the per-test IGRIS_BRAIN_DIR — Scenario D).
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK    sample/claude"* ]]
  assert_file_contains "$PROJ/.claude/agents/sample.md" \
    "INSERTED-PERSONAL-PARAGRAPH from the runtime registry sidecar."

  # Drift must see the rendered one-paragraph exception as in-sync (AC-3).
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" == *"1 targets — 1 in sync, 0 drifted/missing"* ]]
}

@test "B: core agent still resolves sidecar from the in-repo dir (regression guard)" {
  # A core-layer agent whose sidecar lives ONLY in the in-repo body-exceptions
  # dir (NOT the registry). Proves the new personal branch did not redirect
  # core sidecars and the unchanged else-branch still works.
  write_core_manifest "core-fixture"
  local repo_be="$PROJ/core/scripts/cli-adapters/body-exceptions"
  mkdir -p "$repo_be"
  write_sidecar "$repo_be/core-fixture.json"

  # The adapter resolves $ADAPTER_DIR/body-exceptions/ — i.e. relative to where
  # the *.sh live. Copy the real adapters into the temp project so ADAPTER_DIR
  # points at the temp project's in-repo body-exceptions dir.
  cp "$ADAPTERS"/*.sh "$PROJ/core/scripts/cli-adapters/"

  # Deliberately leave the registry EMPTY so a (wrong) personal-branch lookup
  # would FAIL — only the in-repo resolution can succeed here.
  run bash "$PROJ/core/scripts/cli-adapters/compile_harnesses.sh" \
    --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK    sample/claude"* ]]
  assert_file_contains "$PROJ/.claude/agents/sample.md" \
    "INSERTED-PERSONAL-PARAGRAPH from the runtime registry sidecar."

  run bash "$PROJ/core/scripts/cli-adapters/check_harness_drift.sh" \
    --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
}

@test "C: personal sidecar absent from registry is a hard FAIL/MISSING naming the registry path" {
  # No ghost.json anywhere. The error MUST name the registry path (proving the
  # personal branch was taken), not the in-repo path, and stay a hard failure.
  write_personal_manifest "ghost"

  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 1 ]
  [[ "$output" == *"body-exception sidecar missing"* ]]
  [[ "$output" == *"$REGISTRY_BE/ghost.json"* ]]
  # NOT the in-repo path.
  [[ "$output" != *"$ADAPTERS/body-exceptions/ghost.json"* ]]

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  [[ "$output" == *"body-exception sidecar absent"* ]]
  [[ "$output" == *"$REGISTRY_BE/ghost.json"* ]]
}
