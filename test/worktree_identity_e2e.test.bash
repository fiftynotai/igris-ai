#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# worktree_identity_e2e.test.bash — TD-359 AC-W2, end to end on a scratch brain.
#
# AC-W2: from a git worktree of igris-ai whose directory name is NOT `igris-ai`,
# a session start, brief work, a commit and a session end land no row under the
# worktree's directory name; every row lands under `igris-ai`. Shown by
# read-only SQL on a scratch brain before and after; the live brain is never
# opened for writing.
#
# THE PROCEDURE (PLAN §6 "AC-W2 procedure", run ONCE in setup_file):
#   1. Migrate a scratch brain by spawning the VENDORED
#      cli/dist/brain-mcp-server/dist/index.js once, stdin at EOF, both seams
#      set (IGRIS_BRAIN_DIR + IGRIS_DB_PATH) — the smoke-bundled-mcp.sh
#      mechanism. Its `[brain] db:` line must name the scratch DB (E0).
#   2. `igris register-project` the scratch main repo, named `igris-ai`.
#   3. From the worktree `wt-td359-<rand>` (OUTSIDE the main repo's tree, the
#      GL-015 shape), the boot verbs in /boot's order, none given a --project
#      the skill does not give: `ceremony start --name boot` (no --project),
#      `attention begin`, `detect`, `attention bind --project <detect slug>`,
#      `attention read` (boot:index), `session gather --project <detect slug>`,
#      `session register --project <detect slug> --project-path <detect path>
#      --attention-session <id>`, `ceremony stop --project <detect slug>`.
#   4. Brief work: `instance state` with NO --project (BUILDING), the
#      pre_tool_use.sh brief gate on a Write inside the worktree, the write,
#      then the hunt-style transition to COMMITTING (`igris_brief_sync` through
#      the engine + `instance state`, again with no --project).
#   5. `igris_session_sync` dispatched through the vendored engine
#      (bootEngine + gateway.dispatch — the brain-write-bridge.ts precedent)
#      with project = the detect slug.
#   6. A real `git commit` in the worktree through the repo's git hooks
#      (core.hooksPath -> a dir of SYMLINKS to core/git-hooks/*, so `$0` is a
#      symlink, as in a consumer clone), carrying IGRIS_INSTANCE_ID one-shot as
#      /hunt Phase 7 will (PLAN §2.2).
#   7. core/hooks/shared/session_end.sh fired from the worktree.
#   8. Counts with read-only SQL, before (after step 2) and after (step 7):
#      instances.project_slug, ceremony_events.project, sessions.project,
#      attention_sessions.project, attention_events joined to its session's
#      project, and the ~/.igris/projects/<name>/ directories — for the
#      worktree name AND for igris-ai. (`ceremony_runs` does not exist and
#      `attention_tool_inventory` has no project column — PLAN §0.)
#   9. Live-brain proof (E9, OPT-IN): IGRIS_E2E_LIVE_DB=<path of the live
#      knowledge.db> makes the test read it with `sqlite3 -readonly` and
#      assert 0 rows for the random worktree name in the same tables. Without
#      the variable E9 skips with that reason (CI has no live brain, and the
#      fenced HOME never reaches one).
#
# Each @test asserts ONE facet of the single run, so a HEAD run shows which
# surface still lands under the worktree name. IGRIS_E2E_RECORD=<file> appends
# the before/after counts (TSV) to <file> for the brief's record; the same
# record is printed by any failing table assertion.
#
# Fence: every sandboxed command runs under `env -i` with HOME=$E/home,
# IGRIS_BRAIN_DIR=$HOME/.igris (one path — the hooks read $HOME/.igris, the CLI
# reads IGRIS_BRAIN_DIR) and a REBUILT PATH whose `igris` is a shim onto THIS
# checkout's cli/dist (the global `igris` is never reachable — E0 proves it)
# and whose `curl` is a refusing stub (session_end.sh's deregister curls
# localhost:3001; a stub keeps any local brain unreachable even if a future
# change seeds the session file it keys on). No harness marker survives
# `env -i`, so the owner walk records no owner and identification is S1/S3.
#
# Reads of the scratch DB are read-only: `sqlite3 -readonly` when the WAL
# side files exist, else `file:<db>?immutable=1` (a WAL-mode DB with no -wal
# file is fully checkpointed, and -readonly cannot create the -shm it would
# need). See ro_q.

load test_helper

E2E_MAIN_SLUG="igris-ai"

# ro_q <db> <sql> — read-only query (see header). A -wal without a -shm is an
# inconsistent snapshot we refuse to guess about.
ro_q() {
  local db="$1" sql="$2"
  if [ -e "$db-wal" ] && [ -e "$db-shm" ]; then
    sqlite3 -readonly "$db" "$sql"
  elif [ ! -e "$db-wal" ]; then
    sqlite3 -readonly "file:$db?immutable=1" "$sql"
  else
    echo "ro_q: $db has a -wal but no -shm" >&2
    return 1
  fi
}

# jget <file> <dotted.key> — a field of the LAST JSON line of <file> ("" when absent).
jget() {
  node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
    let v;
    try { v = JSON.parse(lines[lines.length - 1]); } catch { process.exit(0); }
    for (const k of process.argv[2].split(".")) { v = v == null ? undefined : v[k]; }
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  ' "$1" "$2"
}

# in_sbx <cmd...> — run <cmd> under the fenced, rebuilt environment.
in_sbx() {
  env -i HOME="$E2E_HOME" IGRIS_BRAIN_DIR="$E2E_HOME/.igris" PATH="$E2E_PATH" \
    GIT_CONFIG_GLOBAL="$E2E_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 TMPDIR="$E2E_DIR/tmp" \
    LANG=C "$@"
}

# e2e_step <name> <cmd...> — stdout/stderr to $E2E_LOG/<name>.{out,err}, the
# exit code to steps.tsv. Never fails: setup_file records, the tests assert.
e2e_step() {
  local name="$1" rc=0
  shift
  "$@" > "$E2E_LOG/$name.out" 2> "$E2E_LOG/$name.err" || rc=$?
  printf '%s\t%s\n' "$name" "$rc" >> "$E2E_LOG/steps.tsv"
  return 0
}

# cli_in <cwd> <args...> — this checkout's CLI, from <cwd>, fenced.
cli_in() {
  local cwd="$1"
  shift
  (cd "$cwd" && in_sbx node "$E2E_CLI" "$@")
}

# engine <tool> <json-args> — one gateway.dispatch through the vendored engine.
engine() {
  in_sbx env IGRIS_DB_PATH="$E2E_DB" node "$E2E_DIR/engine-dispatch.mjs" "$E2E_ENGINE" "$E2E_DB" "$1" "$2"
}

# e2e_counts <label> — TSV rows "label name table count", read-only.
e2e_counts() {
  local label="$1" name q c
  for name in "$E2E_WT_NAME" "$E2E_MAIN_SLUG"; do
    q=${name//\'/\'\'}
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM instances WHERE project_slug='$q'")"
    printf '%s\t%s\tinstances\t%s\n' "$label" "$name" "$c"
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM ceremony_events WHERE project='$q'")"
    printf '%s\t%s\tceremony_events\t%s\n' "$label" "$name" "$c"
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM sessions WHERE project='$q'")"
    printf '%s\t%s\tsessions\t%s\n' "$label" "$name" "$c"
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM attention_sessions WHERE project='$q'")"
    printf '%s\t%s\tattention_sessions\t%s\n' "$label" "$name" "$c"
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM attention_events e JOIN attention_sessions s ON s.id = e.session_id WHERE s.project='$q'")"
    printf '%s\t%s\tattention_events\t%s\n' "$label" "$name" "$c"
    c=0
    [ -d "$E2E_HOME/.igris/projects/$name" ] && c=1
    printf '%s\t%s\tprojects_dir\t%s\n' "$label" "$name" "$c"
    # Recorded, not asserted (outside AC-W2's table list): the LIVE file rows.
    c="$(ro_q "$E2E_DB" "SELECT COUNT(*) FROM session_files WHERE project='$q'")"
    printf '%s\t%s\tsession_files(record-only)\t%s\n' "$label" "$name" "$c"
  done
}

setup_file() {
  local root cli server engine_js
  root="$IGRIS_ROOT"
  cli="$root/cli/dist/index.js"
  server="$root/cli/dist/brain-mcp-server/dist/index.js"
  engine_js="$root/cli/dist/brain-mcp-server/dist/engine/index.js"
  # Prerequisites missing: run nothing; setup() skips every test with the reason.
  [ -f "$cli" ] && [ -f "$server" ] && [ -f "$engine_js" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 && command -v git >/dev/null 2>&1 \
    && command -v node >/dev/null 2>&1 || return 0

  local E rand
  E="$(mkdir -p "$BATS_FILE_TMPDIR/e2e" && cd "$BATS_FILE_TMPDIR/e2e" && pwd -P)"
  rand="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  E2E_DIR="$E"
  E2E_HOME="$E/home"
  E2E_LOG="$E/log"
  E2E_DB="$E2E_HOME/.igris/memory/knowledge.db"
  E2E_CLI="$cli"
  E2E_ENGINE="$engine_js"
  E2E_WT_NAME="wt-td359-$rand"
  E2E_MAIN="$E/main/$E2E_MAIN_SLUG"
  E2E_WT="$E/elsewhere/$E2E_WT_NAME"
  mkdir -p "$E2E_HOME/.igris/memory" "$E2E_LOG" "$E/bin" "$E/tmp" "$E/hooks" \
    "$E/main" "$E/elsewhere"

  # The sandbox PATH: node/python3 symlinks, the `igris` shim, the curl stub,
  # then /usr/bin:/bin (git, sqlite3, jq, ps, hostname, sed, ...). The global
  # igris lives elsewhere and is not reachable.
  local tool p
  for tool in node python3; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && ln -s "$p" "$E/bin/$tool"
  done
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$E/bin/node" "$cli" > "$E/bin/igris"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/curl-calls.log"\nexit 7\n' "$E" > "$E/bin/curl"
  chmod +x "$E/bin/igris" "$E/bin/curl"
  E2E_PATH="$E/bin:/usr/bin:/bin"

  printf '[user]\n\tname = td359-e2e\n\temail = td359@igris.invalid\n[init]\n\tdefaultBranch = main\n' > "$E/gitconfig"

  # A perception stub where session_end.sh looks for the extractor: it records
  # the slug the hook passes. Plus the OS index /boot's `attention read` reads.
  mkdir -p "$E2E_HOME/.igris/core/hooks/shared" "$E2E_HOME/.igris/core/os"
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >> "$HOME/perception-slugs.log"\n' \
    > "$E2E_HOME/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  chmod +x "$E2E_HOME/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  printf '# Igris OS index (td359 e2e fixture)\n' > "$E2E_HOME/.igris/core/os/INDEX.md"

  # The engine dispatcher (step 5 + the brief fixture): one engine per process
  # (brain-write-bridge.ts STEP 7), schedules disabled (D1a), always shut down.
  cat > "$E/engine-dispatch.mjs" <<'MJS'
import { pathToFileURL } from "node:url";
const [enginePath, dbPath, tool, argsJson] = process.argv.slice(2);
const { bootEngine } = await import(pathToFileURL(enginePath).href);
const engine = bootEngine({ dbPath, components: { schedules: { enabled: false } } });
let code = 0;
try {
  const res = await engine.gateway.dispatch(tool, JSON.parse(argsJson));
  process.stdout.write(JSON.stringify(res) + "\n");
  if (res && res.isError) code = 1;
} catch (err) {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  code = 1;
} finally {
  engine.shutdown();
}
process.exit(code);
MJS

  # The git hooks as SYMLINKS (so $0 is a link, the consumer-clone shape).
  ln -s "$root/core/git-hooks/pre-commit" "$E/hooks/pre-commit"
  ln -s "$root/core/git-hooks/commit-msg" "$E/hooks/commit-msg"

  # Persist the paths for setup() and every @test (each runs in its own process).
  local k
  for k in E2E_DIR E2E_HOME E2E_LOG E2E_DB E2E_CLI E2E_ENGINE E2E_WT_NAME E2E_MAIN E2E_WT E2E_PATH; do
    printf '%s=%q\n' "$k" "${!k}"
  done > "$BATS_FILE_TMPDIR/e2e.env"

  : > "$E2E_LOG/steps.tsv"

  # --- 1. migrate the scratch brain through the vendored server -------------
  local rc=0 pid deadline
  env -i HOME="$E2E_HOME" IGRIS_BRAIN_DIR="$E2E_HOME/.igris" IGRIS_DB_PATH="$E2E_DB" \
    PATH="$E2E_PATH" TMPDIR="$E/tmp" "$E/bin/node" "$server" \
    < /dev/null > "$E2E_LOG/migrate.out" 2> "$E2E_LOG/migrate.err" &
  pid=$!
  deadline=$(( $(date +%s) + 60 ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.2
  done
  wait "$pid" || rc=$?
  printf 'migrate\t%s\n' "$rc" >> "$E2E_LOG/steps.tsv"

  # The scratch main repo (one commit) and its linked worktree OUTSIDE its tree.
  mkdir -p "$E2E_MAIN"
  in_sbx git -C "${E2E_MAIN:?}" init -q
  printf 'main\n' > "$E2E_MAIN/README.md"
  in_sbx git -C "${E2E_MAIN:?}" add README.md
  in_sbx git -C "${E2E_MAIN:?}" commit -q -m "chore: scratch main" --no-verify
  in_sbx git -C "${E2E_MAIN:?}" config core.hooksPath "$E/hooks"
  in_sbx git -C "${E2E_MAIN:?}" worktree add -q -b td359-e2e "${E2E_WT:?}"

  # --- 2. register the main repo ---------------------------------------------
  e2e_step register_project cli_in "$E" register-project "$E2E_MAIN"
  # Fixture: the hunted brief, under igris-ai, through the engine (FTS-safe).
  e2e_step brief_fixture engine igris_brief_sync \
    '{"project":"igris-ai","brief_id":"TD-1","brief_type":"Technical Debt","title":"td359 e2e fixture","status":"In Progress","phase":"BUILDING"}'

  e2e_counts before > "$E2E_LOG/counts.tsv"

  # --- 3. session start: the boot verbs from the worktree ---------------------
  local WT="$E2E_WT" slug path harness aid iid
  e2e_step ceremony_start cli_in "$WT" ceremony start --name boot
  e2e_step attention_begin cli_in "$WT" attention begin
  aid="$(jget "$E2E_LOG/attention_begin.out" session.id)"
  e2e_step detect cli_in "$WT" detect
  slug="$(jget "$E2E_LOG/detect.out" project_slug)"
  path="$(jget "$E2E_LOG/detect.out" project_path)"
  harness="$(jget "$E2E_LOG/detect.out" harness)"
  e2e_step attention_bind cli_in "$WT" attention bind --session "$aid" --project "$slug" --harness "$harness"
  e2e_step attention_read cli_in "$WT" attention read --session "$aid" --type os_module \
    --id igris-core:INDEX --selection boot --selection-ref boot:index
  e2e_step session_gather cli_in "$WT" session gather --project "$slug"
  e2e_step session_register cli_in "$WT" session register --project "$slug" \
    --project-path "$path" --attention-session "$aid"
  iid="$(jget "$E2E_LOG/session_register.out" instance_id)"
  e2e_step ceremony_stop cli_in "$WT" ceremony stop --name boot --project "$slug" --instance-id "$iid"

  # --- 4. brief work -----------------------------------------------------------
  e2e_step state_building cli_in "$WT" instance state --instance-id "$iid" \
    --current-brief TD-1 --current-phase BUILDING --current-task "td359 e2e build" --lease-minutes 120
  mkdir -p "$WT/notes"
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"cwd":"%s"}' \
    "$WT/notes/e2e-note.txt" "$WT" > "$E2E_LOG/pre_tool_use.in"
  e2e_step pre_tool_use bash -c 'cd "$1" && "${@:2}" < "$0"' "$E2E_LOG/pre_tool_use.in" "$WT" \
    env -i HOME="$E2E_HOME" IGRIS_BRAIN_DIR="$E2E_HOME/.igris" PATH="$E2E_PATH" TMPDIR="$E/tmp" \
    bash "$root/core/hooks/shared/pre_tool_use.sh"
  printf 'td359 e2e\n' > "$WT/notes/e2e-note.txt"
  e2e_step brief_committing engine igris_brief_sync \
    '{"project":"igris-ai","brief_id":"TD-1","brief_type":"Technical Debt","title":"td359 e2e fixture","status":"In Progress","phase":"COMMITTING"}'
  e2e_step state_committing cli_in "$WT" instance state --instance-id "$iid" \
    --current-brief TD-1 --current-phase COMMITTING --current-task "td359 e2e commit" --lease-minutes 120

  # --- 5. session sync through the vendored engine ----------------------------
  e2e_step session_sync engine igris_session_sync \
    "{\"project\":\"$slug\",\"brief_id\":\"TD-1\",\"phase\":\"COMMITTING\",\"mode\":\"HUNT\",\"summary\":\"td359 e2e session\"}"

  # --- 6. a real commit through the hooks --------------------------------------
  in_sbx git -C "${WT:?}" rev-list --count HEAD > "$E2E_LOG/commits_before.txt"
  in_sbx git -C "${WT:?}" add notes/e2e-note.txt
  e2e_step commit in_sbx env IGRIS_INSTANCE_ID="$iid" \
    git -C "${WT:?}" commit -m "chore: td359 e2e worktree commit"
  in_sbx git -C "${WT:?}" rev-list --count HEAD > "$E2E_LOG/commits_after.txt"

  # --- 7. session end ----------------------------------------------------------
  printf '{"session_id":"td359-e2e","reason":"exit","cwd":"%s"}' "$WT" > "$E2E_LOG/session_end.in"
  e2e_step session_end bash -c 'cd "$1" && "${@:2}" < "$0"' "$E2E_LOG/session_end.in" "$WT" \
    env -i HOME="$E2E_HOME" IGRIS_BRAIN_DIR="$E2E_HOME/.igris" PATH="$E2E_PATH" TMPDIR="$E/tmp" \
    GIT_CONFIG_GLOBAL="$E/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
    bash "$root/core/hooks/shared/session_end.sh"
  # The perception spawn is detached (nohup … & disown); give it a moment.
  local i=0
  while [ ! -s "$E2E_HOME/perception-slugs.log" ] && [ "$i" -lt 15 ]; do
    sleep 0.2
    i=$((i + 1))
  done

  # --- 8. after ------------------------------------------------------------------
  e2e_counts after >> "$E2E_LOG/counts.tsv"
  {
    printf 'worktree_name\t%s\n' "$E2E_WT_NAME"
    printf 'detect_slug\t%s\n' "$slug"
    printf 'instance_id\t%s\n' "$iid"
    printf 'perception_slugs\t%s\n' \
      "$([ -f "$E2E_HOME/perception-slugs.log" ] && tr '\n' ' ' < "$E2E_HOME/perception-slugs.log")"
    printf 'igris_ai_knowledge_sha\t%s\n' "$(ro_q "$E2E_DB" "SELECT ifnull(knowledge_sha,'NULL') FROM projects WHERE slug='igris-ai'")"
    sed 's/^/step\t/' "$E2E_LOG/steps.tsv"
    cat "$E2E_LOG/counts.tsv"
  } > "$E2E_LOG/record.tsv"
  if [ -n "${IGRIS_E2E_RECORD:-}" ]; then
    { printf '# worktree_identity_e2e %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"; cat "$E2E_LOG/record.tsv"; } \
      >> "$IGRIS_E2E_RECORD"
  fi
}

setup() {
  [ -f "$IGRIS_ROOT/cli/dist/index.js" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  [ -f "$IGRIS_ROOT/cli/dist/brain-mcp-server/dist/index.js" ] || skip "vendored brain missing — run 'npm run build' in cli/ first"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v node >/dev/null 2>&1 || skip "node not available"
  [ -f "$BATS_FILE_TMPDIR/e2e.env" ] || { echo "setup_file wrote no e2e.env"; return 1; }
  # shellcheck source=/dev/null
  . "$BATS_FILE_TMPDIR/e2e.env"
}

# count_of <label> <name> <table> — one cell of counts.tsv ("" when absent).
count_of() {
  awk -F'\t' -v l="$1" -v n="$2" -v t="$3" '$1 == l && $2 == n && $3 == t { print $4 }' \
    "$E2E_LOG/counts.tsv"
}

# assert_table <table> — after the run: 0 under the worktree name, >= 1 under
# igris-ai; and the worktree name started at 0 (the before snapshot).
assert_table() {
  local t="$1" wt main before
  wt="$(count_of after "$E2E_WT_NAME" "$t")"
  main="$(count_of after "$E2E_MAIN_SLUG" "$t")"
  before="$(count_of before "$E2E_WT_NAME" "$t")"
  echo "table=$t worktree($E2E_WT_NAME): before=$before after=$wt; $E2E_MAIN_SLUG after=$main"
  echo "--- record ---"
  cat "$E2E_LOG/record.tsv"
  [ "$before" = "0" ] || return 1
  [ "$wt" = "0" ] || return 1
  [ -n "$main" ] && [ "$main" -ge 1 ] || return 1
}

@test "E0: the AC-W2 procedure ran end to end in the fence (every step exit 0, scratch DB only)" {
  # The vendored server opened the SCRATCH db (TD-426's containment line).
  run grep -m1 '^\[brain\] db: ' "$E2E_LOG/migrate.err"
  [ "$output" = "[brain] db: $E2E_DB" ] || { echo "migrate opened: $output"; cat "$E2E_LOG/migrate.err"; return 1; }
  # The sandbox PATH reaches THIS checkout's CLI, never the global one.
  run env -i PATH="$E2E_PATH" /bin/sh -c 'command -v igris'
  [ "$output" = "$E2E_DIR/bin/igris" ] || { echo "igris resolves to: $output"; return 1; }
  # No sandboxed command reached curl (session_end's localhost deregister).
  [ ! -e "$E2E_DIR/curl-calls.log" ] || { echo "curl was called:"; cat "$E2E_DIR/curl-calls.log"; return 1; }
  # The worktree really is a linked worktree whose leaf is not the slug.
  [ "$(basename "$E2E_WT")" != "igris-ai" ] || return 1
  [ -f "$E2E_WT/.git" ] || { echo "not a linked worktree: $E2E_WT"; return 1; }
  # The brief-gate target is not an exempt path (a vacuous allow otherwise).
  case "$E2E_WT/notes/e2e-note.txt" in
    */.igris/*|*/core/*|*/.claude/*|*/test/*|*/tests/*) echo "target path is gate-exempt"; return 1 ;;
  esac
  # Every step exited 0.
  run awk -F'\t' '$2 != "0" { print }' "$E2E_LOG/steps.tsv"
  [ -z "$output" ] || {
    echo "steps with a non-zero exit:"; echo "$output"
    for s in $(awk -F'\t' '$2 != "0" { print $1 }' "$E2E_LOG/steps.tsv"); do
      echo "--- $s.out"; cat "$E2E_LOG/$s.out" 2>/dev/null; echo "--- $s.err"; tail -20 "$E2E_LOG/$s.err" 2>/dev/null
    done
    return 1
  }
  # 18 recorded steps: a missing line is a step that never ran.
  [ "$(wc -l < "$E2E_LOG/steps.tsv" | tr -d ' ')" -eq 18 ] || { cat "$E2E_LOG/steps.tsv"; return 1; }
}

@test "E1: instances — 0 rows under the worktree name, >= 1 under igris-ai" {
  assert_table instances
}

@test "E2: ceremony_events — 0 rows under the worktree name, >= 1 under igris-ai" {
  assert_table ceremony_events
}

@test "E3: sessions — 0 rows under the worktree name, >= 1 under igris-ai" {
  assert_table sessions
}

@test "E4: attention_sessions — 0 rows under the worktree name, >= 1 under igris-ai" {
  assert_table attention_sessions
}

@test "E5: attention_events (via their session's project) — 0 under the worktree name, >= 1 under igris-ai" {
  assert_table attention_events
}

@test "E6: ~/.igris/projects/ — no directory for the worktree name; igris-ai's exists" {
  assert_table projects_dir
}

@test "E7: brief work and the commit ran through the gates under igris-ai" {
  # The brief gate did not deny the Write (igris-ai holds an In Progress brief).
  run grep -c '"permissionDecision": *"deny"' "$E2E_LOG/pre_tool_use.out"
  [ "$output" = "0" ] || { echo "brief gate denied:"; cat "$E2E_LOG/pre_tool_use.out"; return 1; }
  # The commit landed, through the hooks (the layers line proves pre-commit ran).
  [ "$(awk -F'\t' '$1 == "commit" { print $2 }' "$E2E_LOG/steps.tsv")" = "0" ] \
    || { cat "$E2E_LOG/commit.out" "$E2E_LOG/commit.err"; return 1; }
  [ "$(cat "$E2E_LOG/commits_after.txt")" -eq "$(( $(cat "$E2E_LOG/commits_before.txt") + 1 ))" ] || return 1
  cat "$E2E_LOG/commit.out" "$E2E_LOG/commit.err" > "$E2E_LOG/commit.all"
  grep -q '^\[pre-commit\] layers: ' "$E2E_LOG/commit.all" || { cat "$E2E_LOG/commit.all"; return 1; }
  # The session carried IGRIS_INSTANCE_ID, so the guard must have identified it:
  # a D1 "not identified" notice here means the hook resolved the wrong project.
  run grep -c 'committing session not identified' "$E2E_LOG/commit.all"
  [ "$output" = "0" ] || { cat "$E2E_LOG/commit.all"; return 1; }
}

@test "E8: session end landed under igris-ai (watermark row + perception slug)" {
  echo "--- record ---"
  cat "$E2E_LOG/record.tsv"
  # record_watermark wrote the igris-ai row (the gate resolved igris-ai).
  sha="$(ro_q "$E2E_DB" "SELECT ifnull(knowledge_sha,'') FROM projects WHERE slug='igris-ai'")"
  [ -n "$sha" ] || { echo "no knowledge watermark on the igris-ai row"; return 1; }
  # The detached perception spawn named igris-ai, never the worktree name.
  [ -s "$E2E_HOME/perception-slugs.log" ] || { echo "perception was never spawned"; return 1; }
  run grep -vxF "$E2E_MAIN_SLUG" "$E2E_HOME/perception-slugs.log"
  [ -z "$output" ] || { echo "perception got: $output"; return 1; }
}

@test "E9: live-brain proof — 0 rows for the random worktree name (opt-in, read-only)" {
  [ -n "${IGRIS_E2E_LIVE_DB:-}" ] || skip "set IGRIS_E2E_LIVE_DB=<live knowledge.db> to run the read-only live proof"
  [ -f "$IGRIS_E2E_LIVE_DB" ] || { echo "no such file: $IGRIS_E2E_LIVE_DB"; return 1; }
  case "$IGRIS_E2E_LIVE_DB" in
    "$E2E_DIR"/*) echo "IGRIS_E2E_LIVE_DB points into the sandbox"; return 1 ;;
  esac
  local q t col n total=0
  q=${E2E_WT_NAME//\'/\'\'}
  for spec in instances:project_slug ceremony_events:project sessions:project attention_sessions:project projects:slug; do
    t="${spec%%:*}"; col="${spec#*:}"
    if [ -z "$(ro_q "$IGRIS_E2E_LIVE_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='$t'")" ]; then
      echo "live $t: absent"
      continue
    fi
    n="$(ro_q "$IGRIS_E2E_LIVE_DB" "SELECT COUNT(*) FROM $t WHERE $col='$q'")"
    echo "live $t.$col='$E2E_WT_NAME': $n"
    total=$((total + n))
  done
  if [ -n "$(ro_q "$IGRIS_E2E_LIVE_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='attention_events'")" ]; then
    n="$(ro_q "$IGRIS_E2E_LIVE_DB" "SELECT COUNT(*) FROM attention_events e JOIN attention_sessions s ON s.id = e.session_id WHERE s.project='$q'")"
    echo "live attention_events via session '$E2E_WT_NAME': $n"
    total=$((total + n))
  fi
  [ "$total" -eq 0 ]
}
