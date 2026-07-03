#!/usr/bin/env bats

# session_start_hook.test.bash - Tests for core/hooks/shared/session_start.sh
#
# Added for FR-178 (terminal tab title = Igris project slug). The hook's
# contract under test:
#   - ALWAYS exit 0.
#   - stdout is the additionalContext JSON — nothing else, ever. The FR-178
#     OSC title escape must NEVER appear on stdout.
#   - Headless (no controlling tty): title-setting is a silent no-op and
#     stdout is byte-identical to the pre-FR-178 hook (pinned baseline below).
#   - With a tty: the OSC 0 escape carrying the project slug is written to
#     /dev/tty (sqlite registered-slug lookup, basename fallback).
#
# Tests run against the repo source (TD-096 mirror is verified separately).

load test_helper

HOOK_REL="core/hooks/shared/session_start.sh"

setup() {
  HOOK="$IGRIS_ROOT/$HOOK_REL"
  [ -f "$HOOK" ] || skip "hook missing at $HOOK"
  [ -f "$IGRIS_ROOT/core/hooks/shared/_gate.sh" ] || skip "_gate.sh missing"

  # Sandbox HOME so the hook cannot see real session/brief state (output
  # determinism) and a sandbox project dir for PROJECT_DIR resolution.
  # TD-150: realpath-normalise SANDBOX so a registered projects.path matches
  # the gate's pwd -P resolution (macOS /tmp -> /private/tmp, /var symlink).
  SANDBOX="$(mkdir -p "$TEST_TEMP_DIR/session_start_$BATS_TEST_NUMBER" && cd "$TEST_TEMP_DIR/session_start_$BATS_TEST_NUMBER" && pwd -P)"
  mkdir -p "$SANDBOX/home" "$SANDBOX/proj"

  # Pinned baseline stdout (jq shape) for a FRESH project with no session state.
  # Byte-equality against this proves the stdout contract: the FR-178 OSC title
  # addition did not touch it, AND the FR-202 M4 Unit A auto-boot nudge is
  # present for source=startup. NOTE: \\n below is literal — the hook builds the
  # context string with literal backslash-n which jq escapes. The trailing
  # [IGRIS AUTO-BOOT] line is the auto-boot nudge (startup/opencode only).
  BASELINE="$SANDBOX/baseline.json"
  cat > "$BASELINE" <<'EOF'
{
  "additionalContext": "[IGRIS SESSION STATE]\\nSource: startup\\nMode: NO SESSION\\nActive Brief: None\\nBlockers: None\\n[/IGRIS SESSION STATE]\\n[IGRIS AUTO-BOOT] Run /boot to ground this session."
}
EOF

  # Pinned baseline for a NON-fresh session (resume/clear/compact): identical to
  # the startup baseline EXCEPT the auto-boot nudge is ABSENT — re-awakening an
  # already-grounded session would just churn. {SOURCE} is substituted per test.
  NUDGELESS_TEMPLATE='{
  "additionalContext": "[IGRIS SESSION STATE]\\nSource: {SOURCE}\\nMode: NO SESSION\\nActive Brief: None\\nBlockers: None\\n[/IGRIS SESSION STATE]"
}'
}

teardown() {
  [ -d "$SANDBOX" ] && rm -rf "$SANDBOX"
}

# register_proj <home> <projpath> [slug] — seed a brain DB row so the FR-212c
# registration gate treats <projpath> as a registered Igris project. The hook +
# gate hardcode <home>/.igris/memory/knowledge.db. Idempotent table create.
register_proj() {
  local home="$1" projpath="$2" slug="${3:-ss-test-slug}"
  command -v sqlite3 > /dev/null 2>&1 || return 0
  mkdir -p "$home/.igris/memory"
  sqlite3 "$home/.igris/memory/knowledge.db" \
    "CREATE TABLE IF NOT EXISTS projects (slug TEXT, path TEXT); INSERT INTO projects VALUES ('$slug', '$projpath');" 2>/dev/null || true
}

# Run the hook with NO controlling terminal, capturing stdout to a file.
# A controlling tty is a session property, not an fd property — bats' fd
# redirection does NOT remove it, so when bats runs interactively a plain
# invocation would exercise the tty-write branch (and retitle the developer's
# tab) instead of the no-op branch. The python3 wrapper calls os.setsid() in
# the child so /dev/tty is unopenable deterministically in every environment
# (python3 because macOS ships no setsid(1)).
#
# FR-212c: these no-tty tests assert the FULL [IGRIS SESSION STATE] injection,
# which the registration gate only emits inside a REGISTERED project. So the
# wrapper registers $SANDBOX/proj in the sandbox HOME before invoking (the gate
# then de-no-ops and the baseline output is produced). The unregistered /
# brain-absent gate cases below invoke the hook directly, NOT via this wrapper.
# Usage: run_hook_no_tty <home> <proj_env_or_empty> <payload_or_empty> <out>
run_hook_no_tty() {
  register_proj "$1" "$SANDBOX/proj"
  python3 - "$HOOK" "$1" "$2" "$3" "$4" <<'PYEOF'
import os, subprocess, sys
hook, home, proj_env, payload, out = sys.argv[1:6]
env = dict(os.environ, HOME=home)
if proj_env:
    env["IGRIS_PROJECT_DIR"] = proj_env
with open(out, "wb") as f:
    p = subprocess.run(["bash", hook], input=payload.encode(), stdout=f,
                       env=env, preexec_fn=os.setsid)
sys.exit(p.returncode)
PYEOF
}

@test "no-tty stdin payload: exit 0 and stdout byte-identical to pre-FR-178 baseline" {
  require_jq
  require_python3
  run run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"startup\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  cmp "$BASELINE" "$SANDBOX/out.json"
}

@test "no-tty env fallback (empty stdin): exit 0 and stdout byte-identical to baseline" {
  require_jq
  require_python3
  run run_hook_no_tty "$SANDBOX/home" "$SANDBOX/proj" "" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  cmp "$BASELINE" "$SANDBOX/out.json"
}

@test "no-tty: stdout contains no ESC byte (title escape never leaks to stdout)" {
  require_python3
  run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"startup\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/out.json"
  # grep -q exits 1 when ESC absent — that is the pass condition.
  ! LC_ALL=C grep -q "$(printf '\033')" "$SANDBOX/out.json"
}

@test "resume source: exit 0 (title call fires on all session-start paths without breaking)" {
  require_python3
  run run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"resume\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  grep -q 'Source: resume' "$SANDBOX/out.json"
}

# --- FR-202 M4 Unit A: auto-boot nudge gating ------------------------------
# The hook appends an [IGRIS AUTO-BOOT] /boot cue to additionalContext on a
# FRESH session only. Fresh = native-Claude "startup" OR the OpenCode bridge's
# "opencode" source (which it dispatches only on session.created). A Claude
# resume/clear/compact is already grounded → the cue must be ABSENT.

@test "startup: auto-boot /boot nudge present (jq shape == pinned baseline)" {
  require_jq
  require_python3
  run run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"startup\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  # Byte-equal to the baseline (which now carries the nudge) AND the cue is there.
  cmp "$BASELINE" "$SANDBOX/out.json"
  grep -q '\[IGRIS AUTO-BOOT\] Run /boot to ground this session\.' "$SANDBOX/out.json"
}

@test "opencode source: auto-boot /boot nudge present (OpenCode session.created)" {
  require_jq
  require_python3
  # Unified bridge envelope: top-level source=opencode, payload is the raw event.
  run run_hook_no_tty "$SANDBOX/home" "" \
    "{\"source\":\"opencode\",\"event\":\"session_start\",\"project_dir\":\"$SANDBOX/proj\",\"payload\":{\"type\":\"session.created\"}}" \
    "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  grep -q 'Source: opencode' "$SANDBOX/out.json"
  grep -q '\[IGRIS AUTO-BOOT\] Run /boot to ground this session\.' "$SANDBOX/out.json"
}

@test "resume/clear/compact: auto-boot nudge ABSENT (already grounded — no churn)" {
  require_jq
  require_python3
  local src
  for src in resume clear compact; do
    run run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"$src\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/out.json"
    [ "$status" -eq 0 ]
    # The cue must NOT appear for a non-fresh session.
    ! grep -q 'IGRIS AUTO-BOOT' "$SANDBOX/out.json"
    # And the full stdout must byte-match the nudgeless baseline for this source.
    local expected="$SANDBOX/nudgeless_${src}.json"
    printf '%s\n' "${NUDGELESS_TEMPLATE/\{SOURCE\}/$src}" > "$expected"
    cmp "$expected" "$SANDBOX/out.json"
  done
}

@test "auto-boot nudge: jq and python3-fallback serializers emit identical additionalContext" {
  require_jq
  require_python3
  # Capture the jq-serialized output (jq present on PATH).
  run run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"startup\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/jq.json"
  [ "$status" -eq 0 ]

  # Build a PATH with python3 + the hook's other deps but NO jq, forcing the
  # python3 serialization fallback, then re-run from the same input.
  local nojq_bin="$SANDBOX/nojq_bin"
  mkdir -p "$nojq_bin"
  local t src
  # FR-212c: include mkdir/rm so register_proj (invoked by run_hook_no_tty) runs
  # under the stripped PATH; the project is already registered by the first
  # (full-PATH) call above, but register_proj re-runs idempotently per invoke.
  for t in bash python3 cat sqlite3 basename grep sed head dirname env printf mkdir rm; do
    src=$(command -v "$t" 2>/dev/null) && ln -sf "$src" "$nojq_bin/$t"
  done
  [ -z "$(PATH="$nojq_bin" command -v jq 2>/dev/null)" ] || skip "could not isolate jq off PATH"

  PATH="$nojq_bin" run_hook_no_tty "$SANDBOX/home" "" "{\"source\":\"startup\",\"cwd\":\"$SANDBOX/proj\"}" "$SANDBOX/py.json"

  # The JSON envelope formatting differs (jq pretty-prints, python3 is compact) —
  # that is a pre-existing FR-178 property. What MUST be byte-identical is the
  # additionalContext VALUE, nudge included. Extract and compare it.
  local jq_ctx py_ctx
  jq_ctx=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['additionalContext'])" "$SANDBOX/jq.json")
  py_ctx=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['additionalContext'])" "$SANDBOX/py.json")
  [ "$jq_ctx" = "$py_ctx" ]
  printf '%s' "$jq_ctx" | grep -q '\[IGRIS AUTO-BOOT\] Run /boot to ground this session\.'
}

# --- tty-positive tests (allocate a pty via python) -------------------------

# Spawn the hook under a pty; print TTY_CAPTURE:<repr> so the test can assert
# on what reached the controlling terminal. Hook stdout goes to a file.
run_hook_under_pty() {
  local home_dir="$1"
  local proj_dir="$2"
  local out="$3"
  python3 - "$HOOK" "$home_dir" "$proj_dir" "$out" <<'PYEOF'
import pty, sys, os
hook, home, proj, out = sys.argv[1:5]
# Pass paths via the environment (pty.spawn inherits os.environ) rather than
# shell-string interpolation, so paths containing quotes are handled safely.
os.environ["HOME"] = home
os.environ["IGRIS_PROJECT_DIR"] = proj
captured = b""
def read_cb(fd):
    global captured
    data = os.read(fd, 1024)
    captured += data
    return data
status = pty.spawn(
    ['/bin/bash', '-c', 'exec bash "$1" < /dev/null > "$2"', '_', hook, out],
    read_cb)
print("CHILD_STATUS:%d" % status)
print("TTY_CAPTURE:%r" % captured)
PYEOF
}

@test "tty present + registered project: OSC escape with sqlite slug on tty, stdout clean" {
  require_python3
  command -v sqlite3 > /dev/null 2>&1 || skip "sqlite3 not available"
  require_jq

  mkdir -p "$SANDBOX/home/.igris/memory"
  sqlite3 "$SANDBOX/home/.igris/memory/knowledge.db" \
    "CREATE TABLE projects (slug TEXT, path TEXT); INSERT INTO projects VALUES ('fr178-test-slug', '$SANDBOX/proj');"

  run run_hook_under_pty "$SANDBOX/home" "$SANDBOX/proj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CHILD_STATUS:0"* ]]
  # Slug came from the DB (basename would be 'proj'), via OSC 0 ... BEL.
  [[ "$output" == *'\x1b]0;fr178-test-slug\x07'* ]]
  # stdout JSON untouched by the tty write.
  cmp "$BASELINE" "$SANDBOX/out.json"
}

@test "tty present + unregistered project: basename fallback slug on tty, EMPTY context (FR-212c)" {
  require_python3
  require_jq

  # No knowledge.db in sandbox HOME -> the TITLE still sets via basename
  # fallback (FR-178, harmless cosmetic), but the FR-212c registration gate
  # no-ops the CONTEXT for this unregistered project: additionalContext = "".
  run run_hook_under_pty "$SANDBOX/home" "$SANDBOX/proj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CHILD_STATUS:0"* ]]
  # Title still names the tab with the project basename.
  [[ "$output" == *'\x1b]0;proj\x07'* ]]
  # But the injected context is empty (gate no-op for an unregistered project).
  run python3 -c "import json,sys; print(json.load(open('$SANDBOX/out.json'))['additionalContext'])"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "tty present + PROJECT_DIR is subdir of registered path: LIKE prefix match wins" {
  require_python3
  command -v sqlite3 > /dev/null 2>&1 || skip "sqlite3 not available"

  mkdir -p "$SANDBOX/proj/sub/dir" "$SANDBOX/home/.igris/memory"
  sqlite3 "$SANDBOX/home/.igris/memory/knowledge.db" \
    "CREATE TABLE projects (slug TEXT, path TEXT); INSERT INTO projects VALUES ('fr178-prefix-slug', '$SANDBOX/proj');"

  # PROJECT_DIR is a SUBDIR of the registered path -> the LIKE path||'/%'
  # arm must resolve it (basename would be 'dir').
  run run_hook_under_pty "$SANDBOX/home" "$SANDBOX/proj/sub/dir" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CHILD_STATUS:0"* ]]
  [[ "$output" == *'\x1b]0;fr178-prefix-slug\x07'* ]]
}

@test "tty present + PROJECT_DIR containing a single quote: SQL escaping holds" {
  require_python3
  command -v sqlite3 > /dev/null 2>&1 || skip "sqlite3 not available"

  local qproj="$SANDBOX/it's-a-proj"
  mkdir -p "$qproj" "$SANDBOX/home/.igris/memory"
  # Register the quoted path ('' escaping in the test's own INSERT literal).
  # UNQUOTED expansion — the double-quoted form keeps backslashes literal.
  local esc
  esc=${qproj//\'/\'\'}
  sqlite3 "$SANDBOX/home/.igris/memory/knowledge.db" \
    "CREATE TABLE projects (slug TEXT, path TEXT); INSERT INTO projects VALUES ('fr178-quote-slug', '$esc');"

  # Without the hook's '' escaping the query would error and fall back to
  # basename ("it's-a-proj") — the DB slug proves the escaping works.
  run run_hook_under_pty "$SANDBOX/home" "$qproj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CHILD_STATUS:0"* ]]
  [[ "$output" == *'\x1b]0;fr178-quote-slug\x07'* ]]
}

# ---------------------------------------------------------------------------
# FR-212c: the SessionStart REGISTRATION GATE.
# Outside a registered Igris project the hook emits an EMPTY additionalContext
# and skips the [IGRIS SESSION STATE] block + the [IGRIS AUTO-BOOT] nudge — so
# it never injects Igris context / nudges /boot inside someone else's repo.
# These cases invoke the hook directly (NOT via run_hook_no_tty, which
# auto-registers) under os.setsid() so the tty branch is a deterministic no-op.
# ---------------------------------------------------------------------------

# run_hook_raw_no_tty <home> <cwd> <out> — like run_hook_no_tty but WITHOUT the
# auto-registration; lets us exercise the UNREGISTERED / brain-absent gate path.
run_hook_raw_no_tty() {
  python3 - "$HOOK" "$1" "$2" "$3" <<'PYEOF'
import os, subprocess, sys
hook, home, cwd, out = sys.argv[1:5]
env = dict(os.environ, HOME=home)
payload = '{"source":"startup","cwd":"%s"}' % cwd
with open(out, "wb") as f:
    p = subprocess.run(["bash", hook], input=payload.encode(), stdout=f,
                       env=env, preexec_fn=os.setsid)
sys.exit(p.returncode)
PYEOF
}

@test "FR-212c: UNREGISTERED project -> empty additionalContext, no SESSION STATE, no nudge" {
  require_jq
  require_python3
  command -v sqlite3 > /dev/null 2>&1 || skip "sqlite3 not available"
  # Brain DB exists but $SANDBOX/proj is NOT registered (different path row).
  mkdir -p "$SANDBOX/home/.igris/memory"
  sqlite3 "$SANDBOX/home/.igris/memory/knowledge.db" \
    "CREATE TABLE projects (slug TEXT, path TEXT); INSERT INTO projects VALUES ('other', '$SANDBOX/somewhere-else');"

  run run_hook_raw_no_tty "$SANDBOX/home" "$SANDBOX/proj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  # additionalContext is empty; NO session-state block, NO /boot nudge.
  run python3 -c "import json,sys; print(json.load(open('$SANDBOX/out.json'))['additionalContext'])"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  ! grep -q 'IGRIS SESSION STATE' "$SANDBOX/out.json"
  ! grep -q 'IGRIS AUTO-BOOT' "$SANDBOX/out.json"
}

@test "FR-212c: brain DB absent -> empty additionalContext (fail-open-to-no-op)" {
  require_jq
  require_python3
  # No brain DB in the sandbox HOME at all -> gate fails open to not-registered.
  rm -rf "$SANDBOX/home/.igris"
  run run_hook_raw_no_tty "$SANDBOX/home" "$SANDBOX/proj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; print(json.load(open('$SANDBOX/out.json'))['additionalContext'])"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  ! grep -q 'IGRIS AUTO-BOOT' "$SANDBOX/out.json"
}

@test "FR-212c: REGISTERED project -> SESSION STATE block + /boot nudge present (gate transparent)" {
  require_jq
  require_python3
  command -v sqlite3 > /dev/null 2>&1 || skip "sqlite3 not available"
  register_proj "$SANDBOX/home" "$SANDBOX/proj"
  run run_hook_raw_no_tty "$SANDBOX/home" "$SANDBOX/proj" "$SANDBOX/out.json"
  [ "$status" -eq 0 ]
  grep -q 'IGRIS SESSION STATE' "$SANDBOX/out.json"
  grep -q '\[IGRIS AUTO-BOOT\] Run /boot to ground this session\.' "$SANDBOX/out.json"
}
