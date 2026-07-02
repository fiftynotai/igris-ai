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

# ---------------------------------------------------------------------------
# TD-171 M4: tool-name drift validator (long-term safety net)
# ---------------------------------------------------------------------------
#
# Goal: prevent the brain_stewardship.md vs gateway divergence that
# motivated TD-171 from recurring. Two-direction check:
#   FORWARD: every igris_<name> backticked in brain_stewardship.md MUST
#            be registered in some component gateway (or in the
#            DOC_ONLY_ALLOWLIST).
#   REVERSE: every igris_<name> registered in any
#            brain-mcp-server/src/engine/components/*/index.ts MUST
#            appear (backticked) somewhere in brain_stewardship.md so
#            docs are not silently behind the gateway.
#
# Override hooks for bats tests (mirrors SCHEMA_FILE / PROMPT_FILE
# pattern above): COMPONENTS_GLOB env var lets a test redirect the
# components scan to a fixture tree.
import glob, os

# Default: scan repo's real component tree. Derive from SCHEMA_FILE's
# parent-of-parent so the glob tracks the schema location even if the
# repo layout shifts. Tests override via env to point at a fixture dir.
#
# schema_path points at .../engine/components/memory/index.ts; dirname is
# .../engine/components/memory; '..' walks back to .../engine/components,
# then the glob picks up every */index.ts under it.
default_components_glob = os.path.normpath(
    os.path.join(os.path.dirname(schema_path), '..', '*', 'index.ts')
)
components_glob = os.environ.get('COMPONENTS_GLOB', default_components_glob)

# Extract gateway tool names: matches `name: 'igris_<...>'` lines inside
# ToolDefinition objects. Same regex shape as the strict-input contract.
gateway_names = set()
component_files = glob.glob(components_glob)
for path in component_files:
    src = open(path).read()
    for m in re.finditer(r"name:\s*'(igris_[a-z_]+)'", src):
        gateway_names.add(m.group(1))

# Extract advertised names: any backticked `igris_<name>` token in the
# brain_stewardship section.
doc_names = set(re.findall(r"`(igris_[a-z_]+)`", section))

# Doc-only allowlist: intentional aliases or skill-style names that
# happen to start with igris_. Empty by default — every igris_ prefix
# in the docs MUST be a real registered tool.
#
# Intentionally NOT including forward-looking "wait for future tool"
# references — those should either be implemented or have the doc
# reference rewritten to drop the tool-name backticks.
DOC_ONLY_ALLOWLIST = set()

# Reverse-allowlist: tools that ARE registered on the gateway but are
# intentionally undocumented in brain_stewardship.md. These are mostly
# internal / orchestration / sync surfaces that don't carry an "actor
# decision trigger" — they are called by skills, hooks, or the engine
# itself, not by the orchestrator deciding which tool to use.
#
# TD-171 M4 ships this with a non-empty seed reflecting the state at
# the time the safety net was installed. The drift gate's job FROM
# THIS POINT FORWARD is to prevent new undocumented tools from
# accumulating — adding a new tool will fail the validator unless it
# is either documented in brain_stewardship.md or explicitly
# allowlisted here with a one-line rationale.
#
# Future cleanup (separate brief): walk the allowlist, decide per-tool
# whether to (a) document it (move it out of the allowlist) or (b)
# leave it as intentionally-internal (keep it here, with a sharper
# rationale string).
INTERNAL_TOOL_ALLOWLIST = {
    # agent / instance internals — managed by orchestrator hooks, not advertised
    'igris_agent_event',
    'igris_instance_state', 'igris_instance_list', 'igris_instance_remove',

    # backfill / embedding maintenance — operator-run, not actor-decision
    'igris_brief_backfill_embeddings',
    'igris_error_backfill_embeddings',
    'igris_memory_backfill_embeddings',

    # memory promotion mechanics — the /promote pass marks a learning
    # promoted-to-doc; not an actor decision-trigger (operator invokes /promote)
    'igris_memory_mark_promoted',

    # file / session sync mechanics — sync layer, not tool-choice surface
    'igris_brief_file_sync',
    'igris_definition_pull', 'igris_definition_sync',
    'igris_file_pull', 'igris_file_push',
    'igris_session_file_get', 'igris_session_file_list',
    'igris_session_file_pull',
    'igris_session_file_sync', 'igris_session_file_update',
    'igris_session_recall', 'igris_session_sync',
    'igris_sync_queue_drain', 'igris_sync_queue_status',

    # cache management — operator/janitor surface
    'igris_cache_clean', 'igris_cache_rebuild',

    # context mechanics — wired into /boot, not actor-chosen
    'igris_context_get', 'igris_context_load', 'igris_context_register',
    'igris_context_tree',

    # scheduling subsystem — cron surface,
    # not part of actor decision triggers documented in brain_stewardship.md
    'igris_schedule_create', 'igris_schedule_delete',
    'igris_schedule_disable', 'igris_schedule_enable',
    'igris_schedule_fire_now', 'igris_schedule_get', 'igris_schedule_list',

    # event log primitives — internal observability
    'igris_event_log', 'igris_event_log_cleanup',

    # graph internals: node-get is documented at section level via prose,
    # but `_get` (single read) and `_remove` (delete edge) are tactical
    # surfaces not on the decision-trigger ladder
    'igris_edge_remove',
    'igris_error_similar',
    'igris_goal_get',
    'igris_memory_hybrid_search',
    'igris_pattern_suggest',

    # perception lifecycle internals — the public surface is approve/reject/list
    'igris_perception_expire_stale', 'igris_perception_extract_now',
    'igris_perception_submit',

    # catalog CRUD — managed via /harvest skill, not actor-chosen
    'igris_catalog_add', 'igris_catalog_get', 'igris_catalog_list',
    'igris_catalog_remove', 'igris_catalog_search', 'igris_catalog_update',

    # subconscious + suggestion surface — paused per v7 (subconscious.enabled=false)
    'igris_subconscious_run',
    'igris_suggestion_acted', 'igris_suggestion_dismiss', 'igris_suggestion_list',
    'igris_suggestion_apply_action',

    # synapse edge-inference run tool (FR-211) — cron-driven LLM extractor, not a
    # brain READ surface; proposals surface via igris_suggestion_list. Same class
    # as igris_subconscious_run (default off, cognition.synapse.enabled=false).
    'igris_synapse_run',

    # janitor memory-hygiene run tool (FR-119) — cron-driven LLM extractor +
    # deterministic sweep, not a brain READ surface; merge proposals surface via
    # igris_suggestion_list source_module='janitor'. Same class as
    # igris_synapse_run (default off, cognition.janitor.enabled=false).
    'igris_janitor_run_now',
}

forward_misses = doc_names - gateway_names - DOC_ONLY_ALLOWLIST
reverse_misses = gateway_names - doc_names - INTERNAL_TOOL_ALLOWLIST

if forward_misses:
    print("Tool-name drift (FORWARD — doc references missing tool):")
    for n in sorted(forward_misses):
        print(f"  - `{n}` mentioned in brain_stewardship.md but NOT registered in any component")
    print("\nFix: implement the tool, or remove/redirect the doc reference,")
    print("     or add the name to DOC_ONLY_ALLOWLIST in scripts/validate_brain_stewardship_enums.sh")
    print("     if it is intentionally doc-only.")
    sys.exit(1)

if reverse_misses:
    print("Tool-name drift (REVERSE — gateway tool not documented):")
    for n in sorted(reverse_misses):
        print(f"  - `{n}` registered in a component but NOT mentioned in brain_stewardship.md")
    print("\nFix: add a decision-trigger entry to brain_stewardship.md (with the")
    print("     tool name in backticks), OR add to INTERNAL_TOOL_ALLOWLIST in")
    print("     scripts/validate_brain_stewardship_enums.sh if the tool is")
    print("     internal/orchestration-only and intentionally not advertised.")
    sys.exit(1)

total = sum(len(v) for v in expected.values())
print(f"OK: all {total} enum values from memory schema present in brain_stewardship section")
print(f"OK: tool-name parity ({len(gateway_names)} registered tools, all referenced in brain_stewardship)")
PY
