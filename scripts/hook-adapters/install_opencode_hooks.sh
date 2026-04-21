#!/bin/bash

# Description: Install the Igris OpenCode plugin. Copies
#              ~/.igris/core/hooks/bridges/opencode/igris-bridge.ts into OpenCode's
#              global plugins directory. Preserves any other plugins that are
#              already present.
# Usage: install_opencode_hooks.sh [--plugin-dir=<path>] [--source=<path>]
# Dependencies: None (pure bash)
# Exit codes:
#   0 - Success
#   1 - Source plugin missing
#   2 - Usage error
#
# Plugin path reference (per https://opencode.ai/docs/plugins/):
#   Global: ~/.config/opencode/plugins/
#   Auto-discovered by Bun at startup. Raw .ts loads natively — no build step.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: $0 [--plugin-dir=<path>] [--source=<path>]

Install the Igris OpenCode bridge plugin into OpenCode's plugin directory.

Options:
  --plugin-dir=<path>  Target OpenCode plugin dir
                       (default: \$HOME/.config/opencode/plugins)
  --source=<path>      Source bridge file
                       (default: \$HOME/.igris/core/hooks/bridges/opencode/igris-bridge.ts)

Exit codes:
  0 - Success
  1 - Runtime error
  2 - Usage error
EOF
  exit 2
}

main() {
  local plugin_dir="${IGRIS_OPENCODE_PLUGIN_DIR:-$HOME/.config/opencode/plugins}"
  local source_file="${IGRIS_OPENCODE_SOURCE:-$HOME/.igris/core/hooks/bridges/opencode/igris-bridge.ts}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --plugin-dir=*) plugin_dir="${1#--plugin-dir=}" ;;
      --source=*)     source_file="${1#--source=}" ;;
      -h|--help)      usage ;;
      *)
        echo "Error: Unknown argument '$1'" >&2
        usage
        ;;
    esac
    shift
  done

  if [ ! -f "$source_file" ]; then
    echo "Error: Source plugin not found at '$source_file'" >&2
    exit 1
  fi

  mkdir -p "$plugin_dir"

  local target="$plugin_dir/igris-bridge.ts"
  cp "$source_file" "$target"

  echo "[opencode-hooks] installed $target"
}

main "$@"
