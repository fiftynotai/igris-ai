"""Tests for `scripts/backfill_entity_edges.py` (FR-105).

Covers:
  * Pattern extraction across the supported marker styles
  * Self-reference filter
  * In-brief deduplication
  * Confidence values per rule family
  * Dry-run vs apply against an in-memory SQLite DB
  * INSERT OR IGNORE idempotency on re-run
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

# Ensure we import the script as a module — it lives in scripts/, sibling of __tests__/.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import backfill_entity_edges as bf  # noqa: E402  -- sys.path manipulation above


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


ENTITY_EDGES_DDL = """
CREATE TABLE entity_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_type   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT 'observed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata   TEXT NOT NULL DEFAULT '{}',
  UNIQUE(from_type, from_id, to_type, to_id, edge_type)
);
CREATE INDEX idx_edges_from ON entity_edges(from_type, from_id);
CREATE INDEX idx_edges_to   ON entity_edges(to_type, to_id);
CREATE INDEX idx_edges_type ON entity_edges(edge_type);
"""

BRIEF_FILES_DDL = """
CREATE TABLE brief_files (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project, brief_id)
);
"""


SAMPLE_BRIEFS = [
    (
        "FR-053",
        "igris-ai",
        """# FR-053: Phase 2

**Status:** Done
**Parent Brief:** FR-051
**Blocked By:** FR-052

Body text.
""",
    ),
    (
        "FR-054",
        "igris-ai",
        """# FR-054: Phase 3

**Parent Brief:** FR-051
**Blocked By:** FR-053
Related: FR-099
""",
    ),
    (
        "FR-200",
        "igris-ai",
        """# FR-200

Supersedes: FR-199
Blocks: FR-201
""",
    ),
    (
        "FR-300",
        "igris-ai",
        """# FR-300

No structural markers, just a body that happens to mention FR-100 in passing.
""",
    ),
    (
        "FR-105",
        "igris-ai",
        # Self-reference inside its own body — must be filtered.
        """# FR-105: Typed Edges

**Parent Brief:** FR-105
This brief mentions itself by accident.
""",
    ),
]


@pytest.fixture
def db_with_briefs(tmp_path: Path) -> Path:
    """Build an in-memory-style DB on disk so the CLI can connect to it."""
    db_path = tmp_path / "brain.db"
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(ENTITY_EDGES_DDL)
        conn.executescript(BRIEF_FILES_DDL)
        for brief_id, project, content in SAMPLE_BRIEFS:
            conn.execute(
                """INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (f"id-{brief_id}", project, brief_id, f"{brief_id}.md", content, "deadbeef"),
            )
        conn.commit()
    finally:
        conn.close()
    return db_path


# ---------------------------------------------------------------------------
# Pure extraction tests
# ---------------------------------------------------------------------------


class TestExtraction:
    def test_parent_brief_marker(self) -> None:
        edges = bf.extract_edges_from_brief(
            "FR-053", "**Parent Brief:** FR-051\n"
        )
        assert len(edges) == 1
        assert edges[0].edge_type == "parent_of"
        assert edges[0].from_id == "FR-053"
        assert edges[0].to_id == "FR-051"
        assert edges[0].confidence == 1.0
        assert edges[0].provenance == "backfill"

    def test_blocked_by_marker(self) -> None:
        edges = bf.extract_edges_from_brief("FR-054", "**Blocked By:** FR-053\n")
        types = [e.edge_type for e in edges]
        assert "depends_on" in types

    def test_depends_on_marker(self) -> None:
        edges = bf.extract_edges_from_brief("X-1", "Depends on: FR-100\n")
        assert any(e.edge_type == "depends_on" and e.to_id == "FR-100" for e in edges)

    def test_supersedes_marker(self) -> None:
        edges = bf.extract_edges_from_brief("FR-200", "Supersedes: FR-199\n")
        assert edges[0].edge_type == "supersedes"

    def test_blocks_marker(self) -> None:
        edges = bf.extract_edges_from_brief("FR-200", "Blocks: FR-201\n")
        assert any(e.edge_type == "blocks" for e in edges)

    def test_related_marker_is_lower_confidence(self) -> None:
        edges = bf.extract_edges_from_brief("FR-001", "Related: FR-002\n")
        assert len(edges) == 1
        assert edges[0].edge_type == "related_to"
        assert edges[0].confidence == pytest.approx(0.7)

    def test_self_reference_is_filtered(self) -> None:
        edges = bf.extract_edges_from_brief(
            "FR-105", "**Parent Brief:** FR-105\n"
        )
        assert edges == []

    def test_dedupes_within_a_brief(self) -> None:
        # Two identical Parent Brief lines -> only one edge.
        content = "**Parent Brief:** FR-051\n\nLater: **Parent Brief:** FR-051\n"
        edges = bf.extract_edges_from_brief("FR-053", content)
        assert len(edges) == 1

    def test_no_markers_yields_no_edges(self) -> None:
        edges = bf.extract_edges_from_brief(
            "FR-300", "Body text mentioning FR-100 conversationally.\n"
        )
        assert edges == []

    def test_metadata_includes_provenance_label(self) -> None:
        edges = bf.extract_edges_from_brief(
            "FR-053", "**Parent Brief:** FR-051\n", project="igris-ai"
        )
        assert edges[0].metadata["source"] == "backfill"
        assert edges[0].metadata["rule"] == "Parent Brief"
        assert edges[0].metadata["project"] == "igris-ai"


# ---------------------------------------------------------------------------
# Corpus-level extraction
# ---------------------------------------------------------------------------


class TestCorpus:
    def test_extracts_expected_edges_from_fixture(self) -> None:
        rows = [(b, p, c) for (b, p, c) in SAMPLE_BRIEFS]
        edges = bf.extract_edges_from_corpus(rows)

        # FR-053 -> 1 parent_of + 1 depends_on
        # FR-054 -> 1 parent_of + 1 depends_on + 1 related_to
        # FR-200 -> 1 supersedes + 1 blocks
        # FR-300 -> 0
        # FR-105 -> 0 (self filtered)
        # Total = 7
        assert len(edges) == 7
        types = sorted(e.edge_type for e in edges)
        assert types == sorted(
            [
                "parent_of",
                "depends_on",
                "parent_of",
                "depends_on",
                "related_to",
                "supersedes",
                "blocks",
            ]
        )


# ---------------------------------------------------------------------------
# DB I/O — apply + idempotency
# ---------------------------------------------------------------------------


class TestApply:
    def test_dry_run_does_not_write(self, db_with_briefs: Path) -> None:
        rc = bf.main(["--db", str(db_with_briefs), "--quiet"])
        assert rc == 0

        conn = sqlite3.connect(str(db_with_briefs))
        try:
            count = conn.execute("SELECT COUNT(*) FROM entity_edges").fetchone()[0]
        finally:
            conn.close()
        assert count == 0

    def test_apply_writes_expected_edges(self, db_with_briefs: Path) -> None:
        rc = bf.main(["--db", str(db_with_briefs), "--apply", "--quiet"])
        assert rc == 0

        conn = sqlite3.connect(str(db_with_briefs))
        try:
            count = conn.execute("SELECT COUNT(*) FROM entity_edges").fetchone()[0]
            rows = conn.execute(
                "SELECT from_id, to_id, edge_type, confidence, provenance FROM entity_edges ORDER BY id"
            ).fetchall()
        finally:
            conn.close()

        assert count == 7
        # Every backfilled edge must carry provenance='backfill'.
        assert all(p == "backfill" for (_, _, _, _, p) in rows)
        # related_to keeps its 0.7 confidence — explicit ones stay at 1.0.
        for (_, _, edge_type, confidence, _) in rows:
            if edge_type == "related_to":
                assert confidence == pytest.approx(0.7)
            else:
                assert confidence == pytest.approx(1.0)

    def test_apply_is_idempotent(self, db_with_briefs: Path) -> None:
        # First run inserts.
        bf.main(["--db", str(db_with_briefs), "--apply", "--quiet"])
        # Second run must not insert duplicates.
        bf.main(["--db", str(db_with_briefs), "--apply", "--quiet"])

        conn = sqlite3.connect(str(db_with_briefs))
        try:
            count = conn.execute("SELECT COUNT(*) FROM entity_edges").fetchone()[0]
        finally:
            conn.close()
        assert count == 7

    def test_min_edges_acceptance_gate_passes(self, db_with_briefs: Path) -> None:
        rc = bf.main([
            "--db", str(db_with_briefs),
            "--apply", "--quiet",
            "--min-edges", "5",
        ])
        assert rc == 0

    def test_min_edges_acceptance_gate_fails(self, db_with_briefs: Path) -> None:
        rc = bf.main([
            "--db", str(db_with_briefs),
            "--apply", "--quiet",
            "--min-edges", "100",
        ])
        assert rc == 1


# ---------------------------------------------------------------------------
# Argument handling
# ---------------------------------------------------------------------------


class TestCli:
    def test_missing_db_returns_2(self, tmp_path: Path) -> None:
        rc = bf.main(["--db", str(tmp_path / "nope.db"), "--quiet"])
        assert rc == 2

    def test_missing_table_raises(self, tmp_path: Path) -> None:
        # DB exists but has no entity_edges table.
        db = tmp_path / "empty.db"
        sqlite3.connect(str(db)).close()
        with pytest.raises(SystemExit):
            bf.main(["--db", str(db), "--quiet"])

    def test_metadata_is_valid_json(self) -> None:
        edges = bf.extract_edges_from_brief("FR-001", "**Parent Brief:** FR-000\n")
        # as_row serializes metadata to JSON; it must round-trip.
        _, _, _, _, _, _, _, metadata_json = edges[0].as_row()
        loaded = json.loads(metadata_json)
        assert loaded["source"] == "backfill"
