#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# project_slug_parity.test.bash — TD-359 AC-W4 (parity) and AC-W1 (static pins).
#
# THE DEFECT IS DISAGREEMENT. Before TD-359 every surface named a project its
# own way: `igris detect` and the CLI defaults took basename(cwd), the git
# hooks basename(toplevel), the shared hooks a registry ancestor walk with a
# basename fallback. They agreed only by coincidence of the fallback, so a
# worktree, a subdirectory or a split-slug repo got a different project on
# every surface (TD-359 "parity is the actual defect").
#
# THE CONTRACT (TD-359 plan §1.1). One precedence chain with two twins:
#   bash  `igris_resolve_project <dir>` in core/hooks/shared/_gate.sh,
#         setting _IGRIS_RES_SLUG / _IGRIS_RES_SOURCE;
#   TS    `resolveProjectIdentity(dir)` in cli/dist/lib/project-identity.js,
#         returning {slug, source, ...}.
# marker (.igris-project) → git main checkout → registry walk on the
# worktree-TRANSLATED path (deepest ancestor, lowest rowid on a duplicate path)
# → basename(main) → basename(dir); source ∈ {marker, registry, git-main,
# basename}.
#
# For each fixture directory ONE expected `<slug> <source>` must equal:
#   (1) gate      `igris_resolve_project` from `_gate.sh`, in /bin/bash -c
#                 under `set -e` (bash 3.2 on macOS, bash 5 on the CI ubuntu leg);
#   (2) detect    `node cli/dist/index.js detect` run in the directory
#                 (project_slug + the new project_source key);
#   (3) ts        `resolveProjectIdentity(dir)` imported from the dist;
#   (4) git-hook  the real pre-commit run in the directory, with a BUILDING
#                 brief seeded under the EXPECTED slug and IGRIS_INSTANCE_ID
#                 naming a seeded row: the refusal's `project: <slug> (<source>)`
#                 line (git directories only);
#   (5) brief-gate pre_tool_use.sh's deny reason
#                 `(project '<slug>' resolved from <dir> via <source>)`
#                 (registered directories only: the gate no-ops elsewhere BY
#                 DESIGN, FR-212c).
#
# THE MATRIX (one directory per rung and edge; $S is the realpath'd sandbox):
#   1   $S/repos/mainrepo                        igris-ai      registry  (main checkout; dir name != slug, the split-repo shape D2 converges)
#   2   $S/repos/mainrepo/content                igris-ai      registry  (subdir named like ANOTHER project's slug `content`)
#   3   $S/elsewhere/wt-x                        igris-ai      registry  (linked worktree outside the tree)
#   4   $S/repos/mainrepo/.claude/worktrees/agent-x  igris-ai  registry  (Claude Code isolation worktree)
#   5   $S/repos/dup_repo                        repo-legacy   registry  (two rows on one path; legacy slug at the LOW rowid)
#   6   $S/plainproj/nested-repo                 plainproj     registry  (git repo nested in a registered NON-git dir)
#   7a  $S/loose/unreg-repo                      unreg-repo    git-main  (unregistered repo)
#   7b  $S/loose/unreg-repo/src/deep             unreg-repo    git-main  (... and a subdir of it)
#   8   $S/loose/plain-dir                       plain-dir     basename  (no git, no marker, no row)
#   9   $S/repos/marked-repo/src                 marked-slug   marker    (marker beats a registry row on the same repo)
#   10  $S/repos/badmark-repo                    badmark-reg   registry  (invalid marker ignored)
#   11  $S/elsewhere/wt-broken                   wt-broken     basename  (worktree whose gitdir was deleted)
#   12  $S/links/igris-link -> repos/mainrepo    igris-ai      registry  (symlinked checkout)
#   13  $S/repos/dotdot-repo                     dotdot-reg    registry  (marker `..`: not a slug.ts SLUG_RE slug, so ignored —
#                                                                         a slug names ~/.igris/projects/<slug>/, never a path escape)
#   14  $S/ELSEWHERE/wt-case/sub/deep            igris-ai      registry  (MIS-CASED path of a linked worktree subdir; on-disk
#                                                                         $S/elsewhere/Wt-Case/Sub/Deep. Case-insensitive volumes only)
#   15  $S/cased-above/wt-above                  igris-ai      registry  (MIS-CASED linked worktree root under a dir whose marker sits
#                                                                         ABOVE its toplevel: the walk stops at git's toplevel)
#
# LETTER CASE (rows 14, 15). bash 3.2's `pwd -P` keeps a mis-cased spelling on
# a case-insensitive volume while git reports the on-disk one, so a twin that
# subtracted git's toplevel from the input's spelling skipped the worktree
# translation (and walked markers past the toplevel). Both rows SKIP, with the
# reason, when the sandbox volume is case-sensitive (probe: a file created as
# CaseProbe is not found as caseprobe).
#
# TWIN-ONLY ROWS (gate vs ts; detect and the hooks are n/a: they never see
# these spellings — detect's directory is the process getcwd, which is already
# physical and case-canonical, and the git hook passes git's toplevel). Outside
# git there is no git-reported spelling, so the twins agree only if they
# normalise alike: bash `cd -- dir && pwd -P` keeps the letter case it was
# given and drops a `..` textually, and so must the TS twin's realpath.
#   T1  $S/LOOSE/plain-case    (on disk loose/Plain-Case)   plain-case  basename
#   T2  $S/near/hop/../beside  (hop -> $S/far/target)       near-reg    registry
#   T3  $S/loose/bom-dir   marker = UTF-8 BOM + bomslug       bom-dir     basename
#   T4  $S/loose/nbsp-dir  marker = NBSP + nbslug + U+3000    nbsp-dir    basename
#       (bash under BOTH LC_ALL=C and en_US.UTF-8: the trim is ASCII-only,
#       never the locale's [:space:])
#   T5  $S/loose/nul-dir   marker = nulslug NUL /../..        nulslug     marker
#   T5b $S/loose/nulpost-dir marker = abc NUL def             abc         marker
#       (both twins keep the bytes before the first NUL or newline. A line
#       `read` skips NUL bytes from bash 4.3 (NEWS-4.3 p), and T5b's NUL-stripped line
#       `abcdef` is itself a valid slug, so a NUL-skipping reader names a
#       DIFFERENT project there, not a refused one. BR-120)
#   T7  $S/loose/pad4095-dir marker = 4088 spaces + padslug + LF  padslug  marker
#   T7b $S/loose/pad4096-dir marker = 4089 spaces + padslug + LF  pad4096-dir basename
#   T7c $S/loose/huge-dir  marker = 1 MiB, spaces + hugeslug, no LF, no NUL
#                                                            huge-dir    basename
#   T7d $S/loose/nul4095-dir marker = 4088 spaces + padslug + NUL + tail + LF
#                                                            padslug     marker
#   T7e $S/loose/nul4096-dir marker = 4089 spaces + padslug + NUL + LF
#                                                            nul4096-dir basename
#       (MARKER_LINE_MAX, BR-120: a first line that has not ended within
#       4095 bytes is refused by both twins, so 4095 bytes is the longest kept
#       line. T7c also times the bash twin against a 2 s ceiling, under a 20 s
#       watchdog: an unbounded read of it cost 50 s or more per call. T7d and
#       T7e end the line with a NUL, not a newline, at byte index 4095 (kept)
#       and 4096 (refused). Without its NUL, T7d's first line is 4099 bytes,
#       so a reader that skips the NUL refuses it under the bound, or names
#       padslugtail with no bound: never padslug)
#   T6  $S/elsewhere/"lane " a linked worktree ROOT whose name ends in a
#       space                                                igris-ai    registry
#       (git's output is split on newlines only, never trimmed)
#
# SELF-NEGATIVE CONTROLS (test_standards "Scratch-copy mutation": each asserts
# its mutation LANDED before asserting the disagreement):
#   M1  a copy of _gate.sh with the worktree translation removed — the block
#       between the lines carrying `[[ TD-359 TRANSLATE BEGIN ]]` and
#       `[[ TD-359 TRANSLATE END ]]` (the FR-267 G10 marker precedent) — makes
#       row 3 disagree. CONTRACT FOR THE IMPLEMENTATION: _IGRIS_RES_LOOKUP is
#       `here` (top + git's prefix in git, dir_real outside) before that
#       block, and the block is the only place it is rewritten to main +
#       prefix.
#   M2  a copy with `rowid ASC` flipped to `rowid DESC` makes row 5 disagree.
#   M3  a copy whose marker read (the `_gate.sh` line tagged BR-120 NUL READ)
#       loses `-d ''` and its `-n 4096` bound (the pre-BR-120 line read, which
#       the sed restores byte for byte) makes T5b resolve `abcdef
#       marker` where /bin/bash skips NUL bytes (bash >= 4.3: the CI cli-bats
#       leg). Where it does not (bash 3.2, macOS) both readers agree: M3
#       measures that agreement, then skips naming the version.
#   C0  the row checker itself can fail (a wrong expectation is RED).
#
# AC-W1 STATIC PINS (no fixture, no dist; they run in every leg):
#   every `basename "$PROJECT_DIR"`, `basename "$project_dir"` and
#   `basename "$REPO_ROOT"` under core/hooks/shared/*.sh and core/git-hooks/*
#   sits on a line tagged `# TD-359 last-resort`, exactly one per file in the 7
#   files that carry a fallback (plan §5); `basenameOfCwd` is gone from cli/src;
#   cli/src/lib/detect.ts makes no `basename(` call.
#
# FENCE. HOME is the sandbox's fake home and IGRIS_BRAIN_DIR=$HOME/.igris (one
# path: the hooks read $HOME/.igris/memory/knowledge.db, the CLI brainDbPath()).
# Every surface runs with a PATH from which each directory carrying an `igris`
# executable is removed (the live CLI is never reachable), and
# GIT_CEILING_DIRECTORIES stops git discovery at the sandbox's parent.
#
# CI: the L-552 skip literal in setup() (`cli/dist/index.js missing`) is the
# needle `.github/workflows/test.yml` derives the `cli-bats` leg from; the
# matrix rows skip in the root matrix by design, the AC-W1 pins do not.
# Run with `bats test/project_slug_parity.test.bash` (never `bash`).

load test_helper

GATE_SRC="$IGRIS_ROOT/core/hooks/shared/_gate.sh"
PTU_SRC="$IGRIS_ROOT/core/hooks/shared/pre_tool_use.sh"
PRE_COMMIT_SRC="$IGRIS_ROOT/core/git-hooks/pre-commit"
CLI_ENTRY="$IGRIS_ROOT/cli/dist/index.js"
IDENTITY_JS="$IGRIS_ROOT/cli/dist/lib/project-identity.js"

setup() {
  case "$BATS_TEST_DESCRIPTION" in
    AC-W1*) return 0 ;;   # static pins: no fixture, no dist
  esac
  [ -f "$CLI_ENTRY" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  NODE_BIN="$(command -v node 2>/dev/null)" || skip "node not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  local f
  for f in "$GATE_SRC" "$PTU_SRC" "$PRE_COMMIT_SRC"; do
    [ -f "$f" ] || { echo "missing subject: $f"; return 1; }
  done
  build_matrix
}

# --- fixture -----------------------------------------------------------------

sql_q() {
  local esc
  esc=${1//\'/\'\'}
  printf '%s' "$esc"
}

# register <slug> <path> — one projects row (brain DDL: rowid = id).
register() {
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path) VALUES ('$(sql_q "$1")', '$(sql_q "$1")', '$(sql_q "$2")');"
}

# git_repo <dir> — a repo with one commit (hooks bypassed).
git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "${dir:?}" init -q
  printf 'x\n' > "$dir/README.md"
  git -C "${dir:?}" add README.md
  git -C "${dir:?}" commit -q --no-verify -m "chore: init"
}

build_safe_path() {
  local stub="$S/tool-bin" tool p d old_ifs
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
  if env PATH="$SAFE_PATH" /bin/bash -c 'command -v igris' >/dev/null 2>&1; then
    echo "SAFE_PATH still resolves igris"; return 1
  fi
  FENCE_ENV=(env -u IGRIS_INSTANCE_ID -u IGRIS_PROJECT_DIR -u CLAUDE_PROJECT_DIR
             -u IGRIS_BYPASS_PHASE_GUARD -u IGRIS_BYPASS_BRIEF_GATE
             -u IGRIS_BYPASS_AC_GATE -u IGRIS_BYPASS_EVENT_GATE
             -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR
             HOME="$FAKEHOME" IGRIS_BRAIN_DIR="$FAKEHOME/.igris" PATH="$SAFE_PATH"
             GIT_CONFIG_GLOBAL="$FAKEHOME/.gitconfig" GIT_CONFIG_NOSYSTEM=1
             GIT_CEILING_DIRECTORIES="$(dirname "$S")")
}

build_matrix() {
  S="$(cd "$TEST_TEMP_DIR" && pwd -P)/pm"
  SCRATCH="$S/scratch"
  FAKEHOME="$S/fakehome"
  mkdir -p "$SCRATCH" "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  printf '[user]\n\tname = parity\n\temail = parity@igris.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' \
    > "$FAKEHOME/.gitconfig"
  export GIT_CONFIG_GLOBAL="$FAKEHOME/.gitconfig"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CEILING_DIRECTORIES
  GIT_CEILING_DIRECTORIES="$(dirname "$S")"
  build_safe_path || return 1
  HOSTNAME_LOCAL="$(hostname)"

  MAIN="$S/repos/mainrepo"
  git_repo "$MAIN"
  mkdir -p "$MAIN/content"
  mkdir -p "$S/other/content"
  mkdir -p "$S/elsewhere"
  git -C "${MAIN:?}" worktree add -q -b wt-x-lane "$S/elsewhere/wt-x"
  git -C "${MAIN:?}" worktree add -q -b agent-x-lane "$MAIN/.claude/worktrees/agent-x"
  git -C "${MAIN:?}" worktree add -q -b broken-lane "$S/elsewhere/wt-broken"
  rm -rf "$MAIN/.git/worktrees/wt-broken"
  git_repo "$S/repos/dup_repo"
  mkdir -p "$S/plainproj"
  git_repo "$S/plainproj/nested-repo"
  git_repo "$S/loose/unreg-repo"
  mkdir -p "$S/loose/unreg-repo/src/deep" "$S/loose/plain-dir"
  git_repo "$S/repos/marked-repo"
  mkdir -p "$S/repos/marked-repo/src" "$S/srv/marked-home"
  printf 'marked-slug\n' > "$S/repos/marked-repo/.igris-project"
  git_repo "$S/repos/badmark-repo"
  printf 'not a valid slug!\n' > "$S/repos/badmark-repo/.igris-project"
  mkdir -p "$S/links"
  ln -s "$MAIN" "$S/links/igris-link"
  git_repo "$S/repos/dotdot-repo"
  printf '..\n' > "$S/repos/dotdot-repo/.igris-project"
  # Rows 14/15: on-disk names carry capitals; the rows pass a mis-cased spelling.
  git -C "${MAIN:?}" worktree add -q -b case-lane "$S/elsewhere/Wt-Case"
  mkdir -p "$S/elsewhere/Wt-Case/Sub/Deep"
  mkdir -p "$S/cased-above"
  git -C "${MAIN:?}" worktree add -q -b above-lane "$S/cased-above/Wt-Above"
  printf 'above-top\n' > "$S/cased-above/.igris-project"
  # T1/T2 (twin-only rows).
  mkdir -p "$S/loose/Plain-Case" "$S/far/target" "$S/far/beside" "$S/near/beside"
  ln -s "$S/far/target" "$S/near/hop"
  # T3-T6 (twin-only rows): whitespace and NUL handling of the marker and of
  # git's output.
  mkdir -p "$S/loose/bom-dir" "$S/loose/nbsp-dir" "$S/loose/nul-dir" "$S/loose/nulpost-dir"
  printf '\357\273\277bomslug\n' > "$S/loose/bom-dir/.igris-project"
  printf '\302\240nbslug\343\200\200\n' > "$S/loose/nbsp-dir/.igris-project"
  printf 'nulslug\000/../..\n' > "$S/loose/nul-dir/.igris-project"
  printf 'abc\000def\n' > "$S/loose/nulpost-dir/.igris-project"
  # T7-T7e (twin-only rows): the MARKER_LINE_MAX bound (4096 bytes, BR-120).
  mkdir -p "$S/loose/pad4095-dir" "$S/loose/pad4096-dir" "$S/loose/huge-dir"
  printf '%*s%s\n' 4088 '' padslug > "$S/loose/pad4095-dir/.igris-project"
  printf '%*s%s\n' 4089 '' padslug > "$S/loose/pad4096-dir/.igris-project"
  printf '%*s%s' 1048568 '' hugeslug > "$S/loose/huge-dir/.igris-project"
  # T7d/T7e: a NUL, not a newline, at byte index 4095 and 4096.
  mkdir -p "$S/loose/nul4095-dir" "$S/loose/nul4096-dir"
  printf '%*s%s\000tail\n' 4088 '' padslug > "$S/loose/nul4095-dir/.igris-project"
  printf '%*s%s\000\n' 4089 '' padslug > "$S/loose/nul4096-dir/.igris-project"
  git -C "${MAIN:?}" worktree add -q -b space-lane "$S/elsewhere/lane "

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
  # Row order IS the fixture: the legacy slug of the duplicate path takes the
  # LOWEST rowid (live: fifty-dev 932 vs fifty_dev 3722). Its name sorts AFTER
  # the basename slug, so an ORDER BY slug would also pick the wrong row.
  register repo-legacy "$S/repos/dup_repo"
  register igris-ai "$MAIN"
  register content "$S/other/content"
  register plainproj "$S/plainproj"
  register marked-repo "$S/repos/marked-repo"
  register marked-slug "$S/srv/marked-home"
  register badmark-reg "$S/repos/badmark-repo"
  register dup_repo "$S/repos/dup_repo"
  register dotdot-reg "$S/repos/dotdot-repo"
  register near-reg "$S/near/beside"
}

# check_twins <dir> <slug> <source> — the two resolvers alone (T rows).
check_twins() {
  local dir="$1" want="$2 $3" g t
  g="$(surface_gate "$dir")"
  t="$(surface_ts "$dir")"
  echo "dir:      $dir"
  echo "expected: $want"
  echo "  gate: [$g]"
  echo "  ts:   [$t]"
  [ "$g" = "$want" ] && [ "$t" = "$want" ]
}

# case_insensitive_fs — 0 when the sandbox volume ignores letter case.
case_insensitive_fs() {
  : > "$S/CaseProbe"
  [ -e "$S/caseprobe" ]
}

# --- the five surfaces; each echoes "<slug> <source>" or an empty line --------

surface_gate() {
  local dir="$1" gate="${2:-$GATE_SRC}"
  ( cd "$S" && "${FENCE_ENV[@]}" /bin/bash -c '
      set -e
      . "$1"
      igris_resolve_project "$2"
      printf "%s %s\n" "${_IGRIS_RES_SLUG:-}" "${_IGRIS_RES_SOURCE:-}"
    ' _ "$gate" "$dir" 2>/dev/null ) || true
}

# timed_gate <dir> <watchdog-s> — surface_gate's call, timed: prints
# "<wall ms> <slug> <source>", or "<wall ms> TIMEOUT" when the watchdog killed
# it (python3 is already a precondition of this suite; bash 3.2 has no
# sub-second clock).
timed_gate() {
  local dir="$1" limit="$2"
  ( cd "$S" && "${FENCE_ENV[@]}" python3 - "$GATE_SRC" "$dir" "$limit" <<'PY'
import subprocess, sys, time
gate, d, limit = sys.argv[1], sys.argv[2], float(sys.argv[3])
script = 'set -e; . "$1"; igris_resolve_project "$2"; printf "%s %s" "${_IGRIS_RES_SLUG:-}" "${_IGRIS_RES_SOURCE:-}"'
t0 = time.monotonic()
try:
    r = subprocess.run(["/bin/bash", "-c", script, "_", gate, d],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=limit)
    out = r.stdout.decode("utf-8", "replace")
except subprocess.TimeoutExpired:
    out = "TIMEOUT"
print("%d %s" % ((time.monotonic() - t0) * 1000, out))
PY
  ) || true
}

surface_detect() {
  local dir="$1" json
  json="$( cd "$dir" && "${FENCE_ENV[@]}" "$NODE_BIN" "$CLI_ENTRY" detect 2>/dev/null )" || true
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print("%s %s" % (d.get("project_slug", ""), d.get("project_source", "<no-project_source>")))
except Exception:
    print("")
'
}

surface_ts() {
  local dir="$1"
  ( cd "$dir" && "${FENCE_ENV[@]}" "$NODE_BIN" --input-type=module -e '
      const [mod, dir] = process.argv.slice(1);
      try {
        const m = await import(mod);
        const r = await m.resolveProjectIdentity(dir);
        console.log(`${r.slug} ${r.source}`);
      } catch (e) {
        console.log("");
      }
    ' "file://$IDENTITY_JS" "$dir" 2>/dev/null ) || true
}

# surface_git_hook <dir> <expected-slug> — seed the observation under the
# EXPECTED slug: an instance named by IGRIS_INSTANCE_ID whose brief is
# BUILDING. Only a hook that resolved that slug identifies the row and prints
# the refusal's `project:` line.
surface_git_hook() {
  local dir="$1" slug="$2" out
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, project_path,
                           current_brief, current_phase, status,
                           last_activity_at, lease_expires_at)
    VALUES ('parity-inst-0001', '$(sql_q "$HOSTNAME_LOCAL")', '$(sql_q "$slug")',
            '$(sql_q "$dir")', 'TD-9001', 'BUILDING', 'active',
            datetime('now'), datetime('now', '+1 hour'));
    INSERT INTO brief_status (project, brief_id, title, status, phase)
    VALUES ('$(sql_q "$slug")', 'TD-9001', 't', 'In Progress', 'BUILDING');"
  out="$( cd "$dir" && "${FENCE_ENV[@]}" IGRIS_INSTANCE_ID=parity-inst-0001 \
            /bin/bash "$PRE_COMMIT_SRC" 2>&1 )" || true
  sqlite3 "$DB" "DELETE FROM instances WHERE id = 'parity-inst-0001';
                 DELETE FROM brief_status WHERE brief_id = 'TD-9001';"
  printf '%s\n' "$out" | sed -nE 's/^[[:space:]]*project: ([^ ]+) \(([^)]*)\).*$/\1 \2/p' | head -n1
}

surface_brief_gate() {
  local dir="$1"
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"project_dir":"%s"}' \
    "$S/work/target.txt" "$dir" > "$SCRATCH/ptu.json"
  ( cd "$S" && "${FENCE_ENV[@]}" /bin/bash "$PTU_SRC" < "$SCRATCH/ptu.json" 2>/dev/null ) \
    | python3 -c '
import json, re, sys
try:
    h = json.loads(sys.stdin.read()).get("hookSpecificOutput") or {}
    r = h.get("permissionDecisionReason", "") if h.get("permissionDecision") == "deny" else ""
    m = re.search(r"\(project \x27([^\x27]+)\x27 resolved from .+? via ([a-z-]+)", r)
    print("%s %s" % (m.group(1), m.group(2)) if m else "")
except Exception:
    print("")
'
}

# check_row <dir> <slug> <source> <git|nogit> <registered|unregistered>
# Prints one line per surface; returns 1 if any applicable surface disagrees.
check_row() {
  local dir="$1" want="$2 $3" kind="$4" reg="$5" got bad=0 name
  echo "dir:      $dir"
  echo "expected: $want"
  for name in gate detect ts git-hook brief-gate; do
    case "$name" in
      gate)       got="$(surface_gate "$dir")" ;;
      detect)     got="$(surface_detect "$dir")" ;;
      ts)         got="$(surface_ts "$dir")" ;;
      git-hook)
        if [ "$kind" != "git" ]; then echo "  $name: n/a (not a git directory)"; continue; fi
        got="$(surface_git_hook "$dir" "$2")" ;;
      brief-gate)
        if [ "$reg" != "registered" ]; then echo "  $name: skipped (unregistered: the gate no-ops by design)"; continue; fi
        got="$(surface_brief_gate "$dir")" ;;
    esac
    if [ "$got" = "$want" ]; then
      echo "  $name: ok    [$got]"
    else
      echo "  $name: DIFF  [$got]"
      bad=1
    fi
  done
  return "$bad"
}

# =============================================================================
# AC-W4 — the matrix. One @test per directory so a red names its row.
# =============================================================================

@test "row 1: registered main checkout (dir name != slug) -> igris-ai via registry on every surface" {
  check_row "$MAIN" igris-ai registry git registered
}

@test "row 2: subdir named content (another project's slug) -> igris-ai, not content" {
  check_row "$MAIN/content" igris-ai registry git registered
}

@test "row 3: linked worktree outside the tree (wt-x) -> igris-ai" {
  check_row "$S/elsewhere/wt-x" igris-ai registry git registered
}

@test "row 4: worktree at .claude/worktrees/agent-x -> igris-ai" {
  check_row "$MAIN/.claude/worktrees/agent-x" igris-ai registry git registered
}

@test "row 5: duplicate-path rows -> the legacy slug at the lowest rowid (repo-legacy)" {
  check_row "$S/repos/dup_repo" repo-legacy registry git registered
}

@test "row 6: git repo nested in a registered non-git dir -> the registered ancestor (plainproj)" {
  check_row "$S/plainproj/nested-repo" plainproj registry git registered
}

@test "row 7a: unregistered repo -> basename of its main checkout via git-main" {
  check_row "$S/loose/unreg-repo" unreg-repo git-main git unregistered
}

@test "row 7b: subdir of an unregistered repo -> the repo's name via git-main, not the subdir's" {
  check_row "$S/loose/unreg-repo/src/deep" unreg-repo git-main git unregistered
}

@test "row 8: no git, no marker, no row -> basename(dir), no regression" {
  check_row "$S/loose/plain-dir" plain-dir basename nogit unregistered
}

@test "row 9: .igris-project marker -> the marker slug, over the registry row of the same repo" {
  check_row "$S/repos/marked-repo/src" marked-slug marker git registered
}

@test "row 10: invalid marker is ignored -> the registry row" {
  check_row "$S/repos/badmark-repo" badmark-reg registry git registered
}

@test "row 11: worktree whose gitdir was deleted -> basename(dir), and no surface throws" {
  check_row "$S/elsewhere/wt-broken" wt-broken basename nogit unregistered
}

@test "row 12: symlinked checkout -> the realpath's registered slug" {
  check_row "$S/links/igris-link" igris-ai registry git registered
}

@test "row 13: marker '..' (not a SLUG_RE slug) is ignored -> the registry row, never '..'" {
  # Arm: the marker really is '..' and the directory is registered.
  [ "$(head -n1 "$S/repos/dotdot-repo/.igris-project")" = ".." ] || return 1
  check_row "$S/repos/dotdot-repo" dotdot-reg registry git registered
}

@test "row 14: MIS-CASED path of a linked worktree subdir -> igris-ai (translation from git's spelling)" {
  case_insensitive_fs || skip "case-sensitive volume: a mis-cased path does not exist here"
  local given="$S/ELSEWHERE/wt-case/sub/deep"
  # Arm: the spelling opens, and it is NOT the on-disk spelling git reports.
  [ -d "$given" ] || return 1
  [ "$(git -C "${given:?}" rev-parse --show-toplevel)" = "$S/elsewhere/Wt-Case" ] || return 1
  [ "$(git -C "${given:?}" rev-parse --show-prefix)" = "Sub/Deep/" ] || return 1
  check_row "$given" igris-ai registry git registered
}

@test "row 15: MIS-CASED linked worktree under a marker ABOVE its toplevel -> igris-ai, the marker unread" {
  case_insensitive_fs || skip "case-sensitive volume: a mis-cased path does not exist here"
  local given="$S/cased-above/wt-above"
  [ -d "$given" ] || return 1
  [ "$(git -C "${given:?}" rev-parse --show-toplevel)" = "$S/cased-above/Wt-Above" ] || return 1
  [ "$(head -n1 "$S/cased-above/.igris-project")" = "above-top" ] || return 1
  check_row "$given" igris-ai registry git registered
}

# =============================================================================
# Self-negative controls.
# =============================================================================

@test "T1 (twins): outside git a MIS-CASED path keeps its spelling in both twins -> plain-case basename" {
  case_insensitive_fs || skip "case-sensitive volume: a mis-cased path does not exist here"
  [ -d "$S/LOOSE/plain-case" ] || return 1
  check_twins "$S/LOOSE/plain-case" plain-case basename
}

@test "T2 (twins): a '..' after a symlink is dropped textually in both twins (bash cd) -> near-reg" {
  # Arm: the physical parent of the symlink's target is a DIFFERENT directory.
  [ -L "$S/near/hop" ] && [ -d "$S/far/beside" ] || return 1
  check_twins "$S/near/hop/../beside" near-reg registry
}

@test "T3 (twins): a marker led by a UTF-8 BOM is refused by both twins -> bom-dir basename" {
  [ "$(head -c 3 "$S/loose/bom-dir/.igris-project" | od -An -tx1 | tr -d ' ')" = "efbbbf" ] || return 1
  check_twins "$S/loose/bom-dir" bom-dir basename
}

@test "T4 (twins): NBSP / U+3000 around a marker are not trimmed, in either locale -> nbsp-dir basename" {
  local g
  for loc in C en_US.UTF-8; do
    g="$(LC_ALL="$loc" surface_gate "$S/loose/nbsp-dir")"
    echo "gate LC_ALL=$loc: [$g]"
    [ "$g" = "nbsp-dir basename" ] || return 1
  done
  check_twins "$S/loose/nbsp-dir" nbsp-dir basename
}

@test "T5 (twins): a NUL in the marker's first line ends it in both twins -> nulslug marker" {
  [ "$(od -An -tx1 "$S/loose/nul-dir/.igris-project" | tr -s ' ' | grep -c ' 00')" -ge 1 ] || return 1
  check_twins "$S/loose/nul-dir" nulslug marker
}

@test "T5b (twins): slug-valid bytes after a NUL are dropped by both twins -> abc marker" {
  local f="$S/loose/nulpost-dir/.igris-project"
  # Arm: the marker really carries a NUL.
  [ "$(od -An -tx1 "$f" | tr -s ' ' | grep -c ' 00')" -ge 1 ] || return 1
  # Arm: the row discriminates. Without the NUL the line is `abcdef`, itself a
  # VALID slug, so a NUL-skipping reader names a different project here rather
  # than falling to the basename (nulpost-dir).
  [ "$(tr -d '\000' < "$f")" = "abcdef" ] || return 1
  check_twins "$S/loose/nulpost-dir" abc marker
}

@test "T7 (twins): a padded first line of 4095 bytes, the longest kept, is read by both twins -> padslug marker" {
  local f="$S/loose/pad4095-dir/.igris-project"
  # Arm: 4095 bytes of line (spaces then the slug), then the newline at byte 4096.
  [ "$(wc -c < "$f" | tr -d ' ')" -eq 4096 ] || return 1
  [ "$(head -c 4095 "$f" | tr -d ' ')" = "padslug" ] || return 1
  [ "$(tail -c 1 "$f" | od -An -tx1 | tr -d ' \n')" = "0a" ] || return 1
  check_twins "$S/loose/pad4095-dir" padslug marker
}

@test "T7b (twins): a padded first line of 4096 bytes is refused by both twins -> pad4096-dir basename" {
  local f="$S/loose/pad4096-dir/.igris-project"
  # Arm: one byte longer than T7, and still a valid slug once trimmed, so an
  # unbounded reader would name padslug here rather than refuse it.
  [ "$(wc -c < "$f" | tr -d ' ')" -eq 4097 ] || return 1
  [ "$(head -c 4096 "$f" | tr -d ' ')" = "padslug" ] || return 1
  [ "$(tail -c 1 "$f" | od -An -tx1 | tr -d ' \n')" = "0a" ] || return 1
  check_twins "$S/loose/pad4096-dir" pad4096-dir basename
}

@test "T7c (twins): a 1 MiB marker with no newline is refused by both twins, and the bash twin stays under 2 s -> huge-dir basename" {
  local f="$S/loose/huge-dir/.igris-project" out ms got
  # Arm: 1 MiB of spaces then a valid slug, so neither a newline nor a NUL.
  [ "$(wc -c < "$f" | tr -d ' ')" -eq 1048576 ] || return 1
  [ "$(tr -d ' ' < "$f")" = "hugeslug" ] || return 1
  out="$(timed_gate "$S/loose/huge-dir" 20)"
  ms="${out%% *}"
  got="${out#* }"
  echo "bash twin: ${ms} ms -> [$got] (ceiling 2000 ms, watchdog 20 s)"
  [ "$got" = "huge-dir basename" ] || return 1
  [ "$ms" -lt 2000 ] || return 1
  check_twins "$S/loose/huge-dir" huge-dir basename
}

@test "T7d (twins): a NUL at byte index 4095 ends a first line of 4095 bytes, the longest kept, in both twins -> padslug marker" {
  local f="$S/loose/nul4095-dir/.igris-project"
  # Arm: 4095 bytes of line (spaces then the slug) with no NUL or newline among
  # them, the NUL at byte index 4095, then a slug-valid tail and the newline.
  [ "$(wc -c < "$f" | tr -d ' ')" -eq 4101 ] || return 1
  [ "$(head -c 4095 "$f" | tr -dc '\000\n' | wc -c | tr -d ' ')" -eq 0 ] || return 1
  [ "$(head -c 4095 "$f" | tr -d ' ')" = "padslug" ] || return 1
  [ "$(head -c 4096 "$f" | tail -c 1 | od -An -tx1 | tr -d ' \n')" = "00" ] || return 1
  # Arm: the row discriminates. Without the NUL the first line is 4099 bytes
  # (`padslugtail` once trimmed), so a reader that skips the NUL refuses it
  # under the bound (nul4095-dir basename), or names padslugtail with no bound:
  # never padslug.
  [ "$(tr -d '\000\n' < "$f" | wc -c | tr -d ' ')" -eq 4099 ] || return 1
  [ "$(tr -d ' \000\n' < "$f")" = "padslugtail" ] || return 1
  check_twins "$S/loose/nul4095-dir" padslug marker
}

@test "T7e (twins): a NUL at byte index 4096 leaves a first line unended within 4096 bytes, refused by both twins -> nul4096-dir basename" {
  local f="$S/loose/nul4096-dir/.igris-project"
  # Arm: 4096 bytes of spaces then the slug with no NUL or newline among them,
  # then the NUL at byte index 4096 and the newline. Still a valid slug once
  # trimmed, so a reader that took that NUL as the line's end would name
  # padslug here rather than refuse it.
  [ "$(wc -c < "$f" | tr -d ' ')" -eq 4098 ] || return 1
  [ "$(head -c 4096 "$f" | tr -dc '\000\n' | wc -c | tr -d ' ')" -eq 0 ] || return 1
  [ "$(head -c 4096 "$f" | tr -d ' ')" = "padslug" ] || return 1
  [ "$(tail -c 2 "$f" | od -An -tx1 | tr -d ' \n')" = "000a" ] || return 1
  check_twins "$S/loose/nul4096-dir" nul4096-dir basename
}

@test "T6 (twins): a linked worktree ROOT whose name ends in a space -> igris-ai via registry" {
  [ -d "$S/elsewhere/lane " ] || return 1
  [ "$(git -C "$S/elsewhere/lane " rev-parse --show-toplevel)" = "$S/elsewhere/lane " ] || return 1
  check_twins "$S/elsewhere/lane " igris-ai registry
}

@test "C0 (control): the row checker reds on a wrong expectation" {
  run check_row "$MAIN" not-the-slug registry git registered
  echo "$output"
  [ "$status" -ne 0 ]
  [[ "$output" == *"DIFF"* ]] || return 1
}

@test "M1 (mutation): _gate.sh without the worktree translation makes row 3 disagree" {
  local mutant="$SCRATCH/_gate.no-translate.sh" before after
  sed '/\[\[ TD-359 TRANSLATE BEGIN \]\]/,/\[\[ TD-359 TRANSLATE END \]\]/d' "$GATE_SRC" > "$mutant"
  before="$(grep -c 'TD-359 TRANSLATE' "$GATE_SRC" || true)"
  after="$(grep -c 'TD-359 TRANSLATE' "$mutant" || true)"
  echo "markers: real=$before mutant=$after"
  # The mutation LANDED: both markers were present and the block is gone.
  [ "$before" -eq 2 ] || { echo "the TD-359 TRANSLATE markers are not in _gate.sh: the mutation cannot land"; return 1; }
  [ "$after" -eq 0 ] || return 1
  [ "$(wc -l < "$mutant")" -lt "$(wc -l < "$GATE_SRC")" ] || return 1
  real="$(surface_gate "$S/elsewhere/wt-x")"
  mut="$(surface_gate "$S/elsewhere/wt-x" "$mutant")"
  main_mut="$(surface_gate "$MAIN" "$mutant")"
  echo "real=[$real] mutant=[$mut] mutant-on-main=[$main_mut]"
  [ "$real" = "igris-ai registry" ] || return 1
  [ "${mut%% *}" != "igris-ai" ] || return 1
  # Targeted: the mutant still resolves the main checkout itself.
  [ "$main_mut" = "igris-ai registry" ] || return 1
}

@test "M2 (mutation): _gate.sh with rowid ASC flipped to DESC makes row 5 disagree" {
  local mutant="$SCRATCH/_gate.rowid-desc.sh" asc_real asc_mut desc_real desc_mut
  sed 's/rowid ASC/rowid DESC/g' "$GATE_SRC" > "$mutant"
  asc_real="$(grep -c 'rowid ASC' "$GATE_SRC" || true)"
  asc_mut="$(grep -c 'rowid ASC' "$mutant" || true)"
  desc_real="$(grep -c 'rowid DESC' "$GATE_SRC" || true)"
  desc_mut="$(grep -c 'rowid DESC' "$mutant" || true)"
  echo "rowid ASC: real=$asc_real mutant=$asc_mut; rowid DESC: real=$desc_real mutant=$desc_mut"
  [ "$asc_real" -ge 1 ] || { echo "no 'rowid ASC' in _gate.sh: the mutation cannot land"; return 1; }
  [ "$asc_mut" -eq 0 ] || return 1
  [ "$desc_mut" -gt "$desc_real" ] || return 1
  real="$(surface_gate "$S/repos/dup_repo")"
  mut="$(surface_gate "$S/repos/dup_repo" "$mutant")"
  echo "real=[$real] mutant=[$mut]"
  [ "$real" = "repo-legacy registry" ] || return 1
  [ "$mut" = "dup_repo registry" ] || return 1
}

@test "M3 (mutation): the pre-BR-120 line read makes T5b disagree where /bin/bash skips NUL bytes" {
  local mutant="$SCRATCH/_gate.line-read.sh" tag_real tag_mut line_real line_mut ver probe real mut
  sed "/BR-120 NUL READ/s/ -d '' -n 4096//" "$GATE_SRC" > "$mutant"
  tag_real="$(grep -c 'BR-120 NUL READ' "$GATE_SRC" || true)"
  tag_mut="$(grep -c 'BR-120 NUL READ' "$mutant" || true)"
  line_real="$(grep 'BR-120 NUL READ' "$GATE_SRC" || true)"
  line_mut="$(grep 'BR-120 NUL READ' "$mutant" || true)"
  echo "BR-120 NUL READ tag: real=$tag_real mutant=$tag_mut"
  echo "real line:   [$line_real]"
  echo "mutant line: [$line_mut]"
  # The mutation LANDED: one tagged line in each; the real one reads to a NUL
  # within the MARKER_LINE_MAX bound, the mutant's is the exact pre-BR-120
  # line read (no NUL delimiter, no bound).
  [ "$tag_real" -eq 1 ] || { echo "the BR-120 NUL READ tag is not in _gate.sh: the mutation cannot land"; return 1; }
  [ "$tag_mut" -eq 1 ] || return 1
  case "$line_real" in *"read -r -d '' -n 4096 line"*) ;; *) return 1 ;; esac
  case "$line_mut" in *"-d ''"* | *"-n 4096"*) return 1 ;; esac
  # shellcheck disable=SC2016  # the pre-BR-120 source line, matched literally
  case "$line_mut" in *'IFS= read -r line 2>/dev/null < "$f" || true'*) ;; *) return 1 ;; esac
  # Measure the interpreter surface_gate runs (/bin/bash), not the one bats
  # runs under: a line read either stops at a NUL (`a`) or skips it (`ab`).
  ver="$(/bin/bash -c 'printf "%s.%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}" "${BASH_VERSINFO[2]}"')"
  probe="$(printf 'a\000b\n' | /bin/bash -c 'IFS= read -r l; printf "%s" "$l"')"
  real="$(surface_gate "$S/loose/nulpost-dir")"
  mut="$(surface_gate "$S/loose/nulpost-dir" "$mutant")"
  echo "/bin/bash $ver line-read probe=[$probe] real=[$real] mutant=[$mut]"
  [ "$real" = "abc marker" ] || return 1
  case "$probe" in
    a)
      # The old reader agrees here, and that is measured before skipping.
      [ "$mut" = "abc marker" ] || return 1
      skip "/bin/bash $ver: a line read stops at a NUL, so the pre-BR-120 reader agrees here; M3 discriminates on bash >= 4.3 only (the CI cli-bats leg)"
      ;;
    ab)
      # Targeted: the old reader names the NUL-stripped slug, not a refusal.
      [ "$mut" = "abcdef marker" ] || return 1
      ;;
    *)
      echo "unexpected /bin/bash NUL behaviour [$probe]"
      return 1
      ;;
  esac
}

# =============================================================================
# AC-W1 — static pins. RED on HEAD: 15 untagged basename sites (13 shared + 2
# git hooks), basenameOfCwd present in cli/src, detect.ts:170 basename(.
# =============================================================================

# basename_as_slug_lines — `<file>:<line>:<text>` for every non-comment line
# under core/hooks/shared/*.sh and core/git-hooks/* that takes the basename of
# PROJECT_DIR, project_dir or REPO_ROOT (`basename "$X"`, `basename "${X}"`,
# `basename -- "$X"`).
basename_as_slug_lines() {
  local root="${1:-$IGRIS_ROOT}" f
  for f in "$root"/core/hooks/shared/*.sh "$root"/core/git-hooks/*; do
    [ -f "$f" ] || continue
    grep -nE 'basename([[:space:]]+--)?[[:space:]]+"?\$\{?(PROJECT_DIR|project_dir|REPO_ROOT)\}?"?' "$f" 2>/dev/null \
      | grep -vE '^[0-9]+:[[:space:]]*#' \
      | sed "s|^|${f#"$root"/}:|"
  done
}

# The scanner's own self-negative: on a planted tree it reports the untagged
# forms (plain, braced, `--`), carries the tagged one, and skips a comment.
@test "AC-W1 (a0) self-negative: the scanner flags untagged forms, keeps the tag, skips comments" {
  local plant="$BATS_TEST_TMPDIR/plant"
  mkdir -p "$plant/core/hooks/shared" "$plant/core/git-hooks"
  {
    printf '%s\n' '#!/bin/bash'
    printf '%s\n' '  slug=$(basename "$PROJECT_DIR")'
    printf '%s\n' '  slug=$(basename -- "${project_dir}")'
    printf '%s\n' '  # a comment naming basename "$PROJECT_DIR" is not a site'
    printf '%s\n' '  slug=$(basename "$PROJECT_DIR")  # TD-359 last-resort'
  } > "$plant/core/hooks/shared/x.sh"
  printf '%s\n' 'PROJECT="$(basename "$REPO_ROOT")"' > "$plant/core/git-hooks/pre-commit"
  run basename_as_slug_lines "$plant"
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 4 ] || return 1
  [ "$(printf '%s\n' "$output" | grep -vc '# TD-359 last-resort')" -eq 3 ] || return 1
  [[ "$output" == *"core/hooks/shared/x.sh:3:"* ]] || return 1
  [[ "$output" == *"core/git-hooks/pre-commit:1:"* ]] || return 1
  [[ "$output" != *"x.sh:4:"* ]] || return 1
}

@test "AC-W1 (a): every basename-as-slug line in the hooks is a tagged TD-359 last resort, one per fallback file" {
  run basename_as_slug_lines
  echo "$output"
  [ "$status" -eq 0 ]
  local untagged
  untagged="$(printf '%s\n' "$output" | grep -v '# TD-359 last-resort' | grep -v '^$' || true)"
  if [ -n "$untagged" ]; then
    echo "untagged basename-as-slug lines ($(printf '%s\n' "$untagged" | wc -l | tr -d ' ')):"
    echo "$untagged"
    return 1
  fi
  local rel n
  for rel in core/hooks/shared/pre_tool_use.sh core/hooks/shared/session_start.sh \
             core/hooks/shared/pre_compact.sh core/hooks/shared/post_compact.sh \
             core/hooks/shared/session_end.sh core/git-hooks/pre-commit core/git-hooks/commit-msg; do
    n="$(printf '%s\n' "$output" | grep -c "^$rel:" || true)"
    [ "$n" -eq 1 ] || { echo "$rel: $n tagged last-resort lines, expected 1"; return 1; }
  done
}

@test "AC-W1 (b): basenameOfCwd is gone from cli/src" {
  run grep -rn basenameOfCwd "$IGRIS_ROOT/cli/src"
  echo "$output"
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}

@test "AC-W1 (c): cli/src/lib/detect.ts makes no basename( call" {
  [ -f "$IGRIS_ROOT/cli/src/lib/detect.ts" ] || return 1
  run bash -c "grep -nE 'basename\\(' '$IGRIS_ROOT/cli/src/lib/detect.ts' | grep -vE '^[0-9]+:[[:space:]]*(//|\\*|/\\*)'"
  echo "$output"
  [ -z "$output" ]
}
