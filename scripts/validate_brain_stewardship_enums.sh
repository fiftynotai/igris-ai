#!/bin/bash
set -e

# Description: Validates that every enum value declared in
#   brain-mcp-server/src/engine/components/memory/index.ts (the schema)
#   appears verbatim (in backticks) in the brain_stewardship section
#   (formerly memory_agency, broadened in TD-092). Catches drift between
#   the schema and the actor-facing docs (DRIFT-1, TD-070, TD-092).
#
# TD-072 F1+F2:
#   - F1: dedup pass — when an enum field appears in multiple `enum: [...]`
#     blocks (e.g., `scope` lives on both memory_store input and
#     memory_search filter), the script asserts all blocks are byte-equal.
#     Divergence exits 2 with a clear diagnostic. Previously the second
#     block silently overwrote the first.
#   - F2: schema-shrinkage reverse pass — flag enum-shaped backticked
#     tokens in brain_stewardship that no longer appear in any current
#     schema enum. Catches the inverse drift the forward pass misses
#     (docs claim a value the schema removed).
#
# Usage: scripts/validate_brain_stewardship_enums.sh
#   (renamed from validate_memory_agency_enums.sh in TD-148 to match the
#    TD-092 concept rename memory_agency -> brain_stewardship)
# Env overrides (test injection):
#   SCHEMA_FILE  override schema path (default: brain-mcp-server/src/engine/components/memory/index.ts)
#   PROMPT_FILE  override prompt path (default: core/prompts/brain_stewardship.md)
# Exit codes:
#   0 - All enums present in brain_stewardship section, no drift in either direction
#   1 - Drift detected (forward miss or schema-shrinkage)
#   2 - Source files missing/unparseable, OR same field declared with diverging enums in schema

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="${SCHEMA_FILE:-$REPO_ROOT/brain-mcp-server/src/engine/components/memory/index.ts}"
PROMPT_FILE="${PROMPT_FILE:-$REPO_ROOT/core/prompts/brain_stewardship.md}"

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

# Find ALL enum: [...] arrays in the schema as ordered (field, [values]) pairs.
# A field can appear in multiple input schemas (e.g., `scope` is on both
# memory_store and memory_search). TD-072 F1: assert they are byte-equal.
enum_re = re.compile(
    r"(category|scope|provenance):\s*\{[^}]*?enum:\s*\[([^\]]+)\]",
    re.DOTALL)
occurrences = []  # list of (field, tuple_of_values)
for field, body in enum_re.findall(schema):
    values = tuple(re.findall(r"'([a-z_]+)'", body))
    occurrences.append((field, values))

# Group occurrences by field; assert all values are byte-equal within a field.
by_field = {}
for field, values in occurrences:
    by_field.setdefault(field, []).append(values)

divergence_errors = []
for field, value_lists in by_field.items():
    if len(set(value_lists)) > 1:
        # Render each variant for the diagnostic.
        variants = "\n    ".join(
            f"variant {i+1}: {list(v)}" for i, v in enumerate(value_lists))
        divergence_errors.append(
            f"  - field `{field}` declared {len(value_lists)} times with diverging enums:\n    {variants}"
        )

if divergence_errors:
    print("Schema integrity error: same enum field declared with diverging values (TD-072 F1):")
    print("\n".join(divergence_errors))
    print("\nFix: align all `enum:` arrays for the same field name to identical values.")
    sys.exit(2)

# Build expected = field -> dedupped values (any variant — they are equal here).
expected = {field: list(value_lists[0]) for field, value_lists in by_field.items()}

required_fields = {"category", "scope", "provenance"}
missing_fields = required_fields - set(expected)
if missing_fields:
    print(f"Error: could not extract enum(s) from schema: {sorted(missing_fields)}")
    sys.exit(2)

# Forward pass: every enum value must appear inside backticks somewhere in the section.
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

# TD-072 F2: schema-shrinkage reverse pass.
#
# Goal: detect when brain_stewardship.md still references an enum-value
# token that the schema has dropped (e.g., schema removed `scope='session'`
# but the docs still backtick `session` in a sentence about scope).
#
# Strategy: scan the section line-by-line. Only consider lines that mention
# one of the enum field names (`scope`, `category`, `provenance`) — those
# are the lines where an enum value would naturally be cited. On such lines,
# extract every backticked token; if it has enum-value shape AND is NOT in
# any current enum array AND is NOT itself a field name AND is NOT a known
# tool/identifier prefix (igris_*), flag it as orphan.
#
# This narrowly targets the schema-shrinkage failure mode without
# false-positiving on prose tokens elsewhere in the section.
all_current_values = set()
for vs in expected.values():
    for v in vs:
        all_current_values.add(v)

# Field names themselves are ALSO backticked in enum-mentioning lines —
# skip them. Same for the tool name prefix `igris_*` (these are MCP tools
# and command names, not enum values, and they always start with `igris_`).
# Also collect ALL property names from the memory tool input schemas so we
# don't false-positive on sibling field names (e.g., `project`, `title`,
# `content`, `tags`) that the docs naturally co-cite with enum fields.
field_names = set(expected.keys())  # {'category', 'scope', 'provenance'}

# Collect every property-name on every memory_* tool input schema. The
# regex matches `<name>: { ... type: '...' ... }` headers within
# `properties: { ... }` blocks. Conservative — we'd rather skip a real
# property than scan one as a candidate enum value.
prop_re = re.compile(
    r"\b([a-z][a-z_]*)\s*:\s*\{[^}]*?type:\s*'(?:string|number|boolean|array|object)'",
    re.DOTALL,
)
schema_property_names = set(prop_re.findall(schema))

# Enum-value shape: lowercase, all letters, optional underscores between
# letter groups (matches `pattern`, `decision`, `human_asserted`, etc.).
# Reject anything with digits, punctuation, mixed case, or that starts/ends
# with an underscore.
shape_re = re.compile(r"^[a-z]+(?:_[a-z]+)*$")
backtick_re = re.compile(r"`([^`\s]+)`")

# Lines that mention any enum field name as a bareword OR as a backticked
# token are candidates for the reverse-pass scan.
field_mention_re = re.compile(
    r"(?<![a-zA-Z_])(?:" + "|".join(re.escape(f) for f in field_names) + r")(?![a-zA-Z_])"
)

orphan_tokens = []
for line in section.splitlines():
    if not field_mention_re.search(line):
        continue
    for token in backtick_re.findall(line):
        if not shape_re.match(token):
            continue
        if token.startswith("igris_"):
            # Tool/command identifier, not an enum value.
            continue
        if token in field_names:
            # The field name itself, not an enum value of that field.
            continue
        if token in schema_property_names:
            # Sibling property name (e.g., `project`, `title`, `content`)
            # backticked alongside an enum field name in tool descriptions.
            continue
        if token in all_current_values:
            continue
        orphan_tokens.append(token)

# Dedupe while preserving order (helpful diagnostic when many sites cite the same token).
seen = set()
orphan_unique = []
for t in orphan_tokens:
    if t not in seen:
        seen.add(t)
        orphan_unique.append(t)

if orphan_unique:
    print("Schema-shrinkage drift detected (TD-072 F2):")
    for t in orphan_unique:
        print(f"  - WARN: token `{t}` referenced in brain_stewardship but missing from schema enums — possible schema-shrinkage drift")
    print("\nFix: either restore the value to the schema enum, or remove the stale reference from brain_stewardship.md.")
    sys.exit(1)

total = sum(len(v) for v in expected.values())
print(f"OK: all {total} enum values from memory schema present in brain_stewardship section")
PY
