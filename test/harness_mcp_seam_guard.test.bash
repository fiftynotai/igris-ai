#!/usr/bin/env bats

# harness_mcp_seam_guard.test.bash — TD-390: IGRIS_MCP_<HARNESS>_CONFIG is a
# READ-ONLY drift seam; the MCP WRITER refuses under it, and HOME sandboxes it.
#
# THE INCIDENT (TD-388, 2026-08-14, L-1298). `IGRIS_MCP_<HARNESS>_CONFIG`
# redirects the drift READER (`check_harness_drift.sh`, the `verify_mcp` per-
# harness `case`) to a sandbox config. The WRITER chain —
# `compile_harnesses.sh#project_mcp` → `igris loadout project-mcp` → the
# `add-mcp` delegate + the no-prompt grant — has never read it: `add-mcp`
# resolves `join(homedir(), ".claude.json")` at module load and exposes no
# path flag, so `$HOME` is the ONLY thing that steers it. A fixture that set
# the seam and invoked compile therefore merged its canonical `args` into the
# operator's REAL ~/.claude.json (`mcpServers.igris-brain.args[0]` became a
# non-existent fixture path).
#
# THE FIX (TD-390, option 2 — refuse). `project_mcp` sweeps `${!IGRIS_MCP_@}`
# for any `*_CONFIG` name with a non-empty value and, when there are MCP rows to
# project, refuses the pass: one stderr ERROR line + a counted
# `FAIL  mcp/<name>/<harness> — refused: <VAR> is set (read-only drift seam;
# TD-390)` row per target + exit 1. `IGRIS_MCP_ENGINE` (the retired engine
# knob that `cli/tests/integration/fr212-smoke.sh` still exports) is NOT a
# seam and does not trip it. A sandboxed WRITE is an isolated HOME.
#
# SAFETY — READ BEFORE EDITING. Every test here runs under a FENCED HOME
# (`$FENCE_HOME`, mkdir'd under $TEST_TEMP_DIR). The "operator's real config"
# that the RED demonstration mutates is a STAND-IN at `$FENCE_HOME/.claude.json`,
# never `$REAL_HOME/.claude.json`. Three belts, per test_standards ("the fence
# is ARMED, not assumed"):
#   1. `setup()` exports HOME=$FENCE_HOME AND every `run` passes HOME=$FENCE_HOME
#      explicitly through `env`.
#   2. `assert_armed` opens EVERY test: HOME is the fence, HOME is not the real
#      home, and the stand-in exists.
#   3. `assert_real_config_untouched` (T1, T4, T6 — the tests that reach the
#      real writer) compares a READ-ONLY sha256 of `$REAL_HOME/.claude.json`
#      taken in `setup()` against one taken after the run.
# RED root-coincidence (test_standards, TD-414): the OLD compile writes under
# `$HOME`; this fixture fences `HOME`, so old and new code share ONE root and
# the RED is not vacuous. The seam points at a DISTINCT file (`$SEAM_CFG`) so
# "the writer ignored the seam" is separately observable (`cmp` before/after).
#
# Tests:
#   T1  RED, encoded permanently as the M1 kill: a guard-DELETED mutant of
#       compile_harnesses.sh, seam set, rewrites the stand-in's
#       `mcpServers.igris-brain.args[0]` and leaves the seam file untouched.
#   T2  GREEN (AC-2): the real compile, seam set → refused (exit 1, both
#       literals), stand-in byte-identical (whole-file cmp + mcpServers sha256),
#       no grant written, `1 targets — 0 ok, 1 failed`.
#   T3  any-harness seam refuses (IGRIS_MCP_CODEX_CONFIG with a claude row).
#   T4  sandboxed under a fenced HOME; IGRIS_MCP_ENGINE=delegate is not a seam.
#       ALSO the suite's positive control that the writer is LIVE here.
#   T5  scoping: seam + `--surface agents` and seam + agents-only manifest do
#       NOT refuse (guard lives inside project_mcp, on non-empty MCP_ROWS).
#   T6  an EMPTY seam value is unset on both sides (mirrors `${VAR:-default}`).
#
# RED RUN, RECORDED VERBATIM (branch develop @ e7435d0, 2026-09-04, this file
# run BEFORE the guard existed — `grep -c TD-390 compile_harnesses.sh` = 0):
#   T2 FAILED: `[ "$status" -eq 1 ]` — the unfixed compile exited 0 with
#       `OK    mcp/igris-brain/claude (delegate)`; the HOME-fenced stand-in
#       `$FENCE_HOME/.claude.json` changed: `mcpServers.igris-brain.args[0]`
#       went `/real/bundle/cli/dist/index.js` → `/canonical/checkout/cli/dist/index.js`
#       (the TD-388 transition, the same field); the `mcpServers` sha256 went
#       9fcf425efc69d9f90c3de9ae8b167a0e4f9e376b0913f2ff4ac4ccc9297b9021 →
#       22c84404267c44c05e4f5b658ae025e08489e47061a7257e53d33db0a81155bc; and
#       `$SEAM_CFG` stayed cmp-identical to its seed ("seam file: unchanged" —
#       the writer ignored the seam).
#   T3 FAILED the same way under IGRIS_MCP_CODEX_CONFIG (same field transition).
#   T1, T4, T5, T6 passed (T1 IS the pre-fix behaviour; T5 is vacuous on the
#   old code; T4/T6 = HOME sandboxing already worked). The real
#   `$REAL_HOME/.claude.json` sha256 was identical before and after the run.
#   After the fix: 6/6 ok. Battery (scratch copies through TD390_ADAPTERS_DIR):
#   M1 guard deleted → T2,T3 red; M2 claude-only filter → T3; M3 `continue`
#   removed → T2,T3; M4 sweep hoisted to script top → T5 (and T1); M5 `*_CONFIG`
#   widened to `*` → T4; M6 comment-only control → 6/6 green.
#   (Exact bats lines are in TD-390's Agent Log.)
#
# CI: the L-552 skip literal below (`cli/dist/index.js missing`) is the needle
# `.github/workflows/test.yml` derives the `cli-bats` leg from — this file
# auto-joins that job after `Build CLI` and skips in the root matrix by design.
# Run with `bats test/harness_mcp_seam_guard.test.bash` (never `bash`).

load test_helper

# Captured at FILE LOAD, before setup() re-points HOME at the fence. Every
# "real config" belt below compares against this, read-only.
REAL_HOME="$HOME"

setup() {
  # TD390_ADAPTERS_DIR is the mutation-battery seam (the TD388_WRAPPER_SRC
  # idiom): point it at a scratch `<root>/core/scripts/cli-adapters` copy to
  # run T2–T6 against a mutant without touching the repo file. Unset = repo.
  ADAPTERS="${TD390_ADAPTERS_DIR:-$IGRIS_ROOT/core/scripts/cli-adapters}"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  require_python3

  CLI_ENTRY="$IGRIS_ROOT/cli/dist/index.js"
  [ -f "$CLI_ENTRY" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  command -v node >/dev/null 2>&1 || skip "node not available"
  [ -d "$IGRIS_ROOT/node_modules/add-mcp" ] || skip "add-mcp not installed (pinned dep)"

  # No seam may leak in from the caller's environment: T4/T6 assert the writer
  # PROCEEDS, which an inherited IGRIS_MCP_*_CONFIG would falsify.
  local _v
  for _v in "${!IGRIS_MCP_@}"; do unset "$_v"; done

  # The fence: plays the operator's HOME. `.claude/` pre-created (add-mcp/grant
  # parent, per harness_mcp.test.bash).
  FENCE_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$FENCE_HOME/.claude"
  STANDIN="$FENCE_HOME/.claude.json"
  cat > "$STANDIN" <<'EOF'
{"theme":"dark","mcpServers":{"igris-brain":{"command":"node","args":["/real/bundle/cli/dist/index.js"],"env":{},"type":"stdio"}}}
EOF
  cp "$STANDIN" "$STANDIN.before"

  # Where the seam points: elsewhere, on purpose (a DISTINCT file).
  SEAM_CFG="$TEST_TEMP_DIR/seam_$BATS_TEST_NUMBER.json"
  printf '{"mcpServers":{}}\n' > "$SEAM_CFG"
  cp "$SEAM_CFG" "$SEAM_CFG.before"

  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN/loadout"

  PROJ="$TEST_TEMP_DIR/proj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
  write_mcp_manifest "$PROJ/harness-manifest.json"

  # Read-only belt on the ONE file the incident damaged. Absent (CI) → no belt.
  REAL_SHA=""
  if [ -f "$REAL_HOME/.claude.json" ]; then
    REAL_SHA="$(shasum -a 256 "$REAL_HOME/.claude.json" | awk '{print $1}')"
  fi

  export HOME="$FENCE_HOME"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"
  export IGRIS_CLI="node $CLI_ENTRY"
}

# --- fixtures ---------------------------------------------------------------

# One igris-brain block, ONE claude target, canonical args[0] = the TD-388
# literal — so the RED transition is the incident's exact field transition.
write_mcp_manifest() {
  cat > "$1" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "igris-brain",
        "canonical": {
          "command": "node",
          "args": ["/canonical/checkout/cli/dist/index.js"],
          "env": {}
        },
        "targets": [
          { "type": "claude", "method": "merge" }
        ]
      }
    ]
  }
}
EOF
}

# No `surfaces` key at all — the TD-388 fixture-safety shape.
write_agents_only_manifest() {
  cat > "$1" <<'EOF'
{
  "version": 1,
  "agents": []
}
EOF
}

# --- helpers ----------------------------------------------------------------

# sha256 of the `mcpServers` subtree (the AC-2 literal form).
mcp_sha() {
  python3 -c 'import json,hashlib,sys
d=json.load(open(sys.argv[1]))
print(hashlib.sha256(json.dumps(d["mcpServers"],sort_keys=True).encode()).hexdigest())' "$1"
}

# mcpServers.igris-brain.args[0] — the field the incident rewrote.
args0() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(d["mcpServers"]["igris-brain"]["args"][0])' "$1"
}

# run_compile <compile-path> <surface> <manifest> [ENV=VAL ...]
# Belt 1: HOME is passed EXPLICITLY on every run, on top of setup()'s export.
run_compile() {
  local compile="$1" surface="$2" manifest="$3"
  shift 3
  run env HOME="$FENCE_HOME" IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" IGRIS_CLI="node $CLI_ENTRY" "$@" \
    bash "$compile" --project-root "$PROJ" --manifest "$manifest" \
      --surface "$surface" --target claude
}

# Belt 2 — the fence is ARMED, not assumed. `|| return 1` on every line:
# a bare non-final `[ ]`/`[[ ]]` cannot fail a bats test (TD-341).
assert_armed() {
  [ "$HOME" = "$FENCE_HOME" ] || { echo "fence NOT armed: HOME=$HOME" >&2; return 1; }
  [ "$HOME" != "$REAL_HOME" ] || { echo "fence NOT armed: HOME is the real home" >&2; return 1; }
  [ -f "$FENCE_HOME/.claude.json" ] || { echo "fence NOT armed: stand-in missing" >&2; return 1; }
  [ "$STANDIN" != "$REAL_HOME/.claude.json" ] || { echo "fence NOT armed: stand-in IS the real file" >&2; return 1; }
}

# Belt 3 — the operator's real file, read-only, before vs after.
assert_real_config_untouched() {
  if [ -z "$REAL_SHA" ]; then
    echo "real-config belt: $REAL_HOME/.claude.json absent — nothing to compare" >&2
    return 0
  fi
  local now
  now="$(shasum -a 256 "$REAL_HOME/.claude.json" | awk '{print $1}')"
  [ "$now" = "$REAL_SHA" ] || {
    echo "REAL CONFIG CHANGED: $REAL_HOME/.claude.json sha256 $REAL_SHA -> $now" >&2
    return 1
  }
}

# mutant_adapters <sed-expr> <expected-TD-390-count-after>
#   Copies the adapters dir to scratch, applies the sed, and asserts the
#   mutation LANDED (the `TD-390` marker count is exactly <after>). Sets
#   MUTANT_COMPILE (a global — no `$( )`, so a failed precondition is visible).
mutant_adapters() {
  local expr="$1" after="$2"
  # The TD-388 fixture layout: the copy must sit at <root>/core/scripts/
  # cli-adapters/ with the real descriptor at <root>/harness-manifest.json,
  # because the adapters resolve the harness descriptor RELATIVE to their own
  # directory (a flat copy fails "harness descriptor not found").
  local root="$TEST_TEMP_DIR/mutroot_$BATS_TEST_NUMBER"
  local dir="$root/core/scripts/cli-adapters"
  rm -rf "$root"
  mkdir -p "$dir"
  cp "$ADAPTERS"/*.sh "$ADAPTERS"/*.json "$dir/"
  cp "$IGRIS_ROOT/harness-manifest.json" "$root/harness-manifest.json"
  local c0 c1
  c0="$(grep -c 'TD-390' "$dir/compile_harnesses.sh" || true)"
  sed -i.bak "$expr" "$dir/compile_harnesses.sh" || return 1
  rm -f "$dir/compile_harnesses.sh.bak"
  c1="$(grep -c 'TD-390' "$dir/compile_harnesses.sh" || true)"
  echo "mutant: TD-390 marker count $c0 -> $c1 (expected $after)" >&2
  [ "$c1" -eq "$after" ] || { echo "mutation did NOT land" >&2; return 1; }
  MUTANT_COMPILE="$dir/compile_harnesses.sh"
}

# Byte-identity of the two files the guard must leave alone.
assert_fence_unchanged() {
  cmp -s "$STANDIN" "$STANDIN.before" || { echo "stand-in CHANGED" >&2; return 1; }
  [ "$(mcp_sha "$STANDIN")" = "$(mcp_sha "$STANDIN.before")" ] || return 1
  cmp -s "$SEAM_CFG" "$SEAM_CFG.before" || { echo "seam file CHANGED" >&2; return 1; }
}

# --- T1: RED, permanent (the M1 kill) ---------------------------------------

@test "TD-390 T1 (RED, permanent): a guard-deleted compile under a seam rewrites the fenced stand-in's args[0] and ignores the seam" {
  assert_armed || return 1
  # M1: delete both marked guard blocks. The LANDED assertion is `count == 0`
  # (the compile under test carries NO guard); T2 proves the REAL compile does.
  mutant_adapters '/TD-390-GUARD-BEGIN/,/TD-390-GUARD-END/d;/TD-390-ROW-BEGIN/,/TD-390-ROW-END/d' 0 || return 1

  run_compile "$MUTANT_COMPILE" mcp "$PROJ/harness-manifest.json" IGRIS_MCP_CLAUDE_CONFIG="$SEAM_CFG"
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"OK    mcp/igris-brain/claude (delegate)"* ]] || return 1
  [[ "$output" != *"refuses the MCP pass"* ]] || return 1

  # THE INCIDENT'S FIELD, in the fence: /real/bundle/… -> /canonical/checkout/…
  [ "$(args0 "$STANDIN.before")" = "/real/bundle/cli/dist/index.js" ] || return 1
  [ "$(args0 "$STANDIN")" = "/canonical/checkout/cli/dist/index.js" ] || return 1
  [ "$(mcp_sha "$STANDIN")" != "$(mcp_sha "$STANDIN.before")" ] || return 1
  # The seam was IGNORED: the file it names is untouched.
  cmp -s "$SEAM_CFG" "$SEAM_CFG.before" || return 1

  assert_real_config_untouched || return 1
}

# --- T2: GREEN (AC-2) -------------------------------------------------------

@test "TD-390 T2 (AC-2): compile under IGRIS_MCP_CLAUDE_CONFIG is REFUSED — exit 1, both literals, stand-in byte-identical, no grant" {
  assert_armed || return 1
  local sha_before
  sha_before="$(mcp_sha "$STANDIN")"

  run_compile "$COMPILE" mcp "$PROJ/harness-manifest.json" IGRIS_MCP_CLAUDE_CONFIG="$SEAM_CFG"
  echo "status=$status" >&2; echo "$output" >&2
  # Printed BEFORE any assertion so a RED run names the field and the seam.
  echo "stand-in args[0]: before=$(args0 "$STANDIN.before") after=$(args0 "$STANDIN")" >&2
  echo "stand-in mcpServers sha256: before=$sha_before after=$(mcp_sha "$STANDIN")" >&2
  if cmp -s "$SEAM_CFG" "$SEAM_CFG.before"; then echo "seam file: unchanged" >&2; else echo "seam file: CHANGED" >&2; fi
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"refuses the MCP pass: IGRIS_MCP_CLAUDE_CONFIG is set"* ]] || return 1
  [[ "$output" == *"FAIL  mcp/igris-brain/claude — refused: IGRIS_MCP_CLAUDE_CONFIG is set (read-only drift seam; TD-390)"* ]] || return 1
  [[ "$output" == *"1 targets — 0 ok, 1 failed"* ]] || return 1
  [[ "$output" != *"OK    mcp/igris-brain/claude"* ]] || return 1

  # Byte-identical (whole file), AND the AC's literal form (mcpServers sha256).
  assert_fence_unchanged || return 1
  [ "$(mcp_sha "$STANDIN")" = "$sha_before" ] || return 1
  [ "$(args0 "$STANDIN")" = "/real/bundle/cli/dist/index.js" ] || return 1
  # The grant writer never ran either.
  [ ! -f "$FENCE_HOME/.claude/settings.json" ] || return 1
}

# --- T3: any-harness seam ---------------------------------------------------

@test "TD-390 T3: ANY IGRIS_MCP_*_CONFIG refuses — IGRIS_MCP_CODEX_CONFIG stops a claude row and is named" {
  assert_armed || return 1
  run_compile "$COMPILE" mcp "$PROJ/harness-manifest.json" IGRIS_MCP_CODEX_CONFIG="$SEAM_CFG"
  echo "status=$status" >&2; echo "$output" >&2
  echo "stand-in args[0]: before=$(args0 "$STANDIN.before") after=$(args0 "$STANDIN")" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"refuses the MCP pass: IGRIS_MCP_CODEX_CONFIG is set"* ]] || return 1
  [[ "$output" == *"FAIL  mcp/igris-brain/claude — refused: IGRIS_MCP_CODEX_CONFIG is set (read-only drift seam; TD-390)"* ]] || return 1
  assert_fence_unchanged || return 1
  [ ! -f "$FENCE_HOME/.claude/settings.json" ] || return 1
}

# --- T4: sandboxed under a fenced HOME; the retired knob is not a seam ------

@test "TD-390 T4 (AC-6 sandboxed): no *_CONFIG seam + IGRIS_MCP_ENGINE=delegate → the real add-mcp + grant write INTO the fence; real config untouched" {
  assert_armed || return 1
  run_compile "$COMPILE" mcp "$PROJ/harness-manifest.json" IGRIS_MCP_ENGINE=delegate
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"OK    mcp/igris-brain/claude (delegate)"* ]] || return 1
  [[ "$output" != *"refuses"* ]] || return 1

  # The writer is LIVE and it wrote INTO THE FENCE (positive control for T2).
  [ "$(args0 "$STANDIN")" = "/canonical/checkout/cli/dist/index.js" ] || return 1
  [ -f "$FENCE_HOME/.claude/settings.json" ] || { echo "grant did not land in the fence" >&2; return 1; }
  # The seam file was not involved at all.
  cmp -s "$SEAM_CFG" "$SEAM_CFG.before" || return 1

  assert_real_config_untouched || return 1
}

# --- T5: scoping — no false stop ---------------------------------------------

@test "TD-390 T5: the guard is scoped to a non-empty MCP pass — seam + --surface agents, and seam + agents-only manifest, do NOT refuse" {
  assert_armed || return 1

  # (a) same manifest (mcp block PRESENT), agents surface only → project_mcp
  #     is never dispatched.
  run_compile "$COMPILE" agents "$PROJ/harness-manifest.json" IGRIS_MCP_CLAUDE_CONFIG="$SEAM_CFG"
  echo "(a) status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"refuses"* ]] || return 1
  [[ "$output" != *"refused"* ]] || return 1
  assert_fence_unchanged || return 1

  # (b) agents-only manifest (no `surfaces` key — the TD-388 fixture-safety
  #     shape), mcp surface SELECTED, seam set → MCP_ROWS is empty, the sweep
  #     never runs, exit 0 on the "targets matched" path.
  local agents_only="$PROJ/.agents-only.json"
  write_agents_only_manifest "$agents_only"
  run_compile "$COMPILE" mcp "$agents_only" IGRIS_MCP_CLAUDE_CONFIG="$SEAM_CFG"
  echo "(b) status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"targets matched"* ]] || return 1
  [[ "$output" != *"refuses"* ]] || return 1
  [[ "$output" != *"refused"* ]] || return 1
  assert_fence_unchanged || return 1
}

# --- T6: empty value = unset on both sides ------------------------------------

@test "TD-390 T6: an EMPTY IGRIS_MCP_CLAUDE_CONFIG is unset — the pass proceeds and writes the fence (mirrors the reader's \${VAR:-default})" {
  assert_armed || return 1
  run_compile "$COMPILE" mcp "$PROJ/harness-manifest.json" IGRIS_MCP_CLAUDE_CONFIG=""
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"OK    mcp/igris-brain/claude (delegate)"* ]] || return 1
  [[ "$output" != *"refuses"* ]] || return 1
  [ "$(args0 "$STANDIN")" = "/canonical/checkout/cli/dist/index.js" ] || return 1
  assert_real_config_untouched || return 1
}
