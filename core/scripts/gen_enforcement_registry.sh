#!/bin/bash
set -euo pipefail

# Description: Discovery generator for the enforcement registry (FR-199).
#              Scans the self-describing obligation definitions —
#              core/enforcement/*.md (minus the generated INDEX itself) —
#              parses each file's YAML frontmatter (obligation / mechanism /
#              status / lives_in / summary), and emits the model-facing
#              registry as a markdown table to core/enforcement/INDEX.md.
#
#              This is the "self-describing convention over hand-maintained
#              registries" principle (the gen_doc_type_catalog.sh sibling): each
#              obligation declares its own metadata, the registry discovers them
#              and generates the map of "what's forced and how". Never hand-edit
#              the output — re-run this script after editing or adding a
#              definition.
#
#              A definition missing a REQUIRED field (obligation/mechanism/
#              status/lives_in/summary) is a hard error — the generator exits
#              non-zero, so running it IS the validation gate.
#
# Usage:       bash core/scripts/gen_enforcement_registry.sh
#              Resolves its own paths from the script location, so it can be run
#              from anywhere in (or out of) the checkout.

# --- Resolve paths from the script's own location (repo-side, no $HOME) ------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REGISTRY_DIR="${CORE_DIR}/enforcement"
INDEX_FILE="${REGISTRY_DIR}/INDEX.md"

if [[ ! -d "${REGISTRY_DIR}" ]]; then
  echo "error: enforcement dir not found: ${REGISTRY_DIR}" >&2
  exit 1
fi

# --- Collect the scan set: core/enforcement/*.md (excluding INDEX.md) ---------
# Build a newline-delimited file list, then hand it to the parser on stdin.
scan_list="$(
  find "${REGISTRY_DIR}" -maxdepth 1 -type f -name '*.md' ! -name 'INDEX.md' -print | sort -u
)"

if [[ -z "${scan_list}" ]]; then
  echo "error: no enforcement definitions found under ${REGISTRY_DIR}" >&2
  exit 1
fi

# --- Parse frontmatter and emit the table (Python: robust, stdlib-only) -------
# yq is not available; Python's frontmatter parse is hand-rolled (simple
# `key: value` scalars between the first two `---` fences) — that is exactly
# the schema every definition uses, so no YAML library is needed. The scan list
# is passed via the environment (newline-delimited) so Python's stdin stays free
# and there is no pipe/heredoc collision.
table_body="$(
  IGRIS_ENFORCEMENT_SCAN_LIST="${scan_list}" python3 - <<'PY'
import os
import sys

# Required fields: a definition missing any of these is a hard error (the
# generator IS the validation gate). All required fields are also displayed
# columns for the enforcement registry.
REQUIRED = ("obligation", "mechanism", "status", "lives_in", "summary")
FIELDS = ("obligation", "mechanism", "status", "lives_in", "summary")


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


def slug_name(path):
    """Display name: the file stem."""
    base = os.path.basename(path)
    return base[:-3] if base.endswith(".md") else base


rows = []
missing = []
for raw in os.environ.get("IGRIS_ENFORCEMENT_SCAN_LIST", "").splitlines():
    path = raw.strip()
    if not path:
        continue
    meta = parse_frontmatter(path)
    name = slug_name(path)
    absent = [f for f in REQUIRED if not meta.get(f)]
    if absent:
        missing.append(f"{name}: missing {', '.join(absent)}")
    rows.append(
        {
            "obligation": meta.get("obligation", ""),
            "mechanism": meta.get("mechanism", ""),
            "status": meta.get("status", ""),
            "lives_in": meta.get("lives_in", ""),
            "summary": meta.get("summary", ""),
        }
    )

if missing:
    sys.stderr.write("error: enforcement definitions with incomplete frontmatter:\n")
    for m in missing:
        sys.stderr.write(f"  - {m}\n")
    sys.exit(1)

rows.sort(key=lambda r: r["obligation"].lower())

for r in rows:
    print(
        "| {obligation} | {mechanism} | {status} | {lives_in} | {summary} |".format(
            obligation=cell(r["obligation"]),
            mechanism=cell(r["mechanism"]),
            status=cell(r["status"]),
            lives_in=cell(r["lives_in"]),
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
<!-- GENERATED by core/scripts/gen_enforcement_registry.sh — DO NOT EDIT BY HAND. -->
<!-- Re-run the generator to refresh; edits here are overwritten. -->

# Enforcement Registry — Obligations → Mechanism

The model-facing registry of "what's forced and how". The **discovery** generator
builds this by scanning each obligation's self-describing frontmatter
(`core/enforcement/*.md`). It is the authoritative obligation→mechanism map the
conduct layer points at.

- **mechanism** = how the obligation is enforced: `gate` (a hook/validator/skill
  step that blocks or surfaces), `automation` (a pipeline does it), or
  `honor-system` (the model is trusted to follow it — no gate).
- **status** = whether the mechanism is live (`shipped`), trusted
  (`honor-system`), or pending another brief.
- **lives_in** = where the mechanism is implemented (the file/skill that enforces
  it), or `—` for a not-yet-built mechanism.

> Consumers: `core/os/conduct.md` (the obligations point here) and
> `core/os/self-maintenance.md` (the enforcement-layer extension rule).

| obligation | mechanism | status | lives_in | summary |
|---|---|---|---|---|
HEADER
  printf '%s\n' "${table_body}"
} > "${INDEX_FILE}"

echo "generated ${INDEX_FILE}"
