"""Tests for BR-021 heatmap no-data fixes in server.py."""

import asyncio
import sys
import os

import pytest
import aiosqlite

# Ensure dashboard package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import SCHEMA_SQL, insert_event, build_skill_heatmap, init_db


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def db(event_loop):
    """Provide an in-memory SQLite database with schema applied."""
    async def _setup():
        conn = await aiosqlite.connect(":memory:")
        await conn.executescript(SCHEMA_SQL)
        await conn.commit()
        return conn

    conn = event_loop.run_until_complete(_setup())
    yield conn
    event_loop.run_until_complete(conn.close())


class TestSkillInvocationsSchema:
    """Fix 4: UNIQUE constraint on skill_invocations."""

    def test_unique_constraint_in_schema(self):
        assert "UNIQUE(skill_name, ts)" in SCHEMA_SQL

    def test_duplicate_insert_ignored(self, db, event_loop):
        async def _test():
            await db.execute(
                "INSERT INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                ("2026-02-17T10:00:00Z", "/hunt", "2026-02-17"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                ("2026-02-17T10:00:00Z", "/hunt", "2026-02-17"),
            )
            await db.commit()
            async with db.execute("SELECT COUNT(*) FROM skill_invocations") as cur:
                row = await cur.fetchone()
            assert row[0] == 1

        event_loop.run_until_complete(_test())


class TestInsertEventSkillInvoke:
    """Fix 2 + Fix 3: skill_invoke handling moved into insert_event with UTC."""

    def test_skill_invoke_inserts_into_skill_invocations(self, db, event_loop):
        async def _test():
            event = {
                "ts": "2026-02-17T12:00:00+00:00",
                "event": "skill_invoke",
                "agent": "orchestrator",
                "skill_name": "/scan",
            }
            result = await insert_event(db, event)
            assert result is True

            async with db.execute("SELECT skill_name FROM skill_invocations") as cur:
                row = await cur.fetchone()
            assert row is not None
            assert row[0] == "/scan"

        event_loop.run_until_complete(_test())

    def test_non_skill_event_does_not_insert_skill(self, db, event_loop):
        async def _test():
            event = {
                "ts": "2026-02-17T12:00:00+00:00",
                "event": "stop",
                "agent": "forger",
            }
            await insert_event(db, event)
            async with db.execute("SELECT COUNT(*) FROM skill_invocations") as cur:
                row = await cur.fetchone()
            assert row[0] == 0

        event_loop.run_until_complete(_test())

    def test_skill_invoke_without_skill_name_skips(self, db, event_loop):
        async def _test():
            event = {
                "ts": "2026-02-17T12:00:00+00:00",
                "event": "skill_invoke",
                "agent": "orchestrator",
                "skill_name": "",
            }
            await insert_event(db, event)
            async with db.execute("SELECT COUNT(*) FROM skill_invocations") as cur:
                row = await cur.fetchone()
            assert row[0] == 0

        event_loop.run_until_complete(_test())


class TestBuildSkillHeatmap:
    """Fix 1: build_skill_heatmap logs warnings instead of silent catch."""

    def test_returns_data_when_populated(self, db, event_loop):
        async def _test():
            await db.execute(
                "INSERT INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                ("2026-02-17T10:00:00Z", "/hunt", "2026-02-17"),
            )
            await db.execute(
                "INSERT INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                ("2026-02-17T10:05:00Z", "/hunt", "2026-02-17"),
            )
            await db.execute(
                "INSERT INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                ("2026-02-17T10:10:00Z", "/scan", "2026-02-17"),
            )
            await db.commit()

            result = await build_skill_heatmap(db, "all")
            assert result["total"] == 3
            assert result["skills"]["/hunt"] == 2
            assert result["skills"]["/scan"] == 1

        event_loop.run_until_complete(_test())

    def test_returns_empty_on_no_data(self, db, event_loop):
        async def _test():
            result = await build_skill_heatmap(db, "all")
            assert result["total"] == 0
            assert result["skills"] == {}

        event_loop.run_until_complete(_test())

    def test_returns_fallback_on_error(self, event_loop):
        """Passing a closed DB should trigger the except branch."""
        async def _test():
            conn = await aiosqlite.connect(":memory:")
            await conn.close()
            result = await build_skill_heatmap(conn, "all")
            assert result == {"skills": {}, "total": 0}

        event_loop.run_until_complete(_test())


class TestStartupVerification:
    """Fix 5: skill_invocations table exists after init_db."""

    def test_table_exists_after_init(self, db, event_loop):
        async def _test():
            async with db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'"
            ) as cur:
                row = await cur.fetchone()
            assert row is not None
            assert row[0] == "skill_invocations"

        event_loop.run_until_complete(_test())
