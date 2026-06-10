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

allowed_top = {"$schema", "_comment", "_schema", "version", "agents", "surfaces"}
for key in manifest:
    if key not in allowed_top:
        fail(f"unknown top-level key '{key}' (additionalProperties:false)")

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
    allowed_surface_keys = {"skills", "mcp_servers", "os_identity", "hooks", "os_context"}
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
        # FR-149/FR-151/FR-153/FR-171: the per-type method allowlist
        # (claude/symlink, codex/symlink, gemini/symlink, agents/symlink,
        # opencode/command) is enforced via `valid_pairs` below — mirrors the
        # `oneOf` constraint in manifest.schema.json so both validation paths
        # agree. The legacy codex/compiler + gemini/converter pairs were retired
        # by FR-153. `valid_skill_methods` retains the legacy method strings so
        # a recognized-but-disallowed pair produces the clearer pair-allowlist
        # error message (not "method unknown"). See L-519.
        valid_skill_types = {"codex", "gemini", "claude", "agents", "opencode"}
        valid_skill_methods = {"compiler", "converter", "symlink", "command"}
        valid_pairs = {("claude", "symlink"), ("codex", "symlink"),
                       ("gemini", "symlink"), ("agents", "symlink"),
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
                         "valid pairs: claude/symlink, codex/symlink, "
                         "gemini/symlink, agents/symlink, opencode/command")
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
        valid_mcp_target_types = {"claude", "codex", "gemini", "opencode"}
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

    # ---- TD-233: structural validation of surfaces.os_identity --------------
    # ARRAY of identity_surface blocks. Mirrors $defs.identity_surface so the
    # structural fallback AGREES with the jsonschema path. Targets carry the
    # 4-harness enum, the const method "file", and a required `filename` (the
    # harness's natively auto-read identity file, e.g. GEMINI.md / AGENTS.md).
    os_identity = surfaces.get("os_identity")
    if os_identity is not None:
        if not isinstance(os_identity, list) or len(os_identity) < 1:
            fail("surfaces.os_identity must be a non-empty array")
        valid_identity_target_types = {"claude", "codex", "gemini", "opencode"}
        allowed_identity_keys = {"source", "version_source", "layer", "scope",
                                 "targets"}
        allowed_identity_target_keys = {"type", "method", "filename"}
        for i_idx, id_block in enumerate(os_identity):
            iwhere = f"surfaces.os_identity[{i_idx}]"
            if not isinstance(id_block, dict):
                fail(f"{iwhere} must be an object")
            for key in id_block:
                if key not in allowed_identity_keys:
                    fail(f"{iwhere}: unknown key '{key}' "
                         "(additionalProperties:false)")
            if "targets" not in id_block:
                fail(f"{iwhere} missing required key 'targets'")
            i_targets = id_block["targets"]
            if not isinstance(i_targets, list) or len(i_targets) < 1:
                fail(f"{iwhere}.targets must be a non-empty array")
            for k, it in enumerate(i_targets):
                itwhere = f"{iwhere}.targets[{k}]"
                if not isinstance(it, dict):
                    fail(f"{itwhere} must be an object")
                for req in ("type", "method", "filename"):
                    if req not in it:
                        fail(f"{itwhere} missing required key '{req}'")
                for key in it:
                    if key not in allowed_identity_target_keys:
                        fail(f"{itwhere}: unknown key '{key}' "
                             "(additionalProperties:false)")
                if it["type"] not in valid_identity_target_types:
                    fail(f"{itwhere}.type '{it['type']}' is not one of "
                         f"{sorted(valid_identity_target_types)}")
                if it["method"] != "file":
                    fail(f"{itwhere}.method '{it['method']}' must be 'file'")
                if not isinstance(it["filename"], str) or not it["filename"]:
                    fail(f"{itwhere}.filename must be a non-empty string")

            # FR-155: optional scope on the identity block.
            if "scope" in id_block:
                validate_scope_shape(id_block["scope"], iwhere)

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
        valid_hook_target_types = {"claude", "opencode"}
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

# FR-137 / TD-191: merge surfaces.skills as a MULTI-BLOCK ARRAY. Personal
# blocks compile ALONGSIDE core (each carries its own source/layer/targets),
# so the merge is a simple concatenation rather than the legacy "keep base
# source + union targets" model. Cross-block target-path collisions (any
# pair, base-vs-overlay, base-vs-base, overlay-vs-overlay) are a HARD error
# — the same FR-137 collision contract, now scoped to the wider surface.
# This guard SUPERSEDES the flatten-pass `seen_paths` dedup (drift #4 in
# TD-191): every legitimate (block, target) row is distinct by construction
# once it passes here. Legacy single-object blocks normalize to `[object]`
# so back-compat holds without a version bump.
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
# FR-180 (D6) os_identity merges, so the three are independent (an overlay
# carrying only one of them still reaches the merged manifest). Start from the
# base surfaces and overlay each block family in turn.
merged_surfaces = None

if base_blocks or overlay_blocks:
    merged_skill_blocks = list(base_blocks) + list(overlay_blocks)
    # Cross-block path-collision guard: every (block, target) row's `path`
    # must be unique across ALL blocks. Mirrors the agent name-collision
    # guard above. Used to live as a base-vs-overlay-only check; widened so
    # the multi-block surface preserves the FR-137 contract end-to-end.
    seen_paths = {}
    for b_idx, block in enumerate(merged_skill_blocks):
        for t in (block or {}).get("targets", []) or []:
            p = (t or {}).get("path")
            if p is None:
                continue
            if p in seen_paths:
                prev = seen_paths[p]
                sys.stderr.write(
                    f"Error: skill-target path '{p}' collides between "
                    f"surfaces.skills[{prev}] and surfaces.skills[{b_idx}]; "
                    "every skill-target path must be unique across all "
                    "blocks (a personal skill must not shadow a core skill, "
                    "nor a sibling personal one).\n"
                )
                sys.exit(1)
            seen_paths[p] = b_idx
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

# FR-180 (D6): merge surfaces.os_identity as a MULTI-BLOCK ARRAY (base ++
# overlay), mirroring the skills + mcp_servers concat. This LIFTS the TD-233
# v1 "personal os_identity accepted but NOT merged" restriction (schema:186):
# without this, a personal os_identity block written by `igris add identity`
# into the overlay would never reach the compile/drift flatten — the SAME
# finding-#2 gap MCP had. The projection MECHANICS are identical to core
# (normalize_identity_shape is untouched → §18.1 golden parity is preserved by
# construction); only this manifest-merge step was the gate. An os_identity
# block has NO `name` (the schema keys it only on `targets`), so identity is
# the (type, filename) PAIR — a personal (overlay) target whose (type, filename)
# collides with ANY other block's (the analogue of the skill target-path
# collision guard) is a HARD error: a personal identity must not silently
# overwrite the same Igris-managed region a core block already owns, nor a
# sibling personal one. Always normalizes missing/single/list shapes; an absent
# os_identity surface contributes [].
def _normalize_identity(value):
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return list(value)
    sys.stderr.write(
        "Error: surfaces.os_identity must be an array of blocks (or a single "
        "object — both normalize)\n"
    )
    sys.exit(1)


base_identity = _normalize_identity(base_surfaces.get("os_identity"))
overlay_identity = _normalize_identity(overlay_surfaces.get("os_identity"))

if base_identity or overlay_identity:
    merged_identity_blocks = list(base_identity) + list(overlay_identity)
    # Cross-block (type, filename) collision guard. Mirrors the skill
    # target-path guard above: every (block, target) row's (type, filename)
    # must be unique across ALL blocks so two blocks never own the same
    # Igris-managed region in the same harness file. base index 0..len-1 are
    # core; overlay blocks follow.
    seen_identity = {}
    for b_idx, block in enumerate(merged_identity_blocks):
        for t in (block or {}).get("targets", []) or []:
            ttype = (t or {}).get("type")
            fname = (t or {}).get("filename")
            if ttype is None or fname is None:
                continue
            pair = (ttype, fname)
            if pair in seen_identity:
                prev = seen_identity[pair]
                sys.stderr.write(
                    f"Error: os_identity target ({ttype}, {fname}) collides "
                    f"between surfaces.os_identity[{prev}] and "
                    f"surfaces.os_identity[{b_idx}]; every (type, filename) "
                    "identity target must be unique across all blocks (a "
                    "personal identity must not shadow a core one, nor a "
                    "sibling personal one).\n"
                )
                sys.exit(1)
            seen_identity[pair] = b_idx
    if merged_surfaces is None:
        merged_surfaces = dict(base_surfaces)
    merged_surfaces["os_identity"] = merged_identity_blocks

# FR-180 (D7): merge surfaces.hooks as a MULTI-BLOCK ARRAY (base ++ overlay),
# mirroring the skills + mcp_servers + os_identity concat. WITHOUT this a
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
# signal the skills / mcp / identity flatten gates use to decide whether to
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
    # claude / gemini / codex → emit the ${VAR} reference verbatim (codex's
    # literal re-resolve is the drift compare's job, never this helper's).
    return value


norm_env = {k: env_for(env[k]) for k in env}

if harness == "claude":
    entry = {"type": "stdio", "command": command, "args": args, "env": norm_env}
elif harness == "gemini":
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
# TD-233 (GAP-3): orchestrator-identity projection helpers (shared by compile
# + drift). The identity surface projects ONE canonical identity template
# (core/templates/identity.tmpl) into each harness's natively auto-read
# project-root context file (gemini → GEMINI.md, codex → AGENTS.md), wrapped
# in an Igris-managed delimited region so pre-existing user content survives.
# ---------------------------------------------------------------------------

# Region markers. Detection matches on the BEGIN PREFIX (an edited BEGIN
# comment still locates the region → DRIFTED, never a duplicate region) and on
# the exact END line. MUST stay byte-identical to IDENTITY_BEGIN_PREFIX /
# IDENTITY_BEGIN_LINE / IDENTITY_END_LINE in cli/src/lib/identity-shape.ts
# (§18.1 — the golden-fixture parity tests pin the pairing).
IGRIS_IDENTITY_BEGIN_PREFIX='<!-- IGRIS:OS_IDENTITY:BEGIN'
IGRIS_IDENTITY_BEGIN_LINE="$IGRIS_IDENTITY_BEGIN_PREFIX (Igris-managed identity region — edit core/templates/identity.tmpl, then run 'igris harness compile'; see TD-233) -->"
IGRIS_IDENTITY_END_LINE='<!-- IGRIS:OS_IDENTITY:END -->'

# ---------------------------------------------------------------------------
# flatten_identity_rows <merged-manifest> <core-surfaces> <target-kind> <project-root>
#
# Emits one TAB-separated row per (identity-block, target). Mirrors
# flatten_mcp_rows: the core surfaces-manifest.json is only unioned when the
# project being compiled OWNS it (its realpath is under --project-root). Rows
# are filtered by <target-kind>; "all" emits every target.
#
# Row columns (TAB-separated, fixed order):
#   source <TAB> version_source <TAB> target_type <TAB> filename <TAB>
#   scope_type <TAB> scope_paths_csv
#
# `-` is the empty sentinel for source (→ caller defaults to
# <brain>/core/templates/identity.tmpl), version_source (→ caller defaults to
# <brain>/config.json) and scope_paths (mirrors the skills flatten).
# ---------------------------------------------------------------------------
flatten_identity_rows() {
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


def load_identity(path):
    # Returns a LIST of os_identity blocks. Legacy single-object normalized to
    # `[object]`; missing/absent → []. Mirrors the mcp/skills loader shape.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return []
    value = (data.get("surfaces") or {}).get("os_identity")
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return value
    return []


# The core surfaces-manifest.json declares GLOBAL Layer-1 surfaces. It is only
# unioned when the project being compiled OWNS it (its realpath is under
# --project-root) — identical posture to the skills + MCP flattens. The merged
# agent manifest (incl. the FR-139 personal overlay) is always read.
sources = [merged_manifest_path]
try:
    cs_real = os.path.realpath(core_surfaces_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, core_surfaces_path)
except (OSError, ValueError):
    pass

for src in sources:
    for block in load_identity(src):
        if not isinstance(block, dict):
            continue
        source = block.get("source", "") or "-"
        version_source = block.get("version_source", "") or "-"
        # FR-155 scope columns (absent → global; `-` empty-paths sentinel).
        scope = block.get("scope") or {}
        scope_type = scope.get("type") or "global"
        scope_paths_list = scope.get("paths") or []
        scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
        for t in block.get("targets", []) or []:
            ttype = (t or {}).get("type", "")
            filename = (t or {}).get("filename", "")
            if not ttype or not filename:
                continue
            if target_kind != "all" and ttype != target_kind:
                continue
            print("\t".join([
                source,
                version_source,
                ttype,
                filename,
                scope_type,
                scope_paths_csv,
            ]))
PY
}

# ---------------------------------------------------------------------------
# read_identity_version <version-source-abs-or-empty>
#
# Resolves the {{IGRIS_VERSION}} token for the identity surface. Reads the
# top-level `version` key of the given JSON file; an empty argument falls back
# to <brain>/config.json (IGRIS_BRAIN_DIR-honoring, like the MCP secrets
# resolution). Emits the bare version string, or EMPTY when the file is
# absent/unparseable/key-less — the caller turns empty into an observable
# FAIL/DRIFTED row (L-232), never a silent skip. Returns 0 always.
#
# A project whose identity files are committed-as-canonical should declare a
# repo-committed `version_source` (the igris-ai repo uses cli/package.json) so
# CI and every contributor checkout re-derive identical bytes without a brain.
# ---------------------------------------------------------------------------
read_identity_version() {
  local version_source="${1:-}"
  if [ -z "$version_source" ]; then
    version_source="${IGRIS_BRAIN_DIR:-$HOME/.igris}/config.json"
  fi
  python3 - "$version_source" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
except (OSError, ValueError):
    print("")
    sys.exit(0)

version = data.get("version") if isinstance(data, dict) else None
print(version if isinstance(version, str) and version else "")
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
    # `[object]`; missing/absent → []. Mirrors the mcp/identity loader shape.
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
# --project-root) — identical posture to the skills + MCP + identity flattens.
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

# ---------------------------------------------------------------------------
# normalize_identity_shape <template-path> <harness> <version>
#
# The §18.1 / L-554 SHARED SHAPE HELPER for the identity surface. Renders the
# canonical identity template for one harness and emits the FULL delimited
# region (BEGIN marker + rendered body + END marker, trailing newline) on
# stdout — byte-identical to the TS `buildHarnessIdentityFile`
# (cli/src/lib/identity-shape.ts; the golden-fixture + bats parity tests pin
# the two together). Used by BOTH the compile pass (what gets written) and the
# drift pass (what is expected) — there is no second normalizer.
#
# Substitutions: {{IGRIS_VERSION}} → <version>; {{HARNESS_SELF_NAME}} → the
# Model-A self-name reword (claude → "Claude", codex → "Codex", gemini →
# "Gemini CLI", opencode → "OpenCode") so a non-Claude output never says
# "Claude" ("Not Gemini CLI using Igris AI."). Model B is parked — do NOT add
# it here. The body is normalized to end with exactly one newline.
#
# Returns 2 on an unknown harness or unreadable template (observable, L-232).
# ---------------------------------------------------------------------------
normalize_identity_shape() {
  local template_path="$1"
  local harness="$2"
  local version="$3"
  python3 - "$template_path" "$harness" "$version" \
    "$IGRIS_IDENTITY_BEGIN_LINE" "$IGRIS_IDENTITY_END_LINE" <<'PY'
import sys

template_path = sys.argv[1]
harness = sys.argv[2]
version = sys.argv[3]
begin_line = sys.argv[4]
end_line = sys.argv[5]

# MUST stay byte-identical to HARNESS_SELF_NAMES in identity-shape.ts.
SELF_NAMES = {
    "claude": "Claude",
    "codex": "Codex",
    "gemini": "Gemini CLI",
    "opencode": "OpenCode",
}

self_name = SELF_NAMES.get(harness)
if self_name is None:
    sys.stderr.write(f"normalize_identity_shape: unknown harness '{harness}'\n")
    sys.exit(2)

try:
    with open(template_path, "r", encoding="utf-8") as fh:
        body = fh.read()
except OSError as exc:
    sys.stderr.write(
        f"normalize_identity_shape: cannot read template '{template_path}': {exc}\n"
    )
    sys.exit(2)

body = body.replace("{{IGRIS_VERSION}}", version)
body = body.replace("{{HARNESS_SELF_NAME}}", self_name)
body = body.rstrip("\n") + "\n"

sys.stdout.write(f"{begin_line}\n{body}{end_line}\n")
PY
}

# ---------------------------------------------------------------------------
# extract_identity_region <file-path>
#
# Drift-side reader: extracts the Igris-managed identity region (BEGIN..END
# lines inclusive) from a harness identity file and emits it on stdout.
#
# Status is signaled via the EXIT CODE:
#   0  → region present; the region bytes are on stdout.
#   10 → file absent (MISSING — run compile).
#   11 → file present but carries NO Igris identity region (MISSING region).
#   12 → BEGIN marker without a closing END (corrupt region → DRIFTED).
#
# NEVER throws under `set -euo pipefail` — every outcome is an explicit rc.
# ---------------------------------------------------------------------------
extract_identity_region() {
  local file_path="$1"
  python3 - "$file_path" "$IGRIS_IDENTITY_BEGIN_PREFIX" "$IGRIS_IDENTITY_END_LINE" <<'PY'
import os
import sys

file_path = sys.argv[1]
begin_prefix = sys.argv[2]
end_line_text = sys.argv[3]

if not os.path.exists(file_path):
    sys.exit(10)

try:
    with open(file_path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines(keepends=True)
except OSError:
    sys.exit(10)

begin_idx = None
end_idx = None
for i, line in enumerate(lines):
    stripped = line.rstrip("\n")
    if begin_idx is None and stripped.startswith(begin_prefix):
        begin_idx = i
    elif begin_idx is not None and stripped == end_line_text:
        end_idx = i
        break

if begin_idx is None:
    sys.exit(11)
if end_idx is None:
    sys.exit(12)

region = "".join(lines[begin_idx:end_idx + 1])
if not region.endswith("\n"):
    region += "\n"
sys.stdout.write(region)
sys.exit(0)
PY
}

# ---------------------------------------------------------------------------
# merge_identity_region <target-path> <region-file>
#
# Compile-side writer: merges the rendered identity region (read from
# <region-file> — a file, not an argument, so multi-line bytes survive shell
# quoting) into <target-path> under the LOCKED merge-into-region clobber
# posture: pre-existing user content in GEMINI.md / AGENTS.md is preserved
# byte-for-byte; only the Igris-managed region is owned by Igris.
#
#   - target absent             → create it containing exactly the region.
#   - target has BEGIN..END     → replace the region lines in place.
#   - target has no markers     → APPEND the region after a separating blank
#                                 line (user content untouched).
#   - target region byte-equals → NO write (idempotent; mtime preserved).
#   - BEGIN without END         → rc 3, file untouched (refuse to guess at a
#                                 corrupt region; fix manually, recompile).
#
# Writes are atomic (temp + os.replace on the same filesystem). Emits one of
# created|updated|appended|unchanged on stdout for the compile summary.
# ---------------------------------------------------------------------------
merge_identity_region() {
  local target_path="$1"
  local region_file="$2"
  python3 - "$target_path" "$region_file" "$IGRIS_IDENTITY_BEGIN_PREFIX" "$IGRIS_IDENTITY_END_LINE" <<'PY'
import os
import sys

target_path = sys.argv[1]
region_file = sys.argv[2]
begin_prefix = sys.argv[3]
end_line_text = sys.argv[4]

with open(region_file, "r", encoding="utf-8") as fh:
    region = fh.read()
if not region.endswith("\n"):
    region += "\n"

if not os.path.exists(target_path):
    action = "created"
    new_content = region
else:
    with open(target_path, "r", encoding="utf-8") as fh:
        existing = fh.read()
    lines = existing.splitlines(keepends=True)
    begin_idx = None
    end_idx = None
    for i, line in enumerate(lines):
        stripped = line.rstrip("\n")
        if begin_idx is None and stripped.startswith(begin_prefix):
            begin_idx = i
        elif begin_idx is not None and stripped == end_line_text:
            end_idx = i
            break
    if begin_idx is None:
        # No Igris region — append it, preserving user content byte-for-byte.
        base = existing
        if base and not base.endswith("\n"):
            base += "\n"
        sep = "\n" if base else ""
        new_content = base + sep + region
        action = "appended"
    elif end_idx is None:
        sys.stderr.write(
            f"merge_identity_region: corrupt Igris identity region in "
            f"{target_path} (BEGIN marker without END) — fix the file "
            "manually, then re-run `igris harness compile`\n"
        )
        sys.exit(3)
    else:
        current = "".join(lines[begin_idx:end_idx + 1])
        if not current.endswith("\n"):
            current += "\n"
        if current == region:
            print("unchanged")
            sys.exit(0)
        new_content = "".join(lines[:begin_idx]) + region + "".join(lines[end_idx + 1:])
        action = "updated"

tmp = f"{target_path}.tmp-{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(new_content)
os.replace(tmp, target_path)
print(action)
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
# TD-233: identity-surface helpers + the marker constants their bodies expand.
export IGRIS_IDENTITY_BEGIN_PREFIX IGRIS_IDENTITY_BEGIN_LINE IGRIS_IDENTITY_END_LINE
export -f flatten_identity_rows
export -f read_identity_version
export -f normalize_identity_shape
export -f extract_identity_region
export -f merge_identity_region
# FR-180 (D7): hook-surface helpers. Hook drift is PRESENCE-BASED (the hook is
# identified by its command path in the merged settings.json, NOT a byte-shape
# comparison), so there is NO bash hook shaper twin the way identity/agents have
# normalize_identity_shape / the α-assemblers — `verify_hook_entry_present` is
# the whole drift contract. The TS `hook-shape.ts` shapes the PROJECTOR's output
# and is pinned by a TS-only golden; it has no bash counterpart by design.
export -f flatten_hook_rows
export -f verify_hook_entry_present
