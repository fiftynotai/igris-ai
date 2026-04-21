#!/bin/bash

# Description: Shared helpers for Igris hook-adapter scripts.
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
# Dependencies: python3
# Exit codes: inherited from callers; helpers return 0/1 where documented.

set -euo pipefail

# Guard: prevent double-sourcing overriding helpers in a long-running bats session.
if [ "${IGRIS_HOOK_ADAPTER_COMMON_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
export IGRIS_HOOK_ADAPTER_COMMON_SOURCED=1

# ---------------------------------------------------------------------------
# Magic prefix that identifies Igris-managed settings.json hook entries. Any
# entry whose `command` starts with this prefix is treated as Igris-owned and
# may be stripped/replaced on re-install; everything else is preserved verbatim.
# ---------------------------------------------------------------------------
IGRIS_HOOK_CMD_PREFIX='$HOME/.igris/core/hooks/'
export IGRIS_HOOK_CMD_PREFIX

# ---------------------------------------------------------------------------
# load_json_file <path>
#   Prints the JSON content of the file to stdout. If the file is missing or
#   invalid JSON, prints the empty object `{}` and returns 0 — callers should
#   treat an empty-object result as "no settings yet".
# ---------------------------------------------------------------------------
load_json_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    printf '{}'
    return 0
  fi
  python3 - "$path" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    print(json.dumps(data))
except Exception:
    # Fail loudly — the caller should refuse to clobber an unreadable settings file.
    print("__IGRIS_SETTINGS_JSON_INVALID__", file=sys.stderr)
    sys.exit(1)
PY
}

# ---------------------------------------------------------------------------
# write_json_file_atomic <path> <json-string>
#   Writes the JSON to a temp file in the same directory, pretty-printed with
#   2-space indent and trailing newline, then renames atomically over the
#   target. mkdir -p on the parent directory if needed.
# ---------------------------------------------------------------------------
write_json_file_atomic() {
  local path="$1"
  local content="$2"
  local dir
  dir=$(dirname "$path")
  mkdir -p "$dir"
  python3 - "$path" "$content" <<'PY'
import json, os, sys, tempfile
target = sys.argv[1]
content = sys.argv[2]
data = json.loads(content)
parent = os.path.dirname(os.path.abspath(target))
fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp", prefix=".igris-settings-")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
os.replace(tmp, target)
PY
}

# ---------------------------------------------------------------------------
# is_igris_hook_entry <command-string>
#   Returns 0 (match) when the command string begins with the Igris prefix;
#   returns 1 otherwise. Used to distinguish Igris-owned entries from user
#   entries during settings.json merge.
# ---------------------------------------------------------------------------
is_igris_hook_entry() {
  local cmd="$1"
  case "$cmd" in
    "$IGRIS_HOOK_CMD_PREFIX"*) return 0 ;;
    *)                          return 1 ;;
  esac
}

export -f load_json_file
export -f write_json_file_atomic
export -f is_igris_hook_entry
