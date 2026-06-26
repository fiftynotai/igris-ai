#!/usr/bin/env bash
#
# fr212-smoke.sh — FR-212d Phase 1: the 5-harness DELEGATE smoke gate.
#
# THE #832 CHOKEPOINT. This gate decides whether the custom skills/MCP placement
# engines may be RETIRED in favour of the pinned external `skills` + `add-mcp`
# delegates. It runs the delegate path (IGRIS_SKILLS_ENGINE=delegate +
# IGRIS_MCP_ENGINE=delegate) against a FRESH sandbox HOME + a fresh non-igris-ai
# project, forcing ALL 5 harness targets explicitly (no auto-detect), and asserts
# real per-harness coverage for:
#
#   1. Skills placed + discoverable   (per harness)
#   2. MCP server entry + no-prompt grant written, NO npx-wrap corruption (per harness)
#   3. remove -> zero dangling        (per harness)
#   4. Hook-gate: registered denies a no-brief write; unregistered allows + no nudge.
#
# It drives the REAL pinned binaries (skills@1.5.13 + add-mcp@1.11.0 resolved from
# the repo-root node_modules — NEVER a network `npx`) and the REAL Igris delegate
# code (the built cli/dist) so the verdict reflects production behaviour, not a
# stub. A FAILURE is a STOP signal (keep custom as default), NOT something to
# work around.
#
# Harnesses (skills agent id / Igris McpHarness id):
#   claude-code/claude · codex/codex · gemini-cli/gemini · opencode/opencode · antigravity/antigravity
#
# Usage:  bash cli/tests/integration/fr212-smoke.sh
# Exit:   0 = gate fully green (safe to retire custom); 1 = a gap (STOP).
#
# This script is PHASE-1 read-of-reality ONLY: it makes NO repo edits, NO commit,
# and does NOT flip any engine default. It pollutes ONLY a mktemp sandbox HOME
# (cleaned up on exit) — never the real ~/.claude/~/.agents/~/.codex/~/.gemini/
# ~/.config/opencode.
#
# bash-3.2-SAFE: macOS /bin/bash is 3.2.57 (no `declare -A`). This harness uses
# NO associative arrays and a case-based per-harness lookup, exactly like the
# bash-3.2 hook scripts it lives beside. `set -u` array reads are guarded.

set -uo pipefail

# ---------------------------------------------------------------------------
# Locations (all absolute — agent cwd resets between calls).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
CLI="$REPO_ROOT/cli/dist/index.js"
SKILLS_BIN="$REPO_ROOT/node_modules/.bin/skills"
ADDMCP_BIN="$REPO_ROOT/node_modules/.bin/add-mcp"
BRAIN_ENTRY="$REPO_ROOT/cli/dist/brain-mcp-server/dist/index.js"
BRAIN_BASENAME="$(basename "$BRAIN_ENTRY")"

REAL_HOME="$HOME"

# The 5 harnesses (skills/add-mcp agent ids).
HARNESSES="claude-code codex gemini-cli opencode antigravity"

# Per-harness lookups (bash-3.2: case fns, not associative arrays).
# skills-agent-id -> igris McpHarness id.
mcp_id() {
  case "$1" in
    claude-code) echo claude ;; codex) echo codex ;; gemini-cli) echo gemini ;;
    opencode) echo opencode ;; antigravity) echo antigravity ;;
  esac
}
# skills-agent-id -> the read-path of its `boot` skill under $HOME.
skill_read_path() {
  if [ "$1" = "claude-code" ]; then echo "$2/.claude/skills/boot"; else echo "$2/.agents/skills/boot"; fi
}
# igris McpHarness id -> "READPATH|MAPKEY|ISTOML" of its MCP server ENTRY ($HOME=$1).
mcp_entry_spec() {
  local home="$1" mh="$2"
  case "$mh" in
    claude)      echo "$home/.claude.json|mcpServers|0" ;;
    gemini)      echo "$home/.gemini/settings.json|mcpServers|0" ;;
    opencode)    echo "$home/.config/opencode/opencode.json|mcp|0" ;;
    codex)       echo "$home/.codex/config.toml|mcp_servers|1" ;;
    antigravity) echo "$home/.gemini/config/mcp_config.json|mcpServers|0" ;;
  esac
}

# ---------------------------------------------------------------------------
# Result store (bash-3.2: a flat newline list of "KEY\tVALUE").
# ---------------------------------------------------------------------------
RESULTS=""
GAPS=""
set_result() { RESULTS="${RESULTS}${1}	${2}"$'\n'; }
get_result() {
  local line; line="$(printf '%s' "$RESULTS" | grep -F "$1	" | head -1)"
  if [ -n "$line" ]; then printf '%s' "${line#*	}"; else printf 'N/A'; fi
}
note_gap() { GAPS="${GAPS}${1}"$'\n'; }
pass() { set_result "$1:$2" "PASS"; }
fail() { set_result "$1:$2" "FAIL"; note_gap "[$1] check $2 — $3"; }

# ---------------------------------------------------------------------------
# Pre-flight: tools + build present (a missing prerequisite is itself a STOP).
# ---------------------------------------------------------------------------
preflight() {
  local ok=1 f
  for f in "$CLI" "$SKILLS_BIN" "$ADDMCP_BIN" "$BRAIN_ENTRY"; do
    [ -e "$f" ] || { echo "PREFLIGHT FAIL: missing $f"; ok=0; }
  done
  local sv av
  sv="$(node -e "console.log(require('$REPO_ROOT/node_modules/skills/package.json').version)" 2>/dev/null)"
  av="$(node -e "console.log(require('$REPO_ROOT/node_modules/add-mcp/package.json').version)" 2>/dev/null)"
  echo "skills binary  : $SKILLS_BIN (v$sv)"
  echo "add-mcp binary : $ADDMCP_BIN (v$av)"
  [ "$sv" = "1.5.13" ] || echo "PREFLIGHT WARN: skills expected 1.5.13, got '$sv'"
  [ "$av" = "1.11.0" ] || echo "PREFLIGHT WARN: add-mcp expected 1.11.0, got '$av'"
  [ "$ok" = 1 ] || exit 2
}

make_sandbox() { cd "$(mktemp -d "${TMPDIR:-/tmp}/fr212smoke.XXXXXX")" && pwd -P; }

# ===========================================================================
# CHECK 1 — Skills placed + discoverable, per harness.
# ===========================================================================
check1_skills() {
  local home="$1" src="$2"
  echo
  echo "### CHECK 1 — skills placed + discoverable (delegate: \`skills add -g -a <5>\`)"
  local out
  out="$(cd "$home" && HOME="$home" IGRIS_SKILLS_ENGINE=delegate \
        node "$CLI" registry project-skills --source "$src" 2>&1)"
  echo "--- igris registry project-skills (delegate) output ---"
  printf '%s\n' "$out" | sed "s#$home#\$HOME#g" | grep -vE '^[[:space:]]*$' | head -26

  local list_json
  list_json="$(HOME="$home" "$SKILLS_BIN" list -g --json 2>/dev/null)"
  echo "--- skills list -g --json ---"
  printf '%s\n' "$list_json" | sed "s#$home#\$HOME#g"
  local listed="no"
  if printf '%s' "$list_json" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(s.get('name')=='boot' for s in d) else 1)" 2>/dev/null; then
    listed="yes"
  fi

  local h read_path
  for h in $HARNESSES; do
    read_path="$(skill_read_path "$h" "$home")/SKILL.md"
    if [ -e "$read_path" ] && [ "$listed" = "yes" ]; then
      pass "$h" 1
    elif [ -e "$read_path" ]; then
      fail "$h" 1 "skill file present at ${read_path/$home/\$HOME} but \`skills list --json\` did not list 'boot'"
    else
      fail "$h" 1 "skill NOT present at read-path ${read_path/$home/\$HOME}"
    fi
  done
}

# ===========================================================================
# CHECK 2 — MCP server entry + no-prompt grant + canonical (non-npx) launch.
# ===========================================================================
check2_mcp() {
  local home="$1" proj="$2"
  echo
  echo "### CHECK 2 — MCP server entry + no-prompt grant (delegate: \`add-mcp\` + Igris grant)"
  local reg_json
  reg_json="$(HOME="$home" node --input-type=module -e "
import { registerBrainAcrossHarnesses } from '$REPO_ROOT/cli/dist/lib/mcp-register.js';
const res = registerBrainAcrossHarnesses({ folder: '$proj' }, { engine: 'delegate' });
console.log(JSON.stringify(res.map(r => ({
  harness: r.harness, engine: r.engine, outcome: r.result.outcome,
  err: r.result.error || null,
  grant: r.grant ? { outcome: r.grant.outcome, path: r.grant.path } : null,
}))));
" 2>/dev/null)"
  echo "--- registerBrainAcrossHarnesses(engine=delegate) per-harness verdict ---"
  printf '%s' "$reg_json" | python3 -m json.tool 2>/dev/null | sed "s#$home#\$HOME#g"

  local h mh spec epath ekey etoml launch entry_ok launch_ok grant_ok goutcome detail
  for h in $HARNESSES; do
    mh="$(mcp_id "$h")"
    spec="$(mcp_entry_spec "$home" "$mh")"
    epath="${spec%%|*}"; spec="${spec#*|}"; ekey="${spec%%|*}"; etoml="${spec#*|}"
    entry_ok=0; launch_ok=0; detail=""

    if [ -f "$epath" ]; then
      if [ "$etoml" = 1 ]; then
        launch="$(python3 - "$epath" "$ekey" <<'PY' 2>/dev/null
import sys
try:
    import tomllib
    d=tomllib.load(open(sys.argv[1],'rb'))
except Exception:
    d={}
srv=d.get(sys.argv[2],{}).get('igris-brain',{})
cmd=srv.get('command',''); args=srv.get('args',[])
if isinstance(args,str): args=[args]
print((str(cmd)+' '+' '.join(map(str,args))).strip())
PY
)"
      else
        launch="$(python3 - "$epath" "$ekey" <<'PY' 2>/dev/null
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    d={}
srv=d.get(sys.argv[2],{}).get('igris-brain',{})
cmd=srv.get('command',''); args=srv.get('args',[])
if isinstance(cmd,list):
    parts=cmd
else:
    parts=[cmd]+(args if isinstance(args,list) else [args])
print(' '.join(map(str,parts)).strip())
PY
)"
      fi
      if [ -n "$launch" ]; then
        entry_ok=1
        if printf '%s' "$launch" | grep -qE '(^|[[:space:]])npx([[:space:]]|$)'; then
          launch_ok=0
          detail="launch is npx-wrapped ('$launch') — add-mcp treats command 'node' as an npx package -> runtime network fetch -> broken brain + violates the no-runtime-npx pin (constraint #2)"
        elif printf '%s' "$launch" | grep -q "node .*$BRAIN_BASENAME"; then
          launch_ok=1
        else
          launch_ok=0; detail="unexpected launch spec ('$launch')"
        fi
      else
        detail="entry file present at ${epath/$home/\$HOME} but no igris-brain server block found"
      fi
    else
      detail="MCP server entry MISSING at the harness read-path ${epath/$home/\$HOME} (add-mcp did not write where Igris/the harness reads MCP)"
    fi

    grant_ok=0
    goutcome="$(printf '%s' "$reg_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((r['grant']['outcome'] for r in d if r['harness']=='$mh' and r.get('grant')), 'none'))" 2>/dev/null)"
    case "$goutcome" in granted|unchanged|covered) grant_ok=1 ;; esac

    if [ "$entry_ok" = 1 ] && [ "$launch_ok" = 1 ] && [ "$grant_ok" = 1 ]; then
      pass "$h" 2
    else
      local why=""
      [ "$entry_ok" = 1 ] || why="server-entry: $detail"
      [ "$entry_ok" = 1 ] && [ "$launch_ok" = 0 ] && why="launch: $detail"
      [ "$grant_ok" = 1 ] || why="${why:+$why; }grant outcome=$goutcome (expected granted/unchanged/covered)"
      fail "$h" 2 "$why"
    fi
  done
}

# ===========================================================================
# CHECK 3 — remove -> zero dangling, per harness.
# ===========================================================================
check3_remove() {
  local home="$1" proj="$2"
  echo
  echo "### CHECK 3 — remove leaves zero dangling (delegate inverse)"

  echo "--- igris registry unproject-skills --name boot (delegate -> skills remove) ---"
  HOME="$home" IGRIS_SKILLS_ENGINE=delegate node "$CLI" registry unproject-skills --name boot 2>&1 \
    | sed "s#$home#\$HOME#g" | grep -vE '^[[:space:]]*$' | head -12

  echo "--- delegate MCP un-registration + grant revoke (all 5, production-symmetric) ---"
  # FR-212d: drive the SAME production removal path the verb uses
  # (unregisterBrainAcrossHarnesses) — it carves out antigravity to the custom
  # un-merger (add-mcp remove targets the wrong antigravity/ path) so the
  # custom-written config/ entry is actually removed, not orphaned.
  HOME="$home" node --input-type=module -e "
import { unregisterBrainAcrossHarnesses } from '$REPO_ROOT/cli/dist/lib/mcp-register.js';
const res = unregisterBrainAcrossHarnesses({ harnesses: ['claude','gemini','codex','opencode','antigravity'], folder: '$proj' }, { engine: 'delegate' });
for (const r of res) {
  console.log('unregister', r.harness, r.result.outcome, '| revoke', r.grant ? r.grant.outcome : 'none');
}
" 2>/dev/null | sed "s#$home#\$HOME#g"

  local h mh spec epath ekey etoml skill_path dangle present gpresent
  for h in $HARNESSES; do
    mh="$(mcp_id "$h")"; dangle=""
    skill_path="$(skill_read_path "$h" "$home")"
    if [ -e "$skill_path" ] || [ -L "$skill_path" ]; then
      dangle="skill link/dir still present at ${skill_path/$home/\$HOME}"
    fi
    if [ -z "$dangle" ]; then
      spec="$(mcp_entry_spec "$home" "$mh")"
      epath="${spec%%|*}"; spec="${spec#*|}"; ekey="${spec%%|*}"; etoml="${spec#*|}"
      if [ -f "$epath" ]; then
        if [ "$etoml" = 1 ]; then
          present="$(python3 -c "import sys
try:
    import tomllib; d=tomllib.load(open('$epath','rb'))
except Exception: d={}
print('yes' if 'igris-brain' in d.get('$ekey',{}) else 'no')" 2>/dev/null)"
        else
          present="$(python3 -c "import json
try: d=json.load(open('$epath'))
except Exception: d={}
print('yes' if 'igris-brain' in d.get('$ekey',{}) else 'no')" 2>/dev/null)"
        fi
        [ "$present" = "yes" ] && dangle="orphan MCP server entry left in ${epath/$home/\$HOME}"
      fi
    fi
    if [ -z "$dangle" ]; then
      gpresent="$(HOME="$home" node --input-type=module -e "
import { verifyBrainGrant } from '$REPO_ROOT/cli/dist/lib/mcp-grant.js';
console.log(verifyBrainGrant('$mh', { folder: '$proj' }) ? 'yes':'no');
" 2>/dev/null)"
      if [ "$gpresent" = "yes" ] && [ "$mh" != "opencode" ]; then
        dangle="orphan no-prompt grant still present for $mh"
      fi
    fi
    # No blind spot: also sweep add-mcp's ACTUAL (non-read-path) antigravity write
    # location — add-mcp writes antigravity's entry to .gemini/antigravity/ (NOT
    # the .gemini/config/ read-path), so an orphan there must also be caught.
    if [ -z "$dangle" ] && [ "$mh" = "antigravity" ] && [ -f "$home/.gemini/antigravity/mcp_config.json" ]; then
      present="$(python3 -c "import json
try: d=json.load(open('$home/.gemini/antigravity/mcp_config.json'))
except Exception: d={}
print('yes' if 'igris-brain' in d.get('mcpServers',{}) else 'no')" 2>/dev/null)"
      [ "$present" = "yes" ] && dangle="orphan MCP entry left in add-mcp's actual write path \$HOME/.gemini/antigravity/mcp_config.json"
    fi
    if [ -z "$dangle" ]; then pass "$h" 3; else fail "$h" 3 "$dangle"; fi
  done
}

# ===========================================================================
# CHECK 4 — Hook-gate (registered deny no-brief / unregistered no-op).
# ===========================================================================
check4_hookgate() {
  echo
  echo "### CHECK 4 — hook-gate (registered deny no-brief / unregistered no-op)"
  local PTU="$REPO_ROOT/core/hooks/shared/pre_tool_use.sh"
  local SST="$REPO_ROOT/core/hooks/shared/session_start.sh"
  local SB FAKEHOME DB REG UNREG
  SB="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/fr212gate.XXXXXX")" && pwd -P)"
  FAKEHOME="$SB/fakehome"; mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  sqlite3 "$DB" "
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, tech_stack TEXT, igris_version TEXT,
      status TEXT DEFAULT 'active', registered_at TEXT, last_session_at TEXT, metadata TEXT);
    CREATE TABLE brief_status (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT, effort TEXT, phase TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  "
  REG="$SB/registered-proj"; mkdir -p "$REG/src"
  UNREG="$SB/random-proj";   mkdir -p "$UNREG/src"
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('registered-proj','registered-proj','$REG');"

  local out_reg out_unreg out_sst out_sst_reg
  out_reg="$(printf '%s' "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REG/src/foo.ts\"},\"project_dir\":\"$REG\"}" \
    | HOME="$FAKEHOME" bash "$PTU" 2>&1)"
  echo "--- 4a registered, no brief (expect deny) ---"
  printf '%s\n' "$out_reg" | sed "s#$SB#\$SB#g" | head -6
  if printf '%s' "$out_reg" | grep -q "permissionDecision"; then
    set_result "hookgate:reg_deny" "PASS"
  else
    set_result "hookgate:reg_deny" "FAIL"; note_gap "[hook-gate] registered project with no brief did NOT deny the write"
  fi

  out_unreg="$(printf '%s' "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$UNREG/src/foo.ts\"},\"project_dir\":\"$UNREG\"}" \
    | HOME="$FAKEHOME" bash "$PTU" 2>&1)"
  echo "--- 4b unregistered (expect allow, no deny) ---"
  printf '%s\n' "${out_unreg:-<empty>}" | sed "s#$SB#\$SB#g" | head -6
  if printf '%s' "$out_unreg" | grep -q "permissionDecision"; then
    set_result "hookgate:unreg_allow" "FAIL"; note_gap "[hook-gate] unregistered project write was DENIED (global misfire)"
  else
    set_result "hookgate:unreg_allow" "PASS"
  fi

  out_sst="$(printf '%s' "{\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"project_dir\":\"$UNREG\"}" \
    | HOME="$FAKEHOME" bash "$SST" 2>/dev/null)"
  echo "--- 4c unregistered session_start (expect empty additionalContext, no /boot nudge) ---"
  printf '%s\n' "${out_sst:-<empty>}" | sed "s#$SB#\$SB#g" | head -4
  if printf '%s' "$out_sst" | grep -qE "IGRIS SESSION STATE|AUTO-BOOT|/boot"; then
    set_result "hookgate:unreg_nonudge" "FAIL"; note_gap "[hook-gate] unregistered session_start injected Igris context/nudge"
  else
    set_result "hookgate:unreg_nonudge" "PASS"
  fi

  sqlite3 "$DB" "INSERT INTO brief_status (project,brief_id,title,status) VALUES ('registered-proj','SMK-1','t','In Progress');"
  out_sst_reg="$(printf '%s' "{\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"project_dir\":\"$REG\"}" \
    | HOME="$FAKEHOME" bash "$SST" 2>/dev/null)"
  echo "--- 4d registered session_start (expect Igris context present) ---"
  printf '%s\n' "${out_sst_reg:-<empty>}" | sed "s#$SB#\$SB#g" | head -4
  if printf '%s' "$out_sst_reg" | grep -qE "IGRIS SESSION STATE|AUTO-BOOT|additionalContext"; then
    set_result "hookgate:reg_inject" "PASS"
  else
    set_result "hookgate:reg_inject" "FAIL"; note_gap "[hook-gate] registered session_start did NOT inject Igris context"
  fi

  rm -rf "$SB"
}

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------
cell() { if [ "$(get_result "$1:$2")" = "PASS" ]; then printf '  PASS '; else printf '  FAIL '; fi; }
report() {
  echo
  echo "==========================================================================="
  echo "FR-212d SMOKE GATE — per-harness x per-check matrix (delegate engine)"
  echo "==========================================================================="
  printf '%-14s | %-6s | %-6s | %-6s\n' "harness" "skills" "mcp" "remove"
  printf '%s-+-%s-+-%s-+-%s\n' "--------------" "------" "------" "------"
  local h
  for h in $HARNESSES; do
    printf '%-14s |%s|%s|%s\n' "$h" "$(cell "$h" 1)" "$(cell "$h" 2)" "$(cell "$h" 3)"
  done
  echo
  echo "Hook-gate (registered/unregistered):"
  printf '  registered + no brief  -> deny write      : %s\n' "$(get_result hookgate:reg_deny)"
  printf '  unregistered           -> allow write      : %s\n' "$(get_result hookgate:unreg_allow)"
  printf '  unregistered           -> no session nudge : %s\n' "$(get_result hookgate:unreg_nonudge)"
  printf '  registered + brief     -> inject context   : %s\n' "$(get_result hookgate:reg_inject)"
  echo

  # Count NON-BLANK gap lines. bash-3.2-safe + correct on EMPTY input: a naive
  # `grep -cvE … || echo 0` double-appends a second "0" when GAPS is empty
  # (grep -c prints 0 AND exits 1 on no-match, so the `|| echo 0` fires too),
  # yielding "0\n0" which fails `= 0` and reports a FALSE gap. Filter the blank
  # lines first, then count with `wc -l`, then strip whitespace → a single int.
  local gaps_trimmed
  gaps_trimmed="$(printf '%s' "$GAPS" | grep -vE '^[[:space:]]*$' | wc -l | tr -d '[:space:]')"
  [ -n "$gaps_trimmed" ] || gaps_trimmed=0
  if [ "$gaps_trimmed" = 0 ]; then
    echo "VERDICT: GATE FULLY GREEN across all 5 harnesses + hook-gate."
    echo "         -> safe to retire the custom skills/MCP engines (FR-212d Phase 2)."
    return 0
  else
    echo "VERDICT: GATE HAS GAP(S) — the #832 recurrence. STOP: keep custom as default."
    echo "Gaps (exact harness + check + failure):"
    printf '%s' "$GAPS" | grep -vE '^[[:space:]]*$' | sed 's/^/  - /'
    return 1
  fi
}

# ---------------------------------------------------------------------------
main() {
  echo "FR-212d 5-harness DELEGATE smoke gate"
  echo "repo: $REPO_ROOT"
  echo "bash: $BASH_VERSION"
  preflight

  local SANDBOX HOME_SB PROJ SRC
  SANDBOX="$(make_sandbox)"
  HOME_SB="$SANDBOX/home"
  PROJ="$SANDBOX/freshproj"
  SRC="$SANDBOX/skill-src"
  mkdir -p "$HOME_SB" "$PROJ/src" "$SRC/boot"
  printf -- '---\nname: boot\ndescription: FR-212d smoke skill\n---\n# Boot\nsmoke.\n' > "$SRC/boot/SKILL.md"
  echo "sandbox HOME    : $HOME_SB"
  echo "fresh project   : $PROJ"
  echo "skills source   : $SRC"
  [ "$HOME_SB" != "$REAL_HOME" ] || { echo "FATAL: sandbox HOME == real HOME"; exit 2; }

  check1_skills "$HOME_SB" "$SRC"
  check2_mcp    "$HOME_SB" "$PROJ"
  check3_remove "$HOME_SB" "$PROJ"
  check4_hookgate

  local rc=0
  report || rc=1
  rm -rf "$SANDBOX"
  return $rc
}

main "$@"
