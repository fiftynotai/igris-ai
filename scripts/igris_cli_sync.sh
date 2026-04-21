#!/bin/bash

# Description: Distribute Igris skills to multiple CLI agents based on the
#              `cli_targets` block in ~/.igris/config.json.
# Usage: igris_cli_sync.sh --cli=<list> [--project-dir=<path>]
#   --cli=<list>         Comma-separated CLI names (e.g. claude,gemini,codex)
#                        or `all` to sync every entry in cli_targets.
#   --project-dir=<path> Project root used to resolve relative targets like
#                        `./AGENTS.md`. Defaults to $PWD.
# Dependencies: python3, _common.sh (via adapters)
# Exit codes:
#   0 - Success (all requested CLIs synced, even if individual skills skipped)
#   1 - Error (unknown CLI, converter failure, missing adapter)
#   2 - Usage error

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate paths.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
IGRIS_REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
CONFIG_FILE="$BRAIN_DIR/config.json"

# Override for tests: allow pointing at an alternate skills root.
SKILLS_ROOT="${IGRIS_SKILLS_ROOT:-$BRAIN_DIR/core/skills}"

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  cat >&2 <<EOF
Usage: $0 --cli=<list> [--project-dir=<path>]

Sync Igris skills to one or more CLI agents.

Options:
  --cli=<list>         Comma-separated CLI names or "all"
                       (e.g. --cli=claude,gemini,codex)
  --project-dir=<path> Project root for relative targets (default: \$PWD)

Environment:
  IGRIS_BRAIN_DIR      Override brain path (default: ~/.igris)
  IGRIS_SKILLS_ROOT    Override skills root (default: \$IGRIS_BRAIN_DIR/core/skills)

Exit codes:
  0 - Success
  1 - Runtime error (missing config, converter failure)
  2 - Usage error (bad arguments)
EOF
  exit 2
}

# ---------------------------------------------------------------------------
# parse_cli_targets_list — reads cli_targets from config and prints the list
# of CLI names (space-separated) on stdout. Used to resolve --cli=all.
# ---------------------------------------------------------------------------
parse_cli_targets_list() {
  python3 - "$CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
targets = cfg.get("cli_targets", {})
print(" ".join(sorted(targets.keys())))
PY
}

# ---------------------------------------------------------------------------
# parse_cli_target_field — reads a single field for a CLI entry.
# Usage: parse_cli_target_field <cli-name> <field-name>
# ---------------------------------------------------------------------------
parse_cli_target_field() {
  local cli="$1"
  local field="$2"
  python3 - "$CONFIG_FILE" "$cli" "$field" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = json.load(fh)
cli = sys.argv[2]
field = sys.argv[3]
entry = cfg.get("cli_targets", {}).get(cli, {})
value = entry.get(field, "")
print(value if value is not None else "")
PY
}

# ---------------------------------------------------------------------------
# expand_target_path — resolves `~` and relative paths against PROJECT_DIR.
# ---------------------------------------------------------------------------
expand_target_path() {
  local raw="$1"
  local project_dir="$2"
  # Expand leading ~ (bash parameter expansion does not treat ~ as special in
  # ${var#~}, so we strip the literal one-character prefix manually).
  # shellcheck disable=SC2088 # we are matching the literal '~/' prefix, not expanding it.
  if [ "${raw:0:2}" = "~/" ]; then
    raw="${HOME}/${raw:2}"
  elif [ "$raw" = "~" ]; then
    raw="$HOME"
  fi
  # Resolve relative paths (e.g., ./AGENTS.md) against project_dir.
  case "$raw" in
    /*) printf '%s' "$raw" ;;
    *)  printf '%s/%s' "$project_dir" "$raw" ;;
  esac
}

# ---------------------------------------------------------------------------
# sync_symlink — walk skills root and `ln -sf` each directory to target.
# ---------------------------------------------------------------------------
sync_symlink() {
  local cli="$1"
  local target_dir="$2"
  echo "[$cli] method=symlink target=$target_dir"
  mkdir -p "$target_dir"

  local count=0
  local skill_dir
  for skill_dir in "$SKILLS_ROOT"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_name
    skill_name=$(basename "$skill_dir")
    # Strip trailing slash from source for cleaner symlink display.
    local skill_path="${skill_dir%/}"
    ln -sf "$skill_path" "$target_dir/$skill_name"
    count=$((count + 1))
  done

  echo "[$cli] linked $count skills"
}

# ---------------------------------------------------------------------------
# sync_converter — run the configured converter script once per skill.
# ---------------------------------------------------------------------------
sync_converter() {
  local cli="$1"
  local target_dir="$2"
  local converter_rel="$3"

  local converter_abs="$IGRIS_REPO_ROOT/$converter_rel"
  if [ ! -f "$converter_abs" ]; then
    echo "Error [$cli]: Converter not found at $converter_abs" >&2
    return 1
  fi

  echo "[$cli] method=converter target=$target_dir converter=$converter_rel"
  mkdir -p "$target_dir"

  local count=0
  local skill_md
  for skill_md in "$SKILLS_ROOT"/*/SKILL.md; do
    [ -f "$skill_md" ] || continue
    local skill_name
    skill_name=$(basename "$(dirname "$skill_md")")
    local output_path="$target_dir/${skill_name}.toml"
    if ! bash "$converter_abs" "$skill_md" "$output_path"; then
      echo "Error [$cli]: Converter failed on '$skill_name'" >&2
      return 1
    fi
    count=$((count + 1))
  done

  echo "[$cli] converted $count skills"
}

# ---------------------------------------------------------------------------
# sync_compiler — run the compiler once; it handles all skills.
# ---------------------------------------------------------------------------
sync_compiler() {
  local cli="$1"
  local target_path="$2"
  local compiler_rel="$3"

  local compiler_abs="$IGRIS_REPO_ROOT/$compiler_rel"
  if [ ! -f "$compiler_abs" ]; then
    echo "Error [$cli]: Compiler not found at $compiler_abs" >&2
    return 1
  fi

  echo "[$cli] method=compiler target=$target_path compiler=$compiler_rel"

  if ! bash "$compiler_abs" "$target_path" "$SKILLS_ROOT"; then
    echo "Error [$cli]: Compiler failed" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# sync_none — explicit no-op with informative message.
# ---------------------------------------------------------------------------
sync_none() {
  local cli="$1"
  local note
  note=$(parse_cli_target_field "$cli" "note")
  if [ -n "$note" ]; then
    echo "[$cli] method=none — $note"
  else
    echo "[$cli] method=none — no-op"
  fi
}

# ---------------------------------------------------------------------------
# sync_one_cli — dispatches to the method handler for a given CLI.
# ---------------------------------------------------------------------------
sync_one_cli() {
  local cli="$1"
  local project_dir="$2"

  local method
  method=$(parse_cli_target_field "$cli" "method")
  if [ -z "$method" ]; then
    echo "Error: Unknown CLI '$cli' (not in cli_targets config)" >&2
    return 1
  fi

  local raw_target
  raw_target=$(parse_cli_target_field "$cli" "target")
  local target
  target=$(expand_target_path "$raw_target" "$project_dir")

  case "$method" in
    symlink)
      sync_symlink "$cli" "$target"
      ;;
    converter)
      local converter
      converter=$(parse_cli_target_field "$cli" "converter")
      if [ -z "$converter" ]; then
        echo "Error [$cli]: method=converter but no 'converter' field set" >&2
        return 1
      fi
      sync_converter "$cli" "$target" "$converter"
      ;;
    compiler)
      local compiler
      compiler=$(parse_cli_target_field "$cli" "compiler")
      if [ -z "$compiler" ]; then
        echo "Error [$cli]: method=compiler but no 'compiler' field set" >&2
        return 1
      fi
      sync_compiler "$cli" "$target" "$compiler"
      ;;
    none)
      sync_none "$cli"
      ;;
    *)
      echo "Error [$cli]: Unknown method '$method'" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# main — argument parsing and dispatch loop.
# ---------------------------------------------------------------------------
main() {
  local cli_arg=""
  local project_dir="$PWD"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --cli=*)
        cli_arg="${1#--cli=}"
        ;;
      --project-dir=*)
        project_dir="${1#--project-dir=}"
        ;;
      -h|--help)
        usage
        ;;
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

  # Expand --cli=all into the full configured list.
  local clis=()
  if [ "$cli_arg" = "all" ]; then
    local all
    all=$(parse_cli_targets_list)
    # shellcheck disable=SC2206
    clis=( $all )
  else
    # Split comma-separated list without relying on IFS tricks.
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
  # Normalize project_dir to absolute.
  project_dir=$(cd "$project_dir" && pwd)

  echo "Igris CLI sync: clis=${clis[*]} project=$project_dir skills_root=$SKILLS_ROOT"
  echo ""

  local cli
  for cli in "${clis[@]}"; do
    # Trim whitespace that may arise from commas.
    cli="${cli#"${cli%%[![:space:]]*}"}"
    cli="${cli%"${cli##*[![:space:]]}"}"
    [ -z "$cli" ] && continue
    sync_one_cli "$cli" "$project_dir"
  done

  echo ""
  echo "Igris CLI sync complete."
}

main "$@"
