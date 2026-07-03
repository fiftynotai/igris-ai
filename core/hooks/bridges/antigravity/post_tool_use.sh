#!/bin/bash

# Description: Antigravity (`agy`) PostToolUse hook bridge for the Igris hook layer.
#              Translates antigravity's PostToolUse stdin payload to the Igris
#              unified shape, fans it out to shared/post_tool_use.sh (the lint
#              dispatcher), and ALWAYS emits {"decision":"allow"} — PostToolUse is
#              fire-and-forget bookkeeping (R2: it never blocks; the post
#              dispatcher is fan-out lint, never a gate).
# Usage: Registered in ~/.gemini/config/hooks.json under PostToolUse → this path.
#        Reads JSON from stdin (NOT argv).
# Dependencies: python3 (no jq); bash.
# Exit codes:
#   0 - Always (hooks must never fail).
#
# Antigravity payload shape: same envelope as the PreToolUse bridge
#   ({ toolCall:{name,args}, workspacePaths:[...] }). The post dispatcher does not
#   gate, so the unified translation here is best-effort (the lint handlers read
#   what they can from the unified payload).

set -e

SHARED_DIR="${IGRIS_SHARED_DIR:-$HOME/.igris/core/hooks/shared}"

INPUT=$(cat 2>/dev/null || true)

build_unified() {
  ANTIGRAVITY_IN="$INPUT" python3 - <<'PY' 2>/dev/null || echo '{"source":"antigravity","event":"post_tool_use","project_dir":"","payload":{"tool_name":"","tool_input":{"file_path":""}}}'
import json, os

raw = os.environ.get("ANTIGRAVITY_IN", "") or "{}"
try:
    p = json.loads(raw)
    if not isinstance(p, dict):
        p = {}
except Exception:
    p = {}

tool_call = p.get("toolCall") or {}
if not isinstance(tool_call, dict):
    tool_call = {}
name = tool_call.get("name") or ""
args = tool_call.get("args") or {}
if not isinstance(args, dict):
    args = {}

TOOL_MAP = {"write_to_file": "Write", "replace_file_content": "Edit"}
tool_name = TOOL_MAP.get(name, "")
file_path = args.get("TargetFile") or "" if tool_name else ""

workspaces = p.get("workspacePaths") or []
project_dir = ""
if isinstance(workspaces, list) and workspaces:
    project_dir = workspaces[0] or ""

unified = {
    "source": "antigravity",
    "event": "post_tool_use",
    "project_dir": project_dir,
    "payload": {"tool_name": tool_name, "tool_input": {"file_path": file_path}},
}
print(json.dumps(unified))
PY
}

main() {
  local unified
  unified=$(build_unified)
  # Fan out to the lint dispatcher; never block on its result (fire-and-forget).
  printf '%s' "$unified" | bash "$SHARED_DIR/post_tool_use.sh" > /dev/null 2>&1 || true
  # PostToolUse is always-allow (R2: never a gate).
  echo '{"decision":"allow"}'
  exit 0
}

main "$@" || { echo '{"decision":"allow"}'; exit 0; }
