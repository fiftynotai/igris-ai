#!/bin/bash

# Description: Shared helpers for Igris CLI adapter scripts.
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
# Dependencies: python3
# Exit codes: inherited from callers; helpers return 0/1 where documented.

set -euo pipefail

# Guard: prevent double-sourcing overriding helpers in a long-running bats session.
if [ "${IGRIS_ADAPTER_COMMON_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
export IGRIS_ADAPTER_COMMON_SOURCED=1

# ===========================================================================
# Surface registry (FR-202 M0) — the ONE source of truth for the wiring
# surfaces the orchestrator (compile_harnesses.sh) projects and the drift
# engine (check_harness_drift.sh) verifies.
#
# A wiring SURFACE is a declarative plugin filling the 3-concern lifecycle the
# core owns: declare → distribute → project → verify. Adding a surface =
#   1. a `$defs/<x>_surface` block + `_contract` metadata in manifest.schema.json
#   2. ONE entry here (the id + its empty-match noun fragment)
#   3. a `project_<x>` plugin in compile_harnesses.sh
#   4. a `verify_<x>` plugin in check_harness_drift.sh
# …and NOTHING in the two top-level scripts' dispatch loops. A concept that
# cannot fill declare→distribute→project→verify is NOT a wiring surface (it
# belongs in core/os, a skill, or the brain). See README.md "Surface-plugin
# contract" and MAINTAINING.md.
#
# bash 3.2 (macOS /bin/bash) constraint: NO associative arrays / namerefs.
# The registry is two positionally-aligned space-delimited strings (the same
# colon/space-delimited idiom the codebase already relies on, e.g.
# TREE_CHECKED). Dispatch is function-name composition: "project_$surface" /
# "verify_$surface". Accumulators stay GLOBAL (no namerefs in 3.2).
#
# IGRIS_SURFACE_IDS   — ordered surface ids (projection order). Used for the
#                       `--surface` enum AND the `project_<id>`/`verify_<id>`
#                       dispatch fn names. `--surface <id>` accepts these + `all`.
# IGRIS_SURFACE_LABELS — positionally-aligned noun fragments for the empty-match
#                       message ("No <labels joined by /> targets matched …").
#                       Kept SEPARATE from the ids because the historical message
#                       uses the singular "agent" while the id is plural "agents"
#                       — a parser-coupled literal (parseHarnessOutput) that must
#                       stay byte-identical. Both arrays MUST stay aligned.
# ---------------------------------------------------------------------------
IGRIS_SURFACE_IDS="agents skills mcp hook"
IGRIS_SURFACE_LABELS="agent skills mcp hook"

# igris_surface_is_valid <value>
#   Returns 0 if <value> is a known surface id OR the literal `all`; 1 otherwise.
#   Replaces the hard-coded `case "$SURFACE_KIND" in agents|skills|…|all)` enum
#   in BOTH top scripts so the accepted set lives ONLY in IGRIS_SURFACE_IDS.
igris_surface_is_valid() {
  local want="$1"
  if [ "$want" = "all" ]; then
    return 0
  fi
  local s
  for s in $IGRIS_SURFACE_IDS; do
    if [ "$s" = "$want" ]; then
      return 0
    fi
  done
  return 1
}

# igris_surface_selected <surface-id> <surface-kind>
#   Returns 0 when the surface should run for the given --surface selection:
#   either the selection is `all` or it exactly names this surface. The
#   registry-driven dispatch loop in each top script uses this to decide
#   whether to call the surface's plugin — replacing the inline
#   `if [ "$SURFACE_KIND" = "X" ] || [ "$SURFACE_KIND" = "all" ]` pass-gates.
igris_surface_selected() {
  local surface="$1"
  local kind="$2"
  if [ "$kind" = "all" ] || [ "$kind" = "$surface" ]; then
    return 0
  fi
  return 1
}

# igris_surface_empty_match_nouns
#   Echoes the surface noun fragments joined by `/` (e.g.
#   "agent/skills/mcp/hook") for the shared empty-match message. The
#   list is derived from IGRIS_SURFACE_LABELS so a new surface extends the
#   message by adding its registry entry — no edit to the message site itself.
igris_surface_empty_match_nouns() {
  local out=""
  local label
  for label in $IGRIS_SURFACE_LABELS; do
    if [ -z "$out" ]; then
      out="$label"
    else
      out="$out/$label"
    fi
  done
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# parse_frontmatter <skill-md-path>
#
# Emits the raw YAML frontmatter block (content between opening and closing
# `---` delimiters, without the delimiters themselves) to stdout.
#
# Returns 0 when frontmatter was found and emitted; returns 1 when the file
# has no frontmatter. Callers that need a missing-frontmatter fallback should
# capture the exit status.
#
# PyYAML is intentionally not required — this is pure delimiter parsing that
# works with or without the yaml module installed.
# ---------------------------------------------------------------------------
parse_frontmatter() {
  local skill_path="$1"
  if [ ! -f "$skill_path" ]; then
    return 1
  fi
  python3 - "$skill_path" <<'PY'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()
if not text.startswith("---"):
    sys.exit(1)
# Split on first two `---` delimiters at line start.
lines = text.splitlines(keepends=True)
if not lines or lines[0].rstrip("\n") != "---":
    sys.exit(1)
body_start = None
for i in range(1, len(lines)):
    if lines[i].rstrip("\n") == "---":
        body_start = i
        break
if body_start is None:
    sys.exit(1)
sys.stdout.write("".join(lines[1:body_start]))
PY
}

# ---------------------------------------------------------------------------
# get_skill_field <skill-md-path> <field>
#
# Extracts a top-level frontmatter scalar field by name. Falls back to
# manually parsing `key: value` lines when PyYAML is not installed (most
# installs). Multi-line / structured values are ignored and return empty.
#
# Supports nested lookups under `platform_overrides` via dotted path, e.g.:
#   get_skill_field path/to/SKILL.md platform_overrides.codex.include
#
# Returns 0 always; prints empty string on missing field.
# ---------------------------------------------------------------------------
get_skill_field() {
  local skill_path="$1"
  local field="$2"
  python3 - "$skill_path" "$field" <<'PY'
import sys
path = sys.argv[1]
field = sys.argv[2]
try:
    import yaml  # type: ignore
    have_yaml = True
except Exception:
    have_yaml = False

with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()
if not text.startswith("---"):
    print("")
    sys.exit(0)
lines = text.splitlines(keepends=True)
body_start = None
for i in range(1, len(lines)):
    if lines[i].rstrip("\n") == "---":
        body_start = i
        break
if body_start is None:
    print("")
    sys.exit(0)
fm = "".join(lines[1:body_start])

if have_yaml:
    try:
        data = yaml.safe_load(fm) or {}
    except Exception:
        data = {}
    cur = data
    for part in field.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            cur = None
            break
    if cur is None:
        print("")
    elif isinstance(cur, (str, int, float, bool)):
        print(cur if not isinstance(cur, bool) else ("true" if cur else "false"))
    else:
        # structured value — callers wanting structure should use PyYAML directly
        print("")
    sys.exit(0)

# Manual fallback: flat `key: value` only, single level. We traverse dotted
# paths via indentation-aware parsing.
def manual_lookup(fm_text: str, dotted: str) -> str:
    parts = dotted.split(".")
    target_depth = 0
    current_indent = None
    stack = []
    for raw in fm_text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.rstrip()
        indent = len(stripped) - len(stripped.lstrip(" "))
        content = stripped.strip()
        if ":" not in content:
            continue
        key, _, value = content.partition(":")
        key = key.strip()
        value = value.strip()
        # normalize stack to current indent depth
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        full_path = [k for _, k in stack]
        if full_path == parts:
            if value.startswith('"') and value.endswith('"'):
                return value[1:-1]
            return value
    return ""

print(manual_lookup(fm, field))
PY
}

# ---------------------------------------------------------------------------
# strip_frontmatter <skill-md-path>
#
# Emits the markdown body (everything after the closing `---` delimiter).
# Leading blank lines immediately after the delimiter are trimmed so the
# body starts at the first meaningful content.
#
# Returns 0 always. If the file has no frontmatter, emits the file verbatim.
# ---------------------------------------------------------------------------
strip_frontmatter() {
  local skill_path="$1"
  python3 - "$skill_path" <<'PY'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()
if not text.startswith("---"):
    sys.stdout.write(text)
    sys.exit(0)
lines = text.splitlines(keepends=True)
body_start = None
for i in range(1, len(lines)):
    if lines[i].rstrip("\n") == "---":
        body_start = i + 1
        break
if body_start is None:
    sys.stdout.write(text)
    sys.exit(0)
# Trim leading blank lines from body
while body_start < len(lines) and lines[body_start].strip() == "":
    body_start += 1
sys.stdout.write("".join(lines[body_start:]))
PY
}

# ---------------------------------------------------------------------------
# is_claude_only <skill-md-path> [cli]
#
# Returns 0 (true) when the skill should be excluded from the target CLI:
#   (a) frontmatter has `platform_overrides.{cli}.include: false`, OR
#   (b) body contains `\bAgent\(` or `\bSkill\(` invocation patterns.
# Returns 1 (false) otherwise.
#
# `cli` defaults to `codex` — the primary consumer of this heuristic.
# Does not read stdin; safe in pipelines.
# ---------------------------------------------------------------------------
is_claude_only() {
  local skill_path="$1"
  local cli="${2:-codex}"
  # Signal (a): explicit opt-out in frontmatter.
  local include_flag
  include_flag=$(get_skill_field "$skill_path" "platform_overrides.${cli}.include" || true)
  if [ "$include_flag" = "false" ]; then
    return 0
  fi
  # Signal (b): body contains Agent( or Skill( invocation patterns.
  local body
  body=$(strip_frontmatter "$skill_path")
  if printf '%s' "$body" | grep -Eq '\bAgent\(|\bSkill\(' ; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# toml_escape <multiline-string>
#
# Escapes a string for use inside a TOML multiline basic string (triple-quote
# delimited). Rules per TOML 1.0:
#   - backslashes are doubled
#   - embedded `"""` sequences are broken with a literal backslash so the
#     parser sees `""\"` instead of closing the block prematurely
#   - lone/triple quotes at the end are escaped similarly
#
# Reads from stdin (preferred) or from $1. Writes escaped text to stdout.
# ---------------------------------------------------------------------------
toml_escape() {
  local input
  if [ "$#" -ge 1 ]; then
    input="$1"
  else
    input=$(cat)
  fi
  python3 - <<'PY' "$input"
import sys
raw = sys.argv[1]
# Order matters: escape backslashes FIRST so we don't re-escape our own.
out = raw.replace("\\", "\\\\")
# TOML multiline basic strings allow `"` and `""` but not `"""`. Break any
# run of 3+ quotes by inserting a `\` before the closing quote of the third.
# We also need to handle a trailing quote just before the closing `"""` so
# the parser doesn't see `""""`.
# Strategy: replace any run of 3+ double quotes with escaped form `""\"`...
import re
def _break(m):
    s = m.group(0)
    # Break every 3 quotes into `""\"` to guarantee no unescaped `"""`.
    return ("\"\"\\\"") * (len(s) // 3) + ("\"" * (len(s) % 3))
out = re.sub(r'"{3,}', _break, out)
sys.stdout.write(out)
PY
}

# ---------------------------------------------------------------------------
# toml_escape_description <single-line-string>
#
# Escapes for TOML basic string (single-line, double-quoted). Collapses
# newlines to spaces and escapes `"` and `\`.
# ---------------------------------------------------------------------------
toml_escape_description() {
  local input
  if [ "$#" -ge 1 ]; then
    input="$1"
  else
    input=$(cat)
  fi
  python3 - <<'PY' "$input"
import sys
raw = sys.argv[1]
# Collapse whitespace/newlines to single spaces (description is one line).
collapsed = " ".join(raw.split())
# TOML basic string escapes
escaped = (
    collapsed.replace("\\", "\\\\")
             .replace('"', '\\"')
)
sys.stdout.write(escaped)
PY
}

# ---------------------------------------------------------------------------
# read_canonical_version <md-path>
#
# Extracts the agent-prompt version marker from a canonical prompt file.
# Strategy (TD-021):
#   1. Look for a `> **Version:** X.Y` blockquote line in the body —
#      content-pipeline prompts use this (confirmed in deck/system-prompt-*).
#   2. Fall back to a `version:` top-level frontmatter key.
# Emits the bare version string (e.g. `1.6`) to stdout, or an empty string
# when neither marker is present (Igris-core agents carry no version marker —
# the manifest declares them `versioned: false`, so empty is expected there).
#
# Returns 0 always.
# ---------------------------------------------------------------------------
read_canonical_version() {
  local md_path="$1"
  python3 - "$md_path" <<'PY'
import re
import sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
except OSError:
    print("")
    sys.exit(0)
# Strategy 1: `> **Version:** X.Y` blockquote line in the body.
m = re.search(r'^\s*>\s*\*\*Version:\*\*\s*([0-9][0-9.]*)\s*$', text, re.MULTILINE)
if m:
    print(m.group(1))
    sys.exit(0)
# Strategy 2: `version:` frontmatter key (only inside the frontmatter block).
if text.startswith("---"):
    lines = text.splitlines(keepends=True)
    body_start = None
    for i in range(1, len(lines)):
        if lines[i].rstrip("\n") == "---":
            body_start = i
            break
    if body_start is not None:
        fm = "".join(lines[1:body_start])
        fm_m = re.search(r'^\s*version:\s*["\']?([0-9][0-9.]*)["\']?\s*$',
                         fm, re.MULTILINE)
        if fm_m:
            print(fm_m.group(1))
            sys.exit(0)
print("")
PY
}

# ---------------------------------------------------------------------------
# latest_canonical <dir> <basename-glob>
#
# Given a directory and a glob (e.g. `agents/deck` + `system-prompt-v*.md`),
# resolves the highest-versioned matching file. Versions are compared with
# `sort -V` so `v1.10` sorts after `v1.9`. Emits the absolute path of the
# newest file to stdout.
#
# Returns 0 when a match was found and emitted; returns 1 when the directory
# does not exist or no file matches the glob (callers should check status).
# ---------------------------------------------------------------------------
latest_canonical() {
  local dir="$1"
  local glob="$2"
  if [ ! -d "$dir" ]; then
    return 1
  fi
  local newest
  # `find` for the matches, `sort -V` for version-aware ordering, take the
  # last line as the highest. Newline-delimited: agent prompt filenames are
  # plain ASCII (`system-prompt-vX.Y.md`), so embedded newlines are not a
  # concern here and `tail -z` is unavailable on BSD/macOS tail anyway.
  newest=$(
    find "$dir" -mindepth 1 -maxdepth 1 -type f -name "$glob" 2>/dev/null \
      | sort -V \
      | tail -n 1
  )
  if [ -z "$newest" ]; then
    return 1
  fi
  # Emit an absolute path for caller convenience.
  ( cd "$(dirname "$newest")" && printf '%s/%s\n' "$(pwd)" "$(basename "$newest")" )
}

# ---------------------------------------------------------------------------
# sha_body <md-path>
#
# Emits the sha256 hex digest of the markdown BODY only (frontmatter stripped
# via strip_frontmatter). This is the idempotency / drift primitive used by
# the harness compiler and the drift guard — comparing body shas ignores
# intentional frontmatter divergence between canonical and harness copies.
#
# Emits the bare 64-char digest to stdout. Returns 0 always.
# ---------------------------------------------------------------------------
sha_body() {
  local md_path="$1"
  local body
  body=$(strip_frontmatter "$md_path")
  # Pass the body as an argv arg, not stdin — a `<<PY` heredoc on the python3
  # call would otherwise override any piped stdin (shellcheck SC2259).
  python3 - "$body" <<'PY'
import hashlib
import sys
data = sys.argv[1].encode("utf-8")
print(hashlib.sha256(data).hexdigest())
PY
}

# ---------------------------------------------------------------------------
# hash_agent_tree <dir>
#
# FR-156: stable content hash over a vendored agent tree (sorted relpath +
# \0 + bytes, folded into one sha256). Bash counterpart to TS
# `hashAgentTree` in cli/src/verbs/registry.ts — must produce IDENTICAL hex
# output for the same tree contents so drift-verify's pre-check pairs with
# the recorded origin hash written by `igris registry add/update`.
#
# Skip-list MUST stay byte-for-byte in sync with the TS side at
# `cli/src/verbs/registry.ts:isAgentTreeSkipped` (three sites, one rule —
# any drift between them re-opens the L-430 "hash basis ≠ disk" trap).
# Per-harness α-assembly outputs (`harness.claude.md`, `harness.gemini.md`)
# are excluded from the basis because they are FR-152 / FR-158 DERIVED
# OUTPUT — including either would make every assembly re-write register as
# drift. Same posture as TS `hashAgentTree`.
#
# Returns 0 always; emits 64-char hex to stdout. Missing dir → empty sha256
# (the well-known `e3b0c4...` digest), matching TS's `existsSync` guard.
# ---------------------------------------------------------------------------
hash_agent_tree() {
  local tree_dir="$1"
  python3 - "$tree_dir" <<'PY'
import hashlib
import os
import sys

# Skip-list: keep byte-for-byte in sync with THREE sites total — TS
# cli/src/verbs/registry.ts:isAgentTreeSkipped (FR-156), and the two
# inline EXACT sets in check_harness_drift.sh (agent tree-diff at ~556,
# skill tree-diff at ~912). REGISTRY-NOTICE.md is the TD-202 vendored-
# copy sidecar — excluded from hash basis so its presence in the
# registry copy (and absence at the operator's source) does not flip
# the hash → DRIFTED.
EXACT = {"MAINTAINING.md", ".DS_Store", "node_modules", ".venv", "__pycache__", "REGISTRY-NOTICE.md"}


def skipped(name):
    if name in EXACT:
        return True
    if name.startswith(".git"):
        return True  # .git, .gitignore, .gitkeep, .github
    if name.endswith(".pyc"):
        return True
    return False


tree = sys.argv[1]
rels = []
if os.path.isdir(tree):
    for root, dirs, files in os.walk(tree):
        # Filter dirs IN-PLACE so os.walk does not descend into skipped dirs
        # (matches the TS recursive walk's pre-recursion skip check).
        dirs[:] = [d for d in dirs if not skipped(d)]
        for f in files:
            if skipped(f):
                continue
            abs_path = os.path.join(root, f)
            rel = os.path.relpath(abs_path, tree).replace(os.sep, "/")
            # FR-152 / FR-158 / FR-159 / FR-171: exclude per-harness α-assembled
            # outputs from the basis (top-level `harness.claude.md` /
            # `harness.gemini.md` / `harness.codex.toml` / `harness.opencode.md`
            # only — a nested file by either name would be legitimate operator
            # content, same as the TS side).
            if rel in ("harness.claude.md", "harness.gemini.md", "harness.codex.toml", "harness.opencode.md"):
                continue
            rels.append(rel)

rels.sort()
h = hashlib.sha256()
for rel in rels:
    h.update(rel.encode("utf-8"))
    h.update(b"\x00")
    with open(os.path.join(tree, rel), "rb") as fh:
        h.update(fh.read())
print(h.hexdigest())
PY
}

# ---------------------------------------------------------------------------
# validate_manifest <manifest-path> <schema-path>
#
# Validates a harness manifest against the JSON Schema (FR-136). Two code
# paths, chosen at runtime:
#   1. If `python3 -c "import jsonschema"` succeeds -> full JSON Schema
#      validation against the schema file (authoritative).
#   2. Otherwise -> a structural fallback that asserts the load-bearing
#      contract WITHOUT the jsonschema dependency: required top-level keys
#      (version, agents), version == 1, each agent has name/canonical/targets,
#      each target type is in {claude, codex, gemini}, and the
#      versioned-glob / unversioned-file `oneOf` (versioned=true requires
#      canonical.glob; versioned=false requires canonical.file).
#
# This helper NEVER no-ops: when jsonschema is absent the structural check
# still runs. On failure it prints a clear, actionable message naming the
# offending field/agent and returns non-zero. Returns 0 on a valid manifest.
# Dependency posture matches the rest of _common.sh: python3 only, no jq.
# ---------------------------------------------------------------------------
validate_manifest() {
  local manifest="$1"
  local schema="$2"
  if [ ! -f "$manifest" ]; then
    echo "Error: manifest '$manifest' does not exist" >&2
    return 1
  fi
  python3 - "$manifest" "$schema" <<'PY'
import json
import sys

manifest_path = sys.argv[1]
schema_path = sys.argv[2]


def fail(msg: str) -> None:
    sys.stderr.write(f"Manifest validation failed ({manifest_path}): {msg}\n")
    sys.exit(1)


try:
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
except json.JSONDecodeError as exc:
    fail(f"not valid JSON: {exc}")
except OSError as exc:
    fail(f"cannot read manifest: {exc}")

try:
    import jsonschema  # type: ignore
    have_jsonschema = True
except Exception:
    have_jsonschema = False

if have_jsonschema:
    try:
        with open(schema_path, "r", encoding="utf-8") as fh:
            schema = json.load(fh)
    except OSError as exc:
        fail(f"cannot read schema '{schema_path}': {exc}")
    try:
        jsonschema.validate(instance=manifest, schema=schema)
    except jsonschema.ValidationError as exc:
        loc = "/".join(str(p) for p in exc.absolute_path) or "<root>"
        fail(f"at '{loc}': {exc.message}")
    sys.exit(0)

# ---- Structural fallback (no jsonschema available) ----
if not isinstance(manifest, dict):
    fail("top-level value must be an object")

for required_key in ("version", "agents"):
    if required_key not in manifest:
        fail(f"missing required top-level key '{required_key}'")

if manifest["version"] != 1:
    fail(f"'version' must be 1 (got {manifest['version']!r})")

allowed_top = {"$schema", "_comment", "_schema", "_harnesses_comment",
               "version", "harnesses", "agents", "surfaces"}
for key in manifest:
    if key not in allowed_top:
        fail(f"unknown top-level key '{key}' (additionalProperties:false)")

# TD-244 (BI-3): structural validation of the per-harness `delegation_model`
# descriptor map. Mirrors the `harnesses` $def in manifest.schema.json so the
# structural fallback AGREES with the jsonschema path. Absent → native-static
# default (no delegation recipe). Each key must be a known harness type; each value an
# object with only an optional `delegation_model` ∈ {native-static, dynamic-define}.
harnesses = manifest.get("harnesses")
if harnesses is not None:
    if not isinstance(harnesses, dict):
        fail("'harnesses' must be an object")
    valid_harness_types = {"claude", "codex", "gemini", "opencode", "antigravity"}
    valid_delegation_models = {"native-static", "dynamic-define"}
    for hkey, hval in harnesses.items():
        if hkey not in valid_harness_types:
            fail(f"harnesses: unknown harness type '{hkey}' "
                 f"(must be one of {sorted(valid_harness_types)})")
        if not isinstance(hval, dict):
            fail(f"harnesses['{hkey}'] must be an object")
        for key in hval:
            if key != "delegation_model":
                fail(f"harnesses['{hkey}']: unknown key '{key}' "
                     "(additionalProperties:false; only 'delegation_model' allowed)")
        dm = hval.get("delegation_model")
        if dm is not None and dm not in valid_delegation_models:
            fail(f"harnesses['{hkey}'].delegation_model '{dm}' is not one of "
                 f"{sorted(valid_delegation_models)}")

agents = manifest["agents"]
if not isinstance(agents, list):
    fail("'agents' must be an array")

valid_target_types = {"claude", "codex", "gemini", "opencode"}
# FR-155: `scope` is allowed on agent + skills_surface entries. Absent → global
# (default, back-compat). The structural shape ({type:"global"} OR
# {type:"project", paths:[...]}) is validated by validate_scope_shape below.
allowed_agent_keys = {"name", "layer", "canonical", "body_exception", "scope",
                      "targets"}
allowed_canon_keys = {"dir", "glob", "file", "versioned"}
allowed_target_keys = {"type", "path"}


def validate_scope_shape(scope, where):
    """FR-155: structural validate of the `scope` field. Mirrors `$defs.scope`
    in manifest.schema.json: oneOf {type:"global"} OR
    {type:"project", paths:[non-empty array of strings]}.
    `additionalProperties:false`. The caller is responsible for `where` (the
    breadcrumb prefix). Returns on success; calls `fail` otherwise.
    """
    if not isinstance(scope, dict):
        fail(f"{where}.scope must be an object")
    t = scope.get("type")
    if t == "global":
        allowed = {"type"}
        for key in scope:
            if key not in allowed:
                fail(f"{where}.scope: unknown key '{key}' "
                     "(additionalProperties:false; scope.type=global allows only 'type')")
    elif t == "project":
        allowed = {"type", "paths"}
        for key in scope:
            if key not in allowed:
                fail(f"{where}.scope: unknown key '{key}' "
                     "(additionalProperties:false; scope.type=project allows only 'type'+'paths')")
        if "paths" not in scope:
            fail(f"{where}.scope: type=project requires 'paths'")
        paths = scope["paths"]
        if not isinstance(paths, list) or len(paths) < 1:
            fail(f"{where}.scope.paths must be a non-empty array")
        for k, p in enumerate(paths):
            if not isinstance(p, str):
                fail(f"{where}.scope.paths[{k}] must be a string")
    else:
        fail(f"{where}.scope.type '{t!r}' is not one of ['global', 'project']")

for i, agent in enumerate(agents):
    where = f"agents[{i}]"
    if not isinstance(agent, dict):
        fail(f"{where} must be an object")
    for req in ("name", "canonical", "targets"):
        if req not in agent:
            fail(f"{where} missing required key '{req}'")
    name = agent["name"]
    where = f"agents[{i}] ('{name}')"
    for key in agent:
        if key not in allowed_agent_keys:
            fail(f"{where}: unknown key '{key}' (additionalProperties:false)")

    canon = agent["canonical"]
    if not isinstance(canon, dict):
        fail(f"{where}.canonical must be an object")
    for req in ("dir", "versioned"):
        if req not in canon:
            fail(f"{where}.canonical missing required key '{req}'")
    for key in canon:
        if key not in allowed_canon_keys:
            fail(f"{where}.canonical: unknown key '{key}' "
                 "(additionalProperties:false)")
    versioned = canon["versioned"]
    if not isinstance(versioned, bool):
        fail(f"{where}.canonical.versioned must be a boolean")
    if versioned and "glob" not in canon:
        fail(f"{where}.canonical: versioned=true requires 'glob'")
    if not versioned and "file" not in canon:
        fail(f"{where}.canonical: versioned=false requires 'file'")

    targets = agent["targets"]
    if not isinstance(targets, list) or len(targets) < 1:
        fail(f"{where}.targets must be a non-empty array")
    for j, target in enumerate(targets):
        twhere = f"{where}.targets[{j}]"
        if not isinstance(target, dict):
            fail(f"{twhere} must be an object")
        for req in ("type", "path"):
            if req not in target:
                fail(f"{twhere} missing required key '{req}'")
        for key in target:
            if key not in allowed_target_keys:
                fail(f"{twhere}: unknown key '{key}' "
                     "(additionalProperties:false)")
        if target["type"] not in valid_target_types:
            fail(f"{twhere}.type '{target['type']}' is not one of "
                 f"{sorted(valid_target_types)}")

    # FR-155: optional scope.
    if "scope" in agent:
        validate_scope_shape(agent["scope"], where)

# ---- FR-137: structural validation of the surfaces.skills sub-shape --------
# The structural fallback (no jsonschema) previously did NOT recurse into
# `surfaces`, so a malformed surfaces block passed silently. Validate the
# skills surface here so the "schema validates surfaces" contract holds in
# BOTH code paths. os_context is left permissive (RESERVED for FR-140).
surfaces = manifest.get("surfaces")
if surfaces is not None:
    if not isinstance(surfaces, dict):
        fail("'surfaces' must be an object")
    allowed_surface_keys = {"skills", "mcp_servers", "hooks", "os_context"}
    for key in surfaces:
        if key not in allowed_surface_keys:
            fail(f"surfaces: unknown key '{key}' (additionalProperties:false)")

    # TD-191: `surfaces.skills` is now an array of blocks (multi-source). The
    # normalizer wraps a legacy single-object value as `[object]` so loaders
    # accept stale overlays without a version bump. The jsonschema path uses
    # the schema's array-only contract directly; this structural fallback
    # mirrors it (the schema is the source of truth, validate_manifest just
    # has to agree).
    skills = surfaces.get("skills")
    if skills is not None:
        if isinstance(skills, dict):
            skills_blocks = [skills]
        elif isinstance(skills, list):
            skills_blocks = skills
        else:
            fail("surfaces.skills must be an array of blocks "
                 "(or a single legacy object — both normalize)")
        if len(skills_blocks) < 1:
            fail("surfaces.skills must be a non-empty array")
        # FR-149/FR-151/FR-153/FR-171/FR-202: the per-type method allowlist
        # (claude/symlink, agents/symlink, opencode/command) is enforced via
        # `valid_pairs` below — mirrors the `oneOf` constraint in
        # manifest.schema.json so both validation paths agree. FR-202 (M1):
        # the dead codex/symlink + gemini/symlink standalone pairs (superseded
        # by agents/symlink under FR-157 — codex+gemini read the `~/.agents/
        # skills/` projection natively) and the long-retired codex/compiler
        # (AGENTS.md aggregator) + gemini/converter (per-skill TOML) methods
        # were dropped here in lockstep with the schema. No live manifest
        # declared any removed value, so every live validate_manifest call still
        # passes identically; only the rejected set narrows. See L-519.
        valid_skill_types = {"claude", "agents", "opencode"}
        valid_skill_methods = {"symlink", "command"}
        valid_pairs = {("claude", "symlink"),
                       ("agents", "symlink"),
                       ("opencode", "command")}
        allowed_skill_target_keys = {"type", "method", "path"}
        # FR-155: `scope` is allowed on a skills_surface block (same shape as
        # on an agent entry). Absent → global (default, back-compat).
        allowed_skills_keys = {"source", "layer", "scope", "targets"}
        for b_idx, skills_block in enumerate(skills_blocks):
            bwhere = f"surfaces.skills[{b_idx}]"
            if not isinstance(skills_block, dict):
                fail(f"{bwhere} must be an object")
            for key in skills_block:
                if key not in allowed_skills_keys:
                    fail(f"{bwhere}: unknown key '{key}' "
                         "(additionalProperties:false)")
            if "targets" not in skills_block:
                fail(f"{bwhere} missing required key 'targets'")
            s_targets = skills_block["targets"]
            if not isinstance(s_targets, list) or len(s_targets) < 1:
                fail(f"{bwhere}.targets must be a non-empty array")
            for k, st in enumerate(s_targets):
                stwhere = f"{bwhere}.targets[{k}]"
                if not isinstance(st, dict):
                    fail(f"{stwhere} must be an object")
                for req in ("type", "method", "path"):
                    if req not in st:
                        fail(f"{stwhere} missing required key '{req}'")
                for key in st:
                    if key not in allowed_skill_target_keys:
                        fail(f"{stwhere}: unknown key '{key}' "
                             "(additionalProperties:false)")
                if st["type"] not in valid_skill_types:
                    fail(f"{stwhere}.type '{st['type']}' is not one of "
                         f"{sorted(valid_skill_types)}")
                if st["method"] not in valid_skill_methods:
                    fail(f"{stwhere}.method '{st['method']}' is not one of "
                         f"{sorted(valid_skill_methods)}")
                # FR-153: per-type method allowlist (mirrors schema `oneOf`).
                pair = (st["type"], st["method"])
                if pair not in valid_pairs:
                    fail(f"{stwhere}: type/method pair "
                         f"'{st['type']}/{st['method']}' is not allowed; "
                         "valid pairs: claude/symlink, agents/symlink, "
                         "opencode/command")
            # FR-155: optional scope on the skills_surface block.
            if "scope" in skills_block:
                validate_scope_shape(skills_block["scope"], bwhere)

    # ---- FR-161 (FR-160 epic): structural validation of surfaces.mcp_servers
    # ARRAY of mcp_surface blocks. Mirrors $defs.mcp_surface so the structural
    # fallback AGREES with the jsonschema path (the parity loop integration
    # test #11 asserts). SEPARATE 4-harness target enum (opencode added); the
    # method is the const "merge". v1 is GLOBAL-ONLY — scope is accepted for
    # forward-compat but consumers treat every block as global.
    mcp_servers = surfaces.get("mcp_servers")
    if mcp_servers is not None:
        if not isinstance(mcp_servers, list):
            fail("surfaces.mcp_servers must be a non-empty array")
        if len(mcp_servers) < 1:
            fail("surfaces.mcp_servers must be a non-empty array")
        valid_mcp_target_types = {"claude", "codex", "gemini", "opencode", "antigravity"}
        allowed_mcp_keys = {"name", "layer", "scope", "canonical", "targets"}
        allowed_mcp_canon_keys = {"command", "args", "env", "startup_timeout_sec"}
        allowed_mcp_target_keys = {"type", "method", "enabled"}
        for m_idx, mcp_block in enumerate(mcp_servers):
            mwhere = f"surfaces.mcp_servers[{m_idx}]"
            if not isinstance(mcp_block, dict):
                fail(f"{mwhere} must be an object")
            for key in mcp_block:
                if key not in allowed_mcp_keys:
                    fail(f"{mwhere}: unknown key '{key}' "
                         "(additionalProperties:false)")
            for req in ("name", "canonical", "targets"):
                if req not in mcp_block:
                    fail(f"{mwhere} missing required key '{req}'")

            canon = mcp_block["canonical"]
            if not isinstance(canon, dict):
                fail(f"{mwhere}.canonical must be an object")
            for key in canon:
                if key not in allowed_mcp_canon_keys:
                    fail(f"{mwhere}.canonical: unknown key '{key}' "
                         "(additionalProperties:false)")
            if "command" not in canon or not isinstance(canon["command"], str):
                fail(f"{mwhere}.canonical.command is required and must be a string")

            m_targets = mcp_block["targets"]
            if not isinstance(m_targets, list) or len(m_targets) < 1:
                fail(f"{mwhere}.targets must be a non-empty array")
            for k, mt in enumerate(m_targets):
                mtwhere = f"{mwhere}.targets[{k}]"
                if not isinstance(mt, dict):
                    fail(f"{mtwhere} must be an object")
                for req in ("type", "method"):
                    if req not in mt:
                        fail(f"{mtwhere} missing required key '{req}'")
                for key in mt:
                    if key not in allowed_mcp_target_keys:
                        fail(f"{mtwhere}: unknown key '{key}' "
                             "(additionalProperties:false)")
                if mt["type"] not in valid_mcp_target_types:
                    fail(f"{mtwhere}.type '{mt['type']}' is not one of "
                         f"{sorted(valid_mcp_target_types)}")
                if mt["method"] != "merge":
                    fail(f"{mtwhere}.method '{mt['method']}' must be 'merge'")

            # v1 GLOBAL-ONLY: scope accepted for forward-compat (consumers
            # treat every block as global). Same structural shape as agents.
            if "scope" in mcp_block:
                validate_scope_shape(mcp_block["scope"], mwhere)

    # ---- FR-180 (D7): structural validation of surfaces.hooks ----------------
    # ARRAY of hook_surface blocks. Mirrors $defs.hook_surface so the structural
    # fallback AGREES with the jsonschema path (parity loop integration test).
    # Targets carry the 2-harness enum (claude + opencode — the two with a
    # native hook MERGE surface), the const method "merge", and `event` is one
    # of the six portable events the canonical-settings.json block declares.
    hooks = surfaces.get("hooks")
    if hooks is not None:
        if not isinstance(hooks, list) or len(hooks) < 1:
            fail("surfaces.hooks must be a non-empty array")
        valid_hook_events = {"SessionStart", "SessionEnd", "PreToolUse",
                             "PostToolUse", "PreCompact", "PostCompact"}
        valid_hook_target_types = {"claude", "opencode", "antigravity"}
        allowed_hook_keys = {"name", "event", "layer", "scope", "canonical",
                             "targets"}
        allowed_hook_canon_keys = {"command", "matcher", "timeout"}
        allowed_hook_target_keys = {"type", "method", "enabled"}
        for h_idx, hook_block in enumerate(hooks):
            hwhere = f"surfaces.hooks[{h_idx}]"
            if not isinstance(hook_block, dict):
                fail(f"{hwhere} must be an object")
            for key in hook_block:
                if key not in allowed_hook_keys:
                    fail(f"{hwhere}: unknown key '{key}' "
                         "(additionalProperties:false)")
            for req in ("name", "event", "canonical", "targets"):
                if req not in hook_block:
                    fail(f"{hwhere} missing required key '{req}'")
            if hook_block["event"] not in valid_hook_events:
                fail(f"{hwhere}.event '{hook_block['event']}' is not one of "
                     f"{sorted(valid_hook_events)}")

            canon = hook_block["canonical"]
            if not isinstance(canon, dict):
                fail(f"{hwhere}.canonical must be an object")
            for key in canon:
                if key not in allowed_hook_canon_keys:
                    fail(f"{hwhere}.canonical: unknown key '{key}' "
                         "(additionalProperties:false)")
            if "command" not in canon or not isinstance(canon["command"], str) \
                    or not canon["command"]:
                fail(f"{hwhere}.canonical.command is required and must be a "
                     "non-empty string")

            h_targets = hook_block["targets"]
            if not isinstance(h_targets, list) or len(h_targets) < 1:
                fail(f"{hwhere}.targets must be a non-empty array")
            for k, ht in enumerate(h_targets):
                htwhere = f"{hwhere}.targets[{k}]"
                if not isinstance(ht, dict):
                    fail(f"{htwhere} must be an object")
                for req in ("type", "method"):
                    if req not in ht:
                        fail(f"{htwhere} missing required key '{req}'")
                for key in ht:
                    if key not in allowed_hook_target_keys:
                        fail(f"{htwhere}: unknown key '{key}' "
                             "(additionalProperties:false)")
                if ht["type"] not in valid_hook_target_types:
                    fail(f"{htwhere}.type '{ht['type']}' is not one of "
                         f"{sorted(valid_hook_target_types)}")
                if ht["method"] != "merge":
                    fail(f"{htwhere}.method '{ht['method']}' must be 'merge'")

            # v1 GLOBAL-ONLY: scope accepted for forward-compat.
            if "scope" in hook_block:
                validate_scope_shape(hook_block["scope"], hwhere)

sys.exit(0)
PY
}

# ---------------------------------------------------------------------------
# merge_overlay_manifest <base-manifest> <overlay-manifest-or-empty>
#
# Implements the FR-136 base+overlay merge seam (the FR-139 registry seam,
# plan section 2 Option B). Emits to stdout a merged manifest JSON whose
# `agents[]` is base.agents ++ overlay.agents. The base manifest is the
# Layer-1 (public, in-repo) data; the overlay is an OPTIONAL gitignored
# Layer-2 (personal/customization) file in the runtime registry.
#
# Guard: a personal (overlay) agent whose `name` collides with a base agent
# name is a HARD ERROR (returns non-zero) - a customization must never
# silently shadow a core agent. FR-139 inherits this guard for free.
#
# FR-137: the overlay may ALSO carry a `surfaces.skills` block whose
# `targets[]` are merged additively into the base `surfaces.skills.targets[]`
# (the FR-139 seam for projecting personal skills). A personal skill-target
# whose `path` collides with a base (core) skill-target `path` is the same
# HARD ERROR - a personal skill must not silently shadow a core skill. When
# the base has no `surfaces.skills`, the overlay's block becomes the merged
# one (still permissive enough that an absent overlay surfaces block is fine).
#
# When the overlay path is empty or absent, emits the base manifest verbatim.
# Returns 0 on success, non-zero on a name/path collision or read error.
# ---------------------------------------------------------------------------
merge_overlay_manifest() {
  local base="$1"
  local overlay="${2:-}"
  if [ -z "$overlay" ] || [ ! -f "$overlay" ]; then
    cat "$base"
    return 0
  fi
  python3 - "$base" "$overlay" <<'PY'
import json
import sys

base_path = sys.argv[1]
overlay_path = sys.argv[2]

with open(base_path, "r", encoding="utf-8") as fh:
    base = json.load(fh)
with open(overlay_path, "r", encoding="utf-8") as fh:
    overlay = json.load(fh)

base_agents = base.get("agents", [])
overlay_agents = overlay.get("agents", [])

base_names = {a.get("name") for a in base_agents}
for agent in overlay_agents:
    nm = agent.get("name")
    if nm in base_names:
        sys.stderr.write(
            f"Error: overlay agent '{nm}' collides with a base (core) agent "
            "name; a personal customization must not shadow a core agent.\n"
        )
        sys.exit(1)

merged = dict(base)
merged["agents"] = list(base_agents) + list(overlay_agents)

# FR-137 / TD-191 / BR-074: merge surfaces.skills as a MULTI-BLOCK ARRAY.
# Personal blocks compile ALONGSIDE core (each carries its own source/layer/
# targets), so the merge is a simple concatenation rather than the legacy "keep
# base source + union targets" model. A target `path` is a consumer ROOT, not the
# final per-skill output path; sibling personal blocks may share it because the
# compiler appends each skill name below that root. Base/core target roots remain
# reserved and still collide with overlay roots. Legacy single-object blocks
# normalize to `[object]` so back-compat holds without a version bump.
def _normalize_skills(value):
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return list(value)
    sys.stderr.write(
        "Error: surfaces.skills must be an array of blocks (or a single "
        "legacy object — both normalize)\n"
    )
    sys.exit(1)


base_surfaces = base.get("surfaces", {}) or {}
overlay_surfaces = overlay.get("surfaces", {}) or {}
base_blocks = _normalize_skills(base_surfaces.get("skills"))
overlay_blocks = _normalize_skills(overlay_surfaces.get("skills"))

# `merged_surfaces` accumulates the skills, the FR-164 mcp_servers, and the
# FR-180 (D7) hooks merges, so each is independent (an overlay carrying only one
# of them still reaches the merged manifest). Start from the base surfaces and
# overlay each block family in turn.
merged_surfaces = None

if base_blocks or overlay_blocks:
    merged_skill_blocks = list(base_blocks) + list(overlay_blocks)
    # Core path-collision guard: a personal skill-target root must not shadow
    # a core/base root. Overlay-vs-overlay reuse is valid: two personal skill
    # blocks can share ~/.agents/skills because they emit distinct
    # ~/.agents/skills/<skill-name> children.
    base_paths = {}
    for b_idx, block in enumerate(base_blocks):
        for t in (block or {}).get("targets", []) or []:
            p = (t or {}).get("path")
            if p is None:
                continue
            base_paths.setdefault(p, b_idx)
    for o_idx, block in enumerate(overlay_blocks):
        for t in (block or {}).get("targets", []) or []:
            p = (t or {}).get("path")
            if p is None:
                continue
            if p in base_paths:
                prev = base_paths[p]
                merged_idx = len(base_blocks) + o_idx
                sys.stderr.write(
                    f"Error: skill-target path '{p}' collides between "
                    f"core surfaces.skills[{prev}] and overlay "
                    f"surfaces.skills[{merged_idx}]; a personal skill must "
                    "not shadow a core skill-target root.\n"
                )
                sys.exit(1)
    merged_surfaces = dict(base_surfaces)
    merged_surfaces["skills"] = merged_skill_blocks

# FR-164 (FR-160 epic): merge surfaces.mcp_servers as a MULTI-BLOCK ARRAY
# (base ++ overlay), mirroring the skills concat. WITHOUT this, a personal MCP
# block written by `add-mcp` into the overlay would never reach the compile/
# drift flatten (finding #2 gap). MCP identity is the block NAME — a personal
# (overlay) block whose `name` collides with a base (core) block is a HARD
# error (the analogue of the agent name-collision guard). Always normalizes
# missing/single/list shapes; an absent mcp_servers surface contributes [].
def _normalize_mcp(value):
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return list(value)
    sys.stderr.write(
        "Error: surfaces.mcp_servers must be an array of blocks (or a single "
        "object — both normalize)\n"
    )
    sys.exit(1)


base_mcp = _normalize_mcp(base_surfaces.get("mcp_servers"))
overlay_mcp = _normalize_mcp(overlay_surfaces.get("mcp_servers"))

if base_mcp or overlay_mcp:
    base_mcp_names = {m.get("name") for m in base_mcp}
    for block in overlay_mcp:
        nm = (block or {}).get("name")
        if nm in base_mcp_names:
            sys.stderr.write(
                f"Error: overlay mcp_servers block '{nm}' collides with a base "
                "(core) block name; a personal customization must not shadow a "
                "core MCP server.\n"
            )
            sys.exit(1)
    if merged_surfaces is None:
        merged_surfaces = dict(base_surfaces)
    merged_surfaces["mcp_servers"] = list(base_mcp) + list(overlay_mcp)

# FR-180 (D7): merge surfaces.hooks as a MULTI-BLOCK ARRAY (base ++ overlay),
# mirroring the skills + mcp_servers concat. WITHOUT this a
# personal hook block written by `igris add hook` into the overlay would never
# reach the compile/drift flatten (the same finding-#2 gap). A hook block IS
# keyed on its `name`, so a personal (overlay) block whose `name` collides with
# a base (core) block is a HARD error (the analogue of the agent / mcp name
# guard). SEPARATELY, two blocks must never both own the same (event, target
# type) cell — that would mean two Igris hooks fighting for the same harness
# event slot — so an (event, type) cross-block collision is ALSO a hard error.
def _normalize_hooks(value):
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return list(value)
    sys.stderr.write(
        "Error: surfaces.hooks must be an array of blocks (or a single "
        "object - both normalize)\n"
    )
    sys.exit(1)


base_hooks = _normalize_hooks(base_surfaces.get("hooks"))
overlay_hooks = _normalize_hooks(overlay_surfaces.get("hooks"))

if base_hooks or overlay_hooks:
    base_hook_names = {h.get("name") for h in base_hooks}
    for block in overlay_hooks:
        nm = (block or {}).get("name")
        if nm in base_hook_names:
            sys.stderr.write(
                f"Error: overlay hooks block '{nm}' collides with a base "
                "(core) block name; a personal customization must not shadow a "
                "core hook.\n"
            )
            sys.exit(1)
    merged_hook_blocks = list(base_hooks) + list(overlay_hooks)
    # Cross-block (event, target type) collision guard.
    seen_hook_cells = {}
    for b_idx, block in enumerate(merged_hook_blocks):
        ev = (block or {}).get("event")
        for t in (block or {}).get("targets", []) or []:
            ttype = (t or {}).get("type")
            if ev is None or ttype is None:
                continue
            cell = (ev, ttype)
            if cell in seen_hook_cells:
                prev = seen_hook_cells[cell]
                sys.stderr.write(
                    f"Error: hook cell ({ev}, {ttype}) collides between "
                    f"surfaces.hooks[{prev}] and surfaces.hooks[{b_idx}]; two "
                    "hooks must not both own the same event in the same harness "
                    "(a personal hook must not shadow a core one, nor a sibling "
                    "personal one).\n"
                )
                sys.exit(1)
            seen_hook_cells[cell] = b_idx
    if merged_surfaces is None:
        merged_surfaces = dict(base_surfaces)
    merged_surfaces["hooks"] = merged_hook_blocks

if merged_surfaces is not None:
    merged["surfaces"] = merged_surfaces

sys.stdout.write(json.dumps(merged))
PY
}

# ---------------------------------------------------------------------------
# FR-180 (S1): shared skill-name filter predicate.
#
# skill_name_matches_filter <skill-name> <name-glob>
#
# Returns 0 (keep) iff <name-glob> is the wildcard `*` (no filter) OR <skill-
# name> matches the glob. Returns 1 (skip) otherwise. Used by the per-skill
# walk in BOTH compile_harnesses.sh and check_harness_drift.sh so `--filter`
# scopes the SKILLS surface the same way it already scopes the AGENTS surface
# (the agent flatten applies `fnmatch` to the agent name). This is what makes
# `igris add`'s scoped verify (S1) real: the check pass re-checks ONLY the
# just-added skill, so pre-existing unrelated skill drift can't false-fail a
# clean add. §18.1: ONE helper, identical application on both sides.
# ---------------------------------------------------------------------------
skill_name_matches_filter() {
  local skill_name="$1"
  local name_glob="$2"
  # `*` (or empty) → no filter → always keep. Otherwise shell case-glob match
  # (same matcher class as the agent flatten's python fnmatch — case-glob is
  # the bash-native equivalent for the simple globs --filter accepts).
  if [ -z "$name_glob" ] || [ "$name_glob" = "*" ]; then
    return 0
  fi
  case "$skill_name" in
    $name_glob) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# FR-180 (TD-235 / D5): shared core-ownership predicate.
#
# core_surfaces_owned <core-surfaces-path> <project-root>
#
# Returns 0 (owned) iff the realpath of <core-surfaces-path> is contained under
# the realpath of <project-root> — the SAME `os.path.commonpath` ownership
# signal the skills / mcp flatten gates use to decide whether to
# union the core surfaces-manifest.json. Returns 1 (not owned) otherwise, and
# also on any realpath/commonpath failure (safe default → core surfaces are
# NOT unioned for an unrelated project).
#
# This is a DIAGNOSTIC predicate only — it does NOT change what the flatten
# gates project (those keep their own in-Python commonpath check verbatim, so
# the projected bytes are unchanged). compile/drift use it to decide between a
# LOUD core-skip FAIL (the run EXPECTED core surfaces) and a visible-but-exit-0
# SKIPPED line (an incidental personal-project compile). §18.1: ONE shared
# helper used by BOTH compile_harnesses.sh and check_harness_drift.sh.
# ---------------------------------------------------------------------------
core_surfaces_owned() {
  local core_surfaces="$1"
  local project_root="$2"
  python3 - "$core_surfaces" "$project_root" <<'PY'
import os
import sys

core_surfaces_path = sys.argv[1]
project_root = sys.argv[2]

try:
    cs_real = os.path.realpath(core_surfaces_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sys.exit(0)
except (OSError, ValueError):
    pass
sys.exit(1)
PY
}

# ---------------------------------------------------------------------------
# FR-180 (TD-235 / D5): does the (merged + core) manifest set DECLARE any core
# skills block at all? Used to decide whether a core-skip diagnostic is even
# relevant — if the core surfaces-manifest.json declares no skills targets,
# there is nothing to skip and no diagnostic is emitted. Reads the core
# surfaces file only (the personal overlay is always unioned regardless of
# ownership, so it is never the thing being skipped).
#
# core_skills_declared <core-surfaces-path>
#   Returns 0 if the core surfaces-manifest.json declares ≥1 skills block with
#   ≥1 target; 1 otherwise (or on read error).
# ---------------------------------------------------------------------------
core_skills_declared() {
  local core_surfaces="$1"
  python3 - "$core_surfaces" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
except OSError:
    sys.exit(1)

value = (data.get("surfaces") or {}).get("skills")
if value is None:
    sys.exit(1)
blocks = [value] if isinstance(value, dict) else (value if isinstance(value, list) else [])
for block in blocks:
    if isinstance(block, dict) and (block.get("targets") or []):
        sys.exit(0)
sys.exit(1)
PY
}

# ---------------------------------------------------------------------------
# FR-164 (FR-160 epic): MCP projection helpers (shared by compile + drift).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# flatten_mcp_rows <merged-manifest> <core-surfaces> <target-kind> <project-root>
#
# Emits one TAB-separated row per (mcp-block, target). Mirrors the skills
# flatten (compile_harnesses.sh): the core surfaces-manifest.json is only
# unioned when the project being compiled OWNS it (its realpath is under
# --project-root). Rows are filtered by <target-kind> (the per-target emit
# gate); "all" emits every target.
#
# Row columns (TAB-separated, fixed order):
#   name <TAB> canonical_json <TAB> target_type <TAB> enabled <TAB>
#   scope_type <TAB> scope_paths_csv
#
# `canonical_json` is the block's canonical launch spec as compact JSON (it can
# carry tabs/newlines only inside JSON strings, which compact json.dumps
# escapes — so the column stays a single physical line, safe for IFS=$'\t'
# read). It NEVER contains a resolved secret — `canonical.env` holds the
# ${VAR} REFERENCE; the literal is resolved only inside the TS projector /
# drift compare, never in this row. `enabled` is `true`/`false`/`-` (sentinel
# for absent). `scope_paths_csv` uses the `-` empty sentinel (mirrors skills).
# v1 is GLOBAL-ONLY — scope columns are emitted for forward-compat but every
# consumer treats blocks as global.
# ---------------------------------------------------------------------------
flatten_mcp_rows() {
  local merged="$1"
  local core_surfaces="$2"
  local target_kind="$3"
  local project_root="$4"
  python3 - "$core_surfaces" "$merged" "$target_kind" "$project_root" <<'PY'
import json
import os
import sys

core_surfaces_path = sys.argv[1]
merged_manifest_path = sys.argv[2]
target_kind = sys.argv[3]
project_root = sys.argv[4]


def load_mcp(path):
    # Returns a LIST of mcp_servers blocks. Legacy single-object normalized to
    # `[object]`; missing/absent → []. Mirrors merge_overlay_manifest's
    # _normalize_mcp + the skills loader shape.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return []
    value = (data.get("surfaces") or {}).get("mcp_servers")
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return value
    return []


# The core surfaces-manifest.json declares GLOBAL Layer-1 surfaces. It is only
# unioned when the project being compiled OWNS it (its realpath is under
# --project-root) — identical posture to the skills flatten. The merged agent
# manifest (incl. the FR-139 personal overlay) is always read.
sources = [merged_manifest_path]
try:
    cs_real = os.path.realpath(core_surfaces_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, core_surfaces_path)
except (OSError, ValueError):
    pass

for src in sources:
    for block in load_mcp(src):
        if not isinstance(block, dict):
            continue
        name = block.get("name", "")
        if not name:
            continue
        canonical = block.get("canonical") or {}
        # Compact JSON (no spaces) keeps the column on one physical line; any
        # embedded control chars inside JSON strings are escaped by json.dumps.
        canonical_json = json.dumps(canonical, separators=(",", ":"))
        # FR-155-style scope columns (absent → global). v1 consumers treat all
        # as global, but we carry them for forward-compat + row-shape parity
        # with the skills flatten.
        scope = block.get("scope") or {}
        scope_type = scope.get("type") or "global"
        scope_paths_list = scope.get("paths") or []
        scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
        for t in block.get("targets", []) or []:
            ttype = (t or {}).get("type", "")
            if not ttype:
                continue
            if target_kind != "all" and ttype != target_kind:
                continue
            enabled = (t or {}).get("enabled")
            if enabled is True:
                enabled_col = "true"
            elif enabled is False:
                enabled_col = "false"
            else:
                enabled_col = "-"
            print("\t".join([
                name,
                canonical_json,
                ttype,
                enabled_col,
                scope_type,
                scope_paths_csv,
            ]))
PY
}

# ---------------------------------------------------------------------------
# extract_mcp_entry <config-path> <map-key> <name>
#
# Drift-side reader: reads the harness config (JSON for claude/gemini/opencode,
# TOML for codex — dispatched by file extension), extracts the entry stored
# under <map-key>.<name>, and emits it as canonical compact JSON on stdout.
#
# Status is signaled via the EXIT CODE (NEVER by printing a secret):
#   0  → entry present; the entry JSON is on stdout.
#   10 → config file absent OR <map-key> map absent OR <name> entry absent
#        (MISSING). Stdout is empty.
#   11 → config file present but UNPARSEABLE (malformed JSON/TOML). Stdout is
#        empty. The caller maps this to a DRIFTED "unparseable" verdict.
#
# NEVER throws under `set -euo pipefail`: the python call's own rc is captured
# and re-emitted, never a stack trace. TOML is parsed via tomllib (py3.11+) or
# the `toml`/`tomli` shim; absent → treated as MISSING-safe (rc 10) so a host
# without a TOML parser never crashes drift.
# ---------------------------------------------------------------------------
extract_mcp_entry() {
  local config_path="$1"
  local map_key="$2"
  local name="$3"
  python3 - "$config_path" "$map_key" "$name" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
map_key = sys.argv[2]
name = sys.argv[3]

# Code 10 = MISSING (absent file / map / entry); 11 = malformed config.
if not os.path.exists(config_path):
    sys.exit(10)

is_toml = config_path.endswith(".toml")

try:
    if is_toml:
        data = None
        try:
            import tomllib  # py3.11+
            with open(config_path, "rb") as fh:
                data = tomllib.load(fh)
        except ImportError:
            loaded = False
            for mod in ("tomli", "toml"):
                try:
                    m = __import__(mod)
                    with open(config_path, "rb" if mod == "tomli" else "r",
                              encoding=None if mod == "tomli" else "utf-8") as fh:
                        data = m.load(fh)
                    loaded = True
                    break
                except ImportError:
                    continue
            if not loaded:
                # No TOML parser available — cannot read; treat as MISSING-safe
                # rather than crash drift on a host without tomllib.
                sys.exit(10)
    else:
        with open(config_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
except (ValueError, OSError):
    # Malformed JSON / TOML — DRIFTED "unparseable" (compile refuses to write).
    sys.exit(11)

if not isinstance(data, dict):
    sys.exit(11)

server_map = data.get(map_key)
if not isinstance(server_map, dict):
    sys.exit(10)

entry = server_map.get(name)
if entry is None:
    sys.exit(10)

sys.stdout.write(json.dumps(entry, separators=(",", ":"), sort_keys=True))
sys.exit(0)
PY
}

# ---------------------------------------------------------------------------
# normalize_mcp_shape <canonical-json> <harness> <enabled>
#
# The §18.1 / L-554 SHARED SHAPE HELPER. Given the canonical launch spec (as
# JSON) it emits the EXPECTED native per-harness entry as canonical compact
# JSON (sort_keys) — byte-identical to the TS `buildHarnessMcpEntry` (the
# golden-fixture + bats parity tests pin the two together).
#
# Per-harness shapes (finding #8):
#   claude   → {"type":"stdio","command":...,"args":[...],"env":{...}}
#   gemini   → {"command":...,"args":[...],"env":{...}}        (NO "type")
#   opencode → {"type":"local","command":[cmd,...args],"enabled":bool,
#               "environment":{...}}   (cmd+args FUSED; env KEY is "environment")
#   codex    → {"command":...,"args":[...],"env":{...}[,"startup_timeout_sec":n]}
#
# ENV VALUES are emitted as the REFERENCE per harness (NEVER a resolved secret):
#   claude/gemini → ${VAR} verbatim
#   opencode      → {env:VAR}
#   codex         → ${VAR} as the drift-comparison STAND-IN (the codex value-
#                   equality re-resolve happens in the drift compare, not here —
#                   so this helper NEVER reads secrets.env and NEVER emits a
#                   literal). A non-ref value passes through verbatim for all.
#
# `enabled` is "true"/"false"/"-" (the flatten sentinel); only opencode uses it
# (absent → defaults true). The output is what the drift compare deep-equals
# against the on-disk entry (with the codex env values swapped to literals at
# compare time by the caller, never here).
# ---------------------------------------------------------------------------
normalize_mcp_shape() {
  local canonical_json="$1"
  local harness="$2"
  local enabled="$3"
  python3 - "$canonical_json" "$harness" "$enabled" <<'PY'
import json
import re
import sys

canonical = json.loads(sys.argv[1])
harness = sys.argv[2]
enabled_col = sys.argv[3]

command = canonical.get("command", "")
args = canonical.get("args", []) or []
env = canonical.get("env", {}) or {}

# Canonical ${VAR} grammar (byte-identical to ENV_VAR_REF in secrets.ts /
# registry.ts) + opencode {env:VAR} grammar. Used only to translate the
# REFERENCE token per harness — a value is never resolved here.
VAR_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def var_name(value):
    m = VAR_RE.match(value)
    return m.group(1) if m else None


def env_for(value):
    if harness == "opencode":
        nm = var_name(value)
        return f"{{env:{nm}}}" if nm is not None else value
    # claude / gemini / antigravity / codex → emit the ${VAR} reference verbatim
    # (codex's literal re-resolve is the drift compare's job, not this helper's).
    return value


norm_env = {k: env_for(env[k]) for k in env}

if harness == "claude":
    entry = {"type": "stdio", "command": command, "args": args, "env": norm_env}
elif harness == "gemini":
    entry = {"command": command, "args": args, "env": norm_env}
elif harness == "antigravity":
    # FR-179: gemini-identical shape (no "type"; gemini lineage). Byte-for-byte
    # the same JSON as the gemini branch — only the config PATH differs (drift
    # side: ~/.gemini/config/mcp_config.json). Pinned by the §18.1 parity test.
    entry = {"command": command, "args": args, "env": norm_env}
elif harness == "opencode":
    en = True if enabled_col == "true" else (False if enabled_col == "false" else True)
    entry = {
        "type": "local",
        "command": [command] + list(args),
        "enabled": en,
        "environment": norm_env,
    }
elif harness == "codex":
    entry = {"command": command, "args": args, "env": norm_env}
    if "startup_timeout_sec" in canonical and canonical["startup_timeout_sec"] is not None:
        entry["startup_timeout_sec"] = canonical["startup_timeout_sec"]
else:
    sys.stderr.write(f"normalize_mcp_shape: unknown harness '{harness}'\n")
    sys.exit(2)

sys.stdout.write(json.dumps(entry, separators=(",", ":"), sort_keys=True))
PY
}

# ---------------------------------------------------------------------------
# FR-180 (D7 - Option B): event-hook projection helpers (shared by compile +
# drift). The hook surface projects ONE event-hook block per (block, target)
# into each harness's native hook surface — claude → .claude/settings.json
# `hooks.<Event>` array (config-MERGE, like MCP), opencode → the FR-104 plugin
# (documented; the plugin already routes the six events to the shared scripts).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# flatten_hook_rows <merged-manifest> <core-surfaces> <target-kind> <project-root>
#
# Emits one TAB-separated row per (hook-block, target). Mirrors flatten_mcp_rows:
# the core surfaces-manifest.json is only unioned when the project being compiled
# OWNS it (its realpath is under --project-root). Rows are filtered by
# <target-kind>; "all" emits every target.
#
# Row columns (TAB-separated, fixed order):
#   name <TAB> event <TAB> command <TAB> matcher <TAB> timeout <TAB>
#   target_type <TAB> enabled <TAB> layer <TAB> scope_type <TAB> scope_paths_csv
#
# `-` is the empty sentinel for matcher (→ no matcher), timeout (→ none),
# scope_paths. `enabled` is true/false/- (sentinel for absent). `layer` defaults
# to non-empty "core" (no tab-collapse risk). The command NEVER carries a
# secret — it is a script path the harness runs.
# ---------------------------------------------------------------------------
flatten_hook_rows() {
  local merged="$1"
  local core_surfaces="$2"
  local target_kind="$3"
  local project_root="$4"
  python3 - "$core_surfaces" "$merged" "$target_kind" "$project_root" <<'PY'
import json
import os
import sys

core_surfaces_path = sys.argv[1]
merged_manifest_path = sys.argv[2]
target_kind = sys.argv[3]
project_root = sys.argv[4]


def load_hooks(path):
    # Returns a LIST of hooks blocks. Legacy single-object normalized to
    # `[object]`; missing/absent → []. Mirrors the mcp loader shape.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return []
    value = (data.get("surfaces") or {}).get("hooks")
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return value
    return []


# The core surfaces-manifest.json declares GLOBAL Layer-1 surfaces. It is only
# unioned when the project being compiled OWNS it (its realpath is under
# --project-root) — identical posture to the skills + MCP flattens.
# The merged agent manifest (incl. the FR-139 personal overlay) is always read.
sources = [merged_manifest_path]
try:
    cs_real = os.path.realpath(core_surfaces_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, core_surfaces_path)
except (OSError, ValueError):
    pass

for src in sources:
    for block in load_hooks(src):
        if not isinstance(block, dict):
            continue
        name = block.get("name", "")
        event = block.get("event", "")
        if not name or not event:
            continue
        canonical = block.get("canonical") or {}
        command = canonical.get("command", "")
        if not command:
            continue
        matcher = canonical.get("matcher") or "-"
        timeout = canonical.get("timeout")
        timeout_col = str(timeout) if isinstance(timeout, int) else "-"
        layer = block.get("layer", "") or "core"
        # FR-155-style scope columns (absent → global; `-` empty-paths sentinel).
        scope = block.get("scope") or {}
        scope_type = scope.get("type") or "global"
        scope_paths_list = scope.get("paths") or []
        scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
        for t in block.get("targets", []) or []:
            ttype = (t or {}).get("type", "")
            if not ttype:
                continue
            if target_kind != "all" and ttype != target_kind:
                continue
            enabled = (t or {}).get("enabled")
            if enabled is True:
                enabled_col = "true"
            elif enabled is False:
                enabled_col = "false"
            else:
                enabled_col = "-"
            print("\t".join([
                name,
                event,
                command,
                matcher,
                timeout_col,
                ttype,
                enabled_col,
                layer,
                scope_type,
                scope_paths_csv,
            ]))
PY
}

# ---------------------------------------------------------------------------
# verify_hook_entry_present <settings-path> <event> <command>
#
# Drift-side reader for the claude hook surface. Reads .claude/settings.json and
# emits a one-word VERDICT on stdout (NEVER a secret — the command is a path):
#   MATCH   → hooks.<Event>[] contains a group whose first command == <command>.
#   MISSING → file/hooks/event absent, OR no group with that command.
#   ERROR   → settings.json present but UNPARSEABLE / unexpected shape.
# Returns 0 always (the verdict is the signal). Mirrors extract_mcp_entry's
# rc-as-status discipline, but as a verdict string (the drift loop reads it).
# ---------------------------------------------------------------------------
verify_hook_entry_present() {
  local settings_path="$1"
  local event="$2"
  local command="$3"
  python3 - "$settings_path" "$event" "$command" <<'PY'
import json
import os
import sys

settings_path = sys.argv[1]
event = sys.argv[2]
command = sys.argv[3]

if not os.path.exists(settings_path):
    print("MISSING")
    sys.exit(0)

try:
    with open(settings_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except (OSError, ValueError):
    print("ERROR")
    sys.exit(0)

if not isinstance(data, dict):
    print("ERROR")
    sys.exit(0)

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    print("MISSING")
    sys.exit(0)

arr = hooks.get(event)
if not isinstance(arr, list):
    print("MISSING")
    sys.exit(0)

for group in arr:
    if not isinstance(group, dict):
        continue
    for h in group.get("hooks", []) or []:
        if isinstance(h, dict) and h.get("command") == command:
            print("MATCH")
            sys.exit(0)

print("MISSING")
PY
}

# Export functions for subshell use (bats tests spawn subshells).
export -f parse_frontmatter
export -f get_skill_field
export -f strip_frontmatter
export -f is_claude_only
export -f toml_escape
export -f toml_escape_description
export -f read_canonical_version
export -f latest_canonical
export -f sha_body
export -f validate_manifest
export -f merge_overlay_manifest
export -f flatten_mcp_rows
export -f extract_mcp_entry
export -f normalize_mcp_shape
# FR-180 (D7): hook-surface helpers. Hook drift is PRESENCE-BASED (the hook is
# identified by its command path in the merged settings.json, NOT a byte-shape
# comparison), so there is NO bash hook shaper twin the way agents have
# the α-assemblers — `verify_hook_entry_present` is
# the whole drift contract. The TS `hook-shape.ts` shapes the PROJECTOR's output
# and is pinned by a TS-only golden; it has no bash counterpart by design.
export -f flatten_hook_rows
export -f verify_hook_entry_present
