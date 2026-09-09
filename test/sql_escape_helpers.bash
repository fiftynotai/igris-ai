#!/usr/bin/env bash

# sql_escape_helpers.bash — BR-104. Shared helpers for the suites that prove
# the bash-3.2 SQL-escape idiom (`q=${x//\'/\'\'}`, an UNQUOTED assignment)
# in the hook-invoked consumers: test/brief_ac_gate.test.bash (Q1-Q5, S7),
# test/agent_event_gate.test.bash (G11-G14) and the four validate_brief_*
# suites (V1-V5).
#
# WHY /bin/bash AND NOT PATH bash. Git runs the hooks by their shebang
# (`#!/bin/bash` — 3.2 on macOS). Under 3.2 the double-quoted form
# `"${x//\'/\'\'}"` keeps the backslashes literal (`it\'\'s`), sqlite3 rejects
# the token, stderr is discarded and the caller fails OPEN. Under bash >= 4
# both forms yield `it''s`, so a suite that runs `bash '$HOOK'` on a machine
# whose PATH bash is 5.x cannot see the defect. Every helper here runs the
# subject under /bin/bash explicitly, and the mutant (RED) arms are gated on
# THAT interpreter's BASH_VERSINFO[0] — `skip_unless_bin_bash_3` names the
# reason on a >= 4 platform (CI's ubuntu leg). bash 3.2 throughout: no
# associative arrays, no `${var,,}`, no mapfile.
#
# Usage (after `load test_helper`): `load sql_escape_helpers`.

# bin_bash_major — the major version of /bin/bash, the interpreter git uses.
bin_bash_major() {
  /bin/bash -c 'printf "%s" "${BASH_VERSINFO[0]}"' 2>/dev/null
}

# skip_unless_bin_bash_3 — the quoted-form defect is 3.x-only; on a newer
# /bin/bash the mutant arm is vacuous and says so instead of passing quietly.
skip_unless_bin_bash_3() {
  local major
  major="$(bin_bash_major)"
  if [ "$major" != "3" ]; then
    skip "/bin/bash is ${major:-absent}; the quoted-form defect is 3.2-only — test/sql_escape_idiom.test.bash covers this platform"
  fi
}

# sql_q <value> — the test's OWN escaping when it seeds a quoted project into a
# fixture table through a sqlite3 string — the UNQUOTED assignment, because
# bats itself runs under /bin/bash 3.2 on macOS and the quoted form would
# reproduce the defect inside the fixture (it did, on the first RED run).
sql_q() {
  local q
  q=${1//\'/\'\'}
  printf '%s' "$q"
}

# quoted_form_count <file> — occurrences of the DOUBLE-QUOTED escape
# (`//\'/\'\'}"`) on NON-comment lines. The closing `}"` is the shape: an
# unquoted assignment ends `}` followed by a newline or a space.
quoted_form_count() {
  grep -vE '^[[:space:]]*#' "$1" | grep -cF "//\\'/\\'\\'}\"" || true
}

# unquoted_form_count <file> — occurrences of the escape token on non-comment
# lines that are NOT the quoted form.
unquoted_form_count() {
  grep -vE '^[[:space:]]*#' "$1" | grep -F "//\\'/\\'\\'}" | grep -vcF "//\\'/\\'\\'}\"" || true
}

# build_quoted_mutant <src> <dst> <n> — a scratch copy of <src> with every
# UNQUOTED escape assignment `=${NAME//\'/\'\'}` rewritten to the QUOTED form
# `="${NAME//\'/\'\'}"`. Asserts the mutation LANDED: <src> has <n> unquoted
# and 0 quoted sites; <dst> has 0 unquoted and <n> quoted (test_standards
# convention 4 — a mutation that did not land is a meaningless green).
build_quoted_mutant() {
  local src="$1" dst="$2" n="$3"
  [ "$(unquoted_form_count "$src")" = "$n" ] || { echo "mutant src: expected $n unquoted sites, got $(unquoted_form_count "$src")" >&2; return 1; }
  [ "$(quoted_form_count "$src")" = "0" ] || { echo "mutant src: expected 0 quoted sites" >&2; return 1; }
  python3 - "$src" "$dst" "$n" <<'PY' || return 1
import re, sys
src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
pat = re.compile(r"=(\$\{[A-Za-z_]+//\\'/\\'\\'\})")
out, hits = [], 0
for line in open(src, encoding="utf-8"):
    if line.lstrip().startswith("#"):
        out.append(line); continue
    line, k = pat.subn(r'="\1"', line)
    hits += k
    out.append(line)
if hits != n:
    sys.exit("expected %d replacements, made %d" % (n, hits))
open(dst, "w", encoding="utf-8").write("".join(out))
PY
  [ "$(unquoted_form_count "$dst")" = "0" ] || { echo "mutant dst: unquoted sites remain" >&2; return 1; }
  [ "$(quoted_form_count "$dst")" = "$n" ] || { echo "mutant dst: expected $n quoted sites" >&2; return 1; }
  chmod +x "$dst"
  return 0
}

# run_hook_bin [extra env assignments...] — invoke the commit-msg hook under
# /bin/bash with cwd=$REPO and the fake HOME, against the current $MSG_FILE.
# The `cd` uses DOUBLE quotes so a repo path carrying `'` survives
# (test/phase_guard.test.bash run_mutant idiom).
run_hook_bin() {
  run bash -c "cd \"$REPO\" && HOME='$FAKEHOME' $* /bin/bash '$HOOK_SRC' '$MSG_FILE' 2>&1"
}

# run_hook_file_bin <hook-path> [extra env assignments...] — same, for a
# scratch copy (the mutant).
run_hook_file_bin() {
  local hook="$1"; shift
  run bash -c "cd \"$REPO\" && HOME='$FAKEHOME' $* /bin/bash '$hook' '$MSG_FILE' 2>&1"
}
