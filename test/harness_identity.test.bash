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
  # FR-180 Phase 5: the empty-match line now enumerates `hook` too
  # (No agent/skills/mcp/identity/hook targets matched). Match on the stable
  # head + tail so the assertion is robust to the surface list growing.
  [[ "$output" == *"No agent/skills/mcp/identity"* ]]
  [[ "$output" == *"targets matched"* ]]
  [ ! -f "$PROJ/GEMINI.md" ]
  run run_drift
  [ "$status" -eq 0 ]
  # No per-row identity VERDICT was emitted (the `[identity/<harness>]` bracket
  # prefix is the verdict row — distinct from the `identity/hook` substring the
  # empty-match summary line now carries).
  [[ "$output" != *"[identity/"* ]]
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

# --- 6b. FR-180 (D6): personal overlay os_identity blocks MERGE + project -----

@test "FR-180 D6: a personal overlay os_identity block projects alongside the core block" {
  # The base manifest carries the core identity (gemini→GEMINI.md). A personal
  # OVERLAY adds a SECOND identity block (codex→AGENTS.md). Before D6 the overlay
  # block was 'accepted but NOT merged'; after D6 merge_overlay_manifest unions
  # it, so BOTH project. (The base manifest already targets codex/AGENTS.md, so
  # the overlay uses a DISTINCT (type, filename) to avoid the collision guard.)
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
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  OVERLAY="$ISOLATED_BRAIN/registry/harness-manifest.personal.json"
  cat > "$OVERLAY" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "layer": "personal",
        "source": "tmpl/identity.tmpl",
        "version_source": "version.json",
        "scope": { "type": "project", "paths": ["."] },
        "targets": [
          { "type": "codex", "method": "file", "filename": "AGENTS.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity --overlay "$OVERLAY"
  [ "$status" -eq 0 ]
  # BOTH the core (gemini) and the personal (codex) regions are projected.
  [ -f "$PROJ/GEMINI.md" ]
  [ -f "$PROJ/AGENTS.md" ]
  grep -qF 'You ARE Igris AI. Not Gemini CLI using Igris AI.' "$PROJ/GEMINI.md"
  grep -qF 'You ARE Igris AI. Not Codex using Igris AI.' "$PROJ/AGENTS.md"
  # Drift-clean for both after compile.
  run run_drift --overlay "$OVERLAY"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
}

@test "FR-180 D6: a personal identity target colliding with a core one is a HARD merge error" {
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
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  OVERLAY="$ISOLATED_BRAIN/registry/harness-manifest.personal.json"
  # The overlay reuses the SAME (gemini, GEMINI.md) pair → must hard-fail.
  cat > "$OVERLAY" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "layer": "personal",
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity --overlay "$OVERLAY"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides between surfaces.os_identity"* ]]
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

# --- 10. TD-244 (BI-3): delegation-mechanism boot-injection surface ------------
#
# A per-harness `harnesses.<type>.delegation_model` (native-static |
# dynamic-define) gates whether the compile identity pass appends the canonical
# delegation recipe (the companion template alongside identity.tmpl) to a
# harness's identity region. The drift pass re-derives the SAME recipe-carrying
# region (§17 paired branch). The recipe is keyed by the identity target's
# `type`, so a dynamic-define harness gets it while a native-static one stays
# recipe-free — the §6 "no recipe leaks to Codex" guardrail.

# Manifest with a harnesses map: gemini=dynamic-define, codex=native-static.
write_manifest_with_delegation() {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "harnesses": {
    "gemini": { "delegation_model": "dynamic-define" },
    "codex": { "delegation_model": "native-static" }
  },
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
  # The companion recipe template lives alongside the identity template.
  cat > "$PROJ/tmpl/delegation-recipe.tmpl" <<'EOF'
## Delegation Mechanism (dynamic-define harness)

To delegate to role X: read ~/.igris/core/agents/<role>.md, define_subagent with
its body + tool scope, then invoke_subagent.
EOF
}

@test "TD-244: compile injects the delegation recipe into the dynamic-define harness only" {
  write_manifest_with_delegation
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  # gemini (dynamic-define) carries the recipe inside its region.
  grep -qF '## Delegation Mechanism (dynamic-define harness)' "$PROJ/GEMINI.md"
  grep -qF 'define_subagent' "$PROJ/GEMINI.md"
  # The recipe sits BETWEEN the identity body and the END marker.
  grep -qF 'You ARE Igris AI. Not Gemini CLI using Igris AI.' "$PROJ/GEMINI.md"
  # codex (native-static) stays recipe-free (the §6 no-leak guardrail).
  ! grep -q 'Delegation Mechanism' "$PROJ/AGENTS.md"
  ! grep -q 'define_subagent' "$PROJ/AGENTS.md"
  grep -qF 'You ARE Igris AI. Not Codex using Igris AI.' "$PROJ/AGENTS.md"
}

@test "TD-244: compile && drift → recipe-carrying region MATCHes (paired drift branch)" {
  write_manifest_with_delegation
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}

@test "TD-244: stripping the recipe from a dynamic-define region surfaces as DRIFTED" {
  write_manifest_with_delegation
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  # Hand-strip the recipe lines but keep the identity body + markers — a
  # native-static-shaped region for a dynamic-define harness must DRIFT.
  python3 - "$PROJ/GEMINI.md" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().splitlines(keepends=True)
out = []
for ln in lines:
    if "Delegation Mechanism" in ln or "define_subagent" in ln or "delegate to role" in ln:
        continue
    out.append(ln)
open(p, "w").write("".join(out))
PY
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[identity/gemini] DRIFTED"* ]]
  # Recompile heals it.
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
}

@test "TD-244: a dynamic-define harness with a MISSING recipe template FAILs (never silent)" {
  write_manifest_with_delegation
  rm "$PROJ/tmpl/delegation-recipe.tmpl"
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL  identity/gemini"* ]]
  [[ "$output" == *"delegation recipe template missing"* ]]
}

@test "TD-244: absent harnesses map → identity-only (back-compat, no recipe)" {
  # The default setup() manifest has NO harnesses map. Both targets default to
  # native-static → identity-only regions, byte-stable with pre-TD-244 output.
  run run_compile --surface identity
  [ "$status" -eq 0 ]
  ! grep -q 'Delegation Mechanism' "$PROJ/GEMINI.md"
  ! grep -q 'Delegation Mechanism' "$PROJ/AGENTS.md"
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[identity/gemini] MATCH"* ]]
  [[ "$output" == *"[identity/codex] MATCH"* ]]
}

@test "TD-244: schema rejects an unknown delegation_model value" {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "harnesses": {
    "gemini": { "delegation_model": "bogus-model" }
  },
  "agents": [],
  "surfaces": {
    "os_identity": [
      {
        "source": "tmpl/identity.tmpl",
        "version_source": "version.json",
        "targets": [
          { "type": "gemini", "method": "file", "filename": "GEMINI.md" }
        ]
      }
    ]
  }
}
EOF
  run run_compile --surface identity
  [ "$status" -ne 0 ]
  [[ "$output" == *"alidation failed"* ]] || [[ "$output" == *"delegation_model"* ]]
}

# --- 10b. TD-244 §18.1 bash↔TS golden parity (dynamic-define) -----------------

@test "TD-244: normalize_identity_shape dynamic-define on the REAL canonical byte-equals the TS golden" {
  real_tmpl="$IGRIS_ROOT/core/templates/identity.tmpl"
  real_recipe="$IGRIS_ROOT/core/templates/delegation-recipe.tmpl"
  golden="$IGRIS_ROOT/cli/src/__tests__/fixtures/td244-identity-golden-gemini-dynamic.md"
  [ -f "$real_tmpl" ] || skip "repo canonical identity.tmpl missing"
  [ -f "$real_recipe" ] || skip "repo canonical delegation-recipe.tmpl missing"
  [ -f "$golden" ] || skip "golden fixture missing: $golden"
  actual_file="$BATS_TEST_TMPDIR/td244-actual-gemini-dynamic.md"
  bash -c "source '$COMMON' >/dev/null 2>&1; normalize_identity_shape '$real_tmpl' gemini 9.9.9 dynamic-define '$real_recipe'" > "$actual_file"
  # byte-compare vs the committed golden — cmp catches a trailing-newline-only
  # divergence that command substitution would silently strip (m1, TD-244 warden).
  if ! cmp -s "$actual_file" "$golden"; then
    echo "PARITY MISMATCH (dynamic-define gemini) — byte-compare vs golden" >&2
    diff "$golden" "$actual_file" >&2 || true
    return 1
  fi
}
