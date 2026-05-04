#!/bin/bash
set -e

# Description: Validates that every enum value declared in
#   brain-mcp-server/src/engine/components/memory/index.ts
#   appears verbatim (in backticks) in the brain_stewardship section
#   (formerly memory_agency, broadened in TD-092). Catches drift between
#   the schema and the actor-facing docs (DRIFT-1, TD-070, TD-092).
#
# Usage: scripts/validate_memory_agency_enums.sh
# Exit codes:
#   0 - All enums present in brain_stewardship section
#   1 - One or more enum values missing (drift detected)
#   2 - Source files missing or unparseable

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/brain-mcp-server/src/engine/components/memory/index.ts"
PROMPT_FILE="$REPO_ROOT/core/prompts/brain_stewardship.md"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "Error: schema file not found: $SCHEMA_FILE"
  exit 2
fi
if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: prompt file not found: $PROMPT_FILE"
  exit 2
fi

python3 - "$SCHEMA_FILE" "$PROMPT_FILE" <<'PY'
import re, sys, pathlib

schema_path, prompt_path = sys.argv[1], sys.argv[2]
schema = pathlib.Path(schema_path).read_text()
prompt = pathlib.Path(prompt_path).read_text()

# Extract brain_stewardship section by markers (scope-limit the search).
# TD-092 renamed memory_agency -> brain_stewardship and moved it to its own file.
m = re.search(
    r"<!-- SECTION: brain_stewardship -->(.*?)<!-- /SECTION: brain_stewardship -->",
    prompt, re.DOTALL)
if not m:
    print("Error: brain_stewardship section markers not found in brain_stewardship.md")
    sys.exit(2)
section = m.group(1)

# Find all enum: [...] arrays in the schema. Only care about the three
# we know live on memory_store: category, scope, provenance.
enum_re = re.compile(
    r"(category|scope|provenance):\s*\{[^}]*?enum:\s*\[([^\]]+)\]",
    re.DOTALL)
expected = {}
for field, body in enum_re.findall(schema):
    values = re.findall(r"'([a-z_]+)'", body)
    expected[field] = values

required_fields = {"category", "scope", "provenance"}
missing_fields = required_fields - set(expected)
if missing_fields:
    print(f"Error: could not extract enum(s) from schema: {sorted(missing_fields)}")
    sys.exit(2)

# Each enum value must appear inside backticks somewhere in the section.
errors = []
for field, values in expected.items():
    for v in values:
        if f"`{v}`" not in section:
            errors.append(f"  - {field}.{v!r} not found as `{v}` in brain_stewardship")

if errors:
    print("Schema/prompt drift detected (DRIFT-1, TD-070, TD-092):")
    print("\n".join(errors))
    print("\nFix: update brain_stewardship section in core/prompts/brain_stewardship.md")
    print("     (remember to mirror to ~/.igris/core/prompts/brain_stewardship.md)")
    sys.exit(1)

total = sum(len(v) for v in expected.values())
print(f"OK: all {total} enum values from memory schema present in brain_stewardship section")
PY
