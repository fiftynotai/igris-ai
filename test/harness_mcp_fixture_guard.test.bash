#!/usr/bin/env bats

# harness_mcp_fixture_guard.test.bash — BR-099: the `verify_mcp` mcp-fixture
# arm of check_harness_drift.sh flags a TEST-FIXTURE MCP server registered in
# a REAL harness config.
#
# THE INCIDENT (BR-099, found 2026-09-04). Three fixture servers — `demo-mcp`
# (`npx -y evil`, env.API=${API_TOKEN}), `personal-mcp` (`node /p.js`) and
# `core-mcp` (`echo hi`) — sat in the operator's real ~/.claude.json for
# weeks: the three CONNECTION_CLOSED servers at every Claude Code session
# start. They are add-mcp output (a bare-word `evil` target is npx-wrapped;
# `"node /p.js"` / `"echo hi"` are the literal-command form), i.e. the
# DELEGATE writer ran under a real HOME: cli/src/__tests__/
# registry-project-mcp.test.ts sandboxes only `configPath`, a seam the
# delegate path never reads (loadout.ts routes to runProjectMcpViaDelegate
# BEFORE `configPath` is consulted). The orchestrator removed the three
# entries by hand on 2026-09-04 (backup
# ~/.claude/backups/.claude.json.pre-BR-099.20260904T103124).
#
# THE FIX under test: `verify_mcp` re-reads every config the per-row loop
# resolved (the SAME seam-resolved path — TD-390's read-only seam now has TWO
# readers) and emits `[mcp-fixture/<name>/<harness>] DRIFTED` + `config :` +
# a reason WITHOUT the `differing key(s):` clause, so
# scripts/validate_harness_drift.sh classifies it as fatal even beside a live
# sibling worktree (W10 in harness_drift_gate.test.bash). Rules live in
# _common.sh: IGRIS_MCP_FIXTURE_NAMES (literal list), IGRIS_MCP_FIXTURE_PREFIX
# (`igris-fixture-`), and the `npx -y evil` / `evil` launch-token rule. The
# two NAME rules are skipped for a name the manifest declares FOR THAT HARNESS
# (a test manifest projecting `demo-mcp` to claude exempts the claude config
# only — T9; the same name in the gemini config is still flagged — T9b); the
# COMMAND rule never is.
#
# SAFETY — READ BEFORE EDITING. Every test runs under a FENCED HOME
# (`$FENCE_HOME` under $TEST_TEMP_DIR); the "real config" every dirty case
# reads is the STAND-IN `$FENCE_HOME/.claude.json`, never
# `$REAL_HOME/.claude.json`. Belts (test_standards, "the fence is ARMED, not
# assumed"): (1) setup() exports HOME=$FENCE_HOME AND every `run` passes
# HOME= explicitly through `env`; (2) `assert_armed` opens EVERY test;
# (3) `assert_real_config_untouched` closes EVERY test — a READ-ONLY sha256
# of the real file's `mcpServers` subtree taken in setup() must be unchanged
# (the whole-file sha is reported too; Claude Code rewrites that file from
# memory during a session, so the subtree — the field the incident damaged —
# is the belt that must hold, and the whole-file sha is informational).
# The guard is a READER; nothing here can reach a writer.
#
# The three reality entries in `seed_dirty_config` were extracted from the
# pre-edit backup on 2026-09-04 with (prints ONLY the three entries):
#   python3 -c 'import json,os;s=json.load(open(os.path.expanduser(
#     "~/.claude/backups/.claude.json.pre-BR-099.20260904T103124")))["mcpServers"]
#     for k in ("demo-mcp","personal-mcp","core-mcp"): print(k, json.dumps(s[k], sort_keys=True))'
#   demo-mcp {"args": ["-y", "evil"], "command": "npx", "env": {"API": "${API_TOKEN}"}}
#   personal-mcp {"args": ["/p.js"], "command": "node"}
#   core-mcp {"args": ["hi"], "command": "echo"}
#
# Tests:
#   T1  dirty config (igris-brain + the three reality entries) → exit 1, three
#       `[mcp-fixture/<name>/claude] DRIFTED` lines each with the fence path,
#       igris-brain MATCH, `3 drifted/missing`, no `differing key(s)`, no env.
#   T2  clean config (control) → exit 0, no mcp-fixture line, summary bytes
#       identical to the pre-BR-099 guard.
#   T3  `some-other-name` = `npx -y evil` → flagged, why `npx-y-evil-command`.
#   T4  `igris-fixture-anything`, benign command → flagged, why `fixture-prefix`.
#   T5  IGRIS_MCP_CLAUDE_CONFIG → the arm reads the SEAM path (dirty seam +
#       clean HOME flags with the seam path; clean seam + dirty HOME does not).
#   T6  dirty config + `--filter igris-brain` → exit 0, no mcp-fixture line.
#   T7  every test: the real config's mcpServers sha256 is unchanged.
#   T8  gemini config dirty, claude clean → `[mcp-fixture/demo-mcp/gemini]`.
#   T9  a fixture name the manifest DECLARES is not flagged (the sibling-suite
#       compatibility case: harness_agent_id_coverage / harness_mcp seed
#       `demo-mcp` in their sandboxes on purpose); the command rule still is.
#   T9b a fixture name declared for CLAUDE only, present in BOTH stand-ins with
#       a benign command → `[mcp-fixture/demo-mcp/gemini]`, no claude line,
#       `1 drifted/missing` (the exemption is scoped to the declaring block's
#       targets[], not project-wide — round 2 of BR-099).
#
# RED RUN, RECORDED VERBATIM (branch develop @ 250c60e, 2026-09-04, this file
# run BEFORE the arm existed — `grep -c mcp-fixture check_harness_drift.sh` = 0):
#   see the Agent Log of BR-099 (T1, T3, T4, T5, T8, T9-command-half red: the
#   guard exited 0 and printed no `mcp-fixture` line; T2, T6, T9-name-half green
#   — vacuous on the old code).
# ROUND-2 RED (same branch, T9b run against the round-1 project-wide
# exemption): `not ok 10` at `[mcp-fixture/demo-mcp/gemini] DRIFTED`; the
# output carried `9 targets — 9 in sync, 0 drifted/missing` and the PARITY line.
#
# BR099_ADAPTERS_DIR is the mutation-battery seam (the TD390_ADAPTERS_DIR
# idiom): point it at a scratch `<root>/core/scripts/cli-adapters` copy (with
# the real descriptor at `<root>/harness-manifest.json`) to run the suite
# against a mutant without touching the repo file. Unset = repo.
#
# No cli/dist dependency (the CLI is a stub) → this file runs in the root
# matrix job per file. Run with `bats test/harness_mcp_fixture_guard.test.bash`.

load test_helper

# Captured at FILE LOAD, before setup() re-points HOME at the fence.
REAL_HOME="$HOME"

setup() {
  ADAPTERS="${BR099_ADAPTERS_DIR:-$IGRIS_ROOT/core/scripts/cli-adapters}"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  # No seam may leak in from the caller's environment (T5 sets its own).
  local _v
  for _v in "${!IGRIS_MCP_@}"; do unset "$_v"; done

  # The fence: plays the operator's HOME.
  FENCE_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$FENCE_HOME/.claude" "$FENCE_HOME/.gemini"
  STANDIN="$FENCE_HOME/.claude.json"
  GEMINI_STANDIN="$FENCE_HOME/.gemini/settings.json"

  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN/loadout"

  PROJ="$TEST_TEMP_DIR/fxproj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
  write_manifest "$PROJ/harness-manifest.json" claude

  # A clean stand-in: the ONE declared block, in the exact claude shape, so the
  # per-entry verdict is MATCH and the only possible DRIFT comes from the arm.
  seed_clean_config "$STANDIN"

  # Stub CLI: the grant arm reads `verify-mcp-grant` → present (0); the
  # agent-id probe exits 2 → the arm SKIPs (graceful, no verdict); anything
  # else → 0. No real add-mcp, no real HOME.
  STUB="$TEST_TEMP_DIR/cli_stub_$BATS_TEST_NUMBER.sh"
  cat > "$STUB" <<'EOF'
#!/bin/bash
case "$2" in
  list-mcp-agents) exit 2 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$STUB"

  # Read-only belt on the ONE file the incident damaged. Absent (CI) → no belt.
  REAL_SHA=""
  REAL_MCP_SHA=""
  if [ -f "$REAL_HOME/.claude.json" ]; then
    REAL_SHA="$(shasum -a 256 "$REAL_HOME/.claude.json" | awk '{print $1}')"
    REAL_MCP_SHA="$(mcp_sha "$REAL_HOME/.claude.json" mcpServers)"
  fi

  export HOME="$FENCE_HOME"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"
  export IGRIS_CLI="bash $STUB"
}

teardown() {
  unset IGRIS_CLI
  if [ -d "${PROJ:-}" ]; then rm -rf "$PROJ"; fi
}

# --- fixtures ---------------------------------------------------------------

CANON_ARG="/canonical/checkout/cli/dist/index.js"

# write_manifest <path> <target-type>...
# ONE igris-brain block, the given targets (merge).
write_manifest() {
  local path="$1"; shift
  local targets="" t
  for t in "$@"; do
    [ -n "$targets" ] && targets="$targets,"
    targets="$targets{ \"type\": \"$t\", \"method\": \"merge\" }"
  done
  cat > "$path" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "igris-brain",
        "canonical": { "command": "node", "args": ["$CANON_ARG"], "env": {} },
        "targets": [ $targets ]
      }
    ]
  }
}
EOF
}

# The claude-shape match for the declared block (normalize_mcp_shape claude).
seed_clean_config() {
  cat > "$1" <<EOF
{"theme":"dark","mcpServers":{"igris-brain":{"type":"stdio","command":"node","args":["$CANON_ARG"],"env":{}}}}
EOF
}

# The gemini-shape match (no `type`).
seed_clean_gemini_config() {
  cat > "$1" <<EOF
{"mcpServers":{"igris-brain":{"command":"node","args":["$CANON_ARG"],"env":{}}}}
EOF
}

# The reality fixture: the clean entry PLUS the three entries byte-for-byte
# as extracted from the pre-BR-099 backup (see the docblock).
seed_dirty_config() {
  cat > "$1" <<EOF
{"theme":"dark","mcpServers":{
  "igris-brain":{"type":"stdio","command":"node","args":["$CANON_ARG"],"env":{}},
  "demo-mcp": {"args": ["-y", "evil"], "command": "npx", "env": {"API": "\${API_TOKEN}"}},
  "personal-mcp": {"args": ["/p.js"], "command": "node"},
  "core-mcp": {"args": ["hi"], "command": "echo"}
}}
EOF
}

# add_entry <config> <map-key> <name> <entry-json> — append one entry.
add_entry() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
p, key, name, entry = sys.argv[1:5]
d = json.load(open(p))
d.setdefault(key, {})[name] = json.loads(entry)
json.dump(d, open(p, "w"))
PY
}

# --- helpers ----------------------------------------------------------------

# mcp_sha <file> <map-key> — sha256 of the map subtree (sort_keys).
mcp_sha() {
  python3 -c 'import json,hashlib,sys
d=json.load(open(sys.argv[1]))
print(hashlib.sha256(json.dumps(d.get(sys.argv[2]),sort_keys=True).encode()).hexdigest())' "$1" "$2"
}

# run_guard [ENV=VAL ...] [-- guard args...]
# Belt 1: HOME is passed EXPLICITLY on every run, on top of setup()'s export.
run_guard() {
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  run env HOME="$FENCE_HOME" IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" IGRIS_CLI="bash $STUB" \
    ${envs[@]+"${envs[@]}"} \
    bash "$GUARD" --project-root "$PROJ" "$@"
}

# Belt 2 — the fence is ARMED, not assumed. `|| return 1` on every line (TD-341).
assert_armed() {
  [ "$HOME" = "$FENCE_HOME" ] || { echo "fence NOT armed: HOME=$HOME" >&2; return 1; }
  [ "$HOME" != "$REAL_HOME" ] || { echo "fence NOT armed: HOME is the real home" >&2; return 1; }
  [ -f "$STANDIN" ] || { echo "fence NOT armed: stand-in missing" >&2; return 1; }
  [ "$STANDIN" != "$REAL_HOME/.claude.json" ] || { echo "fence NOT armed: stand-in IS the real file" >&2; return 1; }
}

# Belt 3 (T7) — the operator's real file, read-only, before vs after.
assert_real_config_untouched() {
  if [ -z "$REAL_MCP_SHA" ]; then
    echo "real-config belt: $REAL_HOME/.claude.json absent — nothing to compare" >&2
    return 0
  fi
  local now_file now_mcp
  now_file="$(shasum -a 256 "$REAL_HOME/.claude.json" | awk '{print $1}')"
  now_mcp="$(mcp_sha "$REAL_HOME/.claude.json" mcpServers)"
  echo "real-config belt: whole-file sha256 $REAL_SHA -> $now_file; mcpServers sha256 $REAL_MCP_SHA -> $now_mcp" >&2
  [ "$now_mcp" = "$REAL_MCP_SHA" ] || {
    echo "REAL CONFIG mcpServers CHANGED: $REAL_HOME/.claude.json" >&2
    return 1
  }
}

# fixture_lines — the arm's verdict lines only (LINE-scoped, TD-434).
fixture_lines() {
  printf '%s\n' "$output" | grep 'mcp-fixture/' || true
}

# summary_for <declared-target-count> — the pre-BR-099 summary line for a
# clean run: the declared (mcp, harness) rows PLUS one silent MATCH per
# descriptor grant harness (the FR-212b grant arm counts them; the stub says
# "present"). Read from the SAME descriptor the guard resolves (repo layout:
# <adapters>/../../../harness-manifest.json — resolve_harness_descriptor_path),
# so a mutant scratch copy and the repo agree. The arm under test must be
# COUNT-NEUTRAL on a clean config (the FR-202 M0 clean-run bytes are an oracle).
summary_for() {
  local declared="$1" grants n
  grants="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(sum(1 for h in d.get("harnesses",{}).values() if isinstance(h,dict) and "grant" in h))' \
    "$ADAPTERS/../../../harness-manifest.json")"
  n=$((declared + grants))
  echo "$n targets — $n in sync, 0 drifted/missing"
}

# --- T1: the reality fixture ----------------------------------------------

@test "BR-099 T1: the three leaked fixture entries beside igris-brain -> exit 1, three DRIFTED lines with the fence path, no key clause, no env" {
  assert_armed || return 1
  seed_dirty_config "$STANDIN"

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  local n
  for n in demo-mcp personal-mcp core-mcp; do
    [[ "$output" == *"[mcp-fixture/$n/claude] DRIFTED"* ]] || { echo "missing verdict for $n" >&2; return 1; }
  done
  # Each hit names the fence path — LINE-scoped (TD-434).
  [ "$(printf '%s\n' "$output" | grep -c "config    : $STANDIN")" -ge 4 ] || return 1
  [[ "$output" == *"'demo-mcp' (known-fixture-name)"* ]] || return 1
  [[ "$output" == *"a test suite wrote the live file (BR-099)"* ]] || return 1
  [[ "$output" == *"3 drifted/missing"* ]] || return 1
  # The TD-388 exemption keys off this clause — it must be absent everywhere.
  if printf '%s\n' "$output" | grep 'differing key(s)' >/dev/null; then return 1; fi
  # Never a value: the fixture's env ref and the `evil` args never print.
  if printf '%s\n' "$output" | grep 'API_TOKEN' >/dev/null; then return 1; fi
  if printf '%s\n' "$output" | grep '"-y"' >/dev/null; then return 1; fi
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 3 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T2: the control --------------------------------------------------------

@test "BR-099 T2 (control): a clean config -> exit 0, no mcp-fixture line, summary bytes unchanged" {
  assert_armed || return 1

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 0 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  # The arm is count-neutral on a clean config: the ONE declared target plus
  # the grant arm's silent per-harness MATCHes, exactly as before BR-099.
  [[ "$output" == *"$(summary_for 1)"* ]] || return 1

  assert_real_config_untouched || return 1
}

# --- T3: the command-shape rule ---------------------------------------------

@test "BR-099 T3: an unknown name launching 'npx -y evil' is flagged by the command rule" {
  assert_armed || return 1
  add_entry "$STANDIN" mcpServers some-other-name '{"type":"stdio","command":"npx","args":["-y","evil"],"env":{}}'

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp-fixture/some-other-name/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"'some-other-name' (npx-y-evil-command)"* ]] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 1 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T4: the prefix rule ----------------------------------------------------

@test "BR-099 T4: an 'igris-fixture-' prefixed name with a benign command is flagged by the prefix rule" {
  assert_armed || return 1
  add_entry "$STANDIN" mcpServers igris-fixture-anything '{"type":"stdio","command":"node","args":["/benign.js"],"env":{}}'

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp-fixture/igris-fixture-anything/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"'igris-fixture-anything' (fixture-prefix)"* ]] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 1 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T5: the arm reads the seam, like its siblings -------------------------

@test "BR-099 T5: under IGRIS_MCP_CLAUDE_CONFIG the arm reads the SEAM file, not HOME" {
  assert_armed || return 1
  local seam="$TEST_TEMP_DIR/seam_$BATS_TEST_NUMBER.json"

  # Arm A: dirty seam, clean HOME -> flagged, naming the seam path.
  seed_dirty_config "$seam"
  run_guard IGRIS_MCP_CLAUDE_CONFIG="$seam"
  echo "A status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp-fixture/demo-mcp/claude] DRIFTED"* ]] || return 1
  [ "$(printf '%s\n' "$output" | grep -c "config    : $seam")" -ge 4 ] || return 1
  if printf '%s\n' "$output" | grep "config    : $STANDIN" >/dev/null; then return 1; fi

  # Arm B (inverse): clean seam, dirty HOME -> NOT flagged.
  seed_clean_config "$seam"
  seed_dirty_config "$STANDIN"
  run_guard IGRIS_MCP_CLAUDE_CONFIG="$seam"
  echo "B status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 0 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T6: the --filter gate --------------------------------------------------

@test "BR-099 T6: a dirty config under --filter igris-brain -> exit 0, no mcp-fixture line (add/remove verify cannot false-fail)" {
  assert_armed || return 1
  seed_dirty_config "$STANDIN"

  run_guard -- --filter igris-brain
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 0 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T7: the belt itself is live -------------------------------------------

@test "BR-099 T7: the real-config belt compares a subtree sha taken before the run (every test above closes on it)" {
  assert_armed || return 1
  # The belt must be able to see a change: prove it on a stand-in copy.
  local probe="$TEST_TEMP_DIR/probe_$BATS_TEST_NUMBER.json"
  seed_clean_config "$probe"
  local before after
  before="$(mcp_sha "$probe" mcpServers)"
  add_entry "$probe" mcpServers demo-mcp '{"command":"npx","args":["-y","evil"]}'
  after="$(mcp_sha "$probe" mcpServers)"
  [ "$before" != "$after" ] || { echo "belt cannot see a subtree change" >&2; return 1; }

  run_guard
  [ "$status" -eq 0 ] || return 1
  assert_real_config_untouched || return 1
}

# --- T8: a second harness ---------------------------------------------------

@test "BR-099 T8: a fixture in the gemini config is flagged as /gemini while claude stays clean" {
  assert_armed || return 1
  write_manifest "$PROJ/harness-manifest.json" claude gemini
  seed_clean_gemini_config "$GEMINI_STANDIN"
  add_entry "$GEMINI_STANDIN" mcpServers demo-mcp '{"command":"npx","args":["-y","evil"],"env":{"API":"${API_TOKEN}"}}'

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp/igris-brain/claude] MATCH"* ]] || return 1
  [[ "$output" == *"[mcp/igris-brain/gemini] MATCH"* ]] || return 1
  [[ "$output" == *"[mcp-fixture/demo-mcp/gemini] DRIFTED"* ]] || return 1
  [ "$(printf '%s\n' "$output" | grep -c "config    : $GEMINI_STANDIN")" -ge 2 ] || return 1
  if printf '%s\n' "$output" | grep 'mcp-fixture/.*/claude' >/dev/null; then return 1; fi
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 1 ] || return 1

  assert_real_config_untouched || return 1
}

# --- T9: a DECLARED fixture name is the manifest's own projection -----------

@test "BR-099 T9: a fixture name the manifest declares is not flagged; the evil command rule still is" {
  assert_armed || return 1
  # A second declared block named demo-mcp (the harness_agent_id_coverage /
  # harness_mcp fixture shape), projected into the fence in the claude shape.
  python3 - "$PROJ/harness-manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["surfaces"]["mcp_servers"].append({
  "name": "demo-mcp",
  "canonical": {"command": "node", "args": ["/x/y.js"], "env": {}},
  "targets": [{"type": "claude", "method": "merge"}],
})
json.dump(d, open(p, "w"))
PY
  add_entry "$STANDIN" mcpServers demo-mcp '{"type":"stdio","command":"node","args":["/x/y.js"],"env":{}}'

  # Half A: declared name -> the per-entry verdict owns it (MATCH), no arm line.
  run_guard
  echo "A status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"[mcp/demo-mcp/claude] MATCH"* ]] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 0 ] || return 1
  [[ "$output" == *"$(summary_for 2)"* ]] || return 1

  # Half B: the SAME declared name launching `npx -y evil` is still flagged —
  # the command rule is unconditional (the per-entry verdict DRIFTs too).
  add_entry "$STANDIN" mcpServers demo-mcp '{"type":"stdio","command":"npx","args":["-y","evil"],"env":{}}'
  run_guard
  echo "B status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"[mcp-fixture/demo-mcp/claude] DRIFTED"* ]] || return 1
  [[ "$output" == *"'demo-mcp' (npx-y-evil-command)"* ]] || return 1

  assert_real_config_untouched || return 1
}

# --- T9b: the declared-name exemption is PER HARNESS, not project-wide -------

@test "BR-099 T9b: a fixture name declared for CLAUDE only is still flagged in the GEMINI config (the exemption is per harness)" {
  assert_armed || return 1
  # igris-brain targets claude+gemini; a second block declares demo-mcp for
  # CLAUDE ONLY. Both stand-ins carry demo-mcp with a BENIGN command, so the
  # unconditional command rule cannot mask the question — only the name rule
  # (and its exemption) decides. Round-1 code exempted the name project-wide,
  # so the gemini copy — a genuine leak in a harness the block never targets —
  # was silently passed.
  # NOTE the asymmetric manifest also trips the FR-217 M4 parity guard
  # (`[mcp/demo-mcp/gemini] PARITY` — a block dropping a harness its sibling
  # keeps), which co-owns the non-zero exit and is pinned below BY NAME. PARITY
  # never touches DRIFT, so the arm's own pin is the summary line: round-1 code
  # prints `0 drifted/missing` here; the per-harness code prints `1`.
  write_manifest "$PROJ/harness-manifest.json" claude gemini
  python3 - "$PROJ/harness-manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["surfaces"]["mcp_servers"].append({
  "name": "demo-mcp",
  "canonical": {"command": "node", "args": ["/x/y.js"], "env": {}},
  "targets": [{"type": "claude", "method": "merge"}],
})
json.dump(d, open(p, "w"))
PY
  add_entry "$STANDIN" mcpServers demo-mcp '{"type":"stdio","command":"node","args":["/x/y.js"],"env":{}}'
  seed_clean_gemini_config "$GEMINI_STANDIN"
  add_entry "$GEMINI_STANDIN" mcpServers demo-mcp '{"command":"node","args":["/x/y.js"],"env":{}}'

  run_guard
  echo "status=$status" >&2; echo "$output" >&2
  [ "$status" -eq 1 ] || return 1
  # claude: declared for this harness -> the per-entry verdict owns it, no arm line.
  [[ "$output" == *"[mcp/demo-mcp/claude] MATCH"* ]] || return 1
  if printf '%s\n' "$output" | grep 'mcp-fixture/.*/claude' >/dev/null; then return 1; fi
  # gemini: NOT declared for this harness -> flagged by the NAME rule.
  [[ "$output" == *"[mcp/igris-brain/gemini] MATCH"* ]] || return 1
  [[ "$output" == *"[mcp-fixture/demo-mcp/gemini] DRIFTED"* ]] || return 1
  [[ "$output" == *"'demo-mcp' (known-fixture-name)"* ]] || return 1
  [ "$(printf '%s\n' "$output" | grep -c "config    : $GEMINI_STANDIN")" -ge 2 ] || return 1
  [ "$(fixture_lines | wc -l | tr -d ' ')" -eq 1 ] || return 1
  [[ "$output" == *"1 drifted/missing"* ]] || return 1
  [[ "$output" == *"[mcp/demo-mcp/gemini] PARITY"* ]] || return 1

  assert_real_config_untouched || return 1
}
