#!/usr/bin/env python3
"""Backfill entity_edges from existing brief markdown corpus (FR-105).

Scans `brief_files.content` in the brain SQLite DB, applies a small set of
high-precision regex patterns, and produces typed edges in the
`entity_edges` table. By default it is a dry run that prints a summary
and the first 20 sample rows; pass `--apply` to commit.

Edge types produced:
  - parent_of      from `**Parent Brief:** FR-XXX` / `Parent: FR-XXX`
  - depends_on     from `**Blocked By:** FR-XXX` / `Depends on: FR-XXX`
  - supersedes     from `Supersedes: FR-XXX`
  - blocks         from `Blocks: FR-XXX`
  - related_to     from `Related: FR-XXX` / `Related to: FR-XXX`

All edges are tagged `provenance='backfill'` and use confidence 1.0
for explicit structural markers, 0.7 for the looser `Related:` family.

Idempotent: uses INSERT OR IGNORE against the UNIQUE constraint on
(from_type, from_id, to_type, to_id, edge_type), so re-running never
duplicates rows.

Usage:
    backfill_entity_edges.py [--db PATH] [--apply] [--project SLUG]
                             [--min-edges N] [--quiet]

Exit codes:
    0  success
    1  produced fewer edges than --min-edges (acceptance gate)
    2  configuration error (missing DB, bad arg)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


# ---------------------------------------------------------------------------
# Edge regex patterns — ordered by precision (most specific first)
# ---------------------------------------------------------------------------

# Brief id pattern: 2-3 letter prefix, hyphen, digits.
BRIEF_ID = r"([A-Z]{2,3}-\d+)"


@dataclass(frozen=True)
class EdgeRule:
    """A regex -> edge_type mapping with confidence + flags."""

    edge_type: str
    pattern: re.Pattern[str]
    confidence: float
    label: str  # human-readable label for the summary table


# Common shape: optional leading `**`, optional heading hash, the keyword,
# optional `**` close, the colon (which in markdown bold lives BEFORE the
# closing stars: `**Parent Brief:**`), optional trailing `**`, then space + id.
EDGE_RULES: tuple[EdgeRule, ...] = (
    EdgeRule(
        "parent_of",
        # Tolerates "**Parent Brief:** FR-051", "Parent: FR-051",
        # "## Parent: FR-051" and similar header variants.
        re.compile(
            rf"(?:\*\*|^|\n)\s*(?:#+\s*)?\*?\*?Parent(?:\s+Brief)?:\*?\*?\s*{BRIEF_ID}",
            re.MULTILINE | re.IGNORECASE,
        ),
        1.0,
        "Parent Brief",
    ),
    EdgeRule(
        "depends_on",
        # `**Blocked By:** FR-XXX` (modern brief format) and
        # `Depends on: FR-XXX` / `Depends: FR-XXX`.
        re.compile(
            rf"(?:\*\*|^|\n)\s*\*?\*?(?:Blocked\s+By|Depends(?:\s+on)?):\*?\*?\s*{BRIEF_ID}",
            re.MULTILINE | re.IGNORECASE,
        ),
        1.0,
        "Depends on / Blocked By",
    ),
    EdgeRule(
        "supersedes",
        re.compile(rf"(?:\*\*|^|\n)\s*\*?\*?Supersedes:\*?\*?\s*{BRIEF_ID}", re.MULTILINE | re.IGNORECASE),
        1.0,
        "Supersedes",
    ),
    EdgeRule(
        "blocks",
        re.compile(rf"(?:\*\*|^|\n)\s*\*?\*?Blocks:\*?\*?\s*{BRIEF_ID}", re.MULTILINE | re.IGNORECASE),
        1.0,
        "Blocks",
    ),
    EdgeRule(
        "related_to",
        # Looser semantic association — lower confidence.
        re.compile(rf"(?:\*\*|^|\n)\s*\*?\*?Related(?:\s+to)?:\*?\*?\s*{BRIEF_ID}", re.MULTILINE | re.IGNORECASE),
        0.7,
        "Related",
    ),
)


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------


@dataclass
class CandidateEdge:
    """An edge produced by the extractor — not yet inserted."""

    from_type: str
    from_id: str
    to_type: str
    to_id: str
    edge_type: str
    confidence: float
    provenance: str
    metadata: dict[str, object]

    def as_row(self) -> tuple[str, str, str, str, str, float, str, str]:
        return (
            self.from_type,
            self.from_id,
            self.to_type,
            self.to_id,
            self.edge_type,
            self.confidence,
            self.provenance,
            json.dumps(self.metadata, sort_keys=True),
        )


def extract_edges_from_brief(
    brief_id: str,
    content: str,
    *,
    project: str | None = None,
) -> list[CandidateEdge]:
    """Return all candidate edges discovered in a single brief's markdown."""
    edges: list[CandidateEdge] = []
    seen: set[tuple[str, str]] = set()  # (edge_type, target_id) — dedupe within same brief

    for rule in EDGE_RULES:
        for match in rule.pattern.finditer(content):
            target = match.group(1)
            if target == brief_id:
                # Self-reference (e.g. brief content quoting its own id) — skip.
                continue
            key = (rule.edge_type, target)
            if key in seen:
                continue
            seen.add(key)

            metadata: dict[str, object] = {"source": "backfill", "rule": rule.label}
            if project:
                metadata["project"] = project

            edges.append(
                CandidateEdge(
                    from_type="brief",
                    from_id=brief_id,
                    to_type="brief",
                    to_id=target,
                    edge_type=rule.edge_type,
                    confidence=rule.confidence,
                    provenance="backfill",
                    metadata=metadata,
                )
            )
    return edges


def extract_edges_from_corpus(
    rows: Iterable[tuple[str, str, str]],
) -> list[CandidateEdge]:
    """Extract edges from an iterable of (brief_id, project, content) rows."""
    out: list[CandidateEdge] = []
    for brief_id, project, content in rows:
        out.extend(extract_edges_from_brief(brief_id, content, project=project))
    return out


# ---------------------------------------------------------------------------
# DB I/O
# ---------------------------------------------------------------------------


def load_brief_corpus(
    conn: sqlite3.Connection,
    *,
    project_filter: str | None = None,
) -> list[tuple[str, str, str]]:
    """Load (brief_id, project, content) triples from brief_files."""
    if project_filter:
        cursor = conn.execute(
            "SELECT brief_id, project, content FROM brief_files WHERE project = ? ORDER BY brief_id",
            (project_filter,),
        )
    else:
        cursor = conn.execute(
            "SELECT brief_id, project, content FROM brief_files ORDER BY project, brief_id"
        )
    return list(cursor.fetchall())


def ensure_entity_edges_table(conn: sqlite3.Connection) -> None:
    """Verify the entity_edges table exists. The schema is owned by the
    edges component migration; this script must not create it on its own.
    """
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_edges'"
    ).fetchone()
    if not row:
        raise SystemExit(
            "Error: entity_edges table not found. Boot the brain server once to "
            "run the edges component migration before running this backfill."
        )


def apply_edges(
    conn: sqlite3.Connection,
    edges: Sequence[CandidateEdge],
) -> dict[str, int]:
    """Insert edges in a single transaction, using INSERT OR IGNORE.

    Returns: dict with `inserted`, `skipped_duplicate`, `errors` counts.
    """
    inserted = 0
    skipped = 0
    errors = 0

    with conn:  # implicit transaction
        for edge in edges:
            try:
                cur = conn.execute(
                    """INSERT OR IGNORE INTO entity_edges
                         (from_type, from_id, to_type, to_id, edge_type,
                          confidence, provenance, metadata)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    edge.as_row(),
                )
                if cur.rowcount == 1:
                    inserted += 1
                else:
                    skipped += 1
            except sqlite3.Error as exc:
                errors += 1
                print(f"  ERROR inserting {edge}: {exc}", file=sys.stderr)

    return {"inserted": inserted, "skipped_duplicate": skipped, "errors": errors}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def default_db_path() -> Path:
    return Path(os.path.expanduser("~/.igris/memory/knowledge.db"))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill entity_edges from brief markdown (FR-105)."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=default_db_path(),
        help="Path to the brain SQLite DB (default: ~/.igris/memory/knowledge.db)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit edges to the DB. Without this, the script is a dry run.",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=None,
        help="Restrict to a single project slug (default: all projects).",
    )
    parser.add_argument(
        "--min-edges",
        type=int,
        default=0,
        help="Exit with code 1 if fewer than this many edges are produced (acceptance gate).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress sample edge output (still prints summary + JSON line).",
    )
    return parser.parse_args(argv)


def format_summary(edges: Sequence[CandidateEdge]) -> str:
    counts = Counter(e.edge_type for e in edges)
    lines = ["Edge type counts:"]
    for edge_type, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"  {edge_type:14s} {count}")
    lines.append(f"  {'TOTAL':14s} {len(edges)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not args.db.exists():
        print(f"Error: DB file not found: {args.db}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(args.db))
    try:
        ensure_entity_edges_table(conn)
        rows = load_brief_corpus(conn, project_filter=args.project)
        if not rows:
            print(
                f"No briefs found{' for project ' + args.project if args.project else ''}.",
                file=sys.stderr,
            )

        edges = extract_edges_from_corpus(rows)

        print(format_summary(edges))

        if not args.quiet and edges:
            print("\nFirst 20 candidate edges:")
            for edge in edges[:20]:
                print(
                    f"  {edge.edge_type:14s} {edge.from_id:>10s} -> "
                    f"{edge.to_id:<10s} conf={edge.confidence:.2f}"
                )

        if args.apply:
            stats = apply_edges(conn, edges)
            print(f"\nApplied: {json.dumps(stats)}")
        else:
            stats = {"inserted": 0, "skipped_duplicate": 0, "errors": 0, "dry_run": True}
            print("\nDry run — pass --apply to commit.")
            print(json.dumps(stats))

        if args.min_edges and len(edges) < args.min_edges:
            print(
                f"\nFAIL: produced {len(edges)} edges, below threshold {args.min_edges}.",
                file=sys.stderr,
            )
            return 1
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
