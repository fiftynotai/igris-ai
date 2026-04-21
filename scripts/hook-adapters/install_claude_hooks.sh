#!/bin/bash

# Description: Merge Igris hook entries into a target project's .claude/settings.json.
#              Idempotent, non-destructive to unknown user entries.
#              Strategy:
#                1. Parse existing settings.json (preserve all unknown top-level keys).
#                2. For every hook event array, split entries into "Igris" (command
#                   prefix matches $HOME/.igris/core/hooks/) and "user" buckets.
#                3. Drop all Igris entries for the 6 portable events — they'll be
#                   rewritten fresh below.
#                4. Preserve user entries verbatim, in original order.
#                5. Append Igris entries for the 6 portable events pointing at
#                   shared bash scripts.
#                6. Write back atomically.
# Usage: install_claude_hooks.sh --project-dir=<path> [--shared-dir=<path>]
# Dependencies: python3, scripts/hook-adapters/_common.sh
# Exit codes:
#   0 - Success
#   1 - Error (invalid JSON, python failure)
#   2 - Usage error

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Portable events that map to shared scripts. Order matters for deterministic
# output ordering when the merge re-serializes.
# ---------------------------------------------------------------------------
PORTABLE_EVENTS=(SessionStart SessionEnd PreCompact PostCompact PreToolUse PostToolUse)

usage() {
  cat >&2 <<EOF
Usage: $0 --project-dir=<path> [--shared-dir=<path>]

Merge Igris hook entries into <project-dir>/.claude/settings.json.

Options:
  --project-dir=<path>  Target project root (must contain .claude/)
  --shared-dir=<path>   Shared scripts dir (default: \$HOME/.igris/core/hooks/shared)

Exit codes:
  0 - Success
  1 - Runtime error
  2 - Usage error
EOF
  exit 2
}

main() {
  local project_dir=""
  # Default literal — Claude Code expands $HOME at runtime. Callers may override
  # via --shared-dir=<absolute-or-literal> for test sandboxing.
  local shared_literal='$HOME/.igris/core/hooks/shared'

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-dir=*) project_dir="${1#--project-dir=}" ;;
      --shared-dir=*)  shared_literal="${1#--shared-dir=}" ;;
      -h|--help)       usage ;;
      *)
        echo "Error: Unknown argument '$1'" >&2
        usage
        ;;
    esac
    shift
  done

  # Environment override for tests.
  if [ -n "${IGRIS_SHARED_DIR:-}" ]; then
    shared_literal="$IGRIS_SHARED_DIR"
  fi

  if [ -z "$project_dir" ]; then
    echo "Error: --project-dir=<path> is required" >&2
    usage
  fi

  if [ ! -d "$project_dir" ]; then
    echo "Error: Project directory '$project_dir' does not exist" >&2
    exit 1
  fi

  local settings_file="$project_dir/.claude/settings.json"
  local existing_json
  existing_json=$(load_json_file "$settings_file")

  # Used inside the python heredoc as the literal path prefix for Igris commands.
  local igris_shared_literal="$shared_literal"

  # ---------------------------------------------------------------------------
  # Build the new hook-entries map as JSON via python3.
  # ---------------------------------------------------------------------------
  local merged
  merged=$(python3 - \
      "$existing_json" \
      "$igris_shared_literal" \
      "$IGRIS_HOOK_CMD_PREFIX" \
      "${PORTABLE_EVENTS[@]}" <<'PY'
import json, sys, re

existing_raw = sys.argv[1]
shared_literal = sys.argv[2]
igris_prefix = sys.argv[3]
portable_events = sys.argv[4:]

existing = json.loads(existing_raw) if existing_raw else {}
hooks = existing.get("hooks") or {}

# Pre-FR-104 Igris portable hooks lived in the project-local .claude/hooks/ dir.
# These exact filenames are legacy-Igris and should be stripped during migration
# so we don't leave dead references pointing at deleted scripts.
LEGACY_PORTABLE_FILENAMES = {
    "session_start.sh",
    "session_end.sh",
    "pre_compact.sh",
    "brief_gate.sh",           # old name for pre_tool_use.sh
    "post_edit_lint.sh",       # now post_tool_use.d/01-lint.sh
    "post_brief_sync.sh",      # now post_tool_use.d/02-brief-sync.sh
    "post_session_sync.sh",    # now post_tool_use.d/03-session-sync.sh
}

def command_is_legacy_portable(cmd: str) -> bool:
    """Matches '...claude/hooks/{legacy-portable-name}' (quoted or not, literal or
    expanded $CLAUDE_PROJECT_DIR prefix). Ignores other user-owned files in the
    same directory like agent_metrics.sh, teammate_idle_assign.sh, etc."""
    if not isinstance(cmd, str):
        return False
    m = re.search(r"\.claude/hooks/([A-Za-z0-9_.-]+)(?:\s|$|\")", cmd)
    if not m:
        return False
    return m.group(1) in LEGACY_PORTABLE_FILENAMES

def is_igris_entry(entry):
    """Entry is a group {matcher?, hooks: [{type, command|url, timeout?}, ...]}.
    An entry counts as Igris if *any* of its hook objects:
      (a) has a command starting with the shared-dir magic prefix, or
      (b) has a command pointing at a legacy portable .claude/hooks/ script."""
    sub = entry.get("hooks") if isinstance(entry, dict) else None
    if not isinstance(sub, list):
        return False
    for h in sub:
        if isinstance(h, dict):
            cmd = h.get("command")
            if not isinstance(cmd, str):
                continue
            if cmd.startswith(igris_prefix):
                return True
            if command_is_legacy_portable(cmd):
                return True
    return False

def strip_igris_from_event(event_list):
    """Given the list-of-groups for one event, drop any group that contains at
    least one Igris-owned hook object. In practice Igris always emits a group
    per entry (one hook per group, never mixed), so this only drops Igris-only
    groups. If a user hand-edits settings.json to combine an Igris command with
    their own commands inside a single hooks:[] array, the entire group — user
    hooks included — is dropped on re-sync; users should keep Igris and user
    hooks in separate groups. User-owned groups (no Igris hooks at all) are
    preserved verbatim in their original order."""
    if not isinstance(event_list, list):
        return []
    return [g for g in event_list if not is_igris_entry(g)]

# Strip Igris entries from portable events only. Claude-only events
# (SubagentStop, Stop, etc.) are untouched — they never contain Igris prefixes.
for event in portable_events:
    hooks[event] = strip_igris_from_event(hooks.get(event, []))

# Append the fresh Igris entries in the plan-documented shape. Each Igris entry
# is a separate *group* (so it can be identified as Igris-owned on re-run).
def igris_cmd(script_name):
    return f"{shared_literal}/{script_name}"

igris_map = {
    "SessionStart": [
        {"hooks": [{"type": "command", "command": igris_cmd("session_start.sh")}]}
    ],
    "SessionEnd": [
        {"hooks": [{"type": "command", "command": igris_cmd("session_end.sh")}]}
    ],
    "PreCompact": [
        {"hooks": [{"type": "command", "command": igris_cmd("pre_compact.sh")}]}
    ],
    "PostCompact": [
        {"hooks": [{"type": "command", "command": igris_cmd("post_compact.sh")}]}
    ],
    "PreToolUse": [
        {
            "matcher": "Write|Edit",
            "hooks": [
                {"type": "command", "command": igris_cmd("pre_tool_use.sh")}
            ],
        }
    ],
    "PostToolUse": [
        {
            "matcher": "Write|Edit",
            "hooks": [
                {
                    "type": "command",
                    "command": igris_cmd("post_tool_use.sh"),
                    "timeout": 20,
                }
            ],
        }
    ],
}

for event, igris_entries in igris_map.items():
    user_entries = hooks.get(event, [])
    # Igris entries go first so they run in a predictable order. User entries
    # preserved as-is afterwards.
    hooks[event] = list(igris_entries) + list(user_entries)

existing["hooks"] = hooks
print(json.dumps(existing))
PY
  )

  # Validate and atomically write.
  write_json_file_atomic "$settings_file" "$merged"

  echo "[claude-hooks] merged Igris hook entries into $settings_file"
}

main "$@"
