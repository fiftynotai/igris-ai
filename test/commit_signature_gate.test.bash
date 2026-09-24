#!/usr/bin/env bats

# commit_signature_gate.test.bash — TD-470. The no-AI-signature gate in
# core/git-hooks/commit-msg (§1b, the `[[ TD-470 SIGNATURE GATE ]]` block).
#
# WHAT IS REFUSED (the hook header is the contract; this file pins it):
#   S1a  a col-0 `Co-authored-by:` line (key only) in the LAST paragraph —
#        the block git reads trailers from;
#   S1b  a col-0 `Co-authored-by: … <user@host>` line ANYWHERE (the identity
#        form GitHub credits — catches a co-author paragraph ABOVE a
#        `closes` paragraph, which git's own parser does not see);
#   S2a  a col-0 emoji (U+1F000-U+1FFFF, optional VS16) + `Generated with `;
#   S2b  a col-0 line that is ENTIRELY `Generated with [name](scheme://…)`.
# Matching is case-insensitive, runs after git's scissors cut and after
# dropping col-0 `#` lines. An indented or quoted signature passes on purpose.
#
# REALITY FIXTURES (test/fixtures/signature-gate/README.md has provenance):
# igris-ai-4aaaf8e.msg / igris-ai-116346f.msg are this repo's own signed
# commits, byte-for-byte from `git cat-file commit`; 4aaaf8e signs with a
# monkey emoji, not the robot, which is why S2a takes the emoji plane.
# 40ff64d / e6deaee / b3df736 are real messages that QUOTE the standard in
# body prose (L-1668's false-positive class) and must pass.
#
# SANDBOX: a git repo 'gproj' and a FAKEHOME with no brain, so the §2/§3
# prelude fails open at BRAIN_DB and only §1/§1b can speak. SB4 seeds a
# PLAIN-table brain (memory 287) to prove the bypass is a section skip.
#
# Past mistakes to avoid: TD-341 (a non-final bare `[[ ]]` cannot fail a bats
# test — every one carries `|| return 1`); "prove the mutation landed" (every
# mutant is followed by a count check on the copy); negative output checks are
# LINE-scoped (TD-434).

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"
FIXTURES="$IGRIS_ROOT/test/fixtures/signature-gate"
AC_CHECK="$IGRIS_ROOT/core/scripts/brief_ac_check.sh"
AC_FIXTURES="$IGRIS_ROOT/test/fixtures/ac-gate"
STANDARDS="$IGRIS_ROOT/core/os/standards.md"

ROBOT="$(printf '\360\237\244\226')"
TRAILER='Co-Authored-By: Claude <noreply@anthropic.com>'

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  [ -f "$FIXTURES/igris-ai-4aaaf8e.msg" ] || { echo "fixture not found"; return 1; }
  command -v git >/dev/null 2>&1 || skip "git not available"

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/sig.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME"
  SCRATCH="$SANDBOX/scratch"
  mkdir -p "$SCRATCH"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t

  MSG_FILE="$SANDBOX/COMMIT_EDITMSG"
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# --- helpers -----------------------------------------------------------------

# write_lines <file> <line>... — one argument per line, newline-terminated.
write_lines() {
  local f="$1"; shift
  printf '%s\n' "$@" > "$f"
}

# build_msg <case-id> <file> — the ONE place a case's message is defined, so
# the individual cases and the SO1 oracle loop read identical bytes. An
# unknown id is an ERROR, never a fall-through to some default message.
build_msg() {
  local f="$2"
  case "$1" in
    SG1)  cp "$FIXTURES/igris-ai-4aaaf8e.msg" "$f" ;;
    SG1b) cp "$FIXTURES/igris-ai-116346f.msg" "$f" ;;
    SG2)  write_lines "$f" 'fix(x): a change' '' 'body line' '' "$TRAILER" ;;
    SG3)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'co-authored-by: x <x@y.z>' ;;
    SG4)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'Co-authored-by: Claude' ;;
    SG5)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'closes #FR-1' "$TRAILER" ;;
    SG5b) write_lines "$f" 'fix(x): a change' '' 'body line' '' 'closes #FR-1' 'Co-authored-by: Claude' ;;
    SG6)  write_lines "$f" 'fix(x): a change' '' 'body line' '' "$TRAILER" '' 'closes #FR-1' ;;
    SG7)  write_lines "$f" 'fix(x): a change' '' 'body line' '' "$ROBOT Generated with [Claude Code](https://claude.com/claude-code)" ;;
    SG8)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'Generated with [opencode](https://opencode.ai)' ;;
    SG9)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'Co-authored-by : x <x@y.z>' ;;
    SC1)  write_lines "$f" 'fix(x): a plain change' '' 'A body paragraph.' ;;
    SC2)  write_lines "$f" 'fix(x): a change' '' 'body line' '' 'closes #TD-470' ;;
    SC3)  write_lines "$f" 'WIP' ;;
    SC4)  write_lines "$f" 'fixup! fix(x): a change' ;;
    SC5)  write_lines "$f" "Merge branch 'x' into develop" ;;
    SC6)  { printf 'docs(os): restate the signature rule\n\nThe rule, quoted from core/os/standards.md:\n\n'
            /usr/bin/grep -F 'No AI signatures' "$STANDARDS" | head -n 1
            printf '\ncloses #TD-470\n'; } > "$f" ;;
    SC7)  { printf 'fix(hooks): gate AI signatures\n\n'; cat "$FIXTURES/TD-470.md"
            printf '\n\ncloses #TD-470\n'; } > "$f" ;;
    SC8)  write_lines "$f" 'feat(db): regenerate the models' '' 'Generated with the new script, the table layout is unchanged.' ;;
    SC9)  write_lines "$f" 'Squashed commit of the following:' '' '    fix(x): an old change' '' "    $ROBOT Generated with [Claude Code](https://claude.com/claude-code)" '' "    $TRAILER" ;;
    SC10) write_lines "$f" 'fix(x): a change' '' 'body line' '' 'Signed-off-by: A Person <a@b.c>' ;;
    SC11) write_lines "$f" 'fix(x): a change' '' 'body line' '' "# $TRAILER" \
            '# ------------------------ >8 ------------------------' \
            '# Do not modify or remove the line above.' \
            '# Everything below it will be ignored.' \
            'diff --git a/f b/f' "+$TRAILER" "$TRAILER" ;;
    SC12) write_lines "$f" 'docs(os): explain the gate' '' 'Co-Authored-By: tags are refused by the new gate, see the standard.' '' 'closes #TD-470' ;;
    SC13a) cp "$FIXTURES/igris-ai-40ff64d.msg" "$f" ;;
    SC13b) cp "$FIXTURES/igris-ai-e6deaee.msg" "$f" ;;
    SC13c) cp "$FIXTURES/igris-ai-b3df736.msg" "$f" ;;
    *) echo "build_msg: unknown case id '$1'" >&2; return 1 ;;
  esac
}

# run_hook_with <hook> [env assignments...] — cwd=$REPO, fake HOME.
run_hook_with() {
  local hook="$1"; shift
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$hook' '$MSG_FILE' 2>&1"
}
run_hook() { run_hook_with "$HOOK_SRC" "$@"; }

# git_coauthor_count <file> — co-author trailers per git's OWN trailer parser.
git_coauthor_count() {
  git interpret-trailers --parse "$1" | /usr/bin/grep -ic '^co-authored-by:' || true
}

# the hook's refusal header, and one SIGNATURE-GATE line per hit
REFUSAL='[commit-msg] TD-470 signature gate'

assert_refused() {
  [ "$status" -eq 1 ] || { echo "expected exit 1, got $status: $output"; return 1; }
  [[ "$output" == *"$REFUSAL"* ]] || { echo "no refusal header: $output"; return 1; }
  [[ "$output" == *"IGRIS_BYPASS_SIGNATURE_GATE=1"* ]] || return 1
}

assert_silent_pass() {
  [ "$status" -eq 0 ] || { echo "expected exit 0, got $status: $output"; return 1; }
  [ "$output" = "" ] || { echo "expected empty output, got: $output"; return 1; }
}

# mutant_without <pattern> <dst> — a hook copy with every line matching the
# fixed-string anchor deleted; asserts exactly <n> lines were removed.
mutant_without() {
  local anchor="$1" dst="$2" n="$3" have
  have="$(/usr/bin/grep -cF "$anchor" "$HOOK_SRC" || true)"
  [ "$have" = "$n" ] || { echo "anchor '$anchor': expected $n line(s) in the hook, found $have"; return 1; }
  /usr/bin/grep -vF "$anchor" "$HOOK_SRC" > "$dst"
  [ "$(/usr/bin/grep -cF "$anchor" "$dst" || true)" = "0" ] || return 1
  [ "$(wc -l < "$dst")" -eq $(( $(wc -l < "$HOOK_SRC") - n )) ] || return 1
}

# =============================================================================
# PART 1 — RED: real and planted signatures are refused
# =============================================================================

@test "(SG1) the REAL signed commit 4aaaf8e, byte-for-byte -> exit 1, names both lines" {
  build_msg SG1 "$MSG_FILE"
  run_hook
  assert_refused
  printf '%s\n' "$output" | /usr/bin/grep -F 'SIGNATURE-GATE: co-author: Co-Authored-By: Claude <noreply@anthropic.com>' >/dev/null || return 1
  printf '%s\n' "$output" | /usr/bin/grep -F 'SIGNATURE-GATE: generated-with: ' | /usr/bin/grep -F 'Generated with [Claude Code](https://claude.com/claude-code)' >/dev/null || return 1
}

@test "(SG1b) the REAL signed commit 116346f (robot emoji) -> exit 1, names both lines" {
  build_msg SG1b "$MSG_FILE"
  run_hook
  assert_refused
  [ "$(printf '%s\n' "$output" | /usr/bin/grep -c '^SIGNATURE-GATE: ')" -eq 2 ] || return 1
}

@test "(SG2) last paragraph Co-Authored-By: Claude <noreply@anthropic.com> -> exit 1" {
  build_msg SG2 "$MSG_FILE"; run_hook; assert_refused
}

@test "(SG3) lowercase co-authored-by: x <x@y.z> -> exit 1" {
  build_msg SG3 "$MSG_FILE"; run_hook; assert_refused
}

@test "(SG4) key-only Co-authored-by: Claude in the last paragraph (no email) -> exit 1 (S1a)" {
  build_msg SG4 "$MSG_FILE"; run_hook; assert_refused
}

@test "(SG5) closes #X + Co-Authored-By in ONE paragraph: git parses 0 trailers, the gate refuses" {
  build_msg SG5 "$MSG_FILE"
  [ "$(git_coauthor_count "$MSG_FILE")" -eq 0 ] || return 1
  run_hook; assert_refused
}

@test "(SG5b) closes #X + a key-only co-author in ONE paragraph -> exit 1 (S1a alone)" {
  build_msg SG5b "$MSG_FILE"
  [ "$(git_coauthor_count "$MSG_FILE")" -eq 0 ] || return 1
  run_hook; assert_refused
}

@test "(SG6) a full-identity co-author paragraph ABOVE a separate closes paragraph -> exit 1 (S1b)" {
  build_msg SG6 "$MSG_FILE"
  [ "$(git_coauthor_count "$MSG_FILE")" -eq 0 ] || return 1
  run_hook; assert_refused
}

@test "(SG7) robot emoji + Generated with [Claude Code](https://…) alone -> exit 1 (S2a)" {
  build_msg SG7 "$MSG_FILE"; run_hook; assert_refused
  printf '%s\n' "$output" | /usr/bin/grep -F 'SIGNATURE-GATE: generated-with: ' >/dev/null || return 1
}

@test "(SG8) Generated with [opencode](https://opencode.ai), no emoji -> exit 1 (S2b)" {
  build_msg SG8 "$MSG_FILE"; run_hook; assert_refused
}

@test "(SG9) Co-authored-by : x <x@y.z> (space before the colon) -> exit 1" {
  build_msg SG9 "$MSG_FILE"; run_hook; assert_refused
}

@test "(SG10) more than three hits -> three SIGNATURE-GATE lines plus a count of the rest" {
  write_lines "$MSG_FILE" 'fix(x): a change' '' 'body' '' \
    'Co-authored-by: a <a@x.y>' 'Co-authored-by: b <b@x.y>' 'Co-authored-by: c <c@x.y>' 'Co-authored-by: d <d@x.y>' 'Co-authored-by: e <e@x.y>'
  run_hook; assert_refused
  [ "$(printf '%s\n' "$output" | /usr/bin/grep -c '^SIGNATURE-GATE: co-author: ')" -eq 3 ] || return 1
  printf '%s\n' "$output" | /usr/bin/grep -F 'SIGNATURE-GATE: (+2 more)' >/dev/null || return 1
}

# =============================================================================
# PART 2 — FALSE-POSITIVE controls: legitimate messages pass SILENTLY
# =============================================================================

@test "(SC1-SC5) plain, closes #TD-470, WIP, fixup!, Merge branch -> exit 0, empty output" {
  for id in SC1 SC2 SC3 SC4 SC5; do
    build_msg "$id" "$MSG_FILE"
    run_hook
    [ "$status" -eq 0 ] || { echo "$id: exit $status: $output"; return 1; }
    [ "$output" = "" ] || { echo "$id: output: $output"; return 1; }
  done
}

@test "(SC6) a body quoting core/os/standards.md's rule line, read at test time -> silent pass" {
  build_msg SC6 "$MSG_FILE"
  /usr/bin/grep -F 'Co-Authored-By' "$MSG_FILE" >/dev/null || { echo "the standards line no longer names the trailer"; return 1; }
  run_hook; assert_silent_pass
}

@test "(SC7) the TD-470 brief body snapshot + closes #TD-470 -> silent pass" {
  build_msg SC7 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC8) prose line 'Generated with the new script, …' -> silent pass" {
  build_msg SC8 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC9) squash message quoting an old signed commit, 4-space indented -> silent pass" {
  build_msg SC9 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC10) a Signed-off-by: trailer -> silent pass" {
  build_msg SC10 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC11) a co-author line only after the scissors line, and a # comment one -> silent pass" {
  build_msg SC11 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC12) col-0 'Co-Authored-By: tags are refused …' in a MIDDLE paragraph, no email -> silent pass" {
  build_msg SC12 "$MSG_FILE"; run_hook; assert_silent_pass
}

@test "(SC13) three REAL messages that quote the standard in body prose (40ff64d, e6deaee, b3df736) -> silent pass" {
  # e6deaee predates the 72-char rule (an 81-char summary), so the REAL hook
  # exits at §1 and never reaches §1b. The fixture stays byte-exact; the
  # control runs through a copy with ONLY the length limit lifted.
  sed 's/"\$len" -gt 72 \]/"$len" -gt 999 ]/' "$HOOK_SRC" > "$SCRATCH/hook-nolen"
  [ "$(/usr/bin/grep -c '"$len" -gt 999 ]' "$SCRATCH/hook-nolen")" -eq 1 ] || return 1
  [ "$(/usr/bin/grep -c '"$len" -gt 72 ]' "$SCRATCH/hook-nolen" || true)" -eq 0 ] || return 1
  build_msg SC13b "$MSG_FILE"
  run_hook
  [[ "$output" == *"summary too long: 81 chars"* ]] || return 1
  for id in SC13a SC13b SC13c; do
    build_msg "$id" "$MSG_FILE"
    run_hook_with "$SCRATCH/hook-nolen"
    [ "$status" -eq 0 ] || { echo "$id: exit $status: $output"; return 1; }
    [ "$output" = "" ] || { echo "$id: output: $output"; return 1; }
  done
}

# =============================================================================
# PART 3 — bypass independence (coding_guidelines §18.11 rule 2)
# =============================================================================

@test "(SB1) IGRIS_BYPASS_SIGNATURE_GATE=1 + SG2 -> exit 0, silent" {
  build_msg SG2 "$MSG_FILE"
  run_hook IGRIS_BYPASS_SIGNATURE_GATE=1
  assert_silent_pass
}

@test "(SB2) IGRIS_BYPASS_AC_GATE=1 IGRIS_BYPASS_EVENT_GATE=1 do NOT silence the signature gate" {
  build_msg SG2 "$MSG_FILE"
  run_hook IGRIS_BYPASS_AC_GATE=1 IGRIS_BYPASS_EVENT_GATE=1
  assert_refused
}

@test "(SB3) the signature bypass leaves the length check armed (73-char summary -> exit 1)" {
  long="$(printf '%*s' 73 '' | tr ' ' 'x')"
  write_lines "$MSG_FILE" "$long" '' "$TRAILER"
  run_hook IGRIS_BYPASS_SIGNATURE_GATE=1
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"max 72"* ]] || return 1
}

# SB4 needs a brain: the AC gate must be able to refuse. PLAIN tables only.
seed_ac_world() {
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  [ -f "$AC_CHECK" ] || { echo "AC parser not found at $AC_CHECK"; return 1; }
  mkdir -p "$FAKEHOME/.igris/memory" "$REPO/core/scripts"
  cp "$AC_CHECK" "$REPO/core/scripts/brief_ac_check.sh"
  python3 - "$FAKEHOME/.igris/memory/knowledge.db" "$PROJECT" "$AC_FIXTURES/TD-347.md" <<'PY'
import sqlite3, sys
db, project, path = sys.argv[1:4]
con = sqlite3.connect(db)
con.execute("CREATE TABLE brief_files (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,"
            " brief_id TEXT NOT NULL, filename TEXT, content TEXT,"
            " updated_at TEXT NOT NULL DEFAULT (datetime('now')))")
con.execute("INSERT INTO brief_files (project, brief_id, filename, content) VALUES (?,?,?,?)",
            (project, "TD-347", "TD-347.md", open(path, encoding="utf-8").read()))
con.commit()
PY
}

@test "(SB4) the signature bypass is a SECTION skip: the AC gate still refuses an unticked close" {
  seed_ac_world
  write_lines "$MSG_FILE" 'fix(x): a change' '' 'body line' '' 'closes #TD-347' "$TRAILER"
  run_hook IGRIS_BYPASS_SIGNATURE_GATE=1
  [ "$status" -eq 1 ] || { echo "exit $status: $output"; return 1; }
  [[ "$output" == *"TD-325 AC gate"* ]] || return 1
  if printf '%s\n' "$output" | /usr/bin/grep -F "$REFUSAL" >/dev/null; then return 1; fi
}

@test "(SB5) without the bypass the signature gate refuses FIRST and exits (the AC verdict is not reached)" {
  seed_ac_world
  write_lines "$MSG_FILE" 'fix(x): a change' '' 'body line' '' 'closes #TD-347' "$TRAILER"
  run_hook
  assert_refused
  if printf '%s\n' "$output" | /usr/bin/grep -F 'TD-325 AC gate' >/dev/null; then return 1; fi
}

# =============================================================================
# PART 4 — self-negative controls: each clause is what makes its case red
# =============================================================================

@test "(SN1) a hook copy with the TD-470 block deleted lets every SG case through" {
  sed '/\[\[ TD-470 SIGNATURE GATE BEGIN \]\]/,/\[\[ TD-470 SIGNATURE GATE END \]\]/d' "$HOOK_SRC" > "$SCRATCH/hook-sn1"
  [ "$(/usr/bin/grep -c 'SIGNATURE-GATE' "$HOOK_SRC")" -gt 0 ] || return 1
  [ "$(/usr/bin/grep -c 'SIGNATURE-GATE' "$SCRATCH/hook-sn1" || true)" -eq 0 ] || return 1
  for id in SG1 SG1b SG2 SG3 SG4 SG5 SG5b SG6 SG7 SG8 SG9; do
    build_msg "$id" "$MSG_FILE"
    run_hook_with "$SCRATCH/hook-sn1"
    [ "$status" -eq 0 ] || { echo "$id: mutant exit $status: $output"; return 1; }
    run_hook
    [ "$status" -eq 1 ] || { echo "$id: real hook exit $status"; return 1; }
  done
}

@test "(SN2) S1a's anchor removed -> SG4 and SG5b pass; SG5 is still caught (by S1b, it carries an email)" {
  mutant_without 'sig-anchor:S1a' "$SCRATCH/hook-sn2" 1
  for id in SG4 SG5b; do
    build_msg "$id" "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn2"
    [ "$status" -eq 0 ] || { echo "$id: mutant exit $status"; return 1; }
  done
  for id in SG1 SG2 SG3 SG5 SG6 SG7 SG8 SG9; do
    build_msg "$id" "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn2"
    [ "$status" -eq 1 ] || { echo "$id: mutant exit $status"; return 1; }
  done
}

@test "(SN3) S1b's anchor removed -> SG6 passes; SG2/SG5 are still caught (by S1a)" {
  mutant_without 'sig-anchor:S1b' "$SCRATCH/hook-sn3" 1
  build_msg SG6 "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn3"
  [ "$status" -eq 0 ] || return 1
  for id in SG2 SG5; do
    build_msg "$id" "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn3"
    [ "$status" -eq 1 ] || { echo "$id: mutant exit $status"; return 1; }
  done
}

@test "(SN4) the scissors cut removed -> SC11 is refused (the diff below the cut is read)" {
  mutant_without 'sig-anchor:SCISSORS' "$SCRATCH/hook-sn4" 1
  build_msg SC11 "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn4"
  [ "$status" -eq 1 ] || return 1
  run_hook
  [ "$status" -eq 0 ] || return 1
}

@test "(SN5) S2's anchor removed -> SG7 and SG8 pass" {
  mutant_without 'sig-anchor:S2' "$SCRATCH/hook-sn5" 1
  for id in SG7 SG8; do
    build_msg "$id" "$MSG_FILE"; run_hook_with "$SCRATCH/hook-sn5"
    [ "$status" -eq 0 ] || { echo "$id: mutant exit $status"; return 1; }
  done
}

# =============================================================================
# PART 5 — the platform matrix and git's own trailer parser
# =============================================================================

@test "(SM1) /bin/bash with PATH=/usr/bin:/bin (the system grep/sed/awk) -> the same verdicts" {
  [ -x /usr/bin/git ] || skip "no /usr/bin/git"
  for pair in SG1:1 SG2:1 SG7:1 SG8:1 SC6:0 SC8:0 SC11:0 SC13a:0; do
    id="${pair%%:*}"; want="${pair##*:}"
    build_msg "$id" "$MSG_FILE"
    run env -i HOME="$FAKEHOME" PATH=/usr/bin:/bin /bin/bash -c "cd '$REPO' && /bin/bash '$HOOK_SRC' '$MSG_FILE' 2>&1"
    [ "$status" -eq "$want" ] || { echo "$id: want $want got $status: $output"; return 1; }
  done
}

@test "(SO1) oracle: wherever git's parser reports a co-author trailer the gate refuses; SG5 is the pinned superset" {
  # git decides these (its trailer block holds the key) ...
  for id in SG2 SG3 SG4 SG9; do
    build_msg "$id" "$MSG_FILE"
    [ "$(git_coauthor_count "$MSG_FILE")" -ge 1 ] || { echo "$id: git reports no trailer"; return 1; }
  done
  # ... and reports none for these.
  for id in SG5 SG6 SC6 SC7 SC12 SC13a SC13b SC13c; do
    build_msg "$id" "$MSG_FILE"
    [ "$(git_coauthor_count "$MSG_FILE")" -eq 0 ] || { echo "$id: git reports a trailer"; return 1; }
  done
  # The implication, over every case: git says trailer => the gate refuses.
  for id in SG1 SG1b SG2 SG3 SG4 SG5 SG5b SG6 SG7 SG8 SG9 SC1 SC2 SC3 SC4 SC5 SC6 SC7 SC8 SC9 SC10 SC11 SC12 SC13a SC13b SC13c; do
    build_msg "$id" "$MSG_FILE"
    n="$(git_coauthor_count "$MSG_FILE")"
    run_hook
    if [ "$n" -ge 1 ] && [ "$status" -ne 1 ]; then echo "$id: git sees $n trailer(s), gate exit $status"; return 1; fi
  done
  # The deliberate divergence: git parses 0 for SG5, the gate refuses it.
  build_msg SG5 "$MSG_FILE"; run_hook
  [ "$status" -eq 1 ] || return 1
}
