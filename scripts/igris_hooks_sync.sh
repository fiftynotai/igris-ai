#!/bin/bash

# Description: Distribute Igris hook bridges to multiple CLI agents based on the
#              `cli_targets.*.hooks` sub-block in ~/.igris/config.json. Sibling to
#              igris_cli_sync.sh (which handles skills). Delegates per-CLI work to
#              scripts/hook-adapters/install_<cli>_hooks.sh.
# Usage: igris_hooks_sync.sh --cli=<list> [--project-dir=<path>]
#   --cli=<list>         Comma-separated CLI names (e.g. claude,opencode,codex)
#                        or `all` to sync every entry in cli_targets.
#   --project-dir=<path> Project root. Defaults to $PWD.
# Dependencies: python3
# Exit codes:
#   0 - Success (all requested CLIs synced, skipped gracefully when no hooks entry)
#   1 - Error (unknown CLI, adapter failure, missing config)
#   2 - Usage error

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
IGRIS_REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
CONFIG_FILE="${IGRIS_CONFIG_FILE:-$BRAIN_DIR/config.json}"

usage() {
  cat >&2 <<EOF
Usage: $0 --cli=<list> [--project-dir=<path>]

Sync Igris hooks to one or more CLI agents.

Options:
  --cli=<list>         Comma-separated CLI names or "all"
  --project-dir=<path> Project root for Claude settings.json target (default: \$PWD)

Environment:
  IGRIS_BRAIN_DIR      Override brain path (default: ~/.igris)
  IGRIS_CONFIG_FILE    Override config.json path (default: \$IGRIS_BRAIN_DIR/config.json)

Exit codes:
  0 - Success
  1 - Runtime error
  2 - Usage error
EOF
  exit 2
}

# ---------------------------------------------------------------------------
# parse_cli_targets_list — reads cli_targets keys from config.
# ---------------------------------------------------------------------------
parse_cli_targets_list() {
  python3 - "$CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
print(" ".join(sorted((cfg.get("cli_targets") or {}).keys())))
PY
}

# ---------------------------------------------------------------------------
# has_hooks_entry <cli> — returns 0 (yes) when cli_targets.<cli>.hooks exists
# and is a non-empty object. Returns 1 otherwise.
# ---------------------------------------------------------------------------
has_hooks_entry() {
  local cli="$1"
  python3 - "$CONFIG_FILE" "$cli" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
entry = (cfg.get("cli_targets") or {}).get(sys.argv[2]) or {}
hooks = entry.get("hooks")
sys.exit(0 if isinstance(hooks, dict) and hooks else 1)
PY
}

# ---------------------------------------------------------------------------
# get_hooks_field <cli> <field>
# ---------------------------------------------------------------------------
get_hooks_field() {
  local cli="$1"
  local field="$2"
  python3 - "$CONFIG_FILE" "$cli" "$field" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
entry = (cfg.get("cli_targets") or {}).get(sys.argv[2]) or {}
hooks = entry.get("hooks") or {}
val = hooks.get(sys.argv[3])
print(val if isinstance(val, str) else "")
PY
}

# ---------------------------------------------------------------------------
# sync_one_cli — dispatch to the correct per-CLI adapter.
# ---------------------------------------------------------------------------
sync_one_cli() {
  local cli="$1"
  local project_dir="$2"

  if ! has_hooks_entry "$cli"; then
    local note
    note=$(get_hooks_field "$cli" "note")
    if [ -n "$note" ]; then
      echo "[$cli] no hooks entry — skipping ($note)"
    else
      echo "[$cli] no hooks entry — skipping"
    fi
    return 0
  fi

  local adapter="$SCRIPT_DIR/hook-adapters/install_${cli}_hooks.sh"
  if [ ! -f "$adapter" ]; then
    # Gemini in particular: explicit unsupported — events_covered is empty.
    local events_covered_cnt
    events_covered_cnt=$(python3 - "$CONFIG_FILE" "$cli" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
entry = (cfg.get("cli_targets") or {}).get(sys.argv[2]) or {}
hooks = entry.get("hooks") or {}
ec = hooks.get("events_covered") or []
print(len(ec) if isinstance(ec, list) else 0)
PY
    )
    if [ "$events_covered_cnt" = "0" ]; then
      local note
      note=$(get_hooks_field "$cli" "note")
      if [ -n "$note" ]; then
        echo "[$cli] unsupported — $note"
      else
        echo "[$cli] unsupported — no hook adapter and events_covered is empty"
      fi
      return 0
    fi
    echo "Error [$cli]: hook adapter not found at $adapter" >&2
    return 1
  fi

  echo "[$cli] installing hooks via $(basename "$adapter")..."
  case "$cli" in
    claude)
      bash "$adapter" --project-dir="$project_dir"
      ;;
    opencode|codex)
      bash "$adapter"
      ;;
    *)
      # Generic adapter invocation. Pass --project-dir in case the adapter uses it.
      bash "$adapter" --project-dir="$project_dir"
      ;;
  esac
}

main() {
  local cli_arg=""
  local project_dir="$PWD"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --cli=*)         cli_arg="${1#--cli=}" ;;
      --project-dir=*) project_dir="${1#--project-dir=}" ;;
      -h|--help)       usage ;;
      *)
        echo "Error: Unknown argument '$1'" >&2
        usage
        ;;
    esac
    shift
  done

  if [ -z "$cli_arg" ]; then
    echo "Error: --cli=<list> is required" >&2
    usage
  fi

  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found at '$CONFIG_FILE'" >&2
    exit 1
  fi

  local clis=()
  if [ "$cli_arg" = "all" ]; then
    local all
    all=$(parse_cli_targets_list)
    # shellcheck disable=SC2206
    clis=( $all )
  else
    local IFS=','
    # shellcheck disable=SC2206
    clis=( $cli_arg )
    unset IFS
  fi

  if [ "${#clis[@]}" -eq 0 ]; then
    echo "Error: No CLIs resolved from --cli='$cli_arg'" >&2
    exit 1
  fi

  if [ ! -d "$project_dir" ]; then
    echo "Error: Project directory '$project_dir' does not exist" >&2
    exit 1
  fi
  project_dir=$(cd "$project_dir" && pwd)

  # shellcheck disable=SC2034  # IGRIS_REPO_ROOT is exported for downstream adapters
  export IGRIS_REPO_ROOT

  echo "Igris hooks sync: clis=${clis[*]} project=$project_dir"
  echo ""

  local cli
  for cli in "${clis[@]}"; do
    cli="${cli#"${cli%%[![:space:]]*}"}"
    cli="${cli%"${cli##*[![:space:]]}"}"
    [ -z "$cli" ] && continue
    sync_one_cli "$cli" "$project_dir"
  done

  echo ""
  echo "Igris hooks sync complete."
}

main "$@"
