#!/usr/bin/env bats

# harness_identity.test.bash - Tests for the TD-233 orchestrator-identity
# surface (GAP-3 remediation).
#
# TD-233 adds `surfaces.os_identity` as the 5th first-class manifest surface:
# ONE canonical identity template (core/templates/identity.tmpl, Model A —
# "the agent IS Igris AI") projected into each harness's natively auto-read
# project-root context file (gemini → GEMINI.md, codex → AGENTS.md;
# empirically confirmed 2026-06-10) as an Igris-managed delimited region.
# Pre-existing user content in those files is PRESERVED (the locked
# merge-into-region clobber posture); drift checks ONLY the region.
#
# Coverage:
#   1. compile emits the correct file per harness with the rendered Model-A
#      region; reword correctness (gemini says "Not Gemini CLI…", codex
#      "Not Codex…", neither says "Claude"); {{IGRIS_VERSION}} substituted.
#   2. compile && drift → identity rows MATCH (drift-clean); re-compile is
#      idempotent ("unchanged", bytes stable).
#   3. DRIFTED: hand-edited region → drift names the harness; recompile heals.
#   4. MISSING: deleted file → drift MISSING; file without a region → MISSING
#      (region absent); compile injects the region, user content preserved.
#   5. merge posture: pre-existing user content survives byte-for-byte around
#      the region; corrupt region (BEGIN without END) → compile FAILs the row
#      and leaves the file untouched; drift reports DRIFTED.
#   6. scope skip: a project-scoped block not matching --project-root is a
#      SILENT skip (no file, no row, exit 0) for both compile and drift.
#   7. version resolution: version_source missing/key-less → observable FAIL
#      (compile) / DRIFTED (drift); default falls back to <brain>/config.json.
#   8. §18.1 parity: bash normalize_identity_shape output for the REAL repo
#      canonical byte-equals the TS golden fixtures
#      (cli/src/__tests__/fixtures/td233-identity-golden-*.md), which
#      identity-shape.test.ts re-derives via buildHarnessIdentityFile.
#   9. surface isolation: --surface agents does not run the identity pass;
#      --surface identity does not run the agent pass.
#
# Isolation: a sandboxed project dir + IGRIS_BRAIN_DIR so the default
# template/config fallbacks never touch the live machine state.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  # Isolate the brain dir so the default overlay/config/template fallbacks
  # never read the live ~/.igris.
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN/registry"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/identity_proj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"

  # The project-owned canonical identity template + version source.
  mkdir -p "$PROJ/tmpl"
  cat > "$PROJ/tmpl/identity.tmpl" <<'EOF'
## Identity
Igris AI v{{IGRIS_VERSION}} — AI-powered engineering OS, developed by fifty.dev.
You ARE Igris AI. Not {{HARNESS_SELF_NAME}} using Igris AI.
EOF
  printf '{ "version": "3.1.4" }\n' > "$PROJ/version.json"

  write_manifest
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# Project-OWNED base manifest declaring one identity block, 2 targets
# (project-root-relative filenames — the confirmed v1 map).
write_manifest() {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "version_source": "version.json",
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" },
          { "type": "codex",  "method": "file", "filename": "AGENTS.md" }
        ]
      }
    ]
  }
}
EOF
}

# Run compile against the sandbox. --overlay '' suppresses the live personal
# overlay (IGRIS_BRAIN_DIR isolation already points discovery at the sandbox
# registry, which is empty — belt and suspenders).
run_compile() {
  bash "$COMPILE" --project-root "$PROJ" "$@"
}

run_drift() {
  bash "$GUARD" --project-root "$PROJ" "$@"
}

# --- 1. compile emits the right file per harness ----------------------------

@test "compile --surface identity writes GEMINI.md + AGENTS.md with the rendered Model-A region" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [ -f "$PROJ/GEMINI.md" ]
  [ -f "$PROJ/AGENTS.md" ]
  grep -q '^<!-- IGRIS:OS_IDENTITY:BEGIN' "$PROJ/GEMINI.md"
  grep -qF '<!-- IGRIS:OS_IDENTITY:END -->' "$PROJ/GEMINI.md"
  grep -qF 'You ARE Igris AI. Not Gemini CLI using Igris AI.' "$PROJ/GEMINI.md"
  grep -qF 'You ARE Igris AI. Not Codex using Igris AI.' "$PROJ/AGENTS.md"
  # {{IGRIS_VERSION}} resolved from version.json.
  grep -qF 'Igris AI v3.1.4' "$PROJ/GEMINI.md"
  grep -qF 'Igris AI v3.1.4' "$PROJ/AGENTS.md"
  # No unresolved tokens leak.
  ! grep -q '{{' "$PROJ/GEMINI.md"
  ! grep -q '{{' "$PROJ/AGENTS.md"
}

@test "Model-A reword: neither non-Claude identity file ever says 'Claude'" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  ! grep -q 'Claude' "$PROJ/GEMINI.md"
  ! grep -q 'Claude' "$PROJ/AGENTS.md"
}

@test "compile --target gemini emits only GEMINI.md" {
  run run_compile --surface identity --target gemini
  [ "$status" -eq 0 ]
  [ -f "$PROJ/GEMINI.md" ]
  [ ! -f "$PROJ/AGENTS.md" ]
}

# --- 2. drift-clean-after-compile + idempotency -----------------------------

@test "compile && drift → identity rows MATCH (drift-clean)" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
  [[ "$output" != *"DRIFTED"* ]]
  [[ "$output" != *"MISSING"* ]]
}

@test "re-compile is idempotent: 'unchanged' and bytes stable" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  before_g="$(cat "$PROJ/GEMINI.md")"
  before_a="$(cat "$PROJ/AGENTS.md")"
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [[ "$output" == *"identity/gemini -> GEMINI.md (unchanged)"* ]]
  [[ "$output" == *"identity/codex -> AGENTS.md (unchanged)"* ]]
  [ "$(cat "$PROJ/GEMINI.md")" = "$before_g" ]
  [ "$(cat "$PROJ/AGENTS.md")" = "$before_a" ]
}

# --- 3. DRIFTED ---------------------------------------------------------------

@test "hand-edited region → drift DRIFTED naming the harness; recompile heals" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  python3 - "$PROJ/GEMINI.md" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, "w").write(s.replace("You ARE Igris AI", "You might be Igris"))
PY
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] DRIFTED"* ]]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
}

@test "version bump in version_source → drift DRIFTED until recompile" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  printf '{ "version": "3.2.0" }\n' > "$PROJ/version.json"
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] DRIFTED"* ]]
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  grep -qF 'Igris AI v3.2.0' "$PROJ/GEMINI.md"
  run run_drift
  [ "$status" -eq 0 ]
}

# --- 4. MISSING ---------------------------------------------------------------

@test "deleted identity file → drift MISSING; file without region → MISSING (region absent)" {
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  rm "$PROJ/GEMINI.md"
  printf '# My own AGENTS notes\nno markers here\n' > "$PROJ/AGENTS.md"
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] MISSING"* ]]
  [[ "$output" == *"identity file absent"* ]]
  [[ "$output" == *"[identity/codex] MISSING"* ]]
  [[ "$output" == *"no Igris identity region"* ]]
}

# --- 5. merge posture (the locked clobber decision) --------------------------

@test "pre-existing user content survives byte-for-byte; region is appended" {
  cat > "$PROJ/AGENTS.md" <<'EOF'
# My hand-written Codex notes

Use tabs, not spaces. Trust no one.
EOF
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [[ "$output" == *"identity/codex -> AGENTS.md (appended)"* ]]
  # User content intact, region present after it.
  head -3 "$PROJ/AGENTS.md" | grep -qF '# My hand-written Codex notes'
  grep -qF 'Use tabs, not spaces. Trust no one.' "$PROJ/AGENTS.md"
  grep -qF 'You ARE Igris AI. Not Codex using Igris AI.' "$PROJ/AGENTS.md"
  # Drift-clean: only the region is Igris-owned.
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
  # Recompile after a canonical change updates ONLY the region.
  printf '{ "version": "9.0.0" }\n' > "$PROJ/version.json"
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [[ "$output" == *"identity/codex -> AGENTS.md (updated)"* ]]
  head -3 "$PROJ/AGENTS.md" | grep -qF '# My hand-written Codex notes'
  grep -qF 'Igris AI v9.0.0' "$PROJ/AGENTS.md"
}

@test "corrupt region (BEGIN without END) → compile FAILs the row, file untouched; drift DRIFTED" {
  cat > "$PROJ/GEMINI.md" <<'EOF'
<!-- IGRIS:OS_IDENTITY:BEGIN (Igris-managed identity region — edit core/templates/identity.tmpl, then run 'igris harness compile'; see TD-233) -->
## Identity
someone deleted the END marker
EOF
  before="$(cat "$PROJ/GEMINI.md")"
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL  identity/gemini"* ]]
  [[ "$output" == *"corrupt"* ]]
  [ "$(cat "$PROJ/GEMINI.md")" = "$before" ]
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] DRIFTED"* ]]
  [[ "$output" == *"BEGIN marker without END"* ]]
}

@test "no .tmp-* litter beside the identity files after compile" {
  printf 'user content\n' > "$PROJ/GEMINI.md"
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  run bash -c "ls \"$PROJ\" | grep -c '\.tmp-'"
  [ "$output" = "0" ]
}

# --- 6. scope skip ------------------------------------------------------------

@test "project-scoped block not matching --project-root is a SILENT skip (compile + drift)" {
  other="$TEST_TEMP_DIR/other_project_$BATS_TEST_NUMBER"
  mkdir -p "$other"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "version_source": "version.json",
        "scope": { "type": "project", "paths": ["$other"] },
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [[ "$output" == *"No agent/skills/mcp/identity targets matched"* ]]
  [ ! -f "$PROJ/GEMINI.md" ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" != *"identity/"* ]]
}

@test "project-scoped block matching --project-root emits normally" {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "version_source": "version.json",
        "scope": { "type": "project", "paths": ["."] },
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  [ -f "$PROJ/GEMINI.md" ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
}

# --- 7. version resolution -----------------------------------------------------

@test "missing version_source file → observable compile FAIL + drift DRIFTED (never silent)" {
  rm "$PROJ/version.json"
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL  identity/gemini"* ]]
  [[ "$output" == *'cannot resolve {{IGRIS_VERSION}}'* ]]
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] DRIFTED"* ]]
  [[ "$output" == *'cannot resolve {{IGRIS_VERSION}}'* ]]
}

@test "absent version_source falls back to <brain>/config.json" {
  printf '{ "version": "5.5.5" }\n' > "$ISOLATED_BRAIN/config.json"
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  grep -qF 'Igris AI v5.5.5' "$PROJ/GEMINI.md"
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
}

@test "absent source falls back to <brain>/core/templates/identity.tmpl" {
  mkdir -p "$ISOLATED_BRAIN/core/templates"
  cp "$PROJ/tmpl/identity.tmpl" "$ISOLATED_BRAIN/core/templates/identity.tmpl"
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "version_source": "version.json",
        "targets": [
          { "type": "codex", "method": "file", "filename": "AGENTS.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  grep -qF 'You ARE Igris AI. Not Codex using Igris AI.' "$PROJ/AGENTS.md"
}

@test "missing canonical template → observable compile FAIL naming the path" {
  rm "$PROJ/tmpl/identity.tmpl"
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"canonical identity template missing"* ]]
}

# --- 8. §18.1 bash↔TS golden parity ------------------------------------------

@test "normalize_identity_shape on the REAL repo canonical byte-equals the TS golden fixtures" {
  real_tmpl="$IGRIS_ROOT/core/templates/identity.tmpl"
  [ -f "$real_tmpl" ] || skip "repo canonical identity.tmpl missing"
  for h in gemini codex; do
    golden="$IGRIS_ROOT/cli/src/__tests__/fixtures/td233-identity-golden-$h.md"
    [ -f "$golden" ] || skip "golden fixture missing: $golden"
    actual=$(bash -c "source '$COMMON' >/dev/null 2>&1; normalize_identity_shape '$real_tmpl' '$h' 9.9.9")
    expected=$(cat "$golden")
    if [ "$actual" != "$expected" ]; then
      echo "PARITY MISMATCH for $h" >&2
      echo "--- bash ---" >&2
      echo "$actual" >&2
      echo "--- golden (TS buildHarnessIdentityFile pins the same bytes) ---" >&2
      echo "$expected" >&2
      return 1
    fi
  done
}

# --- 9. surface isolation ------------------------------------------------------

@test "--surface agents does not run the identity pass" {
  run run_compile --surface agents
  [ "$status" -eq 0 ]
  [ ! -f "$PROJ/GEMINI.md" ]
  [ ! -f "$PROJ/AGENTS.md" ]
}

@test "schema validation rejects a bad identity target pair (method != file)" {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "targets": [
          { "type": "gemini", "method": "symlink", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"alidation failed"* ]] || [[ "$output" == *"must be 'file'"* ]]
}
