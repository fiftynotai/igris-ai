#!/bin/bash

# Description: Sync a canonical agent prompt into a Claude Code subagent
#              harness file (.claude/agents/<name>.md). The harness body is
#              overwritten with the canonical body; the harness YAML
#              frontmatter is PRESERVED verbatim. This mechanizes the TD-018
#              D5 manual "OVERWRITE BODY" step (TD-021).
# Usage: sync_claude_agents.sh <canonical-md> <output-harness-md> [body-exception-json]
#   canonical-md         - Canonical prompt source (markdown, may have frontmatter)
#   output-harness-md    - Existing harness .md whose body is replaced
#   body-exception-json  - Optional: a body-exceptions/*.json sidecar declaring
#                          a documented appendix paragraph to insert into the
#                          harness body (see body-exceptions/ for the schema)
# Dependencies: python3, _common.sh (auto-sourced from script dir)
# Exit codes:
#   0 - Success (harness body synced)
#   1 - Error (missing input, harness does not exist, IO error)
#   2 - Usage error (wrong arguments)
#
# GENERATED-MARKER DIVERGENCE FROM md_to_agents_md.sh:
#   md_to_agents_md.sh injects an HTML-comment marker into its output. This
#   adapter does NOT — the harness body must stay byte-equal to the canonical
#   body (minus any documented body-exception) so check_harness_drift.sh can
#   verify sync via sha_body equality. A marker in the body would break that
#   invariant. The generation signal is the stdout log line instead.
#
# CREATION-VS-SYNC:
#   This adapter mechanizes SYNC, not CREATION. The output harness file MUST
#   already exist — its frontmatter (name:, description:, tools:) is authored
#   by a human and preserved. Creating a brand-new harness is intentionally a
#   manual step.

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
  echo "Usage: $0 <canonical-md> <output-harness-md> [body-exception-json]" >&2
  echo "" >&2
  echo "Overwrites the harness .md body with the canonical body, preserving" >&2
  echo "the harness YAML frontmatter. The harness file must already exist." >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
fi

CANONICAL_PATH="$1"
HARNESS_PATH="$2"
EXCEPTION_PATH="${3:-}"

if [ -z "$CANONICAL_PATH" ] || [ -z "$HARNESS_PATH" ]; then
  usage
fi

if [ ! -f "$CANONICAL_PATH" ]; then
  echo "Error: Canonical file '$CANONICAL_PATH' does not exist" >&2
  exit 1
fi

if [ ! -f "$HARNESS_PATH" ]; then
  echo "Error: Harness file '$HARNESS_PATH' does not exist." >&2
  echo "       This adapter syncs an EXISTING harness; it does not create one." >&2
  echo "       Author the harness frontmatter by hand first, then re-run." >&2
  exit 1
fi

if [ -n "$EXCEPTION_PATH" ] && [ ! -f "$EXCEPTION_PATH" ]; then
  echo "Error: Body-exception file '$EXCEPTION_PATH' does not exist" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Preserve harness frontmatter; the body is sourced from canonical.
# ---------------------------------------------------------------------------
HARNESS_FM=$(parse_frontmatter "$HARNESS_PATH") || {
  echo "Error: Harness file '$HARNESS_PATH' has no YAML frontmatter to preserve" >&2
  exit 1
}

CANONICAL_BODY=$(strip_frontmatter "$CANONICAL_PATH")

# ---------------------------------------------------------------------------
# Emit the synced harness atomically (temp file + mv), matching the
# md_to_agents_md.sh atomic-write convention.
# ---------------------------------------------------------------------------
OUTPUT_DIR=$(dirname "$HARNESS_PATH")
mkdir -p "$OUTPUT_DIR"

TMP_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/igris_claude_harness.XXXXXX")
trap 'rm -f "$TMP_OUTPUT"' EXIT

python3 - "$TMP_OUTPUT" "$HARNESS_FM" "$CANONICAL_BODY" "$EXCEPTION_PATH" <<'PY'
import json
import sys

out_path = sys.argv[1]
frontmatter = sys.argv[2]
body = sys.argv[3]
exception_path = sys.argv[4]

# Apply a documented body-exception: insert the appendix paragraph(s)
# immediately after the unique anchor line within the canonical body.
if exception_path:
    with open(exception_path, "r", encoding="utf-8") as fh:
        exc = json.load(fh)
    anchor = exc["anchor"]
    insert_lines = exc["insert"]
    body_lines = body.splitlines()
    matches = [i for i, ln in enumerate(body_lines) if ln.strip() == anchor.strip()]
    if len(matches) != 1:
        sys.stderr.write(
            f"Error: body-exception anchor matched {len(matches)} lines "
            f"(expected exactly 1) in canonical body\n"
        )
        sys.exit(1)
    idx = matches[0]
    body_lines = body_lines[: idx + 1] + insert_lines + body_lines[idx + 1 :]
    body = "\n".join(body_lines)
    if not body.endswith("\n"):
        body += "\n"

# Normalize: frontmatter block has no leading/trailing blank padding; the
# body follows one blank line after the closing delimiter.
fm = frontmatter.rstrip("\n")
text = "---\n" + fm + "\n---\n\n" + body
if not text.endswith("\n"):
    text += "\n"

with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY

mv "$TMP_OUTPUT" "$HARNESS_PATH"
trap - EXIT

echo "Claude agent harness synced: $HARNESS_PATH"
