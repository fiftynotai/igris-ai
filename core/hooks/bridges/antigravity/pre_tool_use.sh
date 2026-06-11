#!/bin/bash

# Description: Antigravity (`agy`) PreToolUse hook bridge for the Igris hook layer.
#              Antigravity invokes this with its hook payload on STDIN (gemini-cli
#              hook format) and RESPECTS the script's stdout `{decision}` verdict —
#              `deny` BLOCKS the tool. This bridge:
#                1. Reads antigravity's stdin payload.
#                2. Translates it to the Igris UNIFIED shape that
#                   shared/pre_tool_use.sh expects (mapping the antigravity tool
#                   name → the Claude Write/Edit matcher token, and pulling the
#                   file path out of args.TargetFile).
#                3. Runs shared/pre_tool_use.sh (the brief-first gate), capturing
#                   its stdout.
#                4. Translates the shared script's deny-JSON verdict back into
#                   antigravity's {decision,reason} stdout. Empty stdout (= allow)
#                   from the shared script → {"decision":"allow"}.
# Usage: Registered in ~/.gemini/config/hooks.json under PreToolUse → this path.
#        Reads JSON from stdin (NOT argv).
# Dependencies: python3 (no jq — matches _common.sh posture); bash.
# Exit codes:
#   0 - Always (hooks must never fail; deny is via the {decision} JSON, not exit).
#
# Antigravity payload shape (proven, agy v1.0.7, 2026-06-11):
#   { "toolCall": { "name": "write_to_file", "args": { "TargetFile": "...", ... } },
#     "workspacePaths": ["<project-dir>"], "conversationId": "...", ... }
# Tool-name map (R1 resolved): write_to_file → Write, replace_file_content → Edit;
#   BOTH carry the path at args.TargetFile. Other tools pass through with an empty
#   file_path → shared script's is_exempt() allows them (no gate on non-file tools).
# Verdict (proven): shared/pre_tool_use.sh emits
#   {hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:...}}
#   on deny and EMPTY stdout on allow (exit 0 always).

set -e

# ---------------------------------------------------------------------------
# Resolve shared-scripts dir. Allow tests to override via IGRIS_SHARED_DIR.
# (Mirrors codex-notify.sh's IGRIS_SHARED_DIR seam.)
# ---------------------------------------------------------------------------
SHARED_DIR="${IGRIS_SHARED_DIR:-$HOME/.igris/core/hooks/shared}"

INPUT=$(cat 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Translate antigravity stdin → Igris unified shape (python3, no jq). On any
# parse error, emit a minimal unified envelope so the shared gate still runs
# (an empty file_path → is_exempt allows — fail-open, never crash the host).
# ---------------------------------------------------------------------------
build_unified() {
  ANTIGRAVITY_IN="$INPUT" python3 - <<'PY' 2>/dev/null || echo '{"source":"antigravity","event":"pre_tool_use","project_dir":"","payload":{"tool_name":"","tool_input":{"file_path":""}}}'
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

# Tool-name map (R1 resolved). Unmapped tools pass through with an empty
# tool_name; the shared gate keys off file_path (empty → is_exempt allow), so a
# non-file tool is never gated. Both mapped tools carry the path at TargetFile.
TOOL_MAP = {"write_to_file": "Write", "replace_file_content": "Edit"}
tool_name = TOOL_MAP.get(name, "")
file_path = args.get("TargetFile") or "" if tool_name else ""

workspaces = p.get("workspacePaths") or []
project_dir = ""
if isinstance(workspaces, list) and workspaces:
    project_dir = workspaces[0] or ""

unified = {
    "source": "antigravity",
    "event": "pre_tool_use",
    "project_dir": project_dir,
    "payload": {"tool_name": tool_name, "tool_input": {"file_path": file_path}},
}
print(json.dumps(unified))
PY
}

# ---------------------------------------------------------------------------
# Translate the shared gate's stdout verdict → antigravity {decision} JSON.
# Empty / malformed / no-deny → allow (fail-open, never block the host on a
# parse glitch). A permissionDecision=="deny" → deny + the reason.
# ---------------------------------------------------------------------------
translate_verdict() {
  local verdict="$1"
  VERDICT_IN="$verdict" python3 - <<'PY' 2>/dev/null || echo '{"decision":"allow"}'
import json, os

raw = os.environ.get("VERDICT_IN", "") or ""
raw = raw.strip()
if not raw:
    print(json.dumps({"decision": "allow"}))
    raise SystemExit(0)

try:
    v = json.loads(raw)
except Exception:
    # Unparseable verdict → fail-open (never block on a glitch).
    print(json.dumps({"decision": "allow"}))
    raise SystemExit(0)

hso = v.get("hookSpecificOutput") if isinstance(v, dict) else None
decision = ""
reason = ""
if isinstance(hso, dict):
    decision = hso.get("permissionDecision") or ""
    reason = hso.get("permissionDecisionReason") or ""

if decision == "deny":
    print(json.dumps({"decision": "deny", "reason": reason or "Blocked by Igris brief-first gate."}))
else:
    print(json.dumps({"decision": "allow"}))
PY
}

main() {
  local unified verdict
  unified=$(build_unified)
  # Run the shared gate, capturing its stdout. The shared script exits 0 always
  # and emits deny-JSON only on deny (empty on allow). Its stderr (loud WARNINGs
  # on bypass/error) is left to flow to the operator.
  verdict=$(printf '%s' "$unified" | bash "$SHARED_DIR/pre_tool_use.sh" 2>/dev/null || true)
  translate_verdict "$verdict"
  exit 0
}

main "$@" || { echo '{"decision":"allow"}'; exit 0; }
