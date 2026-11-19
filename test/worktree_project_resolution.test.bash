#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# worktree_project_resolution.test.bash — TD-359. A git worktree of a
# registered project is that project, for the git hooks AND the shared hooks.
#
# THE DEFECT. Every hook derived the project slug from the directory NAME:
# `basename "$REPO_ROOT"` in both git hooks, `basename "$PROJECT_DIR"` in the
# shared hooks. A worktree named `wt-td359` became a phantom project with zero
# rows, so
#   - pre-commit's phase guard and commit-msg's AC gate looked under
#     `wt-td359`, found nothing and FAILED OPEN (exit 0);
#   - the shared hooks' registration gate found no registered ancestor of a
#     worktree outside the tree and silently NO-OPPED (the brief gate
#     included), while a worktree INSIDE the tree (`.claude/worktrees/agent-x`)
#     passed the gate and then read and wrote under `projects/agent-x/`.
#
# THE CONTRACT UNDER TEST (TD-359 plan §1, §2.6). One resolver,
# `igris_resolve_project` in core/hooks/shared/_gate.sh: marker, then the git
# main checkout, then the registry ancestor walk on the worktree-TRANSLATED
# path, then basename(main), then basename(dir). Both git hooks reach it
# through a symlink-following locator (`$0` → real hook dir →
# ../hooks/shared/_gate.sh, then $HOME/.igris/core/hooks/shared/_gate.sh).
# Observable outputs pinned here:
#   pre-commit refusal line   `project: <slug> (<source>)`
#   pre_tool_use deny suffix  `(project '<slug>' resolved from <dir> via <source>)`
#                             plus `this project has 0 briefs` when it has none
#
# Cases (RED on HEAD 5247c5a unless marked control):
#   W3a   pre-commit from the worktree, session named by IGRIS_INSTANCE_ID
#   W3a2  pre-commit from the worktree, the one live instance at its root
#   W3a-c control: same worktree, the session's brief is REVIEWING -> allowed
#   W3b   commit-msg from the worktree, `closes #TD-1` with an unticked AC
#   W3b-c control: every AC ticked -> allowed
#   W3c   a REAL `git commit` in the worktree, core.hooksPath = a dir of
#         symlinks into the repo (2 hops: hookdir -> scripts/git-hooks ->
#         core/git-hooks), no _gate.sh mirror under $HOME: the locator must
#         follow `$0`
#   W3c2  the same, commit-msg refusing a closing commit
#   S1    pre_tool_use in the worktree, no brief: deny names slug, dir, 0 briefs
#   S1b   pre_tool_use in the main checkout, a Done brief: names slug and dir,
#         no "0 briefs" clause
#   S2    control: pre_tool_use in the worktree, an In Progress brief -> allow
#   S3    control: a worktree of an UNREGISTERED repo -> allow (FR-212c: a
#         git-main slug is never "registered")
#   S4    post_compact from .claude/worktrees/agent-x -> projects/igris-ai/
#   S4b   post_compact from the outside worktree -> projects/igris-ai/
#   S5    session_start from the worktree reads projects/igris-ai/
#   S6    session_end from the worktree writes projects/igris-ai/, passes
#         `igris-ai` to perception and to the watermark verb
#
# FENCE. HOME is a sandbox (`$FAKEHOME`); IGRIS_BRAIN_DIR is the same root
# (test_standards: one path). Every hook runs with a PATH from which every
# directory carrying an `igris` executable is removed, so the LIVE CLI can
# never be reached (session_end's watermark step calls `igris`); S6 puts a
# recording STUB `igris` in front instead. The brain DB has plain tables only
# (macOS system sqlite3 cannot create vec0/FTS5).
#
# Run with `bats test/worktree_project_resolution.test.bash` (never `bash`).

load test_helper

PRE_COMMIT="$IGRIS_ROOT/core/git-hooks/pre-commit"
COMMIT_MSG="$IGRIS_ROOT/core/git-hooks/commit-msg"
SHARED_DIR="$IGRIS_ROOT/core/hooks/shared"
AC_CHECK_SRC="$IGRIS_ROOT/core/scripts/brief_ac_check.sh"

setup() {
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  local f
  for f in "$PRE_COMMIT" "$COMMIT_MSG" "$AC_CHECK_SRC" \
           "$SHARED_DIR/_gate.sh" "$SHARED_DIR/pre_tool_use.sh" \
           "$SHARED_DIR/post_compact.sh" "$SHARED_DIR/session_start.sh" \
           "$SHARED_DIR/session_end.sh"; do
    [ -f "$f" ] || { echo "missing subject: $f"; return 1; }
  done

  # Realpath'd (TD-150): the registry row must equal the resolver's `pwd -P`.
  SANDBOX="$(cd "$TEST_TEMP_DIR" && pwd -P)/wpr"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  printf '[user]\n\tname = wpr\n\temail = wpr@igris.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' \
    > "$FAKEHOME/.gitconfig"
  # Fixture git commands below read the sandbox identity, never the operator's.
  export GIT_CONFIG_GLOBAL="$FAKEHOME/.gitconfig"
  export GIT_CONFIG_NOSYSTEM=1

  build_safe_path

  # The scratch main checkout is NAMED igris-ai and registered at its realpath.
  MAIN="$SANDBOX/repos/igris-ai"
  WT="$SANDBOX/elsewhere/wt-td359"
  AGENT_WT="$MAIN/.claude/worktrees/agent-x"
  mkdir -p "$MAIN" "$SANDBOX/elsewhere"
  git -C "${MAIN:?}" init -q
  printf 'hello\n' > "$MAIN/README.md"
  git -C "${MAIN:?}" add README.md
  git -C "${MAIN:?}" commit -q --no-verify -m "chore: init"
  git -C "${MAIN:?}" worktree add -q -b td359-lane "$WT"
  git -C "${MAIN:?}" worktree add -q -b agent-x-lane "$AGENT_WT"
  [ "$(cd "$WT" && pwd -P)" = "$WT" ] || { echo "worktree path is not physical: $WT"; return 1; }

  sqlite3 "$DB" "
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, tech_stack TEXT DEFAULT '',
      igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT, metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT, effort TEXT, phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE brief_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, filename TEXT, content TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE instances (
      id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
      project_slug TEXT, project_path TEXT, current_brief TEXT,
      current_phase TEXT, current_task TEXT, status TEXT DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}', harness TEXT, harness_session_id TEXT,
      owner_pid INTEGER, owner_started_at TEXT, liveness_method TEXT,
      liveness_status TEXT, liveness_checked_at TEXT, lease_expires_at TEXT,
      state_updated_at TEXT, machine_id TEXT
    );
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
      component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path) VALUES ('igris-ai', 'igris-ai', '$(sql_q "$MAIN")');"
  HOSTNAME_LOCAL="$(hostname)"
}

# --- helpers -----------------------------------------------------------------

# sql_q <text> — single-quote-escape for an SQL literal. UNQUOTED expansion on
# purpose (MAINTAINING row 153): bash 3.2 keeps the backslashes of the quoted form.
sql_q() {
  local esc
  esc=${1//\'/\'\'}
  printf '%s' "$esc"
}

# build_safe_path — SAFE_PATH is $PATH minus every directory holding an
# `igris` executable, with a stub dir in front that keeps the tools the hooks
# need resolvable (they may share a directory with the live `igris`).
build_safe_path() {
  local stub="$SANDBOX/tool-bin" tool p d old_ifs
  mkdir -p "$stub"
  for tool in git sqlite3 python3 jq gitleaks hostname mktemp ps perl; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    case "$p" in /*) ln -sf "$p" "$stub/$tool" ;; esac
  done
  SAFE_PATH="$stub"
  old_ifs="$IFS"; IFS=':'
  for d in $PATH; do
    [ -n "$d" ] || continue
    [ -x "$d/igris" ] && continue
    SAFE_PATH="$SAFE_PATH:$d"
  done
  IFS="$old_ifs"
  # The fence is ARMED, not assumed: the live CLI is unreachable.
  if env PATH="$SAFE_PATH" /bin/bash -c 'command -v igris' >/dev/null 2>&1; then
    echo "SAFE_PATH still resolves igris"; return 1
  fi
  FENCE_ENV=(env -u IGRIS_INSTANCE_ID -u IGRIS_PROJECT_DIR -u CLAUDE_PROJECT_DIR
             -u IGRIS_BYPASS_PHASE_GUARD -u IGRIS_BYPASS_BRIEF_GATE
             -u IGRIS_BYPASS_AC_GATE -u IGRIS_BYPASS_EVENT_GATE
             -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR
             HOME="$FAKEHOME" IGRIS_BRAIN_DIR="$FAKEHOME/.igris" PATH="$SAFE_PATH"
             GIT_CONFIG_GLOBAL="$FAKEHOME/.gitconfig" GIT_CONFIG_NOSYSTEM=1)
}

# run_in <dir> [NAME=VALUE ...] <cmd> [args...] — bats `run` with cwd=<dir>
# under the fence. Extra assignments come after the fence's, so they win.
run_in() {
  local dir="$1"; shift
  run /bin/bash -c 'cd "$1" || exit 97; shift; exec "$@"' _ "$dir" "${FENCE_ENV[@]}" "$@"
}

# run_hook_stdin <json> [NAME=VALUE ...] <hook> — a shared hook fed <json>,
# from the sandbox root (the hooks take the directory from the payload).
run_hook_stdin() {
  local json="$1"; shift
  printf '%s' "$json" > "$SANDBOX/stdin.json"
  run /bin/bash -c 'cd "$1" || exit 97; in="$2"; shift 2; exec "$@" < "$in"' \
    _ "$SANDBOX" "$SANDBOX/stdin.json" "${FENCE_ENV[@]}" "$@"
}

# seed_instance <id> <brief> <project_path> — an active instance of igris-ai
# on THIS machine, lease in the future, no owner pid (so S2 never matches).
seed_instance() {
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, project_path,
                           current_brief, current_phase, status,
                           last_activity_at, lease_expires_at)
    VALUES ('$(sql_q "$1")', '$(sql_q "$HOSTNAME_LOCAL")', 'igris-ai',
            '$(sql_q "$3")', '$(sql_q "$2")', 'BUILDING', 'active',
            datetime('now'), datetime('now', '+1 hour'));"
}

# seed_brief <brief> <phase> [status] — a brief_status row of igris-ai.
seed_brief() {
  sqlite3 "$DB" "
    INSERT INTO brief_status (project, brief_id, title, status, phase)
    VALUES ('igris-ai', '$(sql_q "$1")', 't', '$(sql_q "${3:-In Progress}")', '$(sql_q "$2")');"
}

# seed_brief_file <brief> <content-file> — python3 does the insert so markdown
# never has to survive shell interpolation into SQL.
seed_brief_file() {
  python3 - "$DB" "$1" "$2" <<'PY'
import sqlite3, sys
db, brief_id, path = sys.argv[1:4]
con = sqlite3.connect(db)
con.execute(
    "INSERT INTO brief_files (project, brief_id, filename, content) VALUES ('igris-ai',?,?,?)",
    (brief_id, brief_id + ".md", open(path, encoding="utf-8").read()),
)
con.commit()
PY
}

# ac_brief <ticked|unticked> — TD-1's content, with AC1 open or ticked.
ac_brief() {
  local box=' '
  [ "$1" = "ticked" ] && box='x'
  printf '# TD-1: worktree fixture\n\n## Acceptance Criteria\n\n- [%s] AC1 the worktree resolves its main checkout slug\n- [x] AC2 already done\n' \
    "$box" > "$SANDBOX/TD-1.md"
  seed_brief_file TD-1 "$SANDBOX/TD-1.md"
}

# stage_ac_parser — the AC parser in the runtime mirror (commit-msg's second
# resolution branch; the scratch repo carries no core/scripts/). It does NOT
# stage _gate.sh: W3c/W3c2 need the locator to find it through `$0`.
stage_ac_parser() {
  mkdir -p "$FAKEHOME/.igris/core/scripts"
  cp "$AC_CHECK_SRC" "$FAKEHOME/.igris/core/scripts/brief_ac_check.sh"
}

# symlinked_hooks — core.hooksPath = a dir whose entries are symlinks to the
# repo's tracked scripts/git-hooks/* (themselves symlinks to core/git-hooks/*):
# the shape `scripts/install_git_hooks.sh` installs. `$0` is a symlink.
symlinked_hooks() {
  HOOKDIR="$SANDBOX/hookdir"
  mkdir -p "$HOOKDIR"
  ln -s "$IGRIS_ROOT/scripts/git-hooks/pre-commit" "$HOOKDIR/pre-commit"
  ln -s "$IGRIS_ROOT/scripts/git-hooks/commit-msg" "$HOOKDIR/commit-msg"
  [ -L "$IGRIS_ROOT/scripts/git-hooks/pre-commit" ] || { echo "scripts/git-hooks/pre-commit is not a symlink"; return 1; }
  git -C "${WT:?}" config core.hooksPath "$HOOKDIR"
  # No mirror copy: only the symlink chain can lead the hook to _gate.sh.
  [ ! -e "$FAKEHOME/.igris/core/hooks/shared/_gate.sh" ] || { echo "a mirror _gate.sh exists"; return 1; }
}

# ptu_json <project_dir> <file_path> — a native-Claude PreToolUse payload.
ptu_json() {
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"project_dir":"%s"}' "$2" "$1"
}

# deny_reason — the permissionDecisionReason of $output, or empty.
deny_reason() {
  printf '%s' "$output" | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
    h = d.get("hookSpecificOutput") or {}
    if h.get("permissionDecision") == "deny":
        print(h.get("permissionDecisionReason", ""))
except Exception:
    pass
'
}

# additional_context — the additionalContext string of $output, or empty.
additional_context() {
  printf '%s' "$output" | python3 -c '
import json, sys
try:
    print(json.loads(sys.stdin.read()).get("additionalContext", ""))
except Exception:
    pass
'
}

# =============================================================================
# AC-W3 (a) — pre-commit from a worktree whose directory name is not the slug.
# RED on HEAD: PROJECT=basename(toplevel)=wt-td359 -> no instance row -> exit 0.
# =============================================================================
@test "W3a: pre-commit from worktree wt-td359 resolves igris-ai and refuses the named session's BUILDING brief" {
  seed_instance td359-inst-a0001 TD-1 "$WT"
  seed_brief TD-1 BUILDING
  run_in "$WT" IGRIS_INSTANCE_ID=td359-inst-a0001 /bin/bash "$PRE_COMMIT"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"PI-004 phase guard: refusing commit"* ]] || return 1
  [[ "$output" == *"project: igris-ai (registry)"* ]] || return 1
  [[ "$output" == *"TD-1"* ]] || return 1
  [[ "$output" == *"BUILDING"* ]] || return 1
  [[ "$output" != *"project: wt-td359"* ]] || return 1
}

# W3a2 — the same worktree with NO IGRIS_INSTANCE_ID: the one live instance
# registered at the worktree root (S3) is the committing session.
@test "W3a2: pre-commit from the worktree identifies the one live instance at its root (no IGRIS_INSTANCE_ID)" {
  seed_instance td359-inst-a0002 TD-1 "$WT"
  seed_brief TD-1 BUILDING
  run_in "$WT" /bin/bash "$PRE_COMMIT"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"PI-004 phase guard: refusing commit"* ]] || return 1
  [[ "$output" == *"project: igris-ai (registry)"* ]] || return 1
  [[ "$output" == *"TD-1"* ]] || return 1
}

# Control: the refusal is the PHASE's, not the mere presence of a row.
@test "W3a-c (control): the worktree session's brief is REVIEWING -> commit allowed" {
  seed_instance td359-inst-a0003 TD-1 "$WT"
  seed_brief TD-1 REVIEWING
  run_in "$WT" IGRIS_INSTANCE_ID=td359-inst-a0003 /bin/bash "$PRE_COMMIT"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]] || return 1
}

# =============================================================================
# AC-W3 (b) — commit-msg from the worktree. RED on HEAD: PROJECT=wt-td359 ->
# no brief_files row -> the AC gate is silent -> exit 0.
# =============================================================================
@test "W3b: commit-msg from the worktree resolves igris-ai and the AC gate refuses closes #TD-1 with an unticked AC" {
  stage_ac_parser
  ac_brief unticked
  printf 'fix(x): close the fixture\n\nbody line\n\ncloses #TD-1\n' > "$SANDBOX/MSG"
  run_in "$WT" /bin/bash "$COMMIT_MSG" "$SANDBOX/MSG"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"TD-325 AC gate: refusing to close a brief with unmet criteria"* ]] || return 1
  [[ "$output" == *"AC-GATE TD-1: VERDICT=FAIL"* ]] || return 1
  [[ "$output" == *"AC1 the worktree resolves its main checkout slug"* ]] || return 1
}

@test "W3b-c (control): every AC of TD-1 ticked -> commit-msg allows the closing commit from the worktree" {
  stage_ac_parser
  ac_brief ticked
  printf 'fix(x): close the fixture\n\nbody line\n\ncloses #TD-1\n' > "$SANDBOX/MSG"
  run_in "$WT" /bin/bash "$COMMIT_MSG" "$SANDBOX/MSG"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing"* ]] || return 1
}

# =============================================================================
# AC-W3 (c) — a REAL commit through symlinked hooks. `$0` is
# $HOOKDIR/pre-commit -> scripts/git-hooks/pre-commit -> ../../core/git-hooks/
# pre-commit; the locator must follow the chain to core/hooks/shared/_gate.sh
# (no mirror copy exists under $HOME). RED on HEAD: the commit lands.
# =============================================================================
@test "W3c: a real git commit in the worktree through symlinked hooks is refused under igris-ai" {
  symlinked_hooks
  seed_instance td359-inst-c0001 TD-1 "$WT"
  seed_brief TD-1 BUILDING
  printf 'lane change\n' > "$WT/lane.txt"
  git -C "${WT:?}" add lane.txt
  before="$(git -C "${WT:?}" rev-list --count HEAD)"
  run_in "$WT" IGRIS_INSTANCE_ID=td359-inst-c0001 git commit -q -m "chore: lane change"
  echo "exit=$status"; echo "$output"
  [ "$status" -ne 0 ]
  [[ "$output" == *"PI-004 phase guard: refusing commit"* ]] || return 1
  [[ "$output" == *"project: igris-ai (registry)"* ]] || return 1
  [ "$(git -C "${WT:?}" rev-list --count HEAD)" -eq "$before" ]
}

@test "W3c2: a real closing commit in the worktree through symlinked hooks is refused by the AC gate under igris-ai" {
  symlinked_hooks
  stage_ac_parser
  ac_brief unticked
  printf 'lane change\n' > "$WT/lane.txt"
  git -C "${WT:?}" add lane.txt
  before="$(git -C "${WT:?}" rev-list --count HEAD)"
  printf 'fix(x): close the fixture\n\nbody line\n\ncloses #TD-1\n' > "$SANDBOX/MSG"
  run_in "$WT" git commit -q -F "$SANDBOX/MSG"
  echo "exit=$status"; echo "$output"
  [ "$status" -ne 0 ]
  [[ "$output" == *"TD-325 AC gate: refusing to close a brief with unmet criteria"* ]] || return 1
  [ "$(git -C "${WT:?}" rev-list --count HEAD)" -eq "$before" ]
}

# =============================================================================
# Shared hooks in a worktree, and TD-359 AC6 (a deny is self-diagnosing).
# =============================================================================

# RED on HEAD: the registration gate finds no registered ancestor of the
# outside worktree and no-ops -> allow, empty output.
@test "S1: pre_tool_use in the worktree, no brief -> deny naming project 'igris-ai', the directory and 0 briefs" {
  run_hook_stdin "$(ptu_json "$WT" "$WT/src/main.go")" /bin/bash "$SHARED_DIR/pre_tool_use.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  reason="$(deny_reason)"
  echo "reason=$reason"
  [ -n "$reason" ] || return 1
  [[ "$reason" == *"No active brief found"* ]] || return 1
  [[ "$reason" == *"(project 'igris-ai' resolved from $WT via registry"* ]] || return 1
  [[ "$reason" == *"this project has 0 briefs"* ]] || return 1
}

# RED on HEAD: the deny carries no slug. The "0 briefs" clause is conditional.
@test "S1b: pre_tool_use in the main checkout, only a Done brief -> deny names slug and dir, no 0-briefs clause" {
  seed_brief TD-2 COMPLETE Done
  run_hook_stdin "$(ptu_json "$MAIN" "$MAIN/src/main.go")" /bin/bash "$SHARED_DIR/pre_tool_use.sh"
  echo "exit=$status"; echo "$output"
  reason="$(deny_reason)"
  echo "reason=$reason"
  [ -n "$reason" ] || return 1
  [[ "$reason" == *"No active brief found"* ]] || return 1
  [[ "$reason" == *"(project 'igris-ai' resolved from $MAIN via registry"* ]] || return 1
  [[ "$reason" != *"0 briefs"* ]] || return 1
}

@test "S2 (control): pre_tool_use in the worktree with an In Progress igris-ai brief -> allow" {
  seed_brief TD-1 BUILDING
  run_hook_stdin "$(ptu_json "$WT" "$WT/src/main.go")" /bin/bash "$SHARED_DIR/pre_tool_use.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]] || return 1
}

# FR-212c polarity: resolving a worktree to its main checkout must not make an
# UNREGISTERED repo "registered" (git-main and basename are never registered).
@test "S3 (control): a worktree of an UNREGISTERED repo -> pre_tool_use allows (gate no-ops)" {
  local other="$SANDBOX/repos/other-repo" lane="$SANDBOX/elsewhere/other-lane"
  mkdir -p "$other"
  git -C "${other:?}" init -q
  printf 'x\n' > "$other/x.txt"
  git -C "${other:?}" add x.txt
  git -C "${other:?}" commit -q --no-verify -m "chore: init"
  git -C "${other:?}" worktree add -q -b other-lane "$lane"
  run_hook_stdin "$(ptu_json "$lane" "$lane/src/main.go")" /bin/bash "$SHARED_DIR/pre_tool_use.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]] || return 1
}

# RED on HEAD: the gate passes (MAIN is an ancestor) and the log lands under
# projects/agent-x/.
@test "S4: post_compact from .claude/worktrees/agent-x logs under projects/igris-ai, not projects/agent-x" {
  run_hook_stdin "{\"source\":\"claude\",\"event\":\"post_compact\",\"project_dir\":\"$AGENT_WT\"}" \
    /bin/bash "$SHARED_DIR/post_compact.sh"
  echo "exit=$status"; echo "$output"
  ls -R "$FAKEHOME/.igris/projects" 2>/dev/null || true
  [ "$status" -eq 0 ]
  [ -f "$FAKEHOME/.igris/projects/igris-ai/session/compact.log" ] || return 1
  grep -q 'event=post_compact source=claude project=igris-ai' "$FAKEHOME/.igris/projects/igris-ai/session/compact.log" || return 1
  [ ! -e "$FAKEHOME/.igris/projects/agent-x" ] || return 1
}

# RED on HEAD: the gate no-ops outside the tree -> nothing is logged.
@test "S4b: post_compact from the outside worktree logs under projects/igris-ai, not projects/wt-td359" {
  run_hook_stdin "{\"source\":\"claude\",\"event\":\"post_compact\",\"project_dir\":\"$WT\"}" \
    /bin/bash "$SHARED_DIR/post_compact.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  grep -q 'project=igris-ai' "$FAKEHOME/.igris/projects/igris-ai/session/compact.log" || return 1
  [ ! -e "$FAKEHOME/.igris/projects/wt-td359" ] || return 1
}

# RED on HEAD: the gate no-ops outside the tree -> empty additionalContext.
@test "S5: session_start from the worktree reads mode, briefs and blockers under projects/igris-ai" {
  local pdir="$FAKEHOME/.igris/projects/igris-ai"
  mkdir -p "$pdir/session" "$pdir/briefs"
  printf '# Session\n\n**Mode:** HUNTING-FIXTURE\n' > "$pdir/session/CURRENT_SESSION.md"
  printf '## blocker one\n' > "$pdir/session/BLOCKERS.md"
  printf '# TD-1: worktree fixture\n\n**Status:** In Progress\n**Phase:** BUILDING\n' > "$pdir/briefs/TD-1.md"
  run_hook_stdin "{\"source\":\"startup\",\"session_id\":\"s\",\"cwd\":\"$WT\"}" \
    /bin/bash "$SHARED_DIR/session_start.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  ctx="$(additional_context)"
  echo "ctx=$ctx"
  [[ "$ctx" == *"[IGRIS SESSION STATE]"* ]] || return 1
  [[ "$ctx" == *"Mode: HUNTING-FIXTURE"* ]] || return 1
  [[ "$ctx" == *"Active Brief: TD-1"* ]] || return 1
  [[ "$ctx" == *"Blockers: 1 active"* ]] || return 1
  [ ! -e "$FAKEHOME/.igris/projects/wt-td359" ] || return 1
}

# RED on HEAD: the gate no-ops outside the tree -> no rewrite, no spawn, no
# watermark call.
@test "S6: session_end from the worktree writes under projects/igris-ai and passes igris-ai to perception and the watermark" {
  local pdir="$FAKEHOME/.igris/projects/igris-ai"
  mkdir -p "$pdir/session" "$FAKEHOME/.igris/core/hooks/shared" "$SANDBOX/stub-igris"
  # No **Instance ID:** line: deregister_instance returns before any curl.
  printf '# Session\n\n**Mode:** ACTIVE\n**Updated:** 2026-01-01\n' > "$pdir/session/CURRENT_SESSION.md"
  # Stand-in perception wrapper under the FAKE $HOME/.igris/core: records argv.
  printf '#!/bin/bash\ncat >/dev/null\nprintf "%%s %%s\\n" "$1" "$2" > "%s/perception.args"\n' "$SANDBOX" \
    > "$FAKEHOME/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  chmod +x "$FAKEHOME/.igris/core/hooks/shared/perception_extract_and_persist.sh"
  # Recording stub `igris` (the live CLI is outside SAFE_PATH).
  printf '#!/bin/sh\necho "$*" > "%s/igris.args"\n' "$SANDBOX" > "$SANDBOX/stub-igris/igris"
  chmod +x "$SANDBOX/stub-igris/igris"
  run_hook_stdin "{\"session_id\":\"s\",\"reason\":\"exit\",\"cwd\":\"$WT\"}" \
    PATH="$SANDBOX/stub-igris:$SAFE_PATH" /bin/bash "$SHARED_DIR/session_end.sh"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 0 ]
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -s "$SANDBOX/perception.args" ] && break
    sleep 0.25
  done
  echo "perception=$(cat "$SANDBOX/perception.args" 2>/dev/null)"
  echo "igris=$(cat "$SANDBOX/igris.args" 2>/dev/null)"
  grep -q '\*\*Mode:\*\* REST MODE' "$pdir/session/CURRENT_SESSION.md" || return 1
  [ "$(cat "$SANDBOX/perception.args" 2>/dev/null)" = "igris-ai session_end" ] || return 1
  [ "$(cat "$SANDBOX/igris.args" 2>/dev/null)" = "project watermark --project igris-ai" ] || return 1
  [ ! -e "$FAKEHOME/.igris/projects/wt-td359" ] || return 1
}
