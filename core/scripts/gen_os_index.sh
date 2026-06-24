#!/bin/bash
set -euo pipefail

# Description: Discovery generator for the Igris OS module index (FR-187).
#              Scans the self-describing context modules — core/os/*.md (minus
#              the generated index itself) plus core/SOUL.md — parses each
#              file's YAML frontmatter (layer / tier / scope / summary /
#              consult_when), and emits the model-facing INDEX as a markdown
#              table to core/os/INDEX.md.
#
#              ALSO scans core/agents/*.md frontmatter (name / description) and
#              emits an agent roster (name -> role) as a second table, so the
#              model learns the agent set by discovery — delegation.md never
#              hand-names an agent. Files without both name AND description are
#              skipped (so non-agent files are naturally excluded).
#
#              ALSO scans core/os/harness-specific/*.md frontmatter
#              (harness / delegation_model) and emits a harness-specific roster
#              (harness -> file) as a third table. These files are the NEW
#              per-harness context layer (FR-202 M4): the Boot stage loads ONLY
#              the file whose `harness:` matches the Detect-resolved harness.
#              They live in a SUBDIRECTORY so the flat `-maxdepth 1` module scan
#              above NEVER picks them up (they carry the Detect schema, not the
#              module layer/tier/scope/summary schema, so they would otherwise
#              trip the module-frontmatter hard-fail and pollute every harness's
#              boot set). The shared `_`-prefixed companion (_delegation-recipe.md)
#              is referenced by the rostered files but is not itself a harness
#              file, so it is skipped (no `harness:` key).
#
#              This is the "self-describing convention over hand-maintained
#              registries" principle made real: parts declare their own
#              metadata, the OS discovers them and generates the map. Never
#              hand-edit the output — re-run this script.
#
#              The operator module (~/.igris/USER.md, machine-home) is a known
#              index entry but is NOT read here — USER is wired into the index
#              at cutover, not from machine-home in this repo-side pass.
#
# Usage:       bash core/scripts/gen_os_index.sh
#              Resolves its own paths from the script location, so it can be
#              run from anywhere in (or out of) the checkout.

# --- Resolve paths from the script's own location (repo-side, no $HOME) ------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OS_DIR="${CORE_DIR}/os"
SOUL_FILE="${CORE_DIR}/SOUL.md"
AGENTS_DIR="${CORE_DIR}/agents"
HARNESS_SPECIFIC_DIR="${OS_DIR}/harness-specific"
INDEX_FILE="${OS_DIR}/INDEX.md"

if [[ ! -d "${OS_DIR}" ]]; then
  echo "error: os dir not found: ${OS_DIR}" >&2
  exit 1
fi

# --- Collect the scan set: core/os/*.md (excluding INDEX.md) + core/SOUL.md ---
# Build a newline-delimited file list, then hand it to the parser on stdin.
scan_list="$(
  {
    find "${OS_DIR}" -maxdepth 1 -type f -name '*.md' ! -name 'INDEX.md' -print
    [[ -f "${SOUL_FILE}" ]] && printf '%s\n' "${SOUL_FILE}"
  } | sort -u
)"

if [[ -z "${scan_list}" ]]; then
  echo "error: no modules found to index under ${OS_DIR}" >&2
  exit 1
fi

# --- Parse frontmatter and emit the table (Python: robust, stdlib-only) -------
# yq is not available; Python's frontmatter parse is hand-rolled (simple
# `key: value` scalars between the first two `---` fences) — that is exactly
# the schema every module uses, so no YAML library is needed. The scan list is
# passed via the environment (newline-delimited) so Python's stdin stays free
# and there is no pipe/heredoc collision.
table_body="$(
  IGRIS_OS_SCAN_LIST="${scan_list}" python3 - <<'PY'
import os
import sys

# Tier sort order: boot first, then on-demand, then reference, then anything
# unrecognized. Within a tier, sort alphabetically by display name.
TIER_RANK = {"boot": 0, "on-demand": 1, "reference": 2}
FIELDS = ("layer", "tier", "scope", "summary", "consult_when")


def parse_frontmatter(path):
    """Return a dict of the leading `---`-fenced YAML scalars, or {} if none."""
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        # Strip a single layer of matching quotes (the schema double-quotes
        # consult_when when it contains a colon).
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key in FIELDS:
            meta[key] = value
    return meta


def cell(value):
    """Markdown-table-safe single cell."""
    if not value:
        return "—"
    # Escape pipes so a value never breaks the column structure; collapse any
    # stray newlines (frontmatter scalars are single-line, but be defensive).
    return value.replace("|", "\\|").replace("\n", " ").strip()


def module_name(path):
    """Display name: SOUL.md -> SOUL; everything else -> stem."""
    base = os.path.basename(path)
    stem = base[:-3] if base.endswith(".md") else base
    return stem


rows = []
missing = []
for raw in os.environ.get("IGRIS_OS_SCAN_LIST", "").splitlines():
    path = raw.strip()
    if not path:
        continue
    meta = parse_frontmatter(path)
    name = module_name(path)
    absent = [f for f in ("layer", "tier", "scope", "summary") if not meta.get(f)]
    if absent:
        missing.append(f"{name}: missing {', '.join(absent)}")
    rows.append(
        {
            "name": name,
            "layer": meta.get("layer", ""),
            "tier": meta.get("tier", ""),
            "scope": meta.get("scope", ""),
            "summary": meta.get("summary", ""),
            "consult_when": meta.get("consult_when", ""),
        }
    )

if missing:
    sys.stderr.write("error: modules with incomplete frontmatter:\n")
    for m in missing:
        sys.stderr.write(f"  - {m}\n")
    sys.exit(1)

rows.sort(key=lambda r: (TIER_RANK.get(r["tier"], 99), r["name"].lower()))

for r in rows:
    print(
        "| {name} | {layer} | {tier} | {scope} | {summary} | {consult_when} |".format(
            name=cell(r["name"]),
            layer=cell(r["layer"]),
            tier=cell(r["tier"]),
            scope=cell(r["scope"]),
            summary=cell(r["summary"]),
            consult_when=cell(r["consult_when"]),
        )
    )
PY
)"

# --- Collect the agent roster: core/agents/*.md (name + description) ----------
# Agents self-describe in their own frontmatter (name / description). Scan them
# and emit a roster so the model discovers the agent set without delegation.md
# naming any. A file missing either field is skipped (non-agent files drop out).
agent_list=""
if [[ -d "${AGENTS_DIR}" ]]; then
  agent_list="$(find "${AGENTS_DIR}" -maxdepth 1 -type f -name '*.md' -print | sort -u)"
fi

# Parse the agent frontmatter into roster rows (same env-var hand-off as above,
# so Python's stdin stays free — no pipe/heredoc collision).
agent_body="$(
  IGRIS_AGENT_LIST="${agent_list}" python3 - <<'PY'
import os

FIELDS = ("name", "description")


def parse_frontmatter(path):
    """Return the leading `---`-fenced YAML scalars we care about, or {}."""
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key in FIELDS:
            meta[key] = value
    return meta


def cell(value):
    if not value:
        return "—"
    return value.replace("|", "\\|").replace("\n", " ").strip()


rows = []
for raw in os.environ.get("IGRIS_AGENT_LIST", "").splitlines():
    path = raw.strip()
    if not path:
        continue
    meta = parse_frontmatter(path)
    # Only real agents — both name AND description present.
    if not meta.get("name") or not meta.get("description"):
        continue
    rows.append({"name": meta["name"], "description": meta["description"]})

rows.sort(key=lambda r: r["name"].lower())

for r in rows:
    print("| {name} | {role} |".format(name=cell(r["name"]), role=cell(r["description"])))
PY
)"

# --- Collect the harness-specific roster: core/os/harness-specific/*.md --------
# The NEW per-harness context layer (FR-202 M4). Each file self-describes with a
# `harness` key (the Detect key) + a `delegation_model` predicate. The Boot stage
# loads ONLY the file whose `harness:` matches the Detect-resolved harness — the
# roster is the discovered map (harness -> file). A file without a `harness` key
# (e.g. the shared `_delegation-recipe.md` companion) is skipped. These files are
# NEVER part of the module table above (the flat `-maxdepth 1` scan excludes the
# subdir by construction; this roster is a SEPARATE discovery pass).
harness_specific_list=""
if [[ -d "${HARNESS_SPECIFIC_DIR}" ]]; then
  harness_specific_list="$(find "${HARNESS_SPECIFIC_DIR}" -maxdepth 1 -type f -name '*.md' -print | sort -u)"
fi

harness_specific_body="$(
  IGRIS_HARNESS_SPECIFIC_LIST="${harness_specific_list}" python3 - <<'PY'
import os

FIELDS = ("harness", "delegation_model", "summary")


def parse_frontmatter(path):
    """Return the leading `---`-fenced YAML scalars we care about, or {}."""
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key in FIELDS:
            meta[key] = value
    return meta


def cell(value):
    if not value:
        return "—"
    return value.replace("|", "\\|").replace("\n", " ").strip()


rows = []
for raw in os.environ.get("IGRIS_HARNESS_SPECIFIC_LIST", "").splitlines():
    path = raw.strip()
    if not path:
        continue
    meta = parse_frontmatter(path)
    # Only real harness files — a `harness` key present. The shared
    # `_delegation-recipe.md` companion has no `harness` key, so it drops out.
    if not meta.get("harness"):
        continue
    rows.append(
        {
            "harness": meta["harness"],
            "file": os.path.basename(path),
            "delegation_model": meta.get("delegation_model", ""),
        }
    )

rows.sort(key=lambda r: r["harness"].lower())

for r in rows:
    print(
        "| {harness} | harness-specific/{file} | {dm} |".format(
            harness=cell(r["harness"]),
            file=r["file"],
            dm=cell(r["delegation_model"]),
        )
    )
PY
)"

# --- Write the generated INDEX -----------------------------------------------
# The static preamble is a single quoted heredoc (no shell expansion, so the
# literal backticks and the leading-dash bullet lines pass through verbatim);
# the dynamic table body is appended after it.
{
  cat <<'HEADER'
<!-- GENERATED by core/scripts/gen_os_index.sh — DO NOT EDIT BY HAND. -->
<!-- Re-run the generator to refresh; edits here are overwritten. -->

# Igris OS — Module Index

The model-facing map of the OS context modules. The **discovery** generator
builds this by scanning each module's self-describing frontmatter
(`core/os/*.md` + `core/SOUL.md`).

- **tier** = when it loads: `boot` (always), `on-demand` (pull when
  `consult_when` fires), `reference` (consulted, not auto-loaded).
- **scope** = who loads it: `orchestrator` or `universal` (all actors).

> The operator module `~/.igris/USER.md` (machine-home) is part of the scan
> set but is wired in at cutover — it is not indexed from this repo-side pass.

| module | layer | tier | scope | summary | consult_when |
|---|---|---|---|---|---|
HEADER
  printf '%s\n' "${table_body}"

  cat <<'AGENTHEADER'

## Agent roster

The agents you delegate to. Discovered by scanning each agent's self-describing
frontmatter (`core/agents/*.md`) — `delegation.md` reaches for a **role**, never
a hand-listed name. Reach for the agent whose role fits the work.

| agent | role |
|---|---|
AGENTHEADER
  printf '%s\n' "${agent_body}"

  # Harness-specific roster (FR-202 M4) — only emitted when files exist, so a
  # project with no harness-specific layer carries no empty table. Discovered by
  # scanning core/os/harness-specific/*.md frontmatter (harness / delegation_model).
  if [[ -n "${harness_specific_body}" ]]; then
    cat <<'HARNESSHEADER'

## Harness-specific roster

Per-harness content the **Boot** stage loads for the Detect-resolved harness —
ONLY the file whose `harness` matches. Discovered by scanning each file's
self-describing frontmatter (`core/os/harness-specific/*.md`). Native-static
harnesses need no file (a clean no-op); `dynamic-define` harnesses point to the
shared delegation recipe. The agnostic OS never branches on harness type — it
points here.

| harness | file | delegation_model |
|---|---|---|
HARNESSHEADER
    printf '%s\n' "${harness_specific_body}"
  fi
} > "${INDEX_FILE}"

echo "generated ${INDEX_FILE}"
