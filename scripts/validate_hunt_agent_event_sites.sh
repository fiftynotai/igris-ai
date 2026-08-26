#!/bin/bash
set -euo pipefail

# Description: FR-267 derivation guard over the hunt skill's `igris_agent_event`
#   call sites. The gateway now REQUIRES `model_requested` on every call, and
#   the brain OWNS `duration_ms` and `round` (it computes both; a call passing
#   `duration_ms` is rejected by additionalProperties:false). Skill prose has
#   no compiler, so this is the control that keeps the carrier honest:
#
#   A SITE is a line containing `` `igris_agent_event` with: `` — the literal
#   shape every call in core/skills/hunt/SKILL.md uses. Its WINDOW is the
#   following strictly-deeper-indented, non-blank lines (the continuation rule
#   scripts/validate_skill_required_args.py established in TD-324): a blank
#   line, or a line at the site's own indent or shallower, closes it.
#
#   Assertions, ALL hard-fail:
#     (a) every window names instance_id, agent, event_type and
#         model_requested as an ARGUMENT (`- key:` / `key:`, never a bare
#         word — "this agent" in a placeholder is not `agent:`);
#     (b) no window passes duration_ms or round (`key:` or `key=`);
#     (c) the set of agents named in START windows covers architect, forger,
#         sentinel, warden, document and mender — the roles the Agent Log
#         names and the commit-msg event gate therefore demands;
#     (d) at least 13 sites exist (12 phase sites + the mender pair minus
#         one, the floor the FR-267 plan fixed) — a rewrite that drops sites
#         must move this floor on purpose.
#
#   Fenced blocks are NOT skipped: a call quoted inside a fence is still a
#   call someone will copy, so it carries the same obligations.
#
# Usage: validate_hunt_agent_event_sites.sh [path]
#   path defaults to core/skills/hunt/SKILL.md under the repo this script
#   lives in. The bats twin points it at mutated scratch copies.
#
# Exit: 0 (prints `OK: <n> sites`), 1 (prints each offending site line
#   number and the rule it breaks), 2 (setup error: unreadable path).
#
# Wired into scripts/git-hooks/pre-commit when core/skills/hunt/SKILL.md or
# brain-mcp-server/src/engine/components/instances/index.ts is staged.
# Portable to bash 3.2 (macOS /bin/bash); builtin-only per-line path.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET="${1:-$REPO_ROOT/core/skills/hunt/SKILL.md}"

if [ ! -r "$TARGET" ]; then
  echo "error: cannot read $TARGET" >&2
  exit 2
fi

REQUIRED=(instance_id agent event_type model_requested)
FORBIDDEN=(duration_ms round)
EXPECTED_START_AGENTS=(architect forger sentinel warden document mender)
MIN_SITES=13
SITE_MARK='`igris_agent_event` with:'

lines=()
while IFS= read -r l; do
  lines+=("$l")
done < "$TARGET"
n=${#lines[@]}

# indent_of <line> — sets _IND to the count of leading whitespace characters.
_IND=0
indent_of() {
  local s="$1"
  local t="${s#"${s%%[![:space:]]*}"}"
  _IND=$(( ${#s} - ${#t} ))
}

sites=0
violations=0
start_agents=" "
i=0
while [ "$i" -lt "$n" ]; do
  ln="${lines[$i]}"
  if [[ "$ln" != *"$SITE_MARK"* ]]; then
    i=$((i + 1))
    continue
  fi

  sites=$((sites + 1))
  site_no=$((i + 1))
  indent_of "$ln"
  site_ind=$_IND

  window=""
  j=$((i + 1))
  while [ "$j" -lt "$n" ]; do
    nxt="${lines[$j]}"
    if [ -z "${nxt//[[:space:]]/}" ]; then
      break
    fi
    indent_of "$nxt"
    if [ "$_IND" -le "$site_ind" ]; then
      break
    fi
    window+="$nxt"$'\n'
    j=$((j + 1))
  done

  for k in "${REQUIRED[@]}"; do
    if ! [[ "$window" =~ (^|[^A-Za-z0-9_])$k[[:space:]]*: ]]; then
      echo "line $site_no: window does not name '$k' as an argument"
      violations=$((violations + 1))
    fi
  done

  for k in "${FORBIDDEN[@]}"; do
    if [[ "$window" =~ (^|[^A-Za-z0-9_])$k[[:space:]]*[:=] ]]; then
      echo "line $site_no: window passes '$k' — brain-derived, never a caller argument"
      violations=$((violations + 1))
    fi
  done

  if [[ "$window" =~ event_type[[:space:]]*:[[:space:]]*\"start\" ]]; then
    if [[ "$window" =~ (^|[^A-Za-z0-9_])agent[[:space:]]*:[[:space:]]*\"([a-z][a-z_-]*)\" ]]; then
      start_agents+="${BASH_REMATCH[2]} "
    else
      echo "line $site_no: start window names no quoted agent"
      violations=$((violations + 1))
    fi
  fi

  i=$j
done

for a in "${EXPECTED_START_AGENTS[@]}"; do
  if [[ "$start_agents" != *" $a "* ]]; then
    echo "no start site names agent \"$a\" (start windows name:${start_agents% })"
    violations=$((violations + 1))
  fi
done

if [ "$sites" -lt "$MIN_SITES" ]; then
  echo "only $sites sites found — fewer than the $MIN_SITES floor (move MIN_SITES on purpose, never by accident)"
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo "FAIL: $sites sites, $violations violation(s) in $TARGET"
  exit 1
fi

echo "OK: $sites sites"
exit 0
