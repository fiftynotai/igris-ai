#!/bin/bash
set -e

# Description: The ONE Agent-Log role parser (FR-267). Reads a brief's markdown
#              content, isolates its `### Agent Log` block(s), and reports the
#              distinct agent ROLES the log names — the set the commit-msg
#              event gate then checks against `agent_events`. Pure and
#              read-only: it opens no database, runs no SQL, and writes
#              nothing. Callers hand it content on stdin or a file path.
#
#              ONE implementation, deliberately (the brief_ac_check.sh
#              discipline): the gate's demand set and any audit's population
#              must be IDENTICAL BY CONSTRUCTION. A second Agent-Log reader
#              re-opens the "cleared queue read as handled while most of the
#              population was invisible" hole TD-325 closed. Change this file;
#              never fork it. The nine /register templates and hunt/SKILL.md's
#              `## Agent Log Format` write the table this parser reads, so a
#              change to the heading or the column order sweeps them together
#              (MAINTAINING.md, the hunt-cost-record row).
#
# THE GRAMMAR (what counts as a role):
#   - An AGENT LOG is any ATX heading (any level) whose text contains
#     `agent log`, case-insensitively. Its block runs to the next heading at
#     the same-or-shallower level. Fenced code is skipped, so a table quoted as
#     an EXAMPLE inside ``` is documentation, not a log.
#   - Inside the block, every markdown table row (a line starting with `|`)
#     contributes its SECOND cell as a ROLE cell — the `| Time | Agent | ... |`
#     shape every template writes. The header row and the `|---|` separator
#     are dropped by the denylist and the separator test below.
#   - NORMALIZATION of a role cell, in this order: lowercase; strip `*` and
#     `` ` `` anywhere and `_` at the edges (bold/code/italic markup — an inner
#     underscore is part of a name); cut at the first `(` (a parenthetical
#     is commentary — `warden (round 2)` is warden); split on `,` `+` `/` and
#     ` and ` (one cell may name several roles — `forger + sentinel`); then per
#     piece: trim, collapse whitespace, strip a leading `/`, strip a trailing
#     ` skill` or ` agent` (`/document skill` is document, `mender agent` is
#     mender); strip a trailing count (`forger x4` is forger).
#   - DENYLIST (never gated): orchestrator, user, operator, system, none, the
#     dash placeholders `-` `—` `–`, agent (the header cell) and the empty
#     string; a compound ending in `orchestrator` (`hunt-orchestrator`) is the
#     orchestrator. These are actors that emit no `igris_agent_event` by design
#     — the orchestrator IS the emitter — so demanding a row for them would
#     make every close fail.
#   - Output is the DISTINCT roles in first-seen order.
#
#   MEASURED, not designed (2026-08-26, every brief_files row, 1,865 briefs,
#   all projects): 56 logs parse to roles, 50 parse to NO_ROWS — every one a
#   v4-era BULLET-LIST log (`- [date PHASE] ...`), which this table grammar
#   does not read and the gate therefore never demands anything for — and
#   1,759 have no Agent Log at all. The three folds above (dash family, count
#   suffix, orchestrator compound) each came from that run; without them the
#   corpus yielded the pseudo-roles `—`, `forger x4` and `hunt-orchestrator`.
#   What remains after the folds is vocabulary, not notation, and stays gated:
#   `codex` (2), `seeker` (2), `fresh-context` (1). A refusal names the exact
#   role, so a log that names a non-role is corrected at the log.
#
# Usage:
#   brief_agent_log_roles.sh [--brief-id <ID>] [--roles] <file>
#   brief_agent_log_roles.sh [--brief-id <ID>] [--roles] -      # stdin
#
#   --brief-id <ID>  labels the verdict line only. It does not change parsing.
#   --roles          print one normalized role per line and nothing else (the
#                    machine form the commit-msg hook consumes). Prints nothing
#                    for NO_LOG / NO_ROWS / DEGRADED.
#
# Output (default) — one machine line:
#   AGENT-LOG <id>: VERDICT=OK roles=architect,forger,sentinel
#
# Verdicts (exit code is ALWAYS 0 — this script reports, the caller decides):
#   OK        at least one role parsed
#   NO_LOG    no Agent Log heading anywhere (fail-open: a legacy brief with no
#             log has nothing to gate)
#   NO_ROWS   a heading exists but no row survived the denylist (a log naming
#             only the orchestrator, or an empty table)
#   DEGRADED  unreadable or empty input
#
# PORTABILITY: written for bash 3.2 (macOS /bin/bash, which is what git runs
#   the hook under). No `${var,,}`, no associative arrays, no `mapfile`. A
#   bash-4-only construct here would not error loudly — the hook's fail-open
#   posture would swallow it, and the gate would silently stop gating.
#
# PERFORMANCE IS PART OF THE CONTRACT (inherited from brief_ac_check.sh):
#   everything on the per-line path is builtin only — `[[ ]]`, parameter
#   expansion, helpers that return through globals. No `$( )`, `grep`, `sed`
#   or `tr` inside the line loops.

usage() {
  sed -n '4,80p' "$0" | sed 's/^# \{0,1\}//'
}

# `orchestrator` is listed for readability only: is_denied() first matches any
# role ENDING in "orchestrator" (`*orchestrator`, so `hunt-orchestrator` folds
# too) before consulting this array — that glob is the effective guard (FR-267
# sentinel finding F5; mutation-proven: removing the array entry alone is inert).
DENYLIST=(orchestrator user operator system none - — – agent)

BRIEF_ID=""
ROLES_ONLY=0
INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --brief-id)
      BRIEF_ID="${2:-}"
      shift 2
      ;;
    --brief-id=*)
      BRIEF_ID="${1#*=}"
      shift
      ;;
    --roles)
      ROLES_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -)
      INPUT="-"
      shift
      ;;
    -*)
      echo "brief_agent_log_roles.sh: unknown option '$1'" >&2
      exit 2
      ;;
    *)
      INPUT="$1"
      shift
      ;;
  esac
done

LABEL="${BRIEF_ID:-<unlabelled>}"

# --- Read the content (fail-open on anything unreadable) ---------------------
content=""
if [ -z "$INPUT" ] || [ "$INPUT" = "-" ]; then
  content="$(cat || true)"
else
  if [ ! -r "$INPUT" ]; then
    [ "$ROLES_ONLY" -eq 1 ] || echo "AGENT-LOG $LABEL: VERDICT=DEGRADED reason=unreadable-input path=$INPUT roles="
    exit 0
  fi
  content="$(cat "$INPUT" || true)"
fi

if [ -z "$content" ]; then
  [ "$ROLES_ONLY" -eq 1 ] || echo "AGENT-LOG $LABEL: VERDICT=DEGRADED reason=empty-input roles="
  exit 0
fi

lines=()
while IFS= read -r ln; do
  lines+=("$ln")
done <<< "$content"
line_count=${#lines[@]}

# --- Helpers. All builtin-only ------------------------------------------------

_LVL=0
_HTEXT=""
scan_heading() {
  local l="$1"
  if [[ "$l" =~ ^(#{1,6})([[:space:]]|$) ]]; then
    _LVL=${#BASH_REMATCH[1]}
    l="${l#"${BASH_REMATCH[1]}"}"
    _HTEXT="${l#"${l%%[![:space:]]*}"}"
  else
    _LVL=0
    _HTEXT=""
  fi
}

# heading_is_log <text> — case-insensitive `agent log` anywhere in the text.
# nocasematch is scoped to this one test.
heading_is_log() {
  local r=1
  shopt -s nocasematch
  [[ "$1" =~ agent[[:space:]]+log ]] && r=0
  shopt -u nocasematch
  return "$r"
}

# lower <text> — sets _LC to the ASCII-lowercased text. bash 3.2 has no
# `${var,,}`, and `tr` is a fork; a 26-way index into two literals is builtin.
UPPER="ABCDEFGHIJKLMNOPQRSTUVWXYZ"
LOWER="abcdefghijklmnopqrstuvwxyz"
_LC=""
lower() {
  local s="$1" out="" ch rest
  local i=0
  while [ "$i" -lt "${#s}" ]; do
    ch="${s:$i:1}"
    rest="${UPPER%%"$ch"*}"
    if [ "${#rest}" -lt 26 ]; then
      ch="${LOWER:${#rest}:1}"
    fi
    out+="$ch"
    i=$((i + 1))
  done
  _LC="$out"
}

# trim <text> — sets _T: leading/trailing whitespace removed, tabs folded to
# spaces, inner runs of spaces collapsed to one.
_T=""
trim() {
  local t="$1"
  t="${t//$'\t'/ }"
  while [[ "$t" == *"  "* ]]; do
    t="${t//  / }"
  done
  t="${t#"${t%%[![:space:]]*}"}"
  t="${t%"${t##*[![:space:]]}"}"
  _T="$t"
}

# denied <role> — 0 when the role is on the denylist (or empty).
denied() {
  local x
  [ -z "$1" ] && return 0
  [[ "$1" == *orchestrator ]] && return 0
  for x in "${DENYLIST[@]}"; do
    [ "$1" = "$x" ] && return 0
  done
  return 1
}

# add_role <role> — append to the distinct, first-seen ordered list.
roles=()
add_role() {
  local x
  for x in "${roles[@]+"${roles[@]}"}"; do
    [ "$x" = "$1" ] && return 0
  done
  roles+=("$1")
}

# normalize_cell <cell> — apply the grammar's normalization and add each
# surviving piece.
normalize_cell() {
  local c="$1" piece
  lower "$c"
  c="$_LC"
  c="${c//\*/}"
  c="${c//\`/}"
  c="${c%%\(*}"
  c="${c//,/$'\n'}"
  c="${c//+/$'\n'}"
  c="${c//\//$'\n'}"
  c="${c// and /$'\n'}"
  while IFS= read -r piece; do
    trim "$piece"
    piece="$_T"
    # Italic markup is an EDGE underscore; an inner one is part of a name
    # (`mvvm_arch_agent`), and folding it would reach a different word.
    while [[ "$piece" == _* ]]; do piece="${piece#_}"; done
    while [[ "$piece" == *_ ]]; do piece="${piece%_}"; done
    piece="${piece#/}"
    piece="${piece% skill}"
    piece="${piece% agent}"
    if [[ "$piece" =~ ^(.*[^[:space:]])[[:space:]]+[x×][0-9]+$ ]]; then
      piece="${BASH_REMATCH[1]}"
    fi
    trim "$piece"
    piece="$_T"
    denied "$piece" && continue
    add_role "$piece"
  done <<< "$c"
}

# --- The single pass: find every Agent Log block, read its table rows ---------
log_found=0
in_log=0
log_level=0
in_fence=0
i=0
while [ "$i" -lt "$line_count" ]; do
  ln="${lines[$i]}"

  if [[ "$ln" =~ ^[[:space:]]*(\`\`\`|~~~) ]]; then
    # A table shown as an EXAMPLE inside a fence is documentation, not a log —
    # and a `#` line inside one is not a heading.
    in_fence=$(( 1 - in_fence ))
    i=$((i + 1))
    continue
  fi
  if [ "$in_fence" -eq 1 ]; then
    i=$((i + 1))
    continue
  fi

  scan_heading "$ln"
  if [ "$_LVL" -gt 0 ]; then
    if [ "$in_log" -eq 1 ] && [ "$_LVL" -le "$log_level" ]; then
      in_log=0
    fi
    if heading_is_log "$_HTEXT"; then
      in_log=1
      log_level=$_LVL
      log_found=1
    fi
    i=$((i + 1))
    continue
  fi

  if [ "$in_log" -eq 1 ] && [[ "$ln" =~ ^[[:space:]]*\| ]]; then
    row="${ln#"${ln%%[![:space:]]*}"}"
    row="${row#|}"
    # Separator row (`|---|:---:|`): nothing but -, :, | and spaces.
    sep="${row//-/}"
    sep="${sep//:/}"
    sep="${sep//|/}"
    sep="${sep// /}"
    if [ -z "$sep" ]; then
      i=$((i + 1))
      continue
    fi
    rest="${row#*|}"
    if [ "$rest" != "$row" ]; then
      cell="${rest%%|*}"
      normalize_cell "$cell"
    fi
  fi
  i=$((i + 1))
done

# --- Report --------------------------------------------------------------------
joined=""
for r in "${roles[@]+"${roles[@]}"}"; do
  if [ -z "$joined" ]; then
    joined="$r"
  else
    joined="$joined,$r"
  fi
done

if [ "$ROLES_ONLY" -eq 1 ]; then
  for r in "${roles[@]+"${roles[@]}"}"; do
    printf '%s\n' "$r"
  done
  exit 0
fi

if [ "$log_found" -eq 0 ]; then
  echo "AGENT-LOG $LABEL: VERDICT=NO_LOG roles="
elif [ "${#roles[@]}" -eq 0 ]; then
  echo "AGENT-LOG $LABEL: VERDICT=NO_ROWS roles="
else
  echo "AGENT-LOG $LABEL: VERDICT=OK roles=$joined"
fi
exit 0
