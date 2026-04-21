#!/bin/bash

# Description: Codex CLI bridge for the Igris hook layer.
#              Codex exposes a single `notify` program in ~/.codex/config.toml,
#              invoked with a JSON payload argument when a turn completes (type:
#              "agent-turn-complete"). This wrapper:
#                1. Invokes the user's pre-Igris `notify` program first (if any)
#                   so existing notification behavior is preserved.
#                2. Translates the payload to the Igris unified shape and pipes it
#                   to shared/session_end.sh for standard end-of-turn bookkeeping.
# Usage: Called automatically by Codex CLI when configured as the `notify` program.
#        Argument 1 is a JSON string.
# Dependencies: python3
# Exit codes:
#   0 - Always (hooks must never fail)

set -euo pipefail

PAYLOAD="${1:-}"

# ---------------------------------------------------------------------------
# Resolve shared-scripts dir. Allow tests to override via IGRIS_SHARED_DIR.
# ---------------------------------------------------------------------------
SHARED_DIR="${IGRIS_SHARED_DIR:-$HOME/.igris/core/hooks/shared}"

# ---------------------------------------------------------------------------
# Invoke user's original notify (if backed up) before running Igris bookkeeping.
# Backup lives in ~/.igris/config.json -> cli_targets.codex.user_notify_backup
# (an array of strings: [program, arg1, arg2, ...])
# ---------------------------------------------------------------------------
invoke_user_notify() {
  local backup_json
  backup_json=$(python3 - <<'PY' 2>/dev/null || echo '[]'
import json, os
p = os.path.expanduser("~/.igris/config.json")
try:
    with open(p) as fh:
        cfg = json.load(fh)
    arr = cfg.get("cli_targets", {}).get("codex", {}).get("user_notify_backup", [])
    if isinstance(arr, list):
        print(json.dumps(arr))
    else:
        print("[]")
except Exception:
    print("[]")
PY
  )

  # Skip if empty or the array is empty.
  if [ "$backup_json" = "[]" ] || [ -z "$backup_json" ]; then
    return 0
  fi

  # Decode to shell array via newline-delimited python output. Each array element
  # is emitted as a single line — no spaces in program args will corrupt it.
  local tmpfile
  tmpfile=$(mktemp)
  python3 - "$backup_json" > "$tmpfile" <<'PY' 2>/dev/null || true
import json, sys
try:
    for item in json.loads(sys.argv[1]):
        print(item)
except Exception:
    pass
PY

  local -a cmd=()
  while IFS= read -r line; do
    cmd+=( "$line" )
  done < "$tmpfile"
  rm -f "$tmpfile"

  if [ "${#cmd[@]}" -eq 0 ]; then
    return 0
  fi

  # Invoke with the original payload appended. Swallow errors — hooks can't fail.
  "${cmd[@]}" "$PAYLOAD" > /dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Translate Codex payload to unified shape and pipe to shared/session_end.sh.
# Codex payload shape (per docs):
#   { "type": "agent-turn-complete", "turn-id": "...",
#     "input-messages": [...], "last-assistant-message": "..." }
# ---------------------------------------------------------------------------
invoke_igris_session_end() {
  local unified
  unified=$(PAYLOAD_IN="$PAYLOAD" python3 - <<'PY' 2>/dev/null || echo '{}'
import json, os, sys
raw = os.environ.get("PAYLOAD_IN", "") or "{}"
try:
    p = json.loads(raw)
except Exception:
    p = {}
unified = {
    "source": "codex",
    "event": "session_end",
    "project_dir": os.environ.get("PWD", ""),
    "payload": p,
    "reason": p.get("type", "turn_complete") if isinstance(p, dict) else "turn_complete",
}
print(json.dumps(unified))
PY
  )

  printf '%s' "$unified" | bash "$SHARED_DIR/session_end.sh" > /dev/null 2>&1 || true
}

main() {
  invoke_user_notify 2>/dev/null || true
  invoke_igris_session_end 2>/dev/null || true
  exit 0
}

main "$@" 2>/dev/null || true
exit 0
