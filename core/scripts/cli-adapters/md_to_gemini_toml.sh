#!/bin/bash

# Description: Convert an Igris SKILL.md into a Gemini CLI TOML command file.
# Usage: md_to_gemini_toml.sh <input-skill-md> <output-toml-path>
# Dependencies: python3, _common.sh (auto-sourced from script dir)
# Exit codes:
#   0 - Success
#   1 - Error (missing input, parse failure, IO error)
#   2 - Usage error (wrong arguments)

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate and source shared helpers.
# ---------------------------------------------------------------------------
ADAPTER_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=_common.sh
source "$ADAPTER_DIR/_common.sh"

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 <input-skill-md> <output-toml-path>" >&2
  echo "" >&2
  echo "Converts an Igris SKILL.md into a Gemini CLI TOML command file with" >&2
  echo "description and prompt keys only. Claude-specific frontmatter is stripped." >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [ "$#" -ne 2 ]; then
  usage
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"

if [ -z "$INPUT_PATH" ] || [ -z "$OUTPUT_PATH" ]; then
  usage
fi

if [ ! -f "$INPUT_PATH" ]; then
  echo "Error: Input file '$INPUT_PATH' does not exist" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Extract description (single line, TOML basic-string escaped) and body
# (multi-line TOML triple-quoted, escaped for safety).
# ---------------------------------------------------------------------------
DESCRIPTION=$(get_skill_field "$INPUT_PATH" "description")
if [ -z "$DESCRIPTION" ]; then
  echo "Warning: No description found in '$INPUT_PATH' — using empty string" >&2
fi

ESCAPED_DESC=$(toml_escape_description "$DESCRIPTION")

BODY=$(strip_frontmatter "$INPUT_PATH")
ESCAPED_BODY=$(toml_escape "$BODY")

# ---------------------------------------------------------------------------
# Ensure output directory exists (idempotent).
# ---------------------------------------------------------------------------
OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Emit TOML. Use python3 for clean file write — avoids shell heredoc issues
# with special characters in the body.
# ---------------------------------------------------------------------------
python3 - "$OUTPUT_PATH" "$ESCAPED_DESC" "$ESCAPED_BODY" <<'PY'
import sys
output_path = sys.argv[1]
description = sys.argv[2]
body = sys.argv[3]

toml = (
    f'description = "{description}"\n'
    f'prompt = """\n'
    f'{body}'
)
# Ensure body ends with a newline before closing triple-quote for readability.
if not toml.endswith("\n"):
    toml += "\n"
toml += '"""\n'

with open(output_path, "w", encoding="utf-8") as fh:
    fh.write(toml)
PY

echo "Gemini TOML written: $OUTPUT_PATH"
