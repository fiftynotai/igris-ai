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
  # ~/.igris/registry/harness-manifest.personal.json (FR-146 leaves this in
  # place between runs; without isolation it merges into every test's
  # manifest and breaks synthetic-root tests).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  # Per-test scratch project root.
  PROJ="$TEST_TEMP_DIR/harness_drift_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  # A canonical agent prompt (frontmatter + body). The guard compares the
  # BODY sha, so the body is what matters.
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

  # A pre-existing harness file with its own frontmatter (sync, not create).
  cat > "$PROJ/.claude/agents/sample.md" <<'EOF'
---
name: sample
description: harness frontmatter (authored by hand, preserved on sync)
tools: Read, Edit
---

placeholder body — will be overwritten by compile
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
  # Compile first so the harness body == canonical body.
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" == *"1 targets — 1 in sync, 0 drifted/missing"* ]]
}

@test "drifted harness body yields exit 1 and DRIFTED" {
  # Compile to a clean MATCH state, then mutate the harness body.
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$MANIFEST" --target claude
  [ "$status" -eq 0 ]

  # Append a stray line to the harness body -> body sha diverges from canon.
  printf '\n- injected drift line\n' >> "$PROJ/.claude/agents/sample.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] DRIFTED"* ]]
  [[ "$output" == *"body sha mismatch"* ]]
  [[ "$output" == *"1 targets — 0 in sync, 1 drifted/missing"* ]]
}

@test "never-compiled harness yields exit 1 and MISSING, not a false DRIFTED" {
  # Remove the harness file entirely (simulates a gitignored harness on a
  # fresh clone that was never compiled). OD-4: this must be MISSING, not
  # DRIFTED, so the operator is told to COMPILE rather than chase a phantom
  # body diff.
  rm -f "$PROJ/.claude/agents/sample.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$MANIFEST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[sample/claude] MISSING"* ]]
  [[ "$output" == *"harness file absent"* ]]
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
    # No harness file at all -> guard reports MISSING.
    :
  else
    # Pre-existing harness with its own frontmatter, then compile to MATCH.
    cat > "$root/.claude/agents/forger.md" <<'EOF'
---
name: forger
description: harness frontmatter preserved on sync
tools: Read, Edit
---

placeholder
EOF
    bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" \
      --project-root "$root" \
      --manifest "$root/harness-manifest.json" \
      --target claude >/dev/null
    if [ "$state" = "drifted" ]; then
      printf '\n- injected drift\n' >> "$root/.claude/agents/forger.md"
    fi
  fi

  echo "$root"
}

@test "wrapper: DRIFTED harness is FATAL -> exit 1" {
  local root
  root="$(build_wrapper_repo drifted)"

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
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

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
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

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
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

  run bash -c "cd '$root' && bash scripts/validate_harness_drift.sh"
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
# IGRIS_BRAIN_DIR's registry/body-exceptions/ dir (already exported by
# setup()), a manifest declaring the agent with `body_exception` +
# `layer: "personal"` (so the sidecar resolves under the isolated brain dir,
# NOT the live in-repo body-exceptions/) + the requested target. Echoes the
# project root path.
build_td193_repo() {
  local ttype="$1"
  local root="$TEST_TEMP_DIR/td193_${ttype}_$BATS_TEST_NUMBER"
  mkdir -p "$root/canon" "$IGRIS_BRAIN_DIR/registry/body-exceptions"

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

  # Body-exception sidecar under the isolated brain's registry dir. The
  # `personal` layer keys sidecar resolution to
  # IGRIS_BRAIN_DIR/registry/body-exceptions/<name>.json — see
  # check_harness_drift.sh:327 + compile_harnesses.sh:286.
  cat > "$IGRIS_BRAIN_DIR/registry/body-exceptions/test_excerpt.json" <<'EOF'
{
  "anchor": "## CONSTRAINTS",
  "insert": ["", "Extra rule for the appendix.", ""]
}
EOF

  if [ "$ttype" = "claude" ]; then
    mkdir -p "$root/.claude/agents"
    # Pre-existing harness frontmatter (sync, not create).
    cat > "$root/.claude/agents/sample.md" <<'EOF'
---
name: sample
description: harness frontmatter preserved on sync
tools: Read, Edit
---

placeholder body — will be overwritten by compile
EOF
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
  # Proves the gate did not regress the claude path: claude + body_exception
  # must still compile WITH the appendix and the guard must still recognize
  # canonical+appendix as the expected body. If the gate accidentally
  # bypasses the appendix for claude this test would false-DRIFT.
  local root
  root="$(build_td193_repo claude)"

  run bash "$COMPILE" --project-root "$root" \
                      --manifest "$root/harness-manifest.json" \
                      --target claude
  [ "$status" -eq 0 ]

  run bash "$GUARD" --project-root "$root" \
                      --manifest "$root/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[sample/claude] MATCH"* ]]
  [[ "$output" != *"DRIFTED"* ]]
}
