#!/bin/bash
set -euo pipefail

# Description: FR-268 authoring control over the four ceremony skills'
#   `igris ceremony start|stop --name <n>` call sites. A ceremony's cost is a
#   brain-timed start/stop pair written by a VERB; the skill's only obligation
#   is to CALL the verb as its first and last executable step. Skill prose has
#   no compiler, so this is the control that keeps that true (L-1314 — a rule
#   about prose is enforced by a validator over the prose, not by more prose).
#
#   A SITE is any line matching `igris ceremony (start|stop) --name <n>`.
#   Fenced blocks are NOT skipped: a call quoted inside a fence is still a
#   call someone will copy, so it carries the same obligations (the FR-267
#   posture).
#
#   Per skill (file, ceremony, anchors), ALL hard-fail:
#     (a) exactly ONE start and ONE stop site, both `--name <the file's
#         ceremony>`; a site naming another ceremony is a violation;
#     (b) the stop site is below the start site;
#     (c) the start site sits ABOVE the skill's first executable step and the
#         stop site BELOW its last one — anchored on headings / marker lines,
#         never on line numbers:
#           boot      start < first `igris detect` line;
#                     stop  > `### 7. Update Session`
#           rest      start < `### 1. Read Current Session`;
#                     stop  > `### 3. Update Session File` and < `### 4. Confirm REST MODE`
#           register  start < `### 1. Parse Arguments`;
#                     stop  > `### 7. Confirm Registration`
#           hunt      start > `### Phase 1: INIT` and < the first `igris_brief_get`
#                     line after it; stop > `**Instance State:**` and < `### Phase 2`
#     (d) no site line lands inside an `` `igris_agent_event` with: `` window
#         (the strictly-deeper-indented continuation lines after that mark —
#         the FR-267 site validator's rule), so a ceremony line can never be
#         read as an argument of an agent event.
#
# Usage: validate_ceremony_sites.sh [skills_dir]
#   skills_dir defaults to core/skills under the repo this script lives in and
#   must contain boot/SKILL.md, rest/SKILL.md, register/SKILL.md and
#   hunt/SKILL.md. The bats twin points it at a scratch copy of that tree.
#
# Exit: 0 (prints `OK: 4 skills, 8 sites`), 1 (prints `file:line -> reason`
#   per violation, then a FAIL summary), 2 (setup error: unreadable path).
#
# Wired into scripts/git-hooks/pre-commit (HARD-fail) when any of the four
# skills is staged. Portable to bash 3.2 (macOS /bin/bash); builtin-only
# per-line path; no `producer | grep -q` (TD-345).

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SKILLS_DIR="${1:-$REPO_ROOT/core/skills}"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "error: cannot read skills dir $SKILLS_DIR" >&2
  exit 2
fi

# Rule table, one entry per ceremony skill. Fields are pipe-separated:
#   dir|ceremony|start_below|start_above|stop_below|stop_above
# A marker is a literal substring; empty means "no bound on that side".
# `start_above` for hunt is resolved AFTER the `start_below` marker.
RULES=(
  'boot|boot||igris detect|### 7. Update Session|'
  'rest|rest||### 1. Read Current Session|### 3. Update Session File|### 4. Confirm REST MODE'
  'register|register||### 1. Parse Arguments|### 7. Confirm Registration|'
  'hunt|hunt-init|### Phase 1: INIT|igris_brief_get|**Instance State:**|### Phase 2'
)

AGENT_EVENT_MARK='`igris_agent_event` with:'

violations=0
total_sites=0
skills=0

# indent_of <line> — sets _IND to the count of leading whitespace characters.
_IND=0
indent_of() {
  local s="$1"
  local t="${s#"${s%%[![:space:]]*}"}"
  _IND=$(( ${#s} - ${#t} ))
}

# first_line_with <needle> <from_index> — sets _LINE to the 1-based number of
# the first line at index >= from_index containing needle, or 0.
_LINE=0
first_line_with() {
  local needle="$1" from="$2" k
  _LINE=0
  k=$from
  while [ "$k" -lt "$n" ]; do
    if [[ "${lines[$k]}" == *"$needle"* ]]; then
      _LINE=$((k + 1))
      return 0
    fi
    k=$((k + 1))
  done
  return 0
}

violate() {
  echo "$1:$2 -> $3"
  violations=$((violations + 1))
}

for rule in "${RULES[@]}"; do
  IFS='|' read -r dir ceremony start_below start_above stop_below stop_above <<EOF_RULE
$rule
EOF_RULE
  file="$SKILLS_DIR/$dir/SKILL.md"
  if [ ! -r "$file" ]; then
    echo "error: cannot read $file" >&2
    exit 2
  fi
  skills=$((skills + 1))

  lines=()
  while IFS= read -r l || [ -n "$l" ]; do
    lines+=("$l")
  done < "$file"
  n=${#lines[@]}

  start_line=0
  stop_line=0
  start_count=0
  stop_count=0
  in_window=0
  window_ind=0
  i=0
  while [ "$i" -lt "$n" ]; do
    ln="${lines[$i]}"
    lineno=$((i + 1))

    # (d) track the agent-event window the FR-267 way.
    if [ "$in_window" -eq 1 ]; then
      if [ -z "${ln//[[:space:]]/}" ]; then
        in_window=0
      else
        indent_of "$ln"
        if [ "$_IND" -le "$window_ind" ]; then
          in_window=0
        fi
      fi
    fi

    if [[ "$ln" =~ igris\ ceremony\ (start|stop)\ --name\ ([A-Za-z0-9_-]+) ]]; then
      action="${BASH_REMATCH[1]}"
      name="${BASH_REMATCH[2]}"
      total_sites=$((total_sites + 1))
      if [ "$in_window" -eq 1 ]; then
        violate "$file" "$lineno" "ceremony $action site sits inside an \`igris_agent_event\` window (indent it to top level)"
      fi
      if [ "$name" != "$ceremony" ]; then
        violate "$file" "$lineno" "site names ceremony '$name' but this skill's ceremony is '$ceremony'"
      elif [ "$action" = "start" ]; then
        start_count=$((start_count + 1))
        [ "$start_line" -eq 0 ] && start_line=$lineno
      else
        stop_count=$((stop_count + 1))
        stop_line=$lineno
      fi
    fi

    if [[ "$ln" == *"$AGENT_EVENT_MARK"* ]]; then
      indent_of "$ln"
      window_ind=$_IND
      in_window=1
    fi
    i=$((i + 1))
  done

  # (a) exactly one of each.
  if [ "$start_count" -eq 0 ]; then
    violate "$file" 0 "no start site (expected one \`igris ceremony start --name $ceremony\`)"
  elif [ "$start_count" -gt 1 ]; then
    violate "$file" "$start_line" "$start_count start sites (expected exactly one)"
  fi
  if [ "$stop_count" -eq 0 ]; then
    violate "$file" 0 "no stop site (expected one \`igris ceremony stop --name $ceremony\`)"
  elif [ "$stop_count" -gt 1 ]; then
    violate "$file" "$stop_line" "$stop_count stop sites (expected exactly one)"
  fi

  # (b) + (c) only when both sites exist — a missing site is already reported.
  if [ "$start_count" -ge 1 ] && [ "$stop_count" -ge 1 ]; then
    if [ "$stop_line" -le "$start_line" ]; then
      violate "$file" "$stop_line" "stop site is not below the start site (line $start_line)"
    fi

    from=0
    if [ -n "$start_below" ]; then
      first_line_with "$start_below" 0
      if [ "$_LINE" -eq 0 ]; then
        violate "$file" 0 "anchor '$start_below' not found"
      else
        [ "$start_line" -le "$_LINE" ] && violate "$file" "$start_line" "start site must be below '$start_below' (line $_LINE)"
        from=$_LINE
      fi
    fi
    if [ -n "$start_above" ]; then
      first_line_with "$start_above" "$from"
      if [ "$_LINE" -eq 0 ]; then
        violate "$file" 0 "anchor '$start_above' not found"
      elif [ "$start_line" -ge "$_LINE" ]; then
        violate "$file" "$start_line" "start site must be above the first '$start_above' line (line $_LINE) — the ceremony's first executable step"
      fi
    fi
    if [ -n "$stop_below" ]; then
      first_line_with "$stop_below" 0
      if [ "$_LINE" -eq 0 ]; then
        violate "$file" 0 "anchor '$stop_below' not found"
      elif [ "$stop_line" -le "$_LINE" ]; then
        violate "$file" "$stop_line" "stop site must be below '$stop_below' (line $_LINE) — the ceremony's last executable step"
      fi
    fi
    if [ -n "$stop_above" ]; then
      first_line_with "$stop_above" 0
      if [ "$_LINE" -eq 0 ]; then
        violate "$file" 0 "anchor '$stop_above' not found"
      elif [ "$stop_line" -ge "$_LINE" ]; then
        violate "$file" "$stop_line" "stop site must be above '$stop_above' (line $_LINE)"
      fi
    fi
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "FAIL: $skills skills, $total_sites sites, $violations violation(s) under $SKILLS_DIR"
  exit 1
fi

echo "OK: $skills skills, $total_sites sites"
exit 0
