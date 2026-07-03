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
  # The dominant FR-138 risk: the guard always checks BOTH surfaces and the
  # skills surface includes a HOME-PATH gemini target (~/.gemini/commands). On
  # a machine that never projected gemini TOMLs that target is MISSING, but it
  # must NOT hard-fail the commit gate — it is out of the gate's scope. Build a
  # repo whose project-relative agent is in sync (MATCH) and whose ONLY MISSING
  # verdict is a home-path skills target.
  local root
  root="$(build_wrapper_repo match)"

  # Point the gemini skills source at a guaranteed-empty temp skills root so the
  # converter finds zero SKILL.md files and the artifact dir is a home path that
  # is reported MISSING (no projected {name}.toml). Inject a skills surface into
  # the project manifest with a ~-path target.
  local empty_skills="$TEST_TEMP_DIR/empty_skills_$BATS_TEST_NUMBER"
  mkdir -p "$empty_skills/placeholder"
  cat > "$empty_skills/placeholder/SKILL.md" <<'EOF'
---
name: placeholder
description: a placeholder skill so the converter has one target
---
body
EOF

  python3 - "$root/harness-manifest.json" "$empty_skills" <<'PY'
import json
import sys

path = sys.argv[1]
skills_src = sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    m = json.load(fh)
m["surfaces"] = {
    "skills": {
        "source": skills_src,
        "layer": "core",
        "targets": [
            {"type": "gemini", "method": "converter", "path": "~/.gemini/commands"}
        ],
    }
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(m, fh, indent=2)
PY

  run bash -c "cd '$root' && IGRIS_BRAIN_DIR='$ISOLATED_BRAIN' bash scripts/validate_harness_drift.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[forger/claude] MATCH"* ]]
  # The home-path gemini target is reported MISSING by the guard...
  [[ "$output" == *"[skills/gemini] MISSING"* ]]
  # ...but the wrapper classifies it OUT OF SCOPE: NOTICE, never FATAL.
  [[ "$output" == *"NOTICE:"* ]]
  [[ "$output" == *"out-of-scope"* ]]
  [[ "$output" != *"FATAL"* ]]
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
  tgt_inode=$(stat -f %i "$target")
  src_inode=$(stat -f %i "$source")
  src_nlink=$(stat -f %l "$source")
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
  # Pre-create a symlink pointing OUTSIDE the loadout — simulates pre-TD-208
  # legacy state. Under TD-208, ANY symbolic link at the gemini target is
  # DRIFTED (the primitive is hard link; Gemini loader does not follow
  # symlinks). The non-loadout-anchored detail is irrelevant — even a
  # loadout-anchored symlink would be drift.
  mkdir -p "$root/consumer-side"
  echo "stale" > "$root/consumer-side/demo.md"
  ln -s "$root/consumer-side/demo.md" "$root/.gemini/agents/demo.md"

  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[demo/gemini] DRIFTED"* ]]
  [[ "$output" == *"symbolic link"* ]]
  [[ "$output" == *"legacy pre-TD-208 emit"* ]]
  [[ "$output" == *"igris harness compile"* ]]
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
  first_inode=$(stat -f %i "$loadout_path")
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
  second_inode=$(stat -f %i "$loadout_path")
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
  [ "$(md5 -q "$target")" = "$(md5 -q "$loadout_path")" ]
  [ "$(stat -f %i "$target")" != "$(stat -f %i "$loadout_path")" ]

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
  [ "$(md5 -q "$target")" != "$(md5 -q "$loadout_path")" ]
  [ "$(stat -f %i "$target")" != "$(stat -f %i "$loadout_path")" ]

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
