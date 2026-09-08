#!/usr/bin/env bats

# sql_escape_idiom.test.bash — BR-104. The source-scan guard for the bash-3.2
# SQL-escape idiom across every hook-invoked bash consumer that interpolates a
# value into a sqlite3 query.
#
# THE DEFECT. `q="${x//\'/\'\'}"` (double-quoted) is the natural way to write
# the single-quote-doubling escape, and under bash >= 4 it works. Under
# /bin/bash 3.2 — the interpreter git runs the hooks under, whatever newer bash
# sits on the operator's PATH — the double-quoted form keeps the backslashes
# literal (`it's` -> `it\'\'s`), sqlite3 rejects the token, the error is
# discarded by the caller's `2>/dev/null`, and the consumer fails OPEN: the
# closing-commit gates skip, the validators report an empty (clean) pass.
# TD-453 (2026-09-07) found three sites in core/git-hooks/pre-commit; BR-104
# swept the remaining nine (commit-msg x4, scripts/validate_brief_*.sh x5).
# The only correct spelling is the UNQUOTED assignment `q=${x//\'/\'\'}`.
#
# WHAT THIS FILE PROVES (the BR-100 "source-scan pin with a self-negative
# control" template, test_standards.md):
#   SC1  the quoted form counts 0 on NON-comment lines in every file of the
#        population (per-file counts printed);
#   SC2  the unquoted form counts the pinned population (16 sites, 2026-09-08,
#        by this scanner) over >= 9 files, so a wrong root cannot read clean;
#   SC3  a planted quoted site in a temp copy IS reported (the scanner fires);
#   SC4  the quoted form ONLY inside a `#` line is NOT reported — the comment
#        exemption is proved, not assumed (core/git-hooks/pre-commit carries
#        the quoted form inside its TD-453 comment on purpose);
#   SC5  the brief's AC-1 grep, verbatim, reads 0 on every named file.
# The BEHAVIOURAL witnesses (the fail-open itself, under /bin/bash 3.x) live
# in test/brief_ac_gate.test.bash (Q1-Q5, S7), test/agent_event_gate.test.bash
# (G11-G14) and the four validate_brief_*.test.bash suites (V1-V5). This file
# is the cross-platform protection: it reds on CI's ubuntu leg too, where the
# 3.2-only mutant arms skip.
#
# SCOPE, STATED: the detector keys on the token `//\'/\'\'}"` (the escape
# closed by `}"`). A quoted form closed by another character (e.g.
# `"...${x//\'/\'\'}'"` inside a larger string) is outside its reach; no such
# site exists in the population (grep 2026-09-08). bash 3.2 throughout.

load test_helper
load sql_escape_helpers

# UNQUOTED_SITES — the pinned population. 2026-09-08, counted by this file's
# scanner over the population below: core/git-hooks/pre-commit 6 (TD-453),
# core/git-hooks/commit-msg 4 (BR-104), core/hooks/shared/session_start.sh 1,
# scripts/validate_brief_{state_reconciliation,priority_vocabulary,
# status_vocabulary,type_vocabulary,ac_completion}.sh 1 each = 16. A NEW
# interpolation site joins this count in the same commit (MAINTAINING.md, the
# bash-3.2 SQL-escape idiom row).
UNQUOTED_SITES=16
MIN_FILES=9

setup() {
  SCRATCH="$TEST_TEMP_DIR/sqlesc_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# population — one path per line, walked by glob from $IGRIS_ROOT. Every file
# git or a harness hook executes, plus every parser/validator they resolve.
population() {
  local f
  for f in "$IGRIS_ROOT/core/git-hooks/pre-commit" \
           "$IGRIS_ROOT/core/git-hooks/commit-msg" \
           "$IGRIS_ROOT"/core/hooks/shared/*.sh \
           "$IGRIS_ROOT"/core/scripts/*.sh \
           "$IGRIS_ROOT"/scripts/*.sh; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  return 0
}

@test "(SC1) the quoted escape form counts 0 on non-comment lines in EVERY population file" {
  local f n bad=0 files=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    files=$((files + 1))
    n="$(quoted_form_count "$f")"
    printf '%s: quoted=%s\n' "${f#"$IGRIS_ROOT"/}" "$n" >&2
    if [ "$n" != "0" ]; then
      echo "QUOTED ESCAPE FORM (fails open under /bin/bash 3.2): ${f#"$IGRIS_ROOT"/} x$n" >&2
      bad=$((bad + 1))
    fi
  done <<< "$(population)"
  [ "$files" -ge "$MIN_FILES" ] || { echo "population too small: $files files (root=$IGRIS_ROOT)"; return 1; }
  [ "$bad" -eq 0 ] || { echo "$bad file(s) carry the quoted form"; return 1; }
}

@test "(SC2) the unquoted escape form counts the pinned population ($UNQUOTED_SITES sites, 2026-09-08) over >= $MIN_FILES files" {
  local f n total=0 files=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    files=$((files + 1))
    n="$(unquoted_form_count "$f")"
    [ "$n" = "0" ] || printf '%s: unquoted=%s\n' "${f#"$IGRIS_ROOT"/}" "$n" >&2
    total=$((total + n))
  done <<< "$(population)"
  echo "files scanned: $files; unquoted sites: $total" >&2
  [ "$files" -ge "$MIN_FILES" ] || { echo "population too small: $files files"; return 1; }
  [ "$total" -eq "$UNQUOTED_SITES" ] || { echo "unquoted sites: expected $UNQUOTED_SITES, got $total (a new site joins the pin in the same commit)"; return 1; }
}

# -----------------------------------------------------------------------------
# (SC3) SELF-NEGATIVE: the scanner FIRES. A temp copy of commit-msg with its
#       PROJECT_SQL assignment re-quoted is reported. Landed-proof: the copy's
#       quoted count goes 0 -> 1 and its unquoted count drops by exactly 1.
# -----------------------------------------------------------------------------
@test "(SC3) a planted quoted site in a temp copy of commit-msg IS reported" {
  local src="$IGRIS_ROOT/core/git-hooks/commit-msg" dst="$SCRATCH/commit-msg.planted"
  local before_u before_q
  before_u="$(unquoted_form_count "$src")"
  before_q="$(quoted_form_count "$src")"
  [ "$before_q" = "0" ] || { echo "precondition: the real hook carries the quoted form ($before_q)"; return 1; }
  python3 - "$src" "$dst" <<'PY' || return 1
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
old = "\nPROJECT_SQL=${PROJECT//\\'/\\'\\'}\n"
new = "\nPROJECT_SQL=\"${PROJECT//\\'/\\'\\'}\"\n"
if text.count(old) != 1:
    sys.exit("PROJECT_SQL assignment not found exactly once")
open(dst, "w", encoding="utf-8").write(text.replace(old, new))
PY
  [ "$(quoted_form_count "$dst")" = "1" ] || { echo "plant did not land (quoted=$(quoted_form_count "$dst"))"; return 1; }
  [ "$(unquoted_form_count "$dst")" = "$((before_u - 1))" ] || { echo "plant did not land (unquoted)"; return 1; }
}

# -----------------------------------------------------------------------------
# (SC4) THE COMMENT EXEMPTION, PROVED. The quoted form inside a `#` line is
#       documentation of the defect (pre-commit's TD-453 comment), not a site.
#       A copy whose ONLY quoted form sits in a comment reads 0.
# -----------------------------------------------------------------------------
@test "(SC4) the quoted form ONLY inside a comment line is NOT reported" {
  local dst="$SCRATCH/comment-only.sh"
  {
    printf '#!/bin/bash\n'
    printf '# never write q="${x//\\'"'"'/\\'"'"'\\'"'"'}" — it fails open under 3.2\n'
    printf '  # indented too: q="${x//\\'"'"'/\\'"'"'\\'"'"'}"\n'
    printf 'q=${x//\\'"'"'/\\'"'"'\\'"'"'}\n'
  } > "$dst"
  # The planted comment lines really carry the token (else SC4 proves nothing).
  [ "$(grep -cF "//\\'/\\'\\'}\"" "$dst")" = "2" ] || { echo "comment plant did not land"; cat "$dst"; return 1; }
  [ "$(quoted_form_count "$dst")" = "0" ] || { echo "comment line reported as a site"; return 1; }
  [ "$(unquoted_form_count "$dst")" = "1" ] || { echo "the unquoted site was not counted"; return 1; }
}

# -----------------------------------------------------------------------------
# (SC5) The brief's AC-1 command, verbatim, from the repo root. `grep -c` prints
#       `file:count` per file and exits 1 when nothing matched — every count
#       must be 0.
# -----------------------------------------------------------------------------
@test "(SC5) BR-104 AC-1: grep -cE for the quoted form reads 0 on commit-msg and the five validators" {
  # The command is written to a scratch script through a QUOTED heredoc so the
  # text below is byte-for-byte the brief's, not a re-quoting of it.
  cat > "$SCRATCH/ac1.sh" <<'SH'
grep -cE "//\\\\'/\\\\'\\\\'\}\"" core/git-hooks/commit-msg scripts/validate_brief_*.sh
SH
  run bash -c "cd \"$IGRIS_ROOT\" && bash \"$SCRATCH/ac1.sh\""
  echo "$output" >&2
  local lines nonzero
  lines="$(printf '%s\n' "$output" | grep -c ':')"
  [ "$lines" -eq 6 ] || { echo "expected 6 files (commit-msg + 5 validators), got $lines"; return 1; }
  nonzero="$(printf '%s\n' "$output" | grep -vc ':0$' || true)"
  [ "$nonzero" -eq 0 ] || { echo "quoted form present"; return 1; }
}
