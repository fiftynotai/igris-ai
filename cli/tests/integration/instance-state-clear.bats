#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# instance-state-clear.bats — TD-494 AC4 through the BUILT cli and the real
# pre-commit hook.
#
# AC4: COMPLETE clears `current_brief` for this instance (skill text and the
# CLI path it calls). One "no brief" value is chosen — `''` (PLAN §3: the only
# clear both write doors can express; under the MCP partial-update semantics a
# NULL means "leave unchanged") — writers use it, and the guard treats NULL,
# `''` and `none` alike. After a COMPLETE the guard does not read the brief.
#
#   C1  the CLI path, on the VENDORED engine's schema (the brain DB is created
#       by spawning cli/dist/brain-mcp-server/dist/index.js once with stdin at
#       EOF — the smoke-bundled-mcp.sh mechanism — never hand-written DDL; the
#       project-watermark.bats #1533 parity precedent):
#         a. `instance state --current-brief FR-1 --current-phase BUILDING`
#            -> SQL holds 'FR-1'; the hook REFUSES naming FR-1;
#         b. a call that OMITS --current-brief -> 'FR-1' unchanged; the hook
#            still refuses;
#         c. `instance state --current-brief "" --current-phase COMPLETE`
#            -> SQL holds '' (typeof text, NOT NULL); the hook ALLOWS;
#         d. a call that omits --current-brief again -> still '' (not NULL);
#            the hook still allows.
#       The brief stays 'In Progress' / BUILDING in brief_status throughout,
#       ON PURPOSE: the allow in (c)/(d) can then only come from the session
#       having no brief, never from the in-progress status filter.
#       The hook runs with IGRIS_INSTANCE_ID naming the instance (PLAN §2.2's
#       one-shot prefix), so the session is identified on HEAD and after.
#   S1  skill pin: /hunt Phase 8 (COMPLETE) runs `igris instance state` with
#       `--current-brief ""` and `--current-phase COMPLETE`.
#   S2  skill pin: the per-transition rule ("Instance State and Work Lease")
#       states the COMPLETE clear `--current-brief ""`.
#
# C1 is a behaviour PIN of the CLI door (PLAN §3: "No CLI code change is
# needed") and is expected green on HEAD; S1/S2 are the AC4 red on HEAD.
#
# Fence: stage_brain fences HOME; IGRIS_BRAIN_DIR is then re-pointed to
# $HOME/.igris so the hook ($HOME/.igris/memory/knowledge.db) and the CLI
# (IGRIS_BRAIN_DIR) read ONE file (test_standards, the one-path fence). Every
# CLI/hook call runs under `env -i`, so no harness marker reaches the owner walk.

load _helpers.bash

setup() {
  stage_brain
  HUNT="$IGRIS_REPO_ROOT/core/skills/hunt/SKILL.md"
}

# stage_c1_world — the vendored-engine brain, a registered git repo, the brief.
stage_c1_world() {
  VENDORED_SERVER="$CLI_DIST/brain-mcp-server/dist/index.js"
  VENDORED_ENGINE="$CLI_DIST/brain-mcp-server/dist/engine/index.js"
  [ -f "$VENDORED_SERVER" ] && [ -f "$VENDORED_ENGINE" ] \
    || skip "vendored brain missing — run 'npm run build' in cli/ first"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"

  export IGRIS_BRAIN_DIR="$HOME/.igris"
  mkdir -p "$IGRIS_BRAIN_DIR/memory"
  DB="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  HOOK="$IGRIS_REPO_ROOT/core/git-hooks/pre-commit"
  [ -f "$HOOK" ] || { echo "hook missing: $HOOK"; return 1; }
  HOOK_PATH="$(path_with_stub_gitleaks)"

  # The vendored server migrates the DB and exits on stdin EOF.
  local pid deadline rc=0
  env -i HOME="$HOME" IGRIS_BRAIN_DIR="$IGRIS_BRAIN_DIR" IGRIS_DB_PATH="$DB" PATH="$PATH" \
    node "$VENDORED_SERVER" < /dev/null > "$BATS_TEST_TMPDIR/migrate.out" 2> "$BATS_TEST_TMPDIR/migrate.err" &
  pid=$!
  deadline=$(( $(date +%s) + 60 ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.2
  done
  wait "$pid" || rc=$?
  [ "$rc" -eq 0 ] || { echo "vendored migrate exited $rc"; tail -20 "$BATS_TEST_TMPDIR/migrate.err"; return 1; }
  # ARM: it opened THIS db, and the tables under test exist.
  grep -qxF "[brain] db: $DB" "$BATS_TEST_TMPDIR/migrate.err" \
    || { echo "vendored server opened another db"; grep '^\[brain\] db:' "$BATS_TEST_TMPDIR/migrate.err"; return 1; }
  [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('instances','brief_status','projects')")" = "3" ] \
    || { echo "vendored schema lacks instances/brief_status/projects"; return 1; }

  REPO="$(cd "$(stage_git_project cproj)" && pwd -P)"
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path) VALUES ('cproj', 'cproj', '$REPO');"

  # The brief, through the engine's own brief_sync (FTS triggers need the
  # engine's sqlite, not the host sqlite3).
  (cd "$CLI_DIST/.." && env -i HOME="$HOME" IGRIS_BRAIN_DIR="$IGRIS_BRAIN_DIR" IGRIS_DB_PATH="$DB" \
    PATH="$PATH" ENGINE="file://$VENDORED_ENGINE" DB="$DB" node --input-type=module -e '
      const { bootEngine } = await import(process.env.ENGINE);
      const e = bootEngine({ dbPath: process.env.DB, components: { schedules: { enabled: false } } });
      try {
        const r = await e.gateway.dispatch("igris_brief_sync", {
          project: "cproj", brief_id: "FR-1", brief_type: "Feature", title: "c1 fixture",
          status: "In Progress", phase: "BUILDING" });
        if (r.isError) { console.error(JSON.stringify(r)); process.exitCode = 1; }
      } finally { e.shutdown(); }
    ' > "$BATS_TEST_TMPDIR/brief.out" 2> "$BATS_TEST_TMPDIR/brief.err") \
    || { echo "brief fixture failed"; tail -20 "$BATS_TEST_TMPDIR/brief.err"; return 1; }
  [ "$(sqlite3 "$DB" "SELECT status || '|' || phase FROM brief_status WHERE project='cproj' AND brief_id='FR-1'")" = "In Progress|BUILDING" ] \
    || { echo "brief fixture not landed"; return 1; }
}

# cli <args...> — the BUILT cli from the repo, fenced, no harness markers.
cli() {
  (cd "$REPO" && env -i HOME="$HOME" IGRIS_BRAIN_DIR="$IGRIS_BRAIN_DIR" PATH="$PATH" \
    node "$CLI_DIST/index.js" "$@")
}

# hook — the real pre-commit from the repo, cwd = the scratch repo, the
# session named one-shot (PLAN §2.2).
hook() {
  (cd "$REPO" && env -i HOME="$HOME" IGRIS_BRAIN_DIR="$IGRIS_BRAIN_DIR" PATH="$HOOK_PATH" \
    IGRIS_INSTANCE_ID="$IID" bash "$HOOK" 2>&1)
}

# brief_cell — typeof|value of this instance's current_brief.
brief_cell() {
  sqlite3 "$DB" "SELECT typeof(current_brief) || '|' || ifnull(current_brief, '<NULL>') FROM instances WHERE id='$IID';"
}

@test "C1: instance state — brief gates, an omitted --current-brief is unchanged, \"\" clears to '' and the guard allows" {
  stage_c1_world

  run cli session register --project cproj --project-path "$REPO"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  IID="$(printf '%s' "$output" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const line = s.split("\n").filter((l) => l.trim().startsWith("{")).pop() || "{}";
      process.stdout.write(JSON.parse(line).instance_id || "");
    });
  ')"
  [ -n "$IID" ] || { echo "register gave no instance_id: $output"; return 1; }

  # (a) the brief is set -> the guard refuses, naming it.
  run cli instance state --project cproj --instance-id "$IID" \
    --current-brief FR-1 --current-phase BUILDING --current-task "c1 build" --lease-minutes 120
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *'"updated":true'* ]] || { echo "$output"; return 1; }
  [ "$(brief_cell)" = "text|FR-1" ] || { echo "after (a): $(brief_cell)"; return 1; }
  run hook
  [ "$status" -eq 1 ] || { echo "(a) hook exit $status: $output"; return 1; }
  [[ "$output" == *"phase guard"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"FR-1"* ]] || { echo "$output"; return 1; }

  # (b) --current-brief omitted -> unchanged; still refused.
  run cli instance state --project cproj --instance-id "$IID" \
    --current-phase TESTING --current-task "c1 test" --lease-minutes 120
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(brief_cell)" = "text|FR-1" ] || { echo "after (b): $(brief_cell)"; return 1; }
  run hook
  [ "$status" -eq 1 ] || { echo "(b) hook exit $status: $output"; return 1; }

  # (c) the COMPLETE clear: "" -> '' (a text value, NOT NULL); the guard allows
  #     although FR-1 is still In Progress / BUILDING in brief_status.
  run cli instance state --project cproj --instance-id "$IID" \
    --current-brief "" --current-phase COMPLETE --current-task "brief closed" --lease-minutes 120
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(brief_cell)" = "text|" ] || { echo "after (c): $(brief_cell)"; return 1; }
  [ "$(sqlite3 "$DB" "SELECT current_phase FROM instances WHERE id='$IID'")" = "COMPLETE" ] || return 1
  run hook
  [ "$status" -eq 0 ] || { echo "(c) hook exit $status: $output"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || { echo "$output"; return 1; }

  # (d) omitted again -> still '' (never NULLed by an omission); still allowed.
  run cli instance state --project cproj --instance-id "$IID" \
    --current-phase COMPLETE --current-task "idle" --lease-minutes 120
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(brief_cell)" = "text|" ] || { echo "after (d): $(brief_cell)"; return 1; }
  run hook
  [ "$status" -eq 0 ] || { echo "(d) hook exit $status: $output"; return 1; }
}

# hunt_section <heading> <stop-regex> — $HUNT from the line starting with
# <heading> to the next line matching <stop-regex> OUTSIDE a code fence (a
# `# comment` inside a bash block is not a heading).
hunt_section() {
  awk -v start="$1" -v stop="$2" '
    !on && index($0, start) == 1 { on = 1; print; next }
    on && /^[[:space:]]*```/ { fence = !fence }
    on && !fence && $0 ~ stop { exit }
    on { print }
  ' "$HUNT"
}

@test "S1: /hunt Phase 8 (COMPLETE) clears the instance's brief with --current-brief \"\"" {
  [ -f "$HUNT" ] || { echo "missing: $HUNT"; return 1; }
  block="$(hunt_section '### Phase 8: COMPLETE' '^##?#? ')"
  [ -n "$block" ] || { echo "Phase 8 not found"; return 1; }
  [[ "$block" == *"igris instance state"* ]] || { echo "Phase 8 runs no 'igris instance state'"; return 1; }
  [[ "$block" == *'--current-brief ""'* ]] || { echo "Phase 8 does not clear with --current-brief \"\""; return 1; }
  [[ "$block" == *"--current-phase COMPLETE"* ]] || { echo "Phase 8 does not record --current-phase COMPLETE"; return 1; }
}

@test "S2: the per-transition instance-state rule states the COMPLETE clear (--current-brief \"\")" {
  [ -f "$HUNT" ] || { echo "missing: $HUNT"; return 1; }
  block="$(hunt_section '## Instance State and Work Lease' '^##? ')"
  [ -n "$block" ] || { echo "section not found"; return 1; }
  [[ "$block" == *'--current-brief ""'* ]] || { echo "the rule never says COMPLETE passes --current-brief \"\""; return 1; }
}
