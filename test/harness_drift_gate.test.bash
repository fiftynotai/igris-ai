#!/usr/bin/env bats

# harness_drift_gate.test.bash - Tests for the FR-135 harness drift gate.
#
# FR-135 wires the TD-021 drift guard (core/scripts/cli-adapters/
# check_harness_drift.sh) into the quality gates. These tests exercise the
# guard's three load-bearing verdicts against a self-contained temp project,
# built with the real adapters (compile_harnesses.sh) so the fixtures are
# byte-identical to what the production path produces:
#
#   1. DRIFTED      — a mutated harness body -> guard exits 1, report DRIFTED.
#   2. MATCH        — freshly compiled, in-sync harness -> guard exits 0.
#   3. MISSING      — generated harness never compiled -> guard exits 1, with
#                     a "MISSING" verdict (NOT a false "DRIFTED"); the wrapper
#                     surfaces a compile hint.
#
# We drive the CLAUDE target type (a .md whose body sha is compared) because
# it is self-contained — codex targets require the D1-gated emitter. The
# guard's MATCH/DRIFTED/MISSING logic is target-type-agnostic, so the claude
# path fully exercises the verdict machinery FR-135 depends on.
#
# The wrapper (scripts/validate_harness_drift.sh) scopes the strict guard:
# DRIFTED is always fatal (exit 1); MISSING is fatal for PROJECT-RELATIVE
# targets (FR-138 flipped this back from the FR-135 STOPGAP, now that codex is
# un-gated and compiled), but a MISSING home/absolute-path target (e.g. the
# gemini ~/.gemini/commands skills surface) is an out-of-scope NOTICE (exit 0).
# The wrapper-level tests below build a synthetic git repo whose manifest uses a
# core-agent name (`forger`) with a project-relative claude target, plus one
# test that injects a home-path gemini skills target to exercise the scoping.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  WRAPPER="$IGRIS_ROOT/scripts/validate_harness_drift.sh"

  [ -x "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  [ -x "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  require_python3

  # Isolate from the live brain dir so the guard/compile do NOT
  # auto-discover the user's personal overlay manifest at
  # ~/.igris/loadout/harness-manifest.personal.json (FR-146 leaves this in
  # place between runs; without isolation it merges into every test's
  # manifest and breaks synthetic-root tests).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  # Per-test scratch project root. FR-152: the claude target is a SYMLINK that
  # the compiler creates atomically; we don't pre-author a harness file at
  # $PROJ/.claude/agents/sample.md anymore (that was the FR-149-era Case C
  # back-compat path, retired by FR-152).
  PROJ="$TEST_TEMP_DIR/harness_drift_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  # A canonical agent prompt (frontmatter + body). The compile-time α-assembly
  # extracts the frontmatter inline (TD-195 fallback — no FR-151 sidecar
  # present) and produces a loadout-resident harness.claude.md the symlink points at.
  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

This is the canonical body. It must match the harness body exactly.

- rule one
- rule two
EOF

  # A project-local manifest declaring one claude-target agent. Canonical is
  # unversioned (a literal file), so no glob resolution is involved.
  MANIFEST="$PROJ/harness-manifest.json"
  cat > "$MANIFEST" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

@test "in-sync compiled harness yields exit 0 and MATCH" {
  # FR-152: compile creates a loadout-anchored symlink (Case A); MATCH verdict
  # is symlink containment + final-component equality against harness.claude.md.
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/agents/sample.md" ]

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" == *"loadout-anchored"* ]]
  [[ "$output" == *"1 targets — 1 in sync, 0 drifted/missing"* ]]
}

@test "drifted symlink (repointed outside loadout) yields exit 1 and DRIFTED" {
  # FR-152: replace the symlink with one pointing OUTSIDE the loadout. The
  # guard reports DRIFTED with "not loadout-anchored".
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]

  mkdir -p "$PROJ/elsewhere"
  echo "stale body" > "$PROJ/elsewhere/sample.md"
  rm -f "$PROJ/.claude/agents/sample.md"
  ln -s "$PROJ/elsewhere/sample.md" "$PROJ/.claude/agents/sample.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] DRIFTED"* ]]
  [[ "$output" == *"not loadout-anchored"* ]]
  [[ "$output" == *"1 targets — 0 in sync, 1 drifted/missing"* ]]
}

@test "never-compiled harness yields exit 1 and MISSING, not a false DRIFTED" {
  # FR-152: symlink absent (compile never ran). MISSING verdict — never
  # DRIFTED — so the operator is told to COMPILE rather than chase a phantom
  # body diff. The target dir exists but no symlink inside.
  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  [[ "$output" == *"absent"* ]]
  # Crucially NOT reported as DRIFTED.
  [[ "$output" != *"DRIFTED"* ]]
  [[ "$output" == *"1 targets — 0 in sync, 1 drifted/missing"* ]]
}

@test "wrapper exits 0 cleanly when the adapter layer is absent (fail-open)" {
  # A repo-root with no core/scripts/cli-adapters at all: the wrapper must
  # skip rather than hard-crash the commit hook on a partial checkout.
  local bare="$TEST_TEMP_DIR/bare_repo_$BATS_TEST_NUMBER"
  mkdir -p "$bare"
  ( cd "$bare" && git init -q )

  run bash -c "cd '$bare' && bash '$WRAPPER'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping drift check"* ]]
}

# ---------------------------------------------------------------------------
# Wrapper-level STOPGAP tests (FR-135). The wrapper resolves its repo root via
# `git rev-parse --show-toplevel` and looks for the guard + manifest under
# core/scripts/cli-adapters/, checking the hardcoded CORE_AGENTS list. To
# exercise its DRIFTED/MISSING/MATCH discrimination in isolation we build a
# synthetic git repo: copy the real cli-adapters in (so the guard + _common.sh
# resolve), drop in a manifest that declares ONE core-agent name (`forger`)
# with a self-contained CLAUDE target, and copy the wrapper alongside so it
# resolves the synthetic root rather than the live repo.
# ---------------------------------------------------------------------------

# build_wrapper_repo <state>  where state is: match | drifted | missing
# Echoes the synthetic repo root.
build_wrapper_repo() {
  local state="$1"
  local root="$TEST_TEMP_DIR/wrap_${state}_$BATS_TEST_NUMBER"
  mkdir -p "$root/core/scripts/cli-adapters" "$root/scripts" \
           "$root/canon" "$root/.claude/agents"
  ( cd "$root" && git init -q )

  # Real adapters (guard + compiler + helpers) so the guard runs for real.
  cp "$ADAPTERS"/*.sh "$root/core/scripts/cli-adapters/"
  # body-exceptions/ is referenced relative to the adapter dir; copy if present.
  [ -d "$ADAPTERS/body-exceptions" ] \
    && cp -R "$ADAPTERS/body-exceptions" "$root/core/scripts/cli-adapters/"

  # The wrapper under test, copied so it resolves THIS root.
  cp "$WRAPPER" "$root/scripts/validate_harness_drift.sh"

  # Canonical prompt for `forger` (a CORE_AGENTS name the wrapper checks).
  cat > "$root/canon/forger.md" <<'EOF'
---
name: forger
description: synthetic canonical for the wrapper test
---

# FORGER (synthetic)

Canonical body the harness must match.
EOF

  # Manifest at the path the wrapper expects (FR-136: repo root), declaring
  # forger -> claude.
  cat > "$root/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "forger",
      "canonical": { "dir": "canon", "file": "forger.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/forger.md" }
      ]
    }
  ]
}
EOF

  if [ "$state" = "missing" ]; then
    # No harness symlink at all -> guard reports MISSING.
    :
  else
    # FR-152: compile creates a loadout-anchored symlink (no pre-authored
    # real file). Use the synthetic repo's IGRIS_BRAIN_DIR-isolated brain so
    # the assembly lands in the test's loadout, not the live one.
    IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" \
      --project-root "$root" \
      --manifest "$root/harness-manifest.json" \
      --target claude >/dev/null
    if [ "$state" = "drifted" ]; then
      # Replace the symlink with one pointing outside the loadout — guard
      # reports DRIFTED with "not loadout-anchored".
      mkdir -p "$root/elsewhere"
      echo "stale" > "$root/elsewhere/forger.md"
      rm -f "$root/.claude/agents/forger.md"
      ln -s "$root/elsewhere/forger.md" "$root/.claude/agents/forger.md"
    fi
  fi

  echo "$root"
}

@test "wrapper: DRIFTED harness is FATAL -> exit 1" {
  local root
  root="$(build_wrapper_repo drifted)"

  run bash -c "cd '$root' && IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[forger/claude] DRIFTED"* ]]
  [[ "$output" == *"FATAL"* ]]
  # A drifted (existing-but-diverged) harness must NOT be excused as MISSING.
  [[ "$output" != *"NOTICE:"* ]]
}

@test "wrapper: project-relative MISSING harness is FATAL -> exit 1 (FR-138)" {
  # FR-138 flipped MISSING back to FATAL for PROJECT-RELATIVE targets. The
  # forger claude target is project-relative (.claude/agents/forger.md), so a
  # never-compiled (absent) harness now hard-fails the gate — it means "you
  # forgot to compile", not "gated and not built yet".
  local root
  root="$(build_wrapper_repo missing)"

  run bash -c "cd '$root' && IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[forger/claude] MISSING"* ]]
  [[ "$output" == *"FATAL"* ]]
  [[ "$output" == *"project-relative"* ]]
  [[ "$output" == *"forgot to compile"* ]]
  # The old STOPGAP NOTICE language must be gone.
  [[ "$output" != *"STOPGAP"* ]]
}

@test "wrapper: home-path MISSING target does NOT hard-fail the gate (FR-138 scoping)" {
  # The dominant FR-138 risk: the guard checks every declared target, and
  # home-anchored targets (e.g. ~/.gemini/agents/*.md) are MISSING on any
  # machine that never projected them; that must NOT hard-fail the commit
  # gate — it is out of the gate's scope. Build a repo whose project-relative
  # agent is in sync (MATCH) and whose ONLY MISSING verdict is a home-path
  # agent target.
  #
  # TD-434 (2026-08-31): the original fixture injected a skills surface with a
  # `gemini` converter target — a shape the surfaces schema has since RETIRED
  # (enum is now agents/claude/opencode), so validate_manifest refused the
  # manifest and the wrapper fail-opened (exit 0, ZERO verdicts). Every
  # assertion here except the final `!= *FATAL*` was a non-final bare [[ ]] —
  # vacuous under Bats >= 1.12 (TD-341's class) — which is how a dead fixture
  # stayed "green" on dev machines while ubuntu's bats 1.10 failed it armed
  # (run 33404539413). Re-pinned on a home-anchored AGENT target (the same
  # class the real repo's NOTICE names), under a sandboxed HOME so the target
  # is deterministically MISSING.
  local root
  root="$(build_wrapper_repo match)"

  python3 - "$root/harness-manifest.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    m = json.load(fh)
m["agents"][0]["targets"].append(
    {"type": "gemini", "path": "~/.gemini/agents/forger.md"}
)
with open(path, "w", encoding="utf-8") as fh:
    json.dump(m, fh, indent=2)
PY
  local sandbox_home="$TEST_TEMP_DIR/wrap_home_$BATS_TEST_NUMBER"
  mkdir -p "$sandbox_home"

  run bash -c "cd '$root' && HOME='$sandbox_home' IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' bash scripts/validate_harness_drift.sh"
  echo "status=$status output: $output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"[forger/claude] MATCH"* ]] || return 1
  # The home-path gemini agent target is reported MISSING by the guard...
  [[ "$output" == *"[forger/gemini] MISSING"* ]] || return 1
  # ...but the wrapper classifies it OUT OF SCOPE: NOTICE, never FATAL.
  [[ "$output" == *"NOTICE:"* ]] || return 1
  [[ "$output" == *"out-of-scope"* ]] || return 1
  [[ "$output" != *"FATAL"* ]] || return 1
}

@test "wrapper: all-MATCH compiled harness -> exit 0, no NOTICE, no FATAL" {
  local root
  root="$(build_wrapper_repo match)"

  run bash -c "cd '$root' && IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[forger/claude] MATCH"* ]]
  [[ "$output" != *"NOTICE:"* ]]
  [[ "$output" != *"FATAL"* ]]
}

# ---------------------------------------------------------------------------
# TD-193: ttype-gated body_exception in the drift verifier.
#
# `compile_harnesses.sh` only routes the body-exception sidecar into the
# claude adapter — the codex emitter writes the plain canonical body via
# strip_frontmatter (no appendix). The drift verifier used to apply the
# appendix unconditionally, which produced a false-DRIFTED (body sha
# mismatch) for any agent that combined `body_exception` with a codex
# target. The fix gates `canonical_body_with_exception` on
# `ttype == "claude"`; for non-claude targets the expected body is the
# plain canonical body. The two tests below pin that contract.
# ---------------------------------------------------------------------------

# build_td193_repo <target_type>  where target_type is: claude | codex
# Builds a self-contained scratch project with: canonical containing the
# anchor, a body-exception sidecar JSON under the per-test isolated
# IGRIS_BRAIN_DIR's loadout/body-exceptions/ dir (already exported by
# setup()), a manifest declaring the agent with `body_exception` +
# `layer: "personal"` (so the sidecar resolves under the isolated brain dir,
# NOT the live in-repo body-exceptions/) + the requested target. Echoes the
# project root path.
build_td193_repo() {
  local ttype="$1"
  local root="$TEST_TEMP_DIR/td193_${ttype}_$BATS_TEST_NUMBER"
  mkdir -p "$root/canon" "$IGRIS_BRAIN_DIR/loadout/body-exceptions"

  # Canonical body with the anchor line that the sidecar will append after.
  cat > "$root/canon/sample.md" <<'EOF'
---
name: sample
description: canonical for TD-193 body_exception gate test
---

# SAMPLE AGENT

Body with the anchor below.

## CONSTRAINTS

- rule one
- rule two
EOF

  # Body-exception sidecar under the isolated brain's loadout dir. The
  # `personal` layer keys sidecar resolution to
  # IGRIS_BRAIN_DIR/loadout/body-exceptions/<name>.json — see
  # check_harness_drift.sh:327 + compile_harnesses.sh:286.
  cat > "$IGRIS_BRAIN_DIR/loadout/body-exceptions/test_excerpt.json" <<'EOF'
{
  "anchor": "## CONSTRAINTS",
  "insert": ["", "Extra rule for the appendix.", ""]
}
EOF

  if [ "$ttype" = "claude" ]; then
    mkdir -p "$root/.claude/agents"
    # FR-152: claude target is a loadout-anchored symlink the compiler
    # creates; no pre-authored harness file.
    cat > "$root/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "layer": "personal",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "body_exception": "test_excerpt",
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
  else
    mkdir -p "$root/.codex/agents"
    cat > "$root/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "layer": "personal",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "body_exception": "test_excerpt",
      "targets": [
        { "type": "codex", "path": ".codex/agents/sample.toml" }
      ]
    }
  ]
}
EOF
  fi

  echo "$root"
}

@test "TD-193: codex + body_exception compiles + drift-checks MATCH (no false DRIFTED)" {
  # The fix this brief lands. Without the ttype gate the guard applies the
  # appendix to the expected body but the codex emitter wrote the PLAIN
  # canonical body — body sha mismatch -> false DRIFTED. With the gate the
  # expected body for codex is the plain canonical body, matching what the
  # codex emitter actually wrote.
  local root
  root="$(build_td193_repo codex)"

  # Real compile (setup() exports IGRIS_BRAIN_DIR -> the scratch brain that
  # holds the body-exception sidecar; no live overlay is auto-discovered).
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" \
                      --target codex
  [ "$status" -eq 0 ]
  [ -f "$root/.codex/agents/sample.toml" ]

  # Real drift check — must MATCH, not false-DRIFTED.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/codex] MATCH"* ]]
  [[ "$output" != *"DRIFTED"* ]]
  [[ "$output" != *"body sha mismatch"* ]]
}

@test "TD-193: claude + body_exception still MATCH (FR-144 regression guard)" {
  # Proves the gate did not regress the claude path under FR-152 α-assembly:
  # claude + body_exception must still ASSEMBLE WITH the appendix into the
  # loadout-resident harness.claude.md, and the symlink resolves there → MATCH.
  # If the gate accidentally bypasses the appendix for claude or the assembly
  # never applies it, this test would surface as a missing appendix in the
  # loadout file (we assert content end-to-end below).
  local root
  root="$(build_td193_repo claude)"

  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" \
                      --target claude
  [ "$status" -eq 0 ]
  # Symlink resolves to the loadout-resident harness.claude.md.
  [ -L "$root/.claude/agents/sample.md" ]
  # The assembled harness.claude.md contains the body-exception appendix.
  local resolved
  resolved="$(realpath "$root/.claude/agents/sample.md")"
  grep -q "Extra rule for the appendix." "$resolved"

  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" == *"loadout-anchored"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}

# ---------------------------------------------------------------------------
# FR-149: claude as a first-class harness consumer of the loadout.
#
# Compile-side behavior emits loadout-anchored symlinks for the common case
# (Case A new, Case B repoint). FR-152 retired the Case C real-file body-
# refresh adapter — a regular-file claude target now hard-errors at compile
# (refuse-to-clobber). The drift verifier MUST report the symlink target's
# realpath containment under $BRAIN_DIR/loadout/ (L-515). Pairs line-for-line
# with compile.
# ---------------------------------------------------------------------------

# build_fr149_agent_project: helper to seed a per-test project with ONE
# loadout-anchored canonical (so $BRAIN_DIR/loadout/agents/<name>/<file>
# points at a real file) and a claude target at .claude/agents/<name>.md.
# Returns project root via stdout.
build_fr149_agent_project() {
  local name="$1"
  local root="$TEST_TEMP_DIR/fr149_agent_${name}_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/$name"
  mkdir -p "$root/.claude/agents" "$loadout_dir"
  cat > "$loadout_dir/system-prompt-v1.0.md" <<EOF
---
name: $name
description: canonical body for FR-149 loadout-anchored test
---

# $name AGENT

Loadout-anchored canonical body.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "$name",
      "layer": "personal",
      "canonical": {
        "dir": "$loadout_dir",
        "versioned": true,
        "glob": "system-prompt-v*.md"
      },
      "targets": [
        { "type": "claude", "path": ".claude/agents/$name.md" }
      ]
    }
  ]
}
EOF
  echo "$root"
}

@test "FR-149: loadout-anchored claude AGENT symlink yields MATCH" {
  local root
  root="$(build_fr149_agent_project demo)"
  # Compile creates the symlink (Case A — target absent).
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"creating claude symlink"* ]]
  # The symlink resolves under $BRAIN_DIR/loadout/. Realpath both sides so
  # macOS `/var` → `/private/var` doesn't produce a false negative.
  [ -L "$root/.claude/agents/demo.md" ]
  local resolved loadout_real
  resolved="$(realpath "$root/.claude/agents/demo.md")"
  loadout_real="$(realpath "$IGRIS_BRAIN_DIR/loadout")"
  case "$resolved" in
    "$loadout_real"/*) : ;;
    *)  printf 'expected under %s, got: %s\n' "$loadout_real" "$resolved" >&2; false ;;
  esac
  # Drift verifier returns MATCH on the symlink path.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/claude] MATCH"* ]]
  [[ "$output" == *"loadout-anchored"* ]]
}

@test "FR-149: legacy claude AGENT symlink (non-loadout) yields DRIFTED" {
  local root
  root="$(build_fr149_agent_project demo)"
  # Pre-create a symlink pointing OUTSIDE the loadout — simulates legacy
  # reference-mode state pre-FR-149.
  mkdir -p "$root/consumer-side"
  cat > "$root/consumer-side/demo.md" <<'EOF'
legacy consumer-side body
EOF
  ln -s "$root/consumer-side/demo.md" "$root/.claude/agents/demo.md"
  # Drift verifier WITHOUT a recompile reports DRIFTED with the migrate hint.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/claude] DRIFTED"* ]]
  [[ "$output" == *"not loadout-anchored"* ]]
  [[ "$output" == *"igris harness compile"* ]]
}

@test "FR-149: claude AGENT repoint then drift MATCH (auto-migration end-to-end)" {
  local root
  root="$(build_fr149_agent_project demo)"
  # Pre-create a legacy non-loadout symlink.
  mkdir -p "$root/consumer-side"
  echo "legacy" > "$root/consumer-side/demo.md"
  ln -s "$root/consumer-side/demo.md" "$root/.claude/agents/demo.md"
  # Compile auto-migrates (Case B repoint).
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"migrating legacy claude symlink"* ]]
  # Symlink now points at the loadout. Realpath both sides for macOS.
  local resolved loadout_real
  resolved="$(realpath "$root/.claude/agents/demo.md")"
  loadout_real="$(realpath "$IGRIS_BRAIN_DIR/loadout")"
  case "$resolved" in
    "$loadout_real"/*) : ;;
    *)  printf 'expected under %s, got: %s\n' "$loadout_real" "$resolved" >&2; false ;;
  esac
  # Drift verifier returns MATCH.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/claude] MATCH"* ]]
}

@test "FR-152: real-file claude AGENT target refuses-to-clobber at compile" {
  # FR-152 retires the FR-149 Case C back-compat (the script that did
  # body-refresh on a real-file claude target is deleted). A pre-existing
  # regular file at the claude target now HARD-ERRORS at compile time, and
  # the drift verifier reports it DRIFTED with the same "remove manually"
  # message. The file is left UNCHANGED so the operator can inspect.
  local root
  root="$(build_fr149_agent_project demo)"
  cat > "$root/.claude/agents/demo.md" <<'EOF'
---
name: demo
description: hand-authored harness file
---

placeholder body — should NOT be clobbered by compile
EOF
  local before
  before="$(cat "$root/.claude/agents/demo.md")"

  # Compile: hard-error refuse-to-clobber, the file is unchanged.
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"refuse to clobber"* ]]
  [[ "$output" == *"$root/.claude/agents/demo.md"* ]]
  # TD-209: batched refuse-to-clobber summary block. Per-file ERROR line + FAIL
  # row are preserved above; the consolidated block emits a header, lists the
  # refused path, and ends in a copy-pasteable recovery command line.
  [[ "$output" == *"Refuse-to-clobber: 1 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"Recovery — inspect the files above"* ]]
  [[ "$output" == *"rm "*"$root/.claude/agents/demo.md"*" && igris harness compile"* ]]
  # File unchanged + still a regular file (NOT a symlink).
  [ -f "$root/.claude/agents/demo.md" ]
  [ ! -L "$root/.claude/agents/demo.md" ]
  [ "$(cat "$root/.claude/agents/demo.md")" = "$before" ]

  # Drift verifier returns DRIFTED with the matching "non-symlink target" reason.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/claude] DRIFTED"* ]]
  [[ "$output" == *"non-symlink target"* ]]
  [[ "$output" == *"remove manually"* ]]
}

# Helper for claude/symlink SKILLS drift tests. Seeds a per-test project
# whose source is loadout-anchored (under $IGRIS_BRAIN_DIR/loadout/skills/).
build_fr149_skill_project() {
  local skill_name="$1"
  local loadout_skill_dir="$IGRIS_BRAIN_DIR/loadout/skills/$skill_name"
  mkdir -p "$PROJ/.claude/skills" "$loadout_skill_dir"
  cat > "$loadout_skill_dir/SKILL.md" <<EOF
---
name: $skill_name
description: loadout-anchored skill for FR-149 drift
---

body
EOF
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$IGRIS_BRAIN_DIR/loadout/skills",
        "layer": "personal",
        "targets": [
          { "type": "claude", "method": "symlink", "path": ".claude/skills" }
        ]
      }
    ]
  }
}
EOF
}

@test "FR-149: loadout-anchored claude SKILL symlink yields MATCH on drift" {
  skip "FR-212d: custom claude SKILL symlink drift retired (skills delegate to the skills CLI; drift = tool idempotent re-check)"
  build_fr149_skill_project demo
  # Compile creates the symlink.
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/skills/demo" ]
  # Drift verifier returns MATCH.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/claude] MATCH"* ]]
}

@test "FR-149: non-loadout claude SKILL symlink yields DRIFTED" {
  skip "FR-212d: custom claude SKILL symlink drift retired (skills delegate to the skills CLI; drift = tool idempotent re-check)"
  build_fr149_skill_project demo
  # Pre-create a symlink pointing OUTSIDE the loadout.
  mkdir -p "$PROJ/.claude/skills" "$PROJ/elsewhere/demo"
  echo "x" > "$PROJ/elsewhere/demo/SKILL.md"
  ln -s "$PROJ/elsewhere/demo" "$PROJ/.claude/skills/demo"
  # Drift verifier WITHOUT recompile reports DRIFTED.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/claude] DRIFTED"* ]]
  [[ "$output" == *"not loadout-anchored"* ]]
  [[ "$output" == *"igris harness compile"* ]]
}

# ---------------------------------------------------------------------------
# FR-152: agent harness unification — claude direct symlink, gemini first-class,
# codex signature refactor. Both claude + gemini symlinks resolve to the SAME
# loadout-resident `<BRAIN_DIR>/loadout/agents/<name>/harness.claude.md` assembled
# from frontmatter + body at compile/vendor time. See L-519 §18.1 pairing.
# ---------------------------------------------------------------------------

# build_fr152_agent_project <name> <ttype>  where ttype ∈ claude|gemini|codex.
# Seeds a project with FR-151-shape vendored frontmatter.claude.md + system-prompt-v1.md
# at $IGRIS_BRAIN_DIR/loadout/agents/<name>/ and a manifest declaring the
# requested target type. Mirrors build_fr149_agent_project but addresses the
# new FR-151 split-canonical shape. Echoes the project root.
build_fr152_agent_project() {
  local name="$1"
  local ttype="$2"
  local root="$TEST_TEMP_DIR/fr152_agent_${name}_${ttype}_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/$name"
  local target_dir target_path
  case "$ttype" in
    claude) target_dir="$root/.claude/agents"; target_path=".claude/agents/$name.md" ;;
    gemini) target_dir="$root/.gemini/agents"; target_path=".gemini/agents/$name.md" ;;
    codex)  target_dir="$root/.codex/agents";  target_path=".codex/agents/$name.toml" ;;
    *) echo "unknown ttype: $ttype" >&2; return 1 ;;
  esac
  mkdir -p "$target_dir" "$loadout_dir"
  # FR-151 sidecar shape: separate frontmatter.claude.md + system-prompt-vN.md.
  cat > "$loadout_dir/frontmatter.claude.md" <<EOF
---
name: $name
description: FR-152 split-shape canonical for $ttype
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<EOF
# $name AGENT

FR-152 body from the FR-151 split-shape sidecar.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "$name",
      "layer": "personal",
      "canonical": {
        "dir": "$loadout_dir",
        "versioned": true,
        "glob": "system-prompt-v*.md"
      },
      "targets": [
        { "type": "$ttype", "path": "$target_path" }
      ]
    }
  ]
}
EOF
  echo "$root"
}

@test "FR-152: claude AGENT cold compile creates symlink to loadout harness.claude.md" {
  local root
  root="$(build_fr152_agent_project demo claude)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"creating claude symlink"* ]]
  # Symlink resolves under $BRAIN_DIR/loadout/agents/<name>/harness.claude.md.
  [ -L "$root/.claude/agents/demo.md" ]
  local resolved expected
  resolved="$(realpath "$root/.claude/agents/demo.md")"
  expected="$(realpath "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.claude.md")"
  [ "$resolved" = "$expected" ]
  # Drift verifier returns MATCH.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/claude] MATCH"* ]]
  [[ "$output" == *"loadout-anchored"* ]]
}

# TD-208 helper: assert that $target is a hard link sharing an inode with
# $source AND that nlink on $source is >= 2 (defensive — same-inode on a
# single-link file would be a kernel inconsistency). Used by every TD-208
# bats test below.
# Usage: assert_gemini_hardlink <target_abs> <loadout_source_abs>
assert_gemini_hardlink() {
  local target="$1" source="$2"
  [ -f "$target" ]
  [ ! -L "$target" ]
  local tgt_inode src_inode src_nlink
  tgt_inode=$(file_inode "$target")
  src_inode=$(file_inode "$source")
  src_nlink=$(file_nlink "$source")
  [ "$tgt_inode" = "$src_inode" ]
  [ "$src_nlink" -ge 2 ]
}

@test "TD-208: gemini AGENT cold compile creates hard link to loadout harness.gemini.md" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  [[ "$output" == *"creating gemini hard link"* ]]
  # TD-208: target is a regular file (NOT a symlink) that shares an inode
  # with the loadout harness.gemini.md.
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" \
                         "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/gemini] MATCH"* ]]
  [[ "$output" == *"hard link"* ]]
}

@test "TD-230: gemini AGENT re-added memory: key is caught as SCHEMA-INVALID (drift stays MATCH)" {
  # TD-230 / GAP-2: a present + drift-clean harness.gemini.md can still be
  # REFUSED by Gemini's loader (unknown key `memory` — the TD-229 blind spot).
  # After a clean compile (drift MATCH), re-inject the Claude-only `memory:` key
  # by an IN-PLACE truncating `>` rewrite of the LOADOUT harness.gemini.md. The
  # `>` preserves the inode, so the hard link + drift MATCH stay intact —
  # ISOLATING the new SCHEMA-INVALID verdict (gemini drift is inode-based, not
  # content-based, so the bytes change does not co-emit a drift verdict).
  local root
  root="$(build_fr152_agent_project demo gemini)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  local loadout_gemini="$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  # In-place truncating rewrite (preserves inode → hard link + drift MATCH hold).
  cat > "$loadout_gemini" <<'EOF'
---
name: demo
description: FR-152 split-shape canonical for gemini
kind: local
memory: project
---

# demo AGENT

FR-152 body from the FR-151 split-shape sidecar.
EOF
  # The hard link still shares the inode (drift MATCH unaffected).
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" "$loadout_gemini"
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  # SCHEMA-INVALID drives exit 1; the drift verdict is still MATCH (isolated).
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/gemini] SCHEMA-INVALID"* ]]
  [[ "$output" == *"unrecognized key(s): memory"* ]]
  [[ "$output" == *"schema-invalid target(s)"* ]]
  # The drift verdict itself remained MATCH (verdict is orthogonal).
  [[ "$output" == *"[demo/gemini] MATCH"* ]]
}

@test "TD-230: freshly compiled clean gemini agent stays green (no false SCHEMA-INVALID)" {
  # No-false-positive guard: a real translated gemini agent (kind: local
  # injected, no Claude-only keys, no invalid tools) must NOT trip the new
  # SCHEMA-INVALID verdict. Proves the current clean tree + the conservative
  # allow-list stay green (§18.1 3-way sync sanity: the allow-list does not
  # reject a legitimately-projected shape).
  local root
  root="$(build_fr152_agent_project demo gemini)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/gemini] MATCH"* ]]
  [[ "$output" != *"SCHEMA-INVALID"* ]]
}

@test "FR-152/FR-158/TD-208: claude symlink + gemini hard link resolve to DIFFERENT per-harness files" {
  # FR-158 supersedes FR-152's "shared harness.md" with per-harness derived
  # outputs (claude → harness.claude.md, gemini → harness.gemini.md, BOTH
  # loadout-resident in the SAME agent dir). TD-208 furthers this: claude
  # PATH uses a SYMLINK (realpath returns the loadout file) while gemini
  # PATH uses a HARD LINK (realpath returns the target's own path — its
  # own inode IS the loadout inode).
  local root="$TEST_TEMP_DIR/fr152_both_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/twin"
  mkdir -p "$root/.claude/agents" "$root/.gemini/agents" "$loadout_dir"
  cat > "$loadout_dir/frontmatter.claude.md" <<'EOF'
---
name: twin
description: FR-158 per-harness derived outputs
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<'EOF'
# TWIN AGENT

Shared body across claude + gemini consumers.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{ "version": 1, "agents": [ {
  "name": "twin", "layer": "personal",
  "canonical": { "dir": "$loadout_dir", "versioned": true, "glob": "system-prompt-v*.md" },
  "targets": [
    { "type": "claude", "path": ".claude/agents/twin.md" },
    { "type": "gemini", "path": ".gemini/agents/twin.md" }
  ] } ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  # Claude side — realpath traverses the symlink to harness.claude.md.
  [ -L "$root/.claude/agents/twin.md" ]
  local c_resolved
  c_resolved="$(realpath "$root/.claude/agents/twin.md")"
  [[ "$c_resolved" == *"/harness.claude.md" ]]
  # Gemini side — TD-208 hard link. realpath on a hard link returns its OWN
  # path, but inode equality with harness.gemini.md is the contract.
  assert_gemini_hardlink "$root/.gemini/agents/twin.md" \
                         "$loadout_dir/harness.gemini.md"
  # Both loadout-resident files live in the SAME agent dir.
  local c_dir g_dir
  c_dir="$(dirname "$c_resolved")"
  g_dir="$(realpath "$loadout_dir")"
  [ "$c_dir" = "$g_dir" ]
}

@test "TD-208: gemini AGENT legacy symlink is auto-migrated to hard link" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  # Pre-create a symlink pointing OUTSIDE the loadout — simulates pre-TD-208
  # state (where gemini was projected via symlink).
  mkdir -p "$root/consumer-side"
  echo "stale gemini body" > "$root/consumer-side/demo.md"
  ln -s "$root/consumer-side/demo.md" "$root/.gemini/agents/demo.md"

  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  [[ "$output" == *"migrating legacy gemini symlink to hard link"* ]]
  # TD-208: after migration, target is a hard link (not a symlink) sharing
  # inode with harness.gemini.md.
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" \
                         "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
}

@test "TD-208: gemini AGENT drift DRIFTED (legacy symlink — any symlink is drift under hard-link primitive)" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  # TD-434 (2026-08-31): compile FIRST so the loadout harness.gemini.md
  # exists. Without it the guard early-returns on the absent-loadout branch
  # ("[absent in loadout]") and the symlink branch under test is UNREACHABLE —
  # this test asserted that branch's text vacuously for its whole life
  # (non-final bare [[ ]], TD-341's class; armed ubuntu bats 1.10 failed it,
  # run 33404539413). Hence the `|| return 1` arms below.
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ] || return 1
  # Now replace the compiled hard link with a symlink pointing OUTSIDE the
  # loadout — simulates pre-TD-208 legacy state. Under TD-208, ANY symbolic
  # link at the gemini target is DRIFTED (the primitive is hard link; Gemini
  # loader does not follow symlinks). The non-loadout-anchored detail is
  # irrelevant — even a loadout-anchored symlink would be drift.
  mkdir -p "$root/consumer-side"
  echo "stale" > "$root/consumer-side/demo.md"
  rm "$root/.gemini/agents/demo.md"
  ln -s "$root/consumer-side/demo.md" "$root/.gemini/agents/demo.md"

  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  echo "status=$status output: $output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[demo/gemini] DRIFTED"* ]] || return 1
  [[ "$output" == *"symbolic link"* ]] || return 1
  [[ "$output" == *"legacy pre-TD-208 emit"* ]] || return 1
  [[ "$output" == *"igris harness compile"* ]] || return 1
}

# TD-208 supersedes the FR-152 "gemini real-file target refuses-to-clobber"
# contract. Under TD-208 the gemini emit primitive IS a hard link (a real
# non-symlink file), so refusing to clobber any real file at $target would
# make Gemini refuse to overwrite its own output. The new contract: the
# compile pipeline OWNS the gemini target path; re-emit is idempotent.
# Operator-replaced state is surfaced at drift-check time via the DRIFT-WARN
# verdict (see TD-208 drift tests below).

@test "TD-208: atomic re-vendor + recompile re-establishes the gemini hard link" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  local loadout_path="$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  local first_inode
  first_inode=$(file_inode "$loadout_path")
  # Hard link established after first compile.
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" "$loadout_path"

  # Simulate atomic re-vendor by rewriting the canonical body. This forces
  # assemble_agent_harness_into_loadout to mv-replace the harness.gemini.md
  # with a NEW inode at the next compile — the OLD hard link in
  # ~/.gemini/agents/ now points at the orphaned old inode and must be
  # re-emitted against the new one.
  cat > "$IGRIS_BRAIN_DIR/loadout/agents/demo/system-prompt-v1.0.md" <<'EOF'
# demo AGENT (re-vendored body)

Modified body to force a new inode at next compile.
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  local second_inode
  second_inode=$(file_inode "$loadout_path")
  [ "$first_inode" != "$second_inode" ]
  # Hard link re-established against the new inode.
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" "$loadout_path"
}

@test "TD-208: drift verifier MATCH for hard-linked gemini target" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  bash "$COMPILE" --project-root "$root" \
                  --manifest "$root/harness-manifest.json" --target gemini

  run bash "$GUARD" --project-root "$root" \
                    --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/gemini] MATCH"* ]]
  [[ "$output" == *"hard link"* ]]
  [[ "$output" == *"nlink"* ]]
}

@test "TD-208: drift verifier DRIFT-WARN when hard link replaced by cp copy" {
  local root
  root="$(build_fr152_agent_project demo gemini)"
  bash "$COMPILE" --project-root "$root" \
                  --manifest "$root/harness-manifest.json" --target gemini
  local target="$root/.gemini/agents/demo.md"
  local loadout_path="$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  # Replace hard link with a real-file copy (operator manually `cp`'d).
  rm "$target"
  cp "$loadout_path" "$target"
  # Sanity: byte content matches but inodes diverge.
  [ "$(file_md5 "$target")" = "$(file_md5 "$loadout_path")" ]
  [ "$(file_inode "$target")" != "$(file_inode "$loadout_path")" ]

  run bash "$GUARD" --project-root "$root" \
                    --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/gemini] DRIFT-WARN"* ]]
  [[ "$output" == *"real-file copy"* ]]
  [[ "$output" == *"igris harness compile"* ]]
}

@test "TD-208: drift verifier DRIFTED when content differs AND inode mismatches" {
  # L-29 coverage guard: pin the hard-DRIFTED verdict path (verdict #5 in
  # verify_gemini_agent_hardlink_drift) — operator both replaced the hard
  # link with a copy AND modified the content. Distinct from the DRIFT-WARN
  # path which requires byte-equality.
  local root
  root="$(build_fr152_agent_project demo gemini)"
  bash "$COMPILE" --project-root "$root" \
                  --manifest "$root/harness-manifest.json" --target gemini
  local target="$root/.gemini/agents/demo.md"
  local loadout_path="$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  # Replace hard link with a different-content real file.
  rm "$target"
  cat > "$target" <<'EOF'
# DEMO (operator hand-edited; content diverged from loadout)
EOF
  # Sanity: content differs AND inodes diverge.
  [ "$(file_md5 "$target")" != "$(file_md5 "$loadout_path")" ]
  [ "$(file_inode "$target")" != "$(file_inode "$loadout_path")" ]

  run bash "$GUARD" --project-root "$root" \
                    --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/gemini] DRIFTED"* ]]
  [[ "$output" == *"content differs"* ]]
  [[ "$output" == *"igris harness compile"* ]]
}

@test "FR-159: codex AGENT compile via TS assembleCodexHarness path emits 3-key TOML + drift MATCH" {
  # FR-159 retires sync_codex_agents.sh in favor of TS assembleCodexHarness
  # (vendor-side) + bash assemble_codex_harness_into_loadout (compile-side
  # fallback for core agents). Compile dispatch routes through
  # compile_md_agent_target "codex" so the .toml is the target of a symlink
  # to <BRAIN_DIR>/loadout/agents/<name>/harness.codex.toml. Drift verdict
  # is symlink-realpath (parity with claude), not body-sha.
  local root
  root="$(build_fr152_agent_project demo codex)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target codex
  [ "$status" -eq 0 ]
  # Target is a symlink, NOT a regular file (FR-159 contract).
  [ -L "$root/.codex/agents/demo.toml" ]
  # Symlink resolves to the loadout-resident harness.codex.toml.
  local resolved
  resolved="$(realpath "$root/.codex/agents/demo.toml")"
  [[ "$resolved" == *"/loadout/agents/demo/harness.codex.toml" ]]
  # The TOML's description came from the FR-151 frontmatter.claude.md sidecar.
  grep -q 'description = "FR-152 split-shape canonical for codex"' \
       "$root/.codex/agents/demo.toml"
  # The TOML's developer_instructions body came from the system-prompt-v1.0.md.
  grep -q "FR-152 body from the FR-151 split-shape sidecar" \
       "$root/.codex/agents/demo.toml"
  # And `name` came from the frontmatter sidecar.
  grep -q 'name = "demo"' "$root/.codex/agents/demo.toml"

  # Drift verifier returns MATCH for codex (symlink-realpath verdict per FR-159).
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/codex] MATCH"* ]]
}

@test "FR-152: codex AGENT compile with inline-frontmatter canonical (TD-195 fallback)" {
  # No frontmatter.claude.md sidecar; canonical has inline frontmatter (the shape of
  # today's 7 igris-core agents). The compile-side resolve_or_extract_frontmatter
  # helper extracts to a tempfile and passes it to the refactored adapter.
  local root="$TEST_TEMP_DIR/fr152_inline_$BATS_TEST_NUMBER"
  mkdir -p "$root/canon" "$root/.codex/agents"
  cat > "$root/canon/inline.md" <<'EOF'
---
name: inline
description: TD-195 fallback — inline frontmatter only
---

# INLINE AGENT

Body for the TD-195 fallback path.
EOF
  cat > "$root/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [ {
  "name": "inline",
  "canonical": { "dir": "canon", "file": "inline.md", "versioned": false },
  "targets": [ { "type": "codex", "path": ".codex/agents/inline.toml" } ]
} ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target codex
  [ "$status" -eq 0 ]
  [ -f "$root/.codex/agents/inline.toml" ]
  grep -q 'description = "TD-195 fallback — inline frontmatter only"' \
       "$root/.codex/agents/inline.toml"
  grep -q "Body for the TD-195 fallback path" "$root/.codex/agents/inline.toml"
}

@test "FR-152: claude AGENT cold compile with inline-frontmatter canonical (TD-195 compile-time α-assembly fallback)" {
  # Core agents don't have an FR-151 frontmatter.claude.md sidecar yet. The compile-
  # side assemble_agent_harness_into_loadout helper extracts inline
  # frontmatter from the canonical and builds harness.claude.md in the loadout; the
  # claude symlink then resolves there. This pins the D4 fallback path.
  local root="$TEST_TEMP_DIR/fr152_inline_claude_$BATS_TEST_NUMBER"
  mkdir -p "$root/canon" "$root/.claude/agents"
  cat > "$root/canon/core.md" <<'EOF'
---
name: core
description: TD-195 fallback — inline frontmatter only (claude side)
---

# CORE AGENT (TD-195)

Body assembled from inline frontmatter + canonical body.
EOF
  cat > "$root/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [ {
  "name": "core",
  "canonical": { "dir": "canon", "file": "core.md", "versioned": false },
  "targets": [ { "type": "claude", "path": ".claude/agents/core.md" } ]
} ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  [ -L "$root/.claude/agents/core.md" ]
  # The loadout's harness.claude.md was assembled by the D4 fallback.
  local loadout_file="$IGRIS_BRAIN_DIR/loadout/agents/core/harness.claude.md"
  [ -f "$loadout_file" ]
  # Both frontmatter (preserved) + body are present in harness.claude.md.
  grep -q '^name: core$' "$loadout_file"
  grep -q "Body assembled from inline frontmatter" "$loadout_file"
  # Drift MATCH.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[core/claude] MATCH"* ]]
}

@test "FR-152: claude AGENT compile is idempotent — no churn on a second run" {
  # FR-152: assembly is deterministic, so two compiles produce identical
  # loadout harness.claude.md bytes and the symlink's resolved target is unchanged.
  local root
  root="$(build_fr152_agent_project demo claude)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  local first_sha
  first_sha="$(shasum "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.claude.md" \
                | awk '{print $1}')"
  local first_resolved
  first_resolved="$(realpath "$root/.claude/agents/demo.md")"

  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target claude
  [ "$status" -eq 0 ]
  local second_sha
  second_sha="$(shasum "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.claude.md" \
                 | awk '{print $1}')"
  local second_resolved
  second_resolved="$(realpath "$root/.claude/agents/demo.md")"

  [ "$first_sha" = "$second_sha" ]
  [ "$first_resolved" = "$second_resolved" ]
}

@test "FR-158/TD-208: gemini AGENT compile produces own harness.gemini.md (auto-translate path)" {
  # FR-158 retry 1: a gemini target compiles against a frontmatter.claude.md
  # sidecar (no frontmatter.gemini.md). The bash compile-side fallback
  # auto-translates Claude-shape → Gemini-shape (mirror of TS
  # `assembleGeminiHarness`): `kind: local` is injected and Claude tool names
  # are translated via the 9-mapping table. TD-208: gemini target is a HARD
  # LINK to the gemini-shape file (inode equality instead of realpath).
  local root
  root="$(build_fr152_agent_project demo gemini)"
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  # The new per-harness derived output exists.
  [ -f "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md" ]
  # TD-208: target is a hard link to the gemini-shape file.
  assert_gemini_hardlink "$root/.gemini/agents/demo.md" \
                         "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  # FR-158 retry 1: the bash compile auto-translates — `kind: local` is now
  # injected even when only `frontmatter.claude.md` exists. This is the
  # post-fix shape (pre-fix had verbatim Claude-shape with no `kind`).
  grep -q "kind: local" "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  # Drift verdict MATCH against the new expected.
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[demo/gemini] MATCH"* ]]
}

@test "FR-158: gemini AGENT compile uses frontmatter.gemini.md override when present" {
  # FR-158 operator override: a frontmatter.gemini.md sidecar is honored
  # verbatim (no auto-translate). The bash compile-side picks it up via the
  # primary_sidecar lookup at $loadout_dir/frontmatter.gemini.md.
  local root
  root="$(build_fr152_agent_project demo gemini)"
  # Author an operator override at the loadout-side path the bash compile
  # uses (build_fr152_agent_project seeds the loadout dir with the sidecar +
  # body — we add the gemini override alongside).
  cat > "$IGRIS_BRAIN_DIR/loadout/agents/demo/frontmatter.gemini.md" <<'EOF'
---
name: demo
kind: local
tools: [web_search]
custom_gemini_marker: present
---
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" --target gemini
  [ "$status" -eq 0 ]
  # The Gemini harness reflects the operator override.
  grep -q "kind: local" "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  grep -q "custom_gemini_marker: present" "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
  grep -q "tools: \[web_search\]" "$IGRIS_BRAIN_DIR/loadout/agents/demo/harness.gemini.md"
}

@test "FR-158 retry 1: bash compile auto-translates Claude-shape tools to Gemini-shape" {
  # FR-158 retry 1 regression guard. Operator flow scenario:
  #   1. Vendor an agent with `frontmatter.claude.md` carrying Claude-shape
  #      `tools: Read` (no `kind:` field — the typical case for personal
  #      agents authored against Claude semantics).
  #   2. `igris harness compile` regenerates `harness.gemini.md`.
  #   3. Post-compile, harness.gemini.md MUST carry Gemini-shape:
  #        - `kind: local` injected (closes "Subagent not found" rejection)
  #        - `tools: [read_file]` translated via CLAUDE_TO_GEMINI_TOOLS
  # The pre-fix behavior (verbatim Claude-shape passthrough) silently
  # clobbered the TS-produced Gemini harness back to broken-on-Gemini state
  # after every `igris harness compile`. The live-machine evidence: the
  # 3 content-pipeline agents in Gemini-shape after `igris loadout update`
  # were re-broken on the next harness compile cycle.
  local root="$TEST_TEMP_DIR/fr158_retry_xlate_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/xlate"
  mkdir -p "$root/.gemini/agents" "$loadout_dir"
  # Author a Claude-shape frontmatter sidecar with multiple tools shapes
  # exercised (string, multiple tools — we use CSV here; flow-list path is
  # covered by the operator-override test). model: must be DROPPED.
  cat > "$loadout_dir/frontmatter.claude.md" <<'EOF'
---
name: xlate
description: FR-158 retry 1 — bash auto-translate guard
tools: Read, Grep, Bash
model: sonnet
memory: project
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<'EOF'
# XLATE

Body for the bash auto-translate guard.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{ "version": 1, "agents": [ {
  "name": "xlate", "layer": "personal",
  "canonical": { "dir": "$loadout_dir", "versioned": true, "glob": "system-prompt-v*.md" },
  "targets": [
    { "type": "gemini", "path": ".gemini/agents/xlate.md" }
  ] } ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  # POST-FIX (FR-158 retry 1) — these assertions WOULD HAVE FAILED before
  # the fix: bash compile was emitting verbatim Claude-shape frontmatter to
  # harness.gemini.md, silently regressing Gemini's `invoke_agent`.
  local gemini_harness="$IGRIS_BRAIN_DIR/loadout/agents/xlate/harness.gemini.md"
  [ -f "$gemini_harness" ]
  # 1. kind: local must be injected.
  grep -q "^kind: local$" "$gemini_harness"
  # 2. tools translated: Read → read_file, Grep → grep_search, Bash → run_shell_command.
  grep -q "tools: \[read_file, grep_search, run_shell_command\]" "$gemini_harness"
  # 3. model: dropped (Gemini uses defaults).
  ! grep -q "^model:" "$gemini_harness"
  # 3b. memory: dropped (TD-229 — Claude-only key; Gemini's strict subagent
  #     schema rejects it with "Unrecognized key(s) in object: 'memory'",
  #     which made the 7 core agents fail to load entirely on Gemini).
  ! grep -q "^memory:" "$gemini_harness"
  # 4. description: + name: pass through verbatim.
  grep -q "^name: xlate$" "$gemini_harness"
  grep -q "^description: " "$gemini_harness"
  # 5. The Claude-shape `tools: Read, Grep, Bash` MUST NOT survive — the
  #    pre-fix bug was passthrough of this exact string.
  ! grep -q "^tools: Read, Grep, Bash$" "$gemini_harness"
  # Idempotency: re-running compile must NOT flip the shape.
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  grep -q "^kind: local$" "$gemini_harness"
  grep -q "tools: \[read_file, grep_search, run_shell_command\]" "$gemini_harness"
}

@test "TD-229: bash compile maps Edit→replace and DROPS mcp__ tool tokens (Gemini schema)" {
  # TD-229 regression guard. The 7 core agents declare Claude tools that the
  # FR-158 map either mis-translated or passed through verbatim, both of which
  # Gemini rejects with "tools.N: Invalid tool name":
  #   - `Edit` mapped to `edit_file` (not a Gemini built-in; the real tool is
  #     `replace`). Blocked forger + sage from loading.
  #   - `mcp__igris-brain__igris_error_lookup` passed through verbatim; Gemini's
  #     schema rejects the double-underscore Claude MCP shape. Blocked mender.
  # Post-fix: Edit → replace, and mcp__ tokens are dropped (MCP tools reach
  # Gemini agents via mcp_servers, not the tools array).
  local root="$TEST_TEMP_DIR/td229_xlate_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/td229"
  mkdir -p "$root/.gemini/agents" "$loadout_dir"
  cat > "$loadout_dir/frontmatter.claude.md" <<'EOF'
---
name: td229
description: TD-229 Edit-map + mcp-drop guard
tools: Read, Edit, Bash, mcp__igris-brain__igris_error_lookup
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<'EOF'
# TD229
Body for the TD-229 guard.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{ "version": 1, "agents": [ {
  "name": "td229", "layer": "personal",
  "canonical": { "dir": "$loadout_dir", "versioned": true, "glob": "system-prompt-v*.md" },
  "targets": [ { "type": "gemini", "path": ".gemini/agents/td229.md" } ] } ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  local gemini_harness="$IGRIS_BRAIN_DIR/loadout/agents/td229/harness.gemini.md"
  [ -f "$gemini_harness" ]
  # Edit → replace (NOT edit_file); Read → read_file; Bash → run_shell_command;
  # the mcp__ token is dropped entirely.
  grep -q "tools: \[read_file, replace, run_shell_command\]" "$gemini_harness"
  ! grep -q "edit_file" "$gemini_harness"
  ! grep -q "mcp__" "$gemini_harness"
}

@test "FR-158 retry 1: bash compile respects operator-provided kind: in claude sidecar (no double-inject)" {
  # Edge case — a Claude sidecar that ALREADY has `kind: local` (e.g., a
  # cross-CLI author who put it there for any reason). The translator must
  # not double-inject; the operator-provided line passes through.
  local root="$TEST_TEMP_DIR/fr158_retry_kind_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/kindops"
  mkdir -p "$root/.gemini/agents" "$loadout_dir"
  cat > "$loadout_dir/frontmatter.claude.md" <<'EOF'
---
name: kindops
kind: local
tools: Read
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<'EOF'
# KINDOPS body
EOF
  cat > "$root/harness-manifest.json" <<EOF
{ "version": 1, "agents": [ {
  "name": "kindops", "layer": "personal",
  "canonical": { "dir": "$loadout_dir", "versioned": true, "glob": "system-prompt-v*.md" },
  "targets": [ { "type": "gemini", "path": ".gemini/agents/kindops.md" } ] } ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  local gemini_harness="$IGRIS_BRAIN_DIR/loadout/agents/kindops/harness.gemini.md"
  # `kind: local` appears EXACTLY ONCE.
  local kind_count
  kind_count=$(grep -c "^kind: local$" "$gemini_harness" || true)
  [ "$kind_count" -eq 1 ]
}

@test "FR-158: drift on harness.claude.md does NOT flag harness.gemini.md (independent verdicts)" {
  # Per-harness derived outputs mean per-harness drift verdicts. Corrupt one;
  # the other stays MATCH.
  local root="$TEST_TEMP_DIR/fr158_indep_$BATS_TEST_NUMBER"
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/agents/indep"
  mkdir -p "$root/.claude/agents" "$root/.gemini/agents" "$loadout_dir"
  cat > "$loadout_dir/frontmatter.claude.md" <<'EOF'
---
name: indep
description: per-harness independent verdicts
---
EOF
  cat > "$loadout_dir/system-prompt-v1.0.md" <<'EOF'
# INDEP

Body for independent-verdict test.
EOF
  cat > "$root/harness-manifest.json" <<EOF
{ "version": 1, "agents": [ {
  "name": "indep", "layer": "personal",
  "canonical": { "dir": "$loadout_dir", "versioned": true, "glob": "system-prompt-v*.md" },
  "targets": [
    { "type": "claude", "path": ".claude/agents/indep.md" },
    { "type": "gemini", "path": ".gemini/agents/indep.md" }
  ] } ] }
EOF
  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  # Corrupt only the claude derived output by repointing the symlink off-loadout.
  rm "$root/.claude/agents/indep.md"
  mkdir -p "$root/elsewhere"
  echo "stale" > "$root/elsewhere/indep.md"
  ln -s "$root/elsewhere/indep.md" "$root/.claude/agents/indep.md"
  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[indep/claude] DRIFTED"* ]]
  [[ "$output" == *"[indep/gemini] MATCH"* ]]
}

# ---------------------------------------------------------------------------
# TD-388: the sibling-worktree MCP exemption.
#
# MECHANISM UNDER TEST. The harness MCP configs (~/.claude.json and friends) are
# HOME-anchored, so every worktree of a repo SHARES them; the projected entry
# names a build artifact INSIDE one checkout. With N worktrees, the N-1 that did
# not compile last each see `mcp/<name>/<harness>` DRIFTED on `args`, and the
# gate's own remedy (`igris harness compile`) would re-point the shared config
# away from the other worktree's live session. The wrapper therefore downgrades
# EXACTLY that class to a non-fatal WORKTREE NOTICE.
#
# WHICH CONDITION EACH TEST ACTUALLY GUARDS — rewritten after mutation testing
# refuted the first version of this map. Read the "guards" column as a claim
# that a mutation of that condition turns the listed test RED, because that is
# how each row was established.
#
#   1. >=1 LIVE sibling worktree  -> W2 (none), W3a (removed), W3b (prunable).
#      GUARDED: mutating condition 1 reds these.
#   2. block is `mcp/*`           -> NO TEST, and none is possible today.
#      NOT GUARDED, deliberately. Condition 2 is REDUNDANT with condition 4:
#      the clause condition 4 requires is emitted at exactly one line in the
#      whole tree (`check_harness_drift.sh:845`, inside verify_mcp_entry_drift),
#      so no non-mcp block can reach the branch anyway. Deleting condition 2
#      alone reds NOTHING. It stays as defence-in-depth against a FUTURE
#      surface that starts printing `differing key(s)`; it cannot be pinned
#      until such an emitter exists. Do not claim W5/W5b cover it — they do not
#      (though condition 2 IS one of the three that jointly hold the agent
#      surface; see the lattice below).
#   3. config is out-of-repo      -> W9 and W9b, one per CLAUSE.
#      GUARDED, by two behavioural PAIRS, because the condition has two halves
#      with different reachable red states:
#        * W9  — the "outside REPO_ROOT" half. Identical args-only drift, same
#          live sibling, config INSIDE vs OUTSIDE the repo. Hardwiring
#          condition 3 to True reds the inside arm.
#        * W9b — the "ABSOLUTE" half, which is the ONLY thing separating
#          is_out_of_repo() from the naive `not is_project_relative(path)`:
#          the two agree on every absolute path, so W9 alone cannot tell them
#          apart. W9b names the same out-of-repo file by a RELATIVE path — an
#          ACCEPTED INPUT class to the guard, not an observed operator practice
#          (every default config path is absolute, and IGRIS_MCP_CLAUDE_CONFIG
#          is documented only as the test-sandbox seam) — real wrapper FATAL,
#          naive inversion exempt.
#      Before these existed the condition had ZERO coverage: swapping in the
#      naive inversion, hardwiring True, and deleting condition 2 alongside
#      either, all survived the entire suite.
#   4. only args|command differ   -> W4a (env only), W4b (args+env), W6 (a
#      reason with no `differing key(s)` clause at all), W1c (command-only IS
#      exempt). NOT W5/W5b — see the lattice below.
#      GUARDED: deleting the whole condition reds W4a, W4b and W6.
#
# THE AGENT SURFACE IS HELD BY A SUFFICIENCY LATTICE, NOT BY ANY ONE ROW ABOVE.
# Measured over every subset of {2,3,4}:
#
#     turned off:  {2} {3} {4} {2,3} {2,4} {3,4}  -> W5/W5b GREEN
#     turned off:  {2,3,4}                        -> W5/W5b RED
#
# Conditions 2, 3 and 4 are EACH INDEPENDENTLY SUFFICIENT, because an agent
# DRIFTED block fails all three simultaneously: it is named `forger/claude`
# (no `mcp/` prefix, cond 2); it prints `target :` / `expected :` /
# `symlink target:`, none of which pathline_re matches, so path="" and
# is_out_of_repo("") is False (cond 3); and no agent reason carries a
# `differing key(s)` clause (cond 4).
#
# METHOD NOTE — this is why two earlier versions of this map were wrong: in a
# conjunction, SINGLE-CONDITION mutation cannot, on its own, establish which
# condition guards a property. When MORE THAN ONE condition is independently
# sufficient — as all three are here — NO singleton mutation can red the test,
# so every singleton looks harmless and the exclusive story built from that is
# false.
# (With exactly one sufficient condition the singleton DOES red, and does
# attribute; you cannot know which case you are in without measuring.)
# Attribution needs the SUBSET LATTICE; singletons plus one triple will
# fit an exclusive story that is false. Do not write a third exclusive claim.
#
# Plus W7 (IGRIS_DRIFT_STRICT_WORKTREE=1) and W8 (the pathline_re no-op).
#
# COVERAGE LIMIT, stated rather than implied: every fixture here drives the
# CLAUDE harness. The predicate reads only the block-name prefix, the config
# path and the reason text, so it is harness-agnostic by construction — but no
# non-claude harness has been driven through the exemption by a test.
#
# HERMETIC BY CONSTRUCTION: every fixture is a synthetic git repo under
# $TEST_TEMP_DIR with its own worktrees, an isolated IGRIS_BRAIN_DIR, and a
# scratch MCP config reached through the documented IGRIS_MCP_CLAUDE_CONFIG
# seam. No test reads or writes the operator's real ~/.claude.json, and no test
# runs `igris harness compile` against a real harness config.
#
# IGRIS_CLI=false in every drift run: the guard's descriptor<->npx agent-id
# probe (`igris loadout list-mcp-agents`) has no business running here, and its
# documented graceful degradation is a stderr SKIP, not a verdict.
# ---------------------------------------------------------------------------

# The canonical MCP shape the fixture manifest declares. The claude expected
# shape derived from it is {args, command, env, type} — so an on-disk entry that
# differs ONLY in args[0] yields exactly `differing key(s): args`.
TD388_CANON_ARG="/canonical/checkout/cli/dist/index.js"

# build_mcp_repo <slug> [with_agent]
#   Echoes the synthetic repo root. `with_agent` = "agent" also declares a
#   project-relative claude AGENT target (used by the mixed-verdict tests).
build_mcp_repo() {
  local slug="$1"
  local with_agent="${2:-}"
  local root="$TEST_TEMP_DIR/td388_${slug}_$BATS_TEST_NUMBER"
  mkdir -p "$root/core/scripts/cli-adapters" "$root/scripts" \
           "$root/canon" "$root/.claude/agents"
  (
    cd "$root" || exit 1
    git init -q
    # `git worktree add` needs a born HEAD.
    git -c user.email=td388@example.invalid -c user.name=td388 \
        commit -q --allow-empty -m init
  )

  cp "$ADAPTERS"/*.sh "$root/core/scripts/cli-adapters/"
  [ -d "$ADAPTERS/body-exceptions" ] \
    && cp -R "$ADAPTERS/body-exceptions" "$root/core/scripts/cli-adapters/"

  # The wrapper under test. TD388_WRAPPER_SRC is the red-first seam: point it at
  # a pre-fix copy to reproduce the failure the exemption removes.
  cp "${TD388_WRAPPER_SRC:-$WRAPPER}" "$root/scripts/validate_harness_drift.sh"

  cat > "$root/canon/forger.md" <<'EOF'
---
name: forger
description: synthetic canonical for the TD-388 worktree tests
---

# FORGER (synthetic)

Canonical body the harness must match.
EOF

  local agents_json='[]'
  if [ "$with_agent" = "agent" ]; then
    agents_json='[
    {
      "name": "forger",
      "canonical": { "dir": "canon", "file": "forger.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/forger.md" }
      ]
    }
  ]'
  fi

  cat > "$root/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": $agents_json,
  "surfaces": {
    "mcp_servers": [
      {
        "name": "igris-brain",
        "canonical": {
          "command": "node",
          "args": ["$TD388_CANON_ARG"],
          "env": {},
          "startup_timeout_sec": 30
        },
        "targets": [ { "type": "claude", "method": "merge" } ]
      }
    ]
  }
}
EOF

  if [ "$with_agent" = "agent" ]; then
    # DANGER, LEARNED THE HARD WAY (TD-388 build incident): a bare
    # `compile_harnesses.sh` runs the MCP projection pass too, and that pass
    # writes the harness config at its DEFAULT home-anchored path. The
    # IGRIS_MCP_*_CONFIG seams are DRIFT-SIDE ONLY — at the time of the
    # incident neither compile_harnesses.sh nor the TS projector read them —
    # so pointing them at a temp dir would have been a guard that proves
    # nothing. The first version of this fixture therefore merged its own
    # canonical `args` straight into the operator's REAL ~/.claude.json: the
    # fixture performed the exact destructive act this brief exists to stop
    # the gate from recommending.
    #
    # The guarantee is now STRUCTURAL, not an argument: compile is handed a
    # SEPARATE, agents-only manifest that contains no `surfaces` key at all, so
    # there is no MCP block for any pass to project, whatever flags it gets.
    # `--surface agents` is kept as a second, weaker belt. The drift run still
    # uses the full harness-manifest.json (with the MCP block), because drift
    # DOES honour IGRIS_MCP_CLAUDE_CONFIG.
    # Since TD-390 compile REFUSES its MCP pass when any IGRIS_MCP_*_CONFIG is
    # set (test/harness_mcp_seam_guard.test.bash); the agents-only manifest
    # stays this fixture's primary, structural guard and the refusal is the
    # belt — it would fire only if an MCP row ever reached the pass.
    # Pinned by the "fixture safety" test below — do not fold the two manifests
    # back together.
    local compile_manifest="$root/.td388-compile-agents-only.json"
    cat > "$compile_manifest" <<EOF
{
  "version": 1,
  "agents": $agents_json
}
EOF
    IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" \
      bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" \
        --project-root "$root" \
        --manifest "$compile_manifest" \
        --surface agents \
        --target claude >/dev/null
  fi

  echo "$root"
}

# add_sibling_worktree <repo_root> <slug>
#   Sets TD388_SIBLING and returns NON-ZERO if the worktree is not live.
#
# It deliberately does NOT echo the path, so it cannot be called inside `$( )`
# — a helper in a command substitution runs in a subshell and its failure is
# invisible to the test. Every caller must write:
#
#     add_sibling_worktree "$root" <slug> || return 1
#     sib="$TD388_SIBLING"
#
# WHY THE ASSERTION LIVES IN THE HELPER. A test whose premise is "a LIVE
# sibling worktree exists" proves nothing if `git worktree add` silently
# failed: W5b would quietly degrade into W2 (agent drift, NO sibling -> FATAL)
# and still pass. That is not hypothetical — sentinel hit exactly this failure
# mode from a concurrent bats run, because test_helper.bash uses
# TEST_TEMP_DIR="$BATS_TMPDIR/igris-test-$$" with an rm -rf teardown, so two
# runs delete each other's live fixtures (TD-387). Putting the check in one
# place makes it impossible for a new test to forget it.
add_sibling_worktree() {
  local root="$1"
  local sib="$TEST_TEMP_DIR/td388_sib_${2}_$BATS_TEST_NUMBER"
  git -C "$root" worktree add -q -b "td388-$2-$BATS_TEST_NUMBER" "$sib" >/dev/null 2>&1
  if [ ! -d "$sib" ]; then
    echo "FIXTURE PRECONDITION FAILED: sibling worktree not live at $sib" >&2
    return 1
  fi
  TD388_SIBLING="$sib"
  return 0
}

# write_mcp_config <file> <args0> [extra_env_json]
# Writes an on-disk claude entry that matches the expected shape EXCEPT for
# args[0] (and, when given, an extra env key).
write_mcp_config() {
  local cfg="$1"
  local args0="$2"
  # NOT `${3:-{\}}` — bash 3.2 (the macOS system bash this suite runs under)
  # leaves the backslash in, producing `{\}` and therefore an UNPARSEABLE
  # config. Every 2-arg caller would then get a `config unparseable` DRIFTED
  # and a FATAL, i.e. the negative tests would pass for the wrong reason.
  local extra_env="$3"
  [ -n "$extra_env" ] || extra_env='{}'
  cat > "$cfg" <<EOF
{
  "mcpServers": {
    "igris-brain": {
      "args": ["$args0"],
      "command": "node",
      "env": $extra_env,
      "type": "stdio"
    }
  }
}
EOF
}

# run_wrapper <repo_root> <config> [extra env assignments...]
run_wrapper() {
  local root="$1"
  local cfg="$2"
  shift 2
  run bash -c "cd '$root' && IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' IGRIS_CLI=false \
    IGRIS_MCP_CLAUDE_CONFIG='$cfg' $* bash scripts/validate_harness_drift.sh"
}

# --- W1: the core case ------------------------------------------------------

@test "TD-388 W1: args-only MCP drift + a live sibling worktree -> WORKTREE NOTICE, exit 0" {
  local root sib cfg
  root="$(build_mcp_repo w1)"
  add_sibling_worktree "$root" w1 || return 1
  sib="$TD388_SIBLING"
  # The config lives OUTSIDE the repo (condition 3), like the real
  # home-anchored ~/.claude.json it stands in for.
  cfg="$TEST_TEMP_DIR/td388_cfg_w1_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  # The guard still renders the honest DRIFTED verdict — the exemption is a
  # wrapper-level reclassification, never a rewritten guard verdict.
  [[ "$output" == *"[mcp/igris-brain/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"differing key(s): args"* ]] || return 1
  # ...and the wrapper downgrades it, loudly.
  [[ "$output" == *"WORKTREE NOTICE: 1 MCP entry/entries DRIFTED"* ]] || return 1
  [[ "$output" != *"FATAL"* ]] || return 1
  # The NOTICE names the config and BOTH worktrees (AC-4: never a green line).
  [[ "$output" == *"$cfg"* ]] || return 1
  [[ "$output" == *"$sib"* ]] || return 1
  [[ "$output" == *"$root"* ]] || return 1
  [[ "$output" == *"mcp-unregistered"* ]] || return 1
}

@test "TD-388 W1b: the NOTICE warns against the destructive remedy" {
  # The gate used to RECOMMEND `igris harness compile`, which rewrites the
  # SHARED config and re-points the other worktree's live MCP server. In the
  # exempt state the wrapper must say the opposite.
  local root sib cfg
  root="$(build_mcp_repo w1b)"
  add_sibling_worktree "$root" w1b || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w1b_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"DO NOT run"* ]] || return 1
  [[ "$output" == *"whichever worktree wrote this config last"* ]] || return 1
  [[ "$output" == *"IGRIS_DRIFT_STRICT_WORKTREE=1"* ]] || return 1
}

@test "TD-388 W1c: command-only drift is exempt too (add-mcp fuses the path into command)" {
  # `add-mcp "node <path>"` registers the artifact path INSIDE `command`, and
  # opencode's native shape does the same by design — so `command` is in the
  # allowlist. This is the arm check for that half of PATH_KEYS.
  local root sib cfg
  root="$(build_mcp_repo w1c)"
  add_sibling_worktree "$root" w1c || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w1c_$BATS_TEST_NUMBER.json"
  cat > "$cfg" <<EOF
{
  "mcpServers": {
    "igris-brain": {
      "args": ["$TD388_CANON_ARG"],
      "command": "node $sib/cli/dist/index.js",
      "env": {},
      "type": "stdio"
    }
  }
}
EOF

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"differing key(s): command"* ]] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1
  [[ "$output" != *"FATAL"* ]] || return 1
}

# --- W2: the consumer / CI control ------------------------------------------

@test "TD-388 W2: the SAME drift with NO sibling worktree is still FATAL -> exit 1" {
  # Every consumer machine and every CI runner has exactly one worktree, so
  # condition 1 is false there and behaviour is unchanged. This is the control
  # that says the exemption is about worktree STATE, not about the drift shape.
  local root cfg
  root="$(build_mcp_repo w2)"
  cfg="$TEST_TEMP_DIR/td388_cfg_w2_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "/some/other/checkout/cli/dist/index.js"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"differing key(s): args"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W3: AC-6, a removed worktree cannot report exempt forever --------------

@test "TD-388 W3a: removing the sibling worktree makes the same drift FATAL again" {
  local root sib cfg
  root="$(build_mcp_repo w3a)"
  add_sibling_worktree "$root" w3a || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w3a_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  # Arm check: exempt BEFORE the removal, so the FATAL after it is attributable
  # to the removal and not to a fixture that never qualified.
  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1

  git -C "$root" worktree remove --force "$sib" >/dev/null 2>&1
  [ ! -d "$sib" ] || return 1

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

@test "TD-388 W3b: a PRUNABLE (dir deleted, still registered) sibling does not count" {
  # git still LISTS the worktree here. The exemption is keyed on the isdir test
  # rather than the porcelain `prunable` field, so a half-removed worktree stops
  # counting immediately.
  local root sib cfg
  root="$(build_mcp_repo w3b)"
  add_sibling_worktree "$root" w3b || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w3b_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1

  rm -rf "$sib"
  # Arm check on the fixture's premise: git must STILL list it, else this test
  # would be W3a in disguise.
  run git -C "$root" worktree list --porcelain
  [[ "$output" == *"$sib"* ]] || return 1

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W4: condition 4, only build-artifact path keys ------------------------

@test "TD-388 W4a: an env.* -only divergence is NOT excused -> FATAL" {
  local root sib cfg
  root="$(build_mcp_repo w4a)"
  add_sibling_worktree "$root" w4a || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w4a_$BATS_TEST_NUMBER.json"
  # args MATCH the canonical; only env diverges.
  write_mcp_config "$cfg" "$TD388_CANON_ARG" '{"SOMETHING":"injected"}'

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"differing key(s): env.SOMETHING"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

@test "TD-388 W4b: args PLUS a shape key is NOT excused (subset, not intersection)" {
  # The condition is `keys ⊆ {args, command}`. A drift that includes a path key
  # AND a shape key must stay fatal — an implementation that merely asked
  # "does args appear?" would pass W1/W4a and fail here.
  local root sib cfg
  root="$(build_mcp_repo w4b)"
  add_sibling_worktree "$root" w4b || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w4b_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js" '{"SOMETHING":"injected"}'

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"args,env.SOMETHING"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W5: the agent surface stays fatal, held JOINTLY by conditions 2, 3, 4 ---

@test "TD-388 W5: a real AGENT drift stays FATAL while the MCP NOTICE still prints" {
  # WHAT THIS PINS: an agent DRIFTED block is never exempted. It does NOT pin
  # any single condition, and two earlier versions of this comment claimed it
  # did — first condition 3, then condition 4. Both were refuted by mutation.
  #
  # The measured attribution is a SUFFICIENCY LATTICE (full table in the block
  # comment at the top of this section). Conditions 2, 3 and 4 are each
  # independently sufficient to reject an agent block, so turning any ONE — or
  # any TWO — of them off leaves this test GREEN; only {2,3,4} together reds it.
  # Concretely — naming the mutation operator, because a reds set can depend on
  # which one you use: DELETING CONDITION 4'S WHOLE CONJUNCT (both
  # `keys is not None` and the subset test; the same operator named at :1509 and
  # by "Deleting the whole condition" in validate_harness_drift.sh's
  # per-condition population list) reds W4a/W4b/W6 and NOT this test;
  # disabling conditions 2+3 reds W9/W9b and NOT this test. Those reds sets are
  # measured for those operators and are not claimed for any narrower one. The
  # half that holds regardless is "and NOT this test", which is what W5 is about.
  #
  # So do not read a green W5 as evidence for any one condition. Read it as
  # what it is: the end-to-end assertion that the agent surface is not excused,
  # plus the assertion below that neither signal eats the other — one FATAL for
  # the agent, and the MCP row still reported as exempt.
  local root sib cfg
  root="$(build_mcp_repo w5 agent)"
  add_sibling_worktree "$root" w5 || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w5_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  # Repoint the compiled agent symlink OUTSIDE the loadout -> genuine DRIFTED.
  mkdir -p "$root/elsewhere"
  echo "stale" > "$root/elsewhere/forger.md"
  rm -f "$root/.claude/agents/forger.md"
  ln -s "$root/elsewhere/forger.md" "$root/.claude/agents/forger.md"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[forger/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  # ...and the MCP row is STILL reported as exempt, not swallowed by the FATAL.
  [[ "$output" == *"WORKTREE NOTICE: 1 MCP entry/entries DRIFTED"* ]] || return 1
}

@test "TD-388 W5b: an agent-ONLY drift with a live sibling worktree is FATAL" {
  # W5 with the MCP variable removed, so the agent verdict is the only thing
  # the exit code can be attributed to. Like W5, it pins the OUTCOME (an agent
  # DRIFTED is never exempted) and not any single condition — conditions 2, 3
  # and 4 are each independently sufficient to produce it; see W5's comment
  # and the lattice at the top of this section.
  #
  # The `add_sibling_worktree … || return 1` above is load-bearing here:
  # without a LIVE sibling this test silently degrades into W2 (agent drift,
  # no sibling -> FATAL) and would pass while proving nothing.
  local root sib cfg
  root="$(build_mcp_repo w5b agent)"
  add_sibling_worktree "$root" w5b || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w5b_$BATS_TEST_NUMBER.json"
  # MCP entry matches canonical exactly -> the ONLY DRIFTED is the agent.
  write_mcp_config "$cfg" "$TD388_CANON_ARG"

  mkdir -p "$root/elsewhere"
  echo "stale" > "$root/elsewhere/forger.md"
  rm -f "$root/.claude/agents/forger.md"
  ln -s "$root/elsewhere/forger.md" "$root/.claude/agents/forger.md"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  [[ "$output" == *"[forger/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W6: a DRIFTED with no `differing key(s)` clause at all ----------------

@test "TD-388 W6: an unparseable config DRIFTED has no key list -> FATAL" {
  # parse_differing_keys returns None here (not the empty set), which fails
  # condition 4. Same for `internal compare error` and MISSING_SECRET.
  local root sib cfg
  root="$(build_mcp_repo w6)"
  add_sibling_worktree "$root" w6 || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w6_$BATS_TEST_NUMBER.json"
  printf '{ this is not json' > "$cfg"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"config unparseable"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W7: the strict escape hatch -------------------------------------------

@test "TD-388 W7: IGRIS_DRIFT_STRICT_WORKTREE=1 restores full strictness" {
  local root sib cfg
  root="$(build_mcp_repo w7)"
  add_sibling_worktree "$root" w7 || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w7_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$sib/cli/dist/index.js"

  # Arm check: exempt WITHOUT the flag, so the FATAL below is attributable to
  # the flag rather than to a fixture that never qualified.
  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1

  run_wrapper "$root" "$cfg" "IGRIS_DRIFT_STRICT_WORKTREE=1"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W8: the pathline_re no-op regression ----------------------------------

@test "TD-388 W8: an ABSENT MCP entry is still an out-of-scope MISSING NOTICE" {
  # TD-388 taught pathline_re the `config` label, which mcp/* blocks print.
  # BEFORE the change an MCP MISSING classified with path="" ->
  # is_project_relative("") is False -> oos_missing. AFTER it, the label
  # resolves the out-of-repo config path -> still not under REPO_ROOT -> still
  # oos_missing. This test exists solely to hold that no-op.
  local root sib cfg
  root="$(build_mcp_repo w8)"
  add_sibling_worktree "$root" w8 || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w8_$BATS_TEST_NUMBER.json"
  printf '{ "mcpServers": {} }' > "$cfg"

  run_wrapper "$root" "$cfg"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MISSING"* ]] || return 1
  [[ "$output" == *"NOTICE: 1 out-of-scope"* ]] || return 1
  [[ "$output" != *"FATAL"* ]] || return 1
  # A MISSING is NOT a worktree exemption — it never reaches that branch.
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- fixture safety (the TD-388 build incident) ----------------------------

@test "TD-388 fixture safety: the compile-time manifest declares no MCP surface" {
  # The incident: build_mcp_repo <slug> agent used to hand the FULL manifest to
  # compile_harnesses.sh. Compile's MCP pass writes the harness config at its
  # DEFAULT home path — the IGRIS_MCP_*_CONFIG seams are drift-side only — so
  # the fixture's canonical `args` were merged into the operator's real
  # ~/.claude.json. This test pins the structural fix: whatever manifest
  # compile is handed must contain no MCP surface at all, so no flag, no
  # refactor and no future pass can turn it into a real config write.
  # Since TD-390 compile REFUSES its MCP pass when any IGRIS_MCP_*_CONFIG is
  # set (test/harness_mcp_seam_guard.test.bash); that refusal is the belt —
  # this agents-only manifest remains the primary, structural guard.
  local root
  root="$(build_mcp_repo fixsafe agent)"

  local compile_manifest="$root/.td388-compile-agents-only.json"
  [ -f "$compile_manifest" ] || return 1
  run grep -c "mcp_servers" "$compile_manifest"
  [ "$status" -ne 0 ] || return 1          # grep exits 1 on zero matches
  run grep -c "surfaces" "$compile_manifest"
  [ "$status" -ne 0 ] || return 1

  # Arm check: the DRIFT manifest — a different file — DOES declare it, so the
  # assertion above is about the compile input and not about an empty fixture.
  run grep -c "mcp_servers" "$root/harness-manifest.json"
  [ "$status" -eq 0 ] || return 1

  # And the agent target really was compiled, so `--surface agents` did its job.
  [ -L "$root/.claude/agents/forger.md" ] || return 1
}

# --- W9: condition 3, the ONLY test that guards it -------------------------

@test "TD-388 W9: identical drift is exempt OUTSIDE the repo and FATAL INSIDE it" {
  # CONDITION 3's behavioural pair. Everything is held constant — same
  # args-only divergence, same live sibling worktree, same manifest, same
  # canonical — and the ONLY variable is where the MCP config FILE lives.
  #
  # Why a pair and not a single assertion: an in-repo-config test on its own
  # cannot tell "condition 3 rejected it" from "the fixture never qualified in
  # the first place". The outside arm IS the arm check, and it runs first.
  #
  # This is the test that was missing. Before it existed, THREE mutations of
  # condition 3 — swapping it for `not is_project_relative(path)`, hardwiring
  # it True, and deleting condition 2 alongside either — all survived the
  # complete suite. A condition with no reachable red state is not a guard.
  local root sib cfg_out cfg_in
  root="$(build_mcp_repo w9)"
  add_sibling_worktree "$root" w9 || return 1
  sib="$TD388_SIBLING"

  # --- arm A: config OUTSIDE the repo -> exempt -----------------------------
  cfg_out="$TEST_TEMP_DIR/td388_cfg_w9_out_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg_out" "$sib/cli/dist/index.js"
  run_wrapper "$root" "$cfg_out"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"differing key(s): args"* ]] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1
  [[ "$output" != *"FATAL"* ]] || return 1

  # --- arm B: byte-identical config INSIDE the repo -> FATAL ----------------
  mkdir -p "$root/inrepo"
  cfg_in="$root/inrepo/claude.json"
  write_mcp_config "$cfg_in" "$sib/cli/dist/index.js"
  # Prove the two configs really are byte-identical, so the ONLY difference
  # the wrapper can be reacting to is the path.
  run cmp -s "$cfg_out" "$cfg_in"
  [ "$status" -eq 0 ] || return 1

  run_wrapper "$root" "$cfg_in"
  [ "$status" -eq 1 ] || return 1
  # Same guard verdict, same key list — only the classification changed.
  [[ "$output" == *"differing key(s): args"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

@test "TD-388 W9b: a RELATIVE config path is never exempt, even resolving outside the repo" {
  # The second half of condition 3, and the half that separates is_out_of_repo
  # from the naive `not is_project_relative(path)`: the ABSOLUTE clause.
  #
  # The two predicates agree on every ABSOLUTE path, so W9 alone cannot tell
  # them apart — swapping in the naive inversion survives W9. They diverge on a
  # path that is not absolute, and `../outside.json` is an ACCEPTED INPUT to
  # the guard: IGRIS_MCP_CLAUDE_CONFIG is read as given, with no absoluteness
  # check. Scope of that claim, measured: it is an input CLASS, not an observed
  # operator practice — every default config path is absolute, no CLI verb or
  # skill sets the var, and it is documented only as the test-sandbox seam.
  #
  # The mandated rule is NON-EMPTY *and* ABSOLUTE *and* outside the repo, i.e.
  # a config the wrapper cannot resolve independently of the caller's cwd is
  # deliberately NOT trusted to be out-of-repo, and stays FATAL. The naive
  # inversion resolves it against cwd and exempts it — silent widening.
  local root sib outside_dir cfg_abs
  root="$(build_mcp_repo w9b)"
  add_sibling_worktree "$root" w9b || return 1
  sib="$TD388_SIBLING"

  # The config file sits OUTSIDE the repo; only its NOTATION varies between the
  # two arms below.
  outside_dir="$(dirname "$root")"
  cfg_abs="$outside_dir/td388_w9b_outside_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg_abs" "$sib/cli/dist/index.js"

  # --- arm A (control): named ABSOLUTELY -> exempt --------------------------
  run_wrapper "$root" "$cfg_abs"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WORKTREE NOTICE"* ]] || return 1

  # --- arm B: the SAME FILE named RELATIVELY -> FATAL -----------------------
  run_wrapper "$root" "../$(basename "$cfg_abs")"
  [ "$status" -eq 1 ] || return 1
  # Arm check on the fixture: the relative name really did reach the same file,
  # so the guard produced the same drift and only the classification differs.
  [[ "$output" == *"differing key(s): args"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
}

# --- W10 (BR-099): a test-fixture MCP entry is FATAL beside a live sibling --

@test "BR-099 W10: a test-fixture MCP entry is FATAL at the commit gate even with a live sibling worktree (no WORKTREE NOTICE)" {
  # The verify_mcp mcp-fixture arm (check_harness_drift.sh) emits
  # `[mcp-fixture/<name>/<harness>] DRIFTED` + `config :` with a reason that
  # carries NO `differing key(s)` clause, so parse_differing_keys returns None
  # and condition 4 fails — the W6 route — while conditions 1–3 all HOLD here
  # (live sibling, an mcp* block name would not even matter, out-of-repo
  # config). igris-brain itself MATCHes (args[0] = canonical), so the ONE
  # fatal verdict is the fixture's: a leaked test fixture in a real harness
  # config can never ride the TD-388 exemption. The entry is the reality
  # shape extracted from the pre-BR-099 backup (2026-09-04).
  local root sib cfg
  root="$(build_mcp_repo w10)"
  add_sibling_worktree "$root" w10 || return 1
  sib="$TD388_SIBLING"
  cfg="$TEST_TEMP_DIR/td388_cfg_w10_$BATS_TEST_NUMBER.json"
  write_mcp_config "$cfg" "$TD388_CANON_ARG"
  python3 - "$cfg" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["mcpServers"]["demo-mcp"] = {"args": ["-y", "evil"], "command": "npx", "env": {"API": "${API_TOKEN}"}}
json.dump(d, open(p, "w"))
PY

  run_wrapper "$root" "$cfg"
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  [[ "$output" == *"[mcp-fixture/demo-mcp/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"FATAL: 1 harness(es) DRIFTED"* ]] || return 1
  [[ "$output" != *"WORKTREE NOTICE"* ]] || return 1
  if printf '%s\n' "$output" | grep 'differing key(s)' >/dev/null; then return 1; fi
  # The premise held for the whole run: the sibling was live.
  [ -d "$sib" ] || return 1
}
