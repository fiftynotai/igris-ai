#!/usr/bin/env bats

# commit_msg_sigpipe.test.bash — BR-107. core/git-hooks/commit-msg leaks EPIPE
# noise onto stderr on an otherwise-PASSING or otherwise-REFUSING commit, when
# the process runs with SIGPIPE ignored (as GitHub Actions' ubuntu-latest
# runner does — CI run 36018510341, 2026-09-24, SC7 in
# commit_signature_gate.test.bash). The verdict (exit code) was always
# correct; the defect is a stderr write, which breaks the "silent on pass"
# and "no noise beyond the refusal" contracts.
#
# MECHANISM: two pipelines end in an early-exiting reader (`head -n1` at
# :138, `head -n 3` at :204) fed by an upstream writer (`grep`, `printf`)
# that can still have buffered output when the reader exits. Under the
# DEFAULT SIGPIPE disposition the orphaned writer is silently killed by the
# kernel; under an IGNORED disposition (`trap '' PIPE`) the writer's next
# write(2) returns EPIPE and the tool reports it on stderr ("grep: write
# error: Broken pipe" on GNU, "grep: stdout: Broken pipe" measured on this
# Mac's BSD grep, "printf: write error" for the bash builtin). This is the
# SAME short-circuiting-reader hazard class as coding_guidelines.md's
# pipefail section, but a different consumer-visible symptom (stderr noise
# on a correct exit code, not a false pipeline failure) — see that section's
# "the reader must not short-circuit" framing.
#
# The fix replaces both early-exiting readers with DRAINING readers —
# `:138` `| sed -n 1p` and `:204` `| sed -n '1,3p' | sed 's/^/SIGNATURE-GATE: /'`
# — that read to EOF regardless of how many lines they print, so the upstream
# writer is never orphaned. (`:204` is two-stage because the one-sed block
# `sed -n '1,3{s/…/…/;p}'` is rejected by BSD sed — "extra characters at the
# end of p command", exit 1, measured on macOS /usr/bin/sed 2026-09-24.) Both sites select the IDENTICAL line(s) as before — see
# test/commit_msg_length.test.bash and test/commit_signature_gate.test.bash,
# the regression controls this brief must leave green and unmodified.
#
# THE ASSERTION IS "stderr is empty" ON THE PASS PATH (R1/C1), never a
# wording — GNU and BSD grep phrase the EPIPE message differently, and this
# suite must be portable to both. On the refusal path (R2/C2) the hook's OWN
# stdout lines are expected, so the assertion there is negative: stderr
# carries no "Broken pipe" / "write error" substring, not stderr == "".
#
# Two large fixtures, built once in setup_file() (not per-test — they don't
# vary between tests and rebuilding per @test would be wasteful):
#   BIG_BODY_FILE    — ~300 KiB of harmless non-comment, non-blank body text,
#                       for R1/C1 (site :138's grep pipeline).
#   BIG_SIGHITS_FILE — ~500 KiB / 8000 unique `Co-authored-by:` identity
#                       lines, for R2/C2 (site :204's `sig_hits` printf).
# Both clear the ≥256 KiB target (past Linux's 64 KiB and macOS' 16-64 KiB
# pipe-buffer floors) named in the BR-107 plan, without vendoring a large
# fixture file (test_standards.md prefers a generator where one is
# straightforward).
#
# Past mistakes to avoid: TD-341 (a non-final bare check cannot fail a bats
# test — every assertion here is `|| return 1` or inside an `[ ... ] ||`);
# TD-434 (negative-string checks are LINE-scoped, not a substring search
# across the whole combined blob — grep each stream on its own).

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"

setup_file() {
  # ~300 KiB body: 2200 non-comment, non-blank lines, none of which match any
  # signature-gate pattern (no "co-authored-by", no "generated with", no
  # leading emoji) and none of which is itself long enough to trip the
  # 72-char summary gate on its own (each line here is a BODY line, never
  # the selected summary).
  # BATS_FILE_TMPDIR (bats-core >= 1.3) is the SAME directory across
  # setup_file/every @test/teardown_file for this file, even though each
  # @test runs in its own process — a plain shell variable set in
  # setup_file does not survive into a later process, so the path (not just
  # its value) must be deterministic. A fixed filename inside it, computed
  # identically here and in setup(), works without any cross-process
  # variable passing.
  BIG_BODY_FILE="$BATS_FILE_TMPDIR/big_body.txt"
  i=0
  while [ "$i" -lt 2200 ]; do
    printf 'padding line %06d %s\n' "$i" "$(printf '%*s' 140 '' | tr ' ' 'x')"
    i=$((i + 1))
  done > "$BIG_BODY_FILE"

  # ~500 KiB / 8000 unique full-identity Co-authored-by lines: each one
  # independently matches S1b ("anywhere in the message"), so all 8000
  # survive the `awk 'NF && !seen[$0]++'` dedup (every line is byte-distinct)
  # and land in $sig_hits, well past the pipe-buffer floor.
  BIG_SIGHITS_FILE="$BATS_FILE_TMPDIR/big_sighits.txt"
  i=0
  BIG_SIGHITS_COUNT=8000
  while [ "$i" -lt "$BIG_SIGHITS_COUNT" ]; do
    printf 'Co-authored-by: user%06d <user%06d@example.com>\n' "$i" "$i"
    i=$((i + 1))
  done > "$BIG_SIGHITS_FILE"
}

teardown_file() {
  rm -f "$BATS_FILE_TMPDIR/big_body.txt" "$BATS_FILE_TMPDIR/big_sighits.txt" 2>/dev/null || true
}

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }

  # Same fixed paths as setup_file() — see the comment there.
  BIG_BODY_FILE="$BATS_FILE_TMPDIR/big_body.txt"
  BIG_SIGHITS_FILE="$BATS_FILE_TMPDIR/big_sighits.txt"
  BIG_SIGHITS_COUNT=8000

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/sigpipe.XXXXXX")"
  MSG_FILE="$SANDBOX/COMMIT_EDITMSG"

  # Two static wrapper scripts (built once per test, not inline `bash -c`
  # strings with nested quoting) that reproduce the orchestrator's measured
  # repro verbatim:
  #   env -i HOME=<empty> PATH=/usr/bin:/bin /bin/bash -c \
  #     "trap '' PIPE; exec /bin/bash <hook> <msg>"
  # WRAPPER_IGNORED sets the trap (SIGPIPE ignored, GitHub Actions' runner
  # disposition); WRAPPER_DEFAULT is the same invocation without the trap
  # (the surviving control — default SIGPIPE disposition kills an orphaned
  # writer silently instead of it reporting EPIPE).
  WRAPPER_IGNORED="$SANDBOX/run_ignored.sh"
  cat > "$WRAPPER_IGNORED" <<'EOF'
#!/bin/bash
# $1=hook $2=msgfile
exec env -i HOME='' PATH=/usr/bin:/bin /bin/bash -c 'trap "" PIPE; exec /bin/bash "$0" "$1"' "$1" "$2"
EOF
  chmod +x "$WRAPPER_IGNORED"

  WRAPPER_DEFAULT="$SANDBOX/run_default.sh"
  cat > "$WRAPPER_DEFAULT" <<'EOF'
#!/bin/bash
# $1=hook $2=msgfile
exec env -i HOME='' PATH=/usr/bin:/bin /bin/bash -c 'exec /bin/bash "$0" "$1"' "$1" "$2"
EOF
  chmod +x "$WRAPPER_DEFAULT"
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# --- fixtures ----------------------------------------------------------------

# build_pass_msg <file> — short valid summary (site :138's TD-180 check
# passes), then a ~300 KiB harmless body with no signature-gate hits and no
# `closes #` footer (so the §2/§3 prelude never engages).
build_pass_msg() {
  local f="$1"
  { printf 'fix(x): a harmless short summary\n\n'
    cat "$BIG_BODY_FILE"
  } > "$f"
}

# build_refusal_msg <file> — >3 signature hits (8000, all via S1b's full
# identity form), so site :204's `sig_hits` is large enough to overflow the
# pipe buffer when `head -n 3` exits early.
build_refusal_msg() {
  local f="$1"
  { printf 'fix(x): a change\n\n'
    printf 'body line\n\n'
    cat "$BIG_SIGHITS_FILE"
  } > "$f"
}

# --- runner --------------------------------------------------------------
# run_sigpipe <wrapper> — captures stdout and stderr SEPARATELY (unlike the
# existing suites' merged `2>&1` capture): this suite must distinguish "some
# output" from "output specifically on stderr". Sets $status, $STDOUT,
# $STDERR. Follows the repo's established `run bash -c "... >f 2>f"` pattern
# (test/brief_gate.test.bash's run_hook_split_stderr) so it works under any
# bats version, not just ones supporting `run --separate-stderr`.
run_sigpipe() {
  local wrapper="$1"
  STDOUT_FILE="$SANDBOX/stdout.$$.$RANDOM"
  STDERR_FILE="$SANDBOX/stderr.$$.$RANDOM"
  run bash -c "'$wrapper' '$HOOK_SRC' '$MSG_FILE' >'$STDOUT_FILE' 2>'$STDERR_FILE'"
  STDOUT="$(cat "$STDOUT_FILE" 2>/dev/null || echo '')"
  STDERR="$(cat "$STDERR_FILE" 2>/dev/null || echo '')"
}

# =============================================================================
# PART 1 — ignored-SIGPIPE reproduction (RED at HEAD, GREEN after Phase 1's
# sed -n fix)
# =============================================================================

@test "(R1) site :138 pass-path under ignored SIGPIPE -> exit 0, EMPTY stderr" {
  build_pass_msg "$MSG_FILE"
  run_sigpipe "$WRAPPER_IGNORED"
  [ "$status" -eq 0 ] || { echo "expected exit 0, got $status; stdout=$STDOUT stderr=$STDERR"; return 1; }
  [ -z "$STDERR" ] || { echo "expected EMPTY stderr, got: $STDERR"; return 1; }
}

@test "(R2) site :204 refusal-path under ignored SIGPIPE -> exit 1, verdict unchanged, no EPIPE noise on stderr" {
  build_refusal_msg "$MSG_FILE"
  run_sigpipe "$WRAPPER_IGNORED"
  [ "$status" -eq 1 ] || { echo "expected exit 1 (refused), got $status; stdout=$STDOUT stderr=$STDERR"; return 1; }
  [[ "$STDOUT" == *"[commit-msg] TD-470 signature gate"* ]] || { echo "no refusal header on stdout: $STDOUT"; return 1; }
  [ "$(printf '%s\n' "$STDOUT" | /usr/bin/grep -c '^SIGNATURE-GATE: co-author: ')" -eq 3 ] || { echo "expected exactly 3 SIGNATURE-GATE lines: $STDOUT"; return 1; }
  printf '%s\n' "$STDOUT" | /usr/bin/grep -F "SIGNATURE-GATE: (+$((BIG_SIGHITS_COUNT - 3)) more)" >/dev/null \
    || { echo "expected the (+$((BIG_SIGHITS_COUNT - 3)) more) count line: $STDOUT"; return 1; }
  # Negative, LINE-scoped (TD-434): no line on stderr carries either tool's
  # EPIPE wording. Absence of the noise string, not stderr == "" — the
  # refusal path's own diagnostics live on stdout, not stderr. `if` (not a
  # bare `&&`/`[[ ]]`) per TD-341 — a non-final bare check cannot fail a
  # bats test.
  if printf '%s\n' "$STDERR" | /usr/bin/grep -qF 'Broken pipe'; then
    echo "stderr carries EPIPE noise (Broken pipe): $STDERR"; return 1
  fi
  if printf '%s\n' "$STDERR" | /usr/bin/grep -qF 'write error'; then
    echo "stderr carries EPIPE noise (write error): $STDERR"; return 1
  fi
}

# =============================================================================
# PART 2 — surviving control: the SAME two fixtures under the DEFAULT SIGPIPE
# disposition. GREEN at HEAD and after the fix, both times — proves the
# `trap '' PIPE` harness (not the large-message fixture alone) is what
# reveals the defect, matching the brief's "on macOS, where the tests default
# to SIGPIPE-kills, it never showed."
# =============================================================================

@test "(C1) site :138 pass-path under DEFAULT SIGPIPE -> exit 0, empty stderr (survives at HEAD)" {
  build_pass_msg "$MSG_FILE"
  run_sigpipe "$WRAPPER_DEFAULT"
  [ "$status" -eq 0 ] || { echo "expected exit 0, got $status; stdout=$STDOUT stderr=$STDERR"; return 1; }
  [ -z "$STDERR" ] || { echo "expected EMPTY stderr, got: $STDERR"; return 1; }
}

@test "(C2) site :204 refusal-path under DEFAULT SIGPIPE -> exit 1, no EPIPE noise (survives at HEAD)" {
  build_refusal_msg "$MSG_FILE"
  run_sigpipe "$WRAPPER_DEFAULT"
  [ "$status" -eq 1 ] || { echo "expected exit 1 (refused), got $status; stdout=$STDOUT stderr=$STDERR"; return 1; }
  if printf '%s\n' "$STDERR" | /usr/bin/grep -qF 'Broken pipe'; then
    echo "stderr carries EPIPE noise (Broken pipe): $STDERR"; return 1
  fi
  if printf '%s\n' "$STDERR" | /usr/bin/grep -qF 'write error'; then
    echo "stderr carries EPIPE noise (write error): $STDERR"; return 1
  fi
}
