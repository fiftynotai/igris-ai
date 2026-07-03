#!/bin/bash
set -euo pipefail

# Description: Discovery generator for the project-context-docs catalog (FR-197).
#              Scans the self-describing doc-type definitions —
#              core/context-doc-types/*.md (minus the generated INDEX itself) —
#              parses each file's YAML frontmatter (type / target / applies_when
#              / consult_when / maintain_when / summary), and emits the
#              model-facing catalog as a markdown table to
#              core/context-doc-types/INDEX.md.
#
#              This is the "self-describing convention over hand-maintained
#              registries" principle (the gen_os_index.sh sibling): each doc-type
#              declares its own metadata, the catalog discovers them and
#              generates the map. Never hand-edit the output — re-run this script
#              after editing or adding a definition.
#
#              A definition missing a REQUIRED field (type/target/applies_when/
#              consult_when/maintain_when/summary) is a hard error — the
#              generator exits non-zero, so running it IS the validation gate.
#
# Usage:       bash core/scripts/gen_doc_type_catalog.sh
#              Resolves its own paths from the script location, so it can be run
#              from anywhere in (or out of) the checkout.

# --- Resolve paths from the script's own location (repo-side, no $HOME) ------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CATALOG_DIR="${CORE_DIR}/context-doc-types"
INDEX_FILE="${CATALOG_DIR}/INDEX.md"

if [[ ! -d "${CATALOG_DIR}" ]]; then
  echo "error: catalog dir not found: ${CATALOG_DIR}" >&2
  exit 1
fi

# --- Collect the scan set: core/context-doc-types/*.md (excluding INDEX.md) ---
# Build a newline-delimited file list, then hand it to the parser on stdin.
scan_list="$(
  find "${CATALOG_DIR}" -maxdepth 1 -type f -name '*.md' ! -name 'INDEX.md' -print | sort -u
)"

if [[ -z "${scan_list}" ]]; then
  echo "error: no doc-type definitions found under ${CATALOG_DIR}" >&2
  exit 1
fi

# --- Parse frontmatter and emit the table (Python: robust, stdlib-only) -------
# yq is not available; Python's frontmatter parse is hand-rolled (simple
# `key: value` scalars between the first two `---` fences) — that is exactly
# the schema every definition uses, so no YAML library is needed. The scan list
# is passed via the environment (newline-delimited) so Python's stdin stays free
# and there is no pipe/heredoc collision.
table_body="$(
  IGRIS_CATALOG_SCAN_LIST="${scan_list}" python3 - <<'PY'
import os
import sys

# Required fields: a definition missing any of these is a hard error (the
# generator IS the validation gate). Displayed columns are a subset — note
# kind_affinity is REQUIRED because /promote P2 routes on it, but it is NOT a
# displayed column: it is a router input, not a model-facing catalog column.
REQUIRED = ("type", "target", "applies_when", "consult_when", "maintain_when", "summary", "kind_affinity")
FIELDS = ("type", "target", "applies_when", "consult_when", "maintain_when", "summary")


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
        # Strip a single layer of matching quotes (the schema double-quotes any
        # value containing a colon-space — TD-219).
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        # Store any key we either display (FIELDS) or validate (REQUIRED) — so
        # kind_affinity is captured for the REQUIRED check even though it is not
        # a displayed column.
        if key in FIELDS or key in REQUIRED:
            meta[key] = value
    return meta


def cell(value):
    """Markdown-table-safe single cell."""
    if not value:
        return "—"
    # Escape pipes so a value never breaks the column structure; collapse any
    # stray newlines (frontmatter scalars are single-line, but be defensive).
    return value.replace("|", "\\|").replace("\n", " ").strip()


def type_name(path):
    """Display name: the file stem."""
    base = os.path.basename(path)
    return base[:-3] if base.endswith(".md") else base


rows = []
missing = []
for raw in os.environ.get("IGRIS_CATALOG_SCAN_LIST", "").splitlines():
    path = raw.strip()
    if not path:
        continue
    meta = parse_frontmatter(path)
    name = type_name(path)
    absent = [f for f in REQUIRED if not meta.get(f)]
    if absent:
        missing.append(f"{name}: missing {', '.join(absent)}")
    rows.append(
        {
            "type": meta.get("type", name),
            "target": meta.get("target", ""),
            "applies_when": meta.get("applies_when", ""),
            "consult_when": meta.get("consult_when", ""),
            "maintain_when": meta.get("maintain_when", ""),
            "summary": meta.get("summary", ""),
        }
    )

if missing:
    sys.stderr.write("error: doc-type definitions with incomplete frontmatter:\n")
    for m in missing:
        sys.stderr.write(f"  - {m}\n")
    sys.exit(1)

rows.sort(key=lambda r: r["type"].lower())

for r in rows:
    print(
        "| {type} | {target} | {applies_when} | {consult_when} | {maintain_when} | {summary} |".format(
            type=cell(r["type"]),
            target=cell(r["target"]),
            applies_when=cell(r["applies_when"]),
            consult_when=cell(r["consult_when"]),
            maintain_when=cell(r["maintain_when"]),
            summary=cell(r["summary"]),
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
<!-- GENERATED by core/scripts/gen_doc_type_catalog.sh — DO NOT EDIT BY HAND. -->
<!-- Re-run the generator to refresh; edits here are overwritten. -->

# Project-Context-Docs — Type Catalog

The model-facing catalog of project-context doc TYPES. The **discovery**
generator builds this by scanning each type's self-describing frontmatter
(`core/context-doc-types/*.md`). Each type maps to an on-disk doc under
`~/.igris/projects/{project}/context/<target>`.

- **applies_when** = the project-kind/archetype predicate (the contract FR-199's
  presence-enforcement reads: a project of a matching kind missing the `target`
  is a presence violation).
- **consult_when** = when the model should read the doc before working.
- **maintain_when** = the staleness trigger — when a change makes the doc stale.

> Consumers: `/promote` P2 (maps a hardened learning to its `target` doc) and
> `/ground` (authors a `target` from the type's body skeleton).

| type | target | applies_when | consult_when | maintain_when | summary |
|---|---|---|---|---|---|
HEADER
  printf '%s\n' "${table_body}"
} > "${INDEX_FILE}"

echo "generated ${INDEX_FILE}"
