"""
Igris AI - Crimson Arena Dashboard Server

FastAPI server that receives agent events via WebSocket and REST,
stores them in SQLite, and serves the static frontend.

Usage:
    uvicorn dashboard.server:app --host 127.0.0.1 --port 8001

Dependencies:
    fastapi, uvicorn, aiosqlite, watchfiles
"""

import asyncio
import json
import logging
import os
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
import httpx
import aiosqlite
from pydantic import BaseModel, Field
from typing import Literal, Optional
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("crimson-arena")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_DIR = os.environ.get(
    "CLAUDE_PROJECT_DIR",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)
METRICS_DIR = os.path.join(PROJECT_DIR, "ai", "session", "metrics")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arena.db")
METRICS_FILE = os.path.join(METRICS_DIR, "agent-metrics.json")
EVENTS_FILE = os.path.join(METRICS_DIR, "events.jsonl")
BUDGET_FILE = os.path.join(METRICS_DIR, "budget.json")
# Determine static directory: prefer Flutter build, fall back to vanilla JS
FLUTTER_BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crimson-arena", "build", "web")
VANILLA_STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

if os.path.isdir(FLUTTER_BUILD) and os.path.isfile(os.path.join(FLUTTER_BUILD, "index.html")):
    STATIC_DIR = FLUTTER_BUILD
    logger.info("Serving Flutter Web build from %s", FLUTTER_BUILD)
else:
    STATIC_DIR = VANILLA_STATIC
    logger.info("Serving vanilla JS dashboard from %s", VANILLA_STATIC)

# ---------------------------------------------------------------------------
# Pricing Data
# ---------------------------------------------------------------------------

LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

FALLBACK_PRICING = {
    "claude-opus-4-6": {
        "input_cost_per_token": 5e-06,
        "output_cost_per_token": 2.5e-05,
        "cache_read_input_token_cost": 5e-07,
        "cache_creation_input_token_cost": 6.25e-06,
    },
    "claude-sonnet-4-5-20250514": {
        "input_cost_per_token": 3e-06,
        "output_cost_per_token": 1.5e-05,
        "cache_read_input_token_cost": 3e-07,
        "cache_creation_input_token_cost": 3.75e-06,
    },
    "claude-haiku-4-5-20250514": {
        "input_cost_per_token": 1e-06,
        "output_cost_per_token": 5e-06,
        "cache_read_input_token_cost": 1e-07,
        "cache_creation_input_token_cost": 1.25e-06,
    },
}

# ---------------------------------------------------------------------------
# Brain Configuration
# ---------------------------------------------------------------------------

BRAIN_CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".igris", "config.json")


def load_brain_config() -> dict:
    """Load brain server configuration from ~/.igris/config.json or env vars."""
    config = {"url": None, "api_key": None}

    # Try config file first
    try:
        if os.path.exists(BRAIN_CONFIG_FILE):
            with open(BRAIN_CONFIG_FILE) as f:
                data = json.load(f)
            remote = data.get("remote_brain", {})
            config["url"] = remote.get("url")
            config["api_key"] = remote.get("api_key")
    except Exception:
        pass

    # Environment variable overrides
    if not config["url"]:
        config["url"] = os.environ.get("BRAIN_URL")
    if not config["api_key"]:
        config["api_key"] = os.environ.get("BRAIN_API_KEY")

    return config


async def brain_request(app, path: str, params: dict = None) -> dict | None:
    """Make authenticated GET request to brain server. Returns None on any error."""
    # Validate path to prevent traversal attacks
    if not path.startswith("/") or ".." in path:
        raise HTTPException(status_code=400, detail="Invalid brain request path")

    brain_config = app.state.brain_config
    if not brain_config.get("url"):
        return None

    if not app.state.brain_client:
        return None

    try:
        url = f"{brain_config['url'].rstrip('/')}{path}"
        headers = {}
        if brain_config.get("api_key"):
            headers["Authorization"] = f"Bearer {brain_config['api_key']}"

        resp = await app.state.brain_client.get(url, params=params, headers=headers)
        if resp.status_code == 200:
            return resp.json()
        else:
            logger.warning("Brain request %s returned %d", path, resp.status_code)
            return None
    except Exception as exc:
        logger.warning("Brain request %s failed: %s", path, exc)
        return None


# ---------------------------------------------------------------------------
# Agent Leveling System
# ---------------------------------------------------------------------------

LEVEL_THRESHOLDS = [
    (0, "Trainee", 0),
    (5, "Novice", 1),
    (15, "Adept", 2),
    (30, "Expert", 3),
    (50, "Master", 4),
    (100, "Legend", 5),
    (200, "Mythic", 6),
]

EVOLUTION_TIERS = {
    0: "In-Training",
    1: "In-Training",
    2: "Rookie",
    3: "Champion",
    4: "Ultimate",
    5: "Mega",
    6: "Mega",
}


def get_level(invocations: int) -> dict:
    """Compute level info from invocation count.

    Returns dict with keys: name, tier, evolution, next_at, progress.
    """
    level_name = "Trainee"
    level_tier = 0
    current_threshold = 0

    for threshold, name, tier in LEVEL_THRESHOLDS:
        if invocations >= threshold:
            level_name = name
            level_tier = tier
            current_threshold = threshold

    # Find next threshold
    next_threshold = None
    for threshold, _name, _tier in LEVEL_THRESHOLDS:
        if threshold > invocations:
            next_threshold = threshold
            break

    # Progress toward next level
    if next_threshold is not None:
        span = next_threshold - current_threshold
        progress = (invocations - current_threshold) / span if span > 0 else 1.0
    else:
        progress = 1.0

    evolution = EVOLUTION_TIERS.get(level_tier, "In-Training")

    return {
        "name": level_name,
        "tier": level_tier,
        "evolution": evolution,
        "next_at": next_threshold if next_threshold else current_threshold,
        "progress": round(progress, 3),
    }


# ---------------------------------------------------------------------------
# RPG Stat Derivation
# ---------------------------------------------------------------------------


def compute_rpg_stats(agent_data: dict, all_agents: dict) -> dict:
    """Compute STR/INT/SPD/VIT from real agent data.

    STR = output token volume (relative to max across agents)
    INT = cache efficiency (cache_read ratio of total cache input)
    SPD = speed (inverse of duration relative to slowest agent)
    VIT = success rate as percentage
    """
    max_output = max(
        (a.get("total_output_tokens", 0) for a in all_agents.values()), default=1
    ) or 1
    max_duration = max(
        (a.get("avg_duration_seconds", 0) for a in all_agents.values()), default=1
    ) or 1

    total_input = agent_data.get("total_input_tokens", 0)
    cache_read = agent_data.get("total_cache_read_tokens", 0)
    cache_create = agent_data.get("total_cache_create_tokens", 0)
    total_cache_input = total_input + cache_read + cache_create

    str_val = round(agent_data.get("total_output_tokens", 0) / max_output * 100)
    int_val = round(cache_read / total_cache_input * 100) if total_cache_input > 0 else 0
    spd_val = round(
        100 - min(agent_data.get("avg_duration_seconds", 0) / max_duration * 100, 100)
    )
    vit_val = round(agent_data.get("success_rate", 1.0) * 100)

    return {"STR": str_val, "INT": int_val, "SPD": spd_val, "VIT": vit_val}


# ---------------------------------------------------------------------------
# Budget Config
# ---------------------------------------------------------------------------


def load_budget_config() -> dict:
    """Load budget configuration from budget.json with sensible defaults."""
    defaults = {
        "daily_token_budget": 1000000,
        "warning_threshold": 0.75,
        "critical_threshold": 0.90,
    }
    try:
        with open(BUDGET_FILE, "r") as f:
            config = json.load(f)
            return {**defaults, **config}
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not load budget.json (%s), using defaults", exc)
        return defaults


async def fetch_pricing() -> dict:
    """Fetch Claude model pricing from LiteLLM community registry.

    Returns dict of claude model entries with 4 cost fields each.
    Falls back to FALLBACK_PRICING on any error.
    """
    cost_fields = (
        "input_cost_per_token",
        "output_cost_per_token",
        "cache_read_input_token_cost",
        "cache_creation_input_token_cost",
    )
    try:
        loop = asyncio.get_running_loop()

        def _fetch():
            req = urllib.request.Request(
                LITELLM_URL,
                headers={"User-Agent": "igris-ai-dashboard/1.0"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await loop.run_in_executor(None, _fetch)

        pricing = {}
        for key, entry in data.items():
            if not key.startswith("claude-"):
                continue
            if not isinstance(entry, dict):
                continue
            if "input_cost_per_token" not in entry:
                continue
            pricing[key] = {field: entry.get(field, 0) for field in cost_fields}

        if pricing:
            logger.info("Fetched pricing for %d Claude models from LiteLLM", len(pricing))
            return pricing, "litellm"
        else:
            logger.warning("No Claude entries in LiteLLM data, using fallback")
            return dict(FALLBACK_PRICING), "fallback"
    except Exception as exc:
        logger.warning("Failed to fetch LiteLLM pricing (%s), using fallback", exc)
        return dict(FALLBACK_PRICING), "fallback"


# ---------------------------------------------------------------------------
# WebSocket Connection Manager
# ---------------------------------------------------------------------------


class ConnectionManager:
    """Manages active WebSocket connections and broadcasts events."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(
            "WebSocket client connected (total: %d)", len(self.active_connections)
        )

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(
            "WebSocket client disconnected (total: %d)", len(self.active_connections)
        )

    async def broadcast(self, data: dict):
        """Send data to all connected clients, removing dead connections."""
        disconnected = []
        for conn in self.active_connections:
            try:
                await conn.send_json(data)
            except Exception:
                disconnected.append(conn)
        for conn in disconnected:
            if conn in self.active_connections:
                self.active_connections.remove(conn)


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# Database Initialization
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event TEXT NOT NULL,
    agent TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    raw_type TEXT DEFAULT '',
    duration_s REAL DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,
    cache_create INTEGER DEFAULT 0,
    session_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_events_session_date ON events(session_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(ts, agent, event, input_tokens, output_tokens, cache_read, cache_create);

CREATE TABLE IF NOT EXISTS agent_levels (
    agent TEXT PRIMARY KEY,
    total_invocations INTEGER DEFAULT 0,
    level_name TEXT DEFAULT 'Trainee',
    level_tier INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_budget (
    date TEXT PRIMARY KEY,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_read INTEGER DEFAULT 0,
    total_cache_create INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    session_date TEXT NOT NULL,
    UNIQUE(skill_name, ts)
);
CREATE INDEX IF NOT EXISTS idx_skill_name ON skill_invocations(skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_session_date ON skill_invocations(session_date);

CREATE TABLE IF NOT EXISTS context_window (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    context_used INTEGER DEFAULT 0,
    context_max INTEGER DEFAULT 200000,
    context_remaining INTEGER DEFAULT 200000,
    model_id TEXT DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_breakdown (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt INTEGER DEFAULT 0,
    system_tools INTEGER DEFAULT 0,
    mcp_tools INTEGER DEFAULT 0,
    custom_agents INTEGER DEFAULT 0,
    rules INTEGER DEFAULT 0,
    claude_md INTEGER DEFAULT 0,
    memory INTEGER DEFAULT 0,
    skills INTEGER DEFAULT 0,
    messages INTEGER DEFAULT 0,
    autocompact_buffer INTEGER DEFAULT 0,
    free_space INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
);
"""


async def init_db(db: aiosqlite.Connection):
    """Create tables and indexes if they do not exist."""
    await db.executescript(SCHEMA_SQL)
    await db.commit()
    logger.info("Database initialized at %s", DB_PATH)


# ---------------------------------------------------------------------------
# Metrics State Loading
# ---------------------------------------------------------------------------


async def load_metrics_state(db: aiosqlite.Connection):
    """Load initial state from agent-metrics.json into agent_levels table.

    Only inserts agents that are not already tracked so that runtime
    updates are not overwritten on restart.
    """
    if not os.path.exists(METRICS_FILE):
        logger.warning("agent-metrics.json not found at %s", METRICS_FILE)
        return

    try:
        with open(METRICS_FILE, "r") as f:
            metrics = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not load agent-metrics.json: %s", exc)
        return

    agents = metrics.get("agents", {})
    now = datetime.now(timezone.utc).isoformat()

    for agent_name, agent_data in agents.items():
        invocations = agent_data.get("invocations", 0)
        level_info = get_level(invocations)

        # Use INSERT OR REPLACE to always have fresh data on restart
        await db.execute(
            """INSERT OR REPLACE INTO agent_levels
               (agent, total_invocations, level_name, level_tier, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (agent_name, invocations, level_info["name"], level_info["tier"], now),
        )

    await db.commit()
    logger.info("Loaded metrics state for %d agents", len(agents))


# ---------------------------------------------------------------------------
# Event Processing
# ---------------------------------------------------------------------------


def extract_session_date(ts_str: str) -> str:
    """Extract YYYY-MM-DD date from an ISO timestamp string."""
    try:
        return ts_str[:10]
    except (TypeError, IndexError):
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_date_range(range_key: str) -> tuple:
    """Get start date string for the given range filter."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if range_key == "today":
        return today
    elif range_key == "week":
        now = datetime.now(timezone.utc)
        monday = now - timedelta(days=now.weekday())
        return monday.strftime("%Y-%m-%d")
    return None  # "all" = no filter


def build_date_where(range_key: str) -> tuple:
    """Return SQL WHERE clause fragment and params for date filtering."""
    if range_key == "today":
        start = get_date_range("today")
        return "AND session_date = ?", (start,)
    elif range_key == "week":
        start = get_date_range("week")
        return "AND session_date >= ?", (start,)
    return "", ()  # "all" = no filter


async def insert_event(db: aiosqlite.Connection, event: dict):
    """Insert a single event into the events table and update aggregates."""
    ts = event.get("ts", datetime.now(timezone.utc).isoformat())
    event_type = event.get("event", "unknown")
    agent = event.get("agent", "unknown")
    agent_id = event.get("agent_id", "")
    raw_type = event.get("raw_type", "")
    duration_s = float(event.get("duration_s", 0))
    input_tokens = int(event.get("input_tokens", 0))
    output_tokens = int(event.get("output_tokens", 0))
    cache_read = int(event.get("cache_read", 0))
    cache_create = int(event.get("cache_create", 0))
    session_date = extract_session_date(ts)

    cursor = await db.execute(
        """INSERT OR IGNORE INTO events
           (ts, event, agent, agent_id, raw_type, duration_s,
            input_tokens, output_tokens, cache_read, cache_create, session_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            ts,
            event_type,
            agent,
            agent_id,
            raw_type,
            duration_s,
            input_tokens,
            output_tokens,
            cache_read,
            cache_create,
            session_date,
        ),
    )

    # Skip aggregate updates if this was a duplicate (already inserted)
    if cursor.rowcount == 0:
        return False

    # Update daily_budget for stop events (which carry token data)
    if event_type == "stop":
        await db.execute(
            """INSERT INTO daily_budget (date, total_input_tokens, total_output_tokens,
                                        total_cache_read, total_cache_create)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                   total_input_tokens = total_input_tokens + excluded.total_input_tokens,
                   total_output_tokens = total_output_tokens + excluded.total_output_tokens,
                   total_cache_read = total_cache_read + excluded.total_cache_read,
                   total_cache_create = total_cache_create + excluded.total_cache_create""",
            (session_date, input_tokens, output_tokens, cache_read, cache_create),
        )

        # Update agent_levels
        now = datetime.now(timezone.utc).isoformat()
        async with db.execute(
            "SELECT total_invocations FROM agent_levels WHERE agent = ?", (agent,)
        ) as cursor:
            row = await cursor.fetchone()

        if row:
            new_count = row[0] + 1
        else:
            new_count = 1

        level_info = get_level(new_count)
        await db.execute(
            """INSERT OR REPLACE INTO agent_levels
               (agent, total_invocations, level_name, level_tier, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (agent, new_count, level_info["name"], level_info["tier"], now),
        )

        # Update context_window for orchestrator stop events with context data
        if agent == "orchestrator":
            ctx_max = int(event.get("context_max", 0))
            if ctx_max > 0:
                ctx_used = int(event.get("context_used", 0))
                ctx_remaining = int(event.get("context_remaining", 0))
                model_id = event.get("model_id", "")
                await db.execute(
                    """INSERT OR REPLACE INTO context_window
                       (id, context_used, context_max, context_remaining, model_id, updated_at)
                       VALUES (1, ?, ?, ?, ?, ?)""",
                    (ctx_used, ctx_max, ctx_remaining, model_id, now),
                )

                # Update context_breakdown if present
                breakdown = event.get("context_breakdown")
                if isinstance(breakdown, dict):
                    await db.execute(
                        """INSERT OR REPLACE INTO context_breakdown
                           (id, system_prompt, system_tools, mcp_tools, custom_agents,
                            rules, claude_md, memory, skills, messages,
                            autocompact_buffer, free_space, updated_at)
                           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            int(breakdown.get("system_prompt", 0)),
                            int(breakdown.get("system_tools", 0)),
                            int(breakdown.get("mcp_tools", 0)),
                            int(breakdown.get("custom_agents", 0)),
                            int(breakdown.get("rules", 0)),
                            int(breakdown.get("claude_md", 0)),
                            int(breakdown.get("memory", 0)),
                            int(breakdown.get("skills", 0)),
                            int(breakdown.get("messages", 0)),
                            int(breakdown.get("autocompact_buffer", 0)),
                            int(breakdown.get("free_space", 0)),
                            now,
                        ),
                    )

    # Handle skill_invoke: insert into skill_invocations table
    if event_type == "skill_invoke":
        skill_name = event.get("skill_name", "")
        if skill_name:
            await db.execute(
                "INSERT OR IGNORE INTO skill_invocations (ts, skill_name, session_date) VALUES (?, ?, ?)",
                (ts, skill_name, session_date),
            )

    await db.commit()
    return True


# ---------------------------------------------------------------------------
# File Watcher (events.jsonl sync)
# ---------------------------------------------------------------------------


async def sync_events_from_file(db: aiosqlite.Connection):
    """Sync events from events.jsonl that were not received via POST.

    Reads the file, skips already-processed lines based on sync_state,
    and inserts new events into the database.
    """
    if not os.path.exists(EVENTS_FILE):
        logger.info("events.jsonl not found, skipping file sync")
        return

    # Get last synced line count
    async with db.execute(
        "SELECT value FROM sync_state WHERE key = 'events_line_count'"
    ) as cursor:
        row = await cursor.fetchone()
    last_count = int(row[0]) if row else 0

    try:
        with open(EVENTS_FILE, "r") as f:
            lines = f.readlines()
    except OSError as exc:
        logger.warning("Could not read events.jsonl: %s", exc)
        return

    new_lines = lines[last_count:]
    inserted = 0
    for line in new_lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
            await insert_event(db, event)
            inserted += 1
        except json.JSONDecodeError:
            logger.warning("Skipping malformed line in events.jsonl")
            continue

    new_count = len(lines)
    await db.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('events_line_count', ?)",
        (str(new_count),),
    )
    await db.commit()

    if inserted > 0:
        logger.info("Synced %d new events from events.jsonl (total lines: %d)", inserted, new_count)
    else:
        logger.info("events.jsonl up to date (total lines: %d)", new_count)


async def backfill_context_window(db: aiosqlite.Connection):
    """One-time backfill of context_window table from events.jsonl.

    Needed when events were synced before the context_window feature existed.
    Scans the file in reverse for the latest orchestrator stop with context data.
    """
    async with db.execute("SELECT COUNT(*) FROM context_window") as cursor:
        row = await cursor.fetchone()
    if row and row[0] > 0:
        return  # Already populated

    if not os.path.exists(EVENTS_FILE):
        return

    try:
        with open(EVENTS_FILE, "r") as f:
            lines = f.readlines()
    except OSError:
        return

    # Scan in reverse for the latest orchestrator stop with context data
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            event.get("agent") == "orchestrator"
            and event.get("event") == "stop"
            and int(event.get("context_max", 0)) > 0
        ):
            now = datetime.now(timezone.utc).isoformat()
            await db.execute(
                """INSERT OR REPLACE INTO context_window
                   (id, context_used, context_max, context_remaining, model_id, updated_at)
                   VALUES (1, ?, ?, ?, ?, ?)""",
                (
                    int(event.get("context_used", 0)),
                    int(event.get("context_max", 200000)),
                    int(event.get("context_remaining", 0)),
                    event.get("model_id", ""),
                    now,
                ),
            )
            await db.commit()
            logger.info(
                "Backfilled context_window: used=%d, max=%d",
                int(event.get("context_used", 0)),
                int(event.get("context_max", 200000)),
            )
            return

    logger.info("No context data found in events.jsonl for backfill")


async def watch_events_file(app: FastAPI):
    """Background task that watches events.jsonl for new lines.

    Uses polling (watchfiles) to detect file changes, then syncs
    new lines into the database and broadcasts to WebSocket clients.
    """
    try:
        from watchfiles import awatch, Change
    except ImportError:
        logger.warning("watchfiles not installed, file watching disabled")
        return

    logger.info("Starting file watcher on %s", EVENTS_FILE)

    try:
        async for changes in awatch(
            os.path.dirname(EVENTS_FILE),
            watch_filter=lambda change, path: path.endswith("events.jsonl"),
        ):
            for change_type, path in changes:
                if change_type == Change.modified and path.endswith("events.jsonl"):
                    db = app.state.db
                    # Get current sync position
                    async with db.execute(
                        "SELECT value FROM sync_state WHERE key = 'events_line_count'"
                    ) as cursor:
                        row = await cursor.fetchone()
                    last_count = int(row[0]) if row else 0

                    try:
                        with open(EVENTS_FILE, "r") as f:
                            lines = f.readlines()
                    except OSError:
                        continue

                    new_lines = lines[last_count:]
                    for line in new_lines:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            was_new = await insert_event(db, event)
                            if was_new:
                                await manager.broadcast({"type": "event", "data": event})
                        except json.JSONDecodeError:
                            continue

                    new_count = len(lines)
                    await db.execute(
                        "INSERT OR REPLACE INTO sync_state (key, value) "
                        "VALUES ('events_line_count', ?)",
                        (str(new_count),),
                    )
                    await db.commit()

    except asyncio.CancelledError:
        logger.info("File watcher stopped")
    except Exception as exc:
        logger.error("File watcher error: %s", exc)


async def poll_brain(app: FastAPI):
    """Background task that polls the brain server and broadcasts updates via WebSocket."""
    brain_config = app.state.brain_config
    if not brain_config.get("url"):
        logger.info("Brain URL not configured, brain polling disabled")
        return

    # Polling intervals (seconds)
    INSTANCE_INTERVAL = 30
    HEALTH_INTERVAL = 60
    PROJECTS_INTERVAL = 120

    last_instances = 0.0
    last_health = 0.0
    last_projects = 0.0

    logger.info(
        "Brain polling started (instances: %ds, health: %ds, projects/briefs: %ds)",
        INSTANCE_INTERVAL, HEALTH_INTERVAL, PROJECTS_INTERVAL,
    )

    while True:
        await asyncio.sleep(5)  # Check every 5 seconds what needs refreshing
        now = asyncio.get_event_loop().time()

        try:
            # Health check (every 60s)
            if now - last_health >= HEALTH_INTERVAL:
                health = await brain_request(app, "/health")
                stats = await brain_request(app, "/api/brain-stats")
                if health or stats:
                    await manager.broadcast({
                        "type": "brain_health",
                        "data": {**(health or {}), **(stats or {})},
                    })

                # Sync status
                try:
                    sync_data = await build_sync_status(app)
                    await manager.broadcast({"type": "sync_status", "data": sync_data})
                except Exception:
                    pass

                # Knowledge stats
                try:
                    knowledge_data = await build_knowledge_state()
                    await manager.broadcast({"type": "brain_knowledge", "data": knowledge_data})
                except Exception:
                    pass

                last_health = now

            # Instances (every 30s -- real-time feel)
            if now - last_instances >= INSTANCE_INTERVAL:
                data = await brain_request(
                    app, "/api/instances", params={"include_stale": "false"}
                )
                if data:
                    await manager.broadcast({
                        "type": "brain_instances",
                        "data": data,
                    })

                    # Fetch agent data for active instances with a current_brief
                    # Limit to 5 instances per cycle to avoid N+1 explosion
                    active_instances = [
                        inst for inst in (data.get("instances") or [])
                        if inst.get("status") == "active" and inst.get("current_brief")
                    ][:5]

                    for inst in active_instances:
                        inst_id = inst.get("id")
                        if not inst_id:
                            continue
                        try:
                            agent_data = await brain_request(
                                app, f"/api/instances/{inst_id}/agents"
                            )
                            log_data = await brain_request(
                                app, f"/api/instances/{inst_id}/log",
                                params={"limit": "20"},
                            )
                            if agent_data or log_data:
                                await manager.broadcast({
                                    "type": "instance_agent_event",
                                    "data": {
                                        "instance_id": inst_id,
                                        "agents": agent_data,
                                        "log": log_data,
                                    },
                                })
                        except Exception as exc:
                            logger.warning(
                                "Failed to fetch agent data for instance %s: %s",
                                inst_id, exc,
                            )

                last_instances = now

            # Projects + Briefs + Sessions (every 120s -- less frequent)
            if now - last_projects >= PROJECTS_INTERVAL:
                projects = await brain_request(app, "/api/projects")
                briefs = await brain_request(app, "/api/briefs")
                sessions = await brain_request(
                    app, "/api/sessions", params={"days": "7"},
                )

                if projects:
                    await manager.broadcast({
                        "type": "brain_projects",
                        "data": projects,
                    })
                if briefs:
                    await manager.broadcast({
                        "type": "brain_briefs",
                        "data": briefs,
                    })
                if sessions:
                    await manager.broadcast({
                        "type": "brain_sessions",
                        "data": sessions,
                    })
                last_projects = now

        except asyncio.CancelledError:
            logger.info("Brain polling stopped")
            return
        except Exception as exc:
            logger.warning("Brain polling error: %s", exc)


async def refresh_pricing_periodically(app: FastAPI):
    """Background task to refresh pricing cache every 24 hours."""
    while True:
        await asyncio.sleep(86400)
        try:
            pricing, source = await fetch_pricing()
            app.state.pricing = pricing
            app.state.pricing_source = source
            app.state.pricing_fetched_at = datetime.now(timezone.utc).isoformat()
            logger.info("Pricing cache refreshed (%d models, source=%s)", len(pricing), source)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.error("Failed to refresh pricing: %s", exc)


# ---------------------------------------------------------------------------
# State Builders
# ---------------------------------------------------------------------------


async def build_agents_state(db: aiosqlite.Connection) -> dict:
    """Build the agents state dict from agent-metrics.json and database.

    Merges the file-based metrics with database-tracked levels.
    """
    agents = {}

    # Load base data from agent-metrics.json
    if os.path.exists(METRICS_FILE):
        try:
            with open(METRICS_FILE, "r") as f:
                metrics = json.load(f)
            for name, data in metrics.get("agents", {}).items():
                agents[name] = {
                    "invocations": data.get("invocations", 0),
                    "total_input_tokens": data.get("total_input_tokens", 0),
                    "total_output_tokens": data.get("total_output_tokens", 0),
                    "total_cache_read_tokens": data.get("total_cache_read_tokens", 0),
                    "total_cache_create_tokens": data.get("total_cache_create_tokens", 0),
                    "avg_duration_seconds": data.get("avg_duration_seconds", 0),
                    "success_rate": data.get("success_rate", 1.0),
                    "last_used": data.get("last_used"),
                    "active": False,
                }
        except (json.JSONDecodeError, OSError):
            pass

    # Discover agents from events table that are not in agent-metrics.json
    # (e.g. orchestrator, which only emits events and has no metrics JSON entry)
    async with db.execute(
        """SELECT agent,
                  COUNT(*) as invocations,
                  COALESCE(SUM(input_tokens), 0),
                  COALESCE(SUM(output_tokens), 0),
                  COALESCE(SUM(cache_read), 0),
                  COALESCE(SUM(cache_create), 0),
                  COALESCE(AVG(duration_s), 0),
                  MAX(ts) as last_used
           FROM events
           WHERE event = 'stop'
           GROUP BY agent"""
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name not in agents:
                agents[agent_name] = {
                    "invocations": row[1],
                    "total_input_tokens": row[2],
                    "total_output_tokens": row[3],
                    "total_cache_read_tokens": row[4],
                    "total_cache_create_tokens": row[5],
                    "avg_duration_seconds": round(row[6], 2),
                    "success_rate": 1.0,
                    "last_used": row[7],
                    "active": False,
                }

    # Enrich with level data from database
    async with db.execute(
        "SELECT agent, total_invocations, level_name, level_tier FROM agent_levels"
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name in agents:
                # Use the higher invocation count (file or db)
                db_invocations = row[1]
                file_invocations = agents[agent_name]["invocations"]
                invocations = max(db_invocations, file_invocations)
                agents[agent_name]["invocations"] = invocations

    # Check for currently active agents (started but not stopped)
    async with db.execute(
        """SELECT agent, agent_id FROM events
           WHERE event = 'start'
           AND agent_id NOT IN (
               SELECT agent_id FROM events WHERE event = 'stop' AND agent_id != ''
           )
           AND agent_id != ''
           ORDER BY ts DESC"""
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name in agents:
                agents[agent_name]["active"] = True

    # Compute levels and RPG stats
    for name, data in agents.items():
        data["level"] = get_level(data["invocations"])
        data["rpg_stats"] = compute_rpg_stats(data, agents)

    return agents


async def build_budget_state(db: aiosqlite.Connection, budget_config: dict) -> dict:
    """Build budget state for today from daily_budget table."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ceiling = budget_config.get("daily_token_budget", 1000000)

    async with db.execute(
        """SELECT total_input_tokens, total_output_tokens,
                  total_cache_read, total_cache_create
           FROM daily_budget WHERE date = ?""",
        (today,),
    ) as cursor:
        row = await cursor.fetchone()

    if row:
        consumed = row[0] + row[1] + row[2] + row[3]
    else:
        consumed = 0

    ratio = consumed / ceiling if ceiling > 0 else 0.0

    return {
        "consumed": consumed,
        "ceiling": ceiling,
        "ratio": round(ratio, 4),
        "warning_threshold": budget_config.get("warning_threshold", 0.75),
        "critical_threshold": budget_config.get("critical_threshold", 0.90),
    }


async def build_recent_events(db: aiosqlite.Connection, limit: int = 50) -> list:
    """Fetch the most recent events from the database."""
    events = []
    async with db.execute(
        """SELECT ts, event, agent, agent_id, raw_type, duration_s,
                  input_tokens, output_tokens, cache_read, cache_create
           FROM events ORDER BY id DESC LIMIT ?""",
        (limit,),
    ) as cursor:
        async for row in cursor:
            events.append(
                {
                    "ts": row[0],
                    "event": row[1],
                    "agent": row[2],
                    "agent_id": row[3],
                    "raw_type": row[4],
                    "duration_s": row[5],
                    "input_tokens": row[6],
                    "output_tokens": row[7],
                    "cache_read": row[8],
                    "cache_create": row[9],
                }
            )
    return events


async def build_totals(db: aiosqlite.Connection) -> dict:
    """Compute aggregate totals across all events."""
    async with db.execute(
        """SELECT COUNT(*) as total_events,
                  COALESCE(SUM(input_tokens), 0),
                  COALESCE(SUM(output_tokens), 0),
                  COALESCE(SUM(cache_read), 0),
                  COALESCE(SUM(cache_create), 0)
           FROM events WHERE event = 'stop'"""
    ) as cursor:
        row = await cursor.fetchone()

    # Count unique stop events as invocations
    async with db.execute(
        "SELECT COUNT(*) FROM events WHERE event = 'stop'"
    ) as cursor:
        stop_row = await cursor.fetchone()

    return {
        "total_invocations": stop_row[0] if stop_row else 0,
        "total_input_tokens": row[1] if row else 0,
        "total_output_tokens": row[2] if row else 0,
        "total_cache_tokens": (row[3] + row[4]) if row else 0,
    }


async def build_context_window_state(db: aiosqlite.Connection) -> dict:
    """Build context window state from the context_window table."""
    async with db.execute(
        """SELECT context_used, context_max, context_remaining, model_id
           FROM context_window WHERE id = 1"""
    ) as cursor:
        row = await cursor.fetchone()

    if row:
        result = {
            "context_used": row[0],
            "context_max": row[1],
            "context_remaining": row[2],
            "model_id": row[3],
        }
    else:
        result = {
            "context_used": 0,
            "context_max": 200000,
            "context_remaining": 200000,
            "model_id": "",
        }

    # Attach context breakdown if available
    try:
        async with db.execute(
            """SELECT system_prompt, system_tools, mcp_tools, custom_agents,
                      rules, claude_md, memory, skills, messages,
                      autocompact_buffer, free_space
               FROM context_breakdown WHERE id = 1"""
        ) as cursor:
            bd_row = await cursor.fetchone()
        if bd_row:
            result["breakdown"] = {
                "system_prompt": bd_row[0],
                "system_tools": bd_row[1],
                "mcp_tools": bd_row[2],
                "custom_agents": bd_row[3],
                "rules": bd_row[4],
                "claude_md": bd_row[5],
                "memory": bd_row[6],
                "skills": bd_row[7],
                "messages": bd_row[8],
                "autocompact_buffer": bd_row[9],
                "free_space": bd_row[10],
            }
    except Exception:
        pass  # Table may not exist yet

    return result


async def build_sync_status(app):
    """Build sync pipeline status from brain server."""
    data = await brain_request(app, "/api/sync-status")
    if data:
        return {**data, "status": "online"}
    return {"status": "offline", "last_push": None, "last_pull": None, "queue_depth": 0}


def build_team_status():
    """Build team status from file system.

    Expected shape of team-status.json:
    {
        "active": true,
        "team_name": "parallel-hunt",
        "is_team_lead": true,
        "teammates": [
            {
                "name": "teammate-alpha",
                "brief": "BR-015",
                "phase": "TESTING",
                "elapsed": "18m22s",
                "tokens": 62000,
                "retries": 0,
                "file_ownership": {"sync/retry.dart": "teammate-alpha"}
            }
        ],
        "coordination_log": [
            {"ts": "2026-02-18T14:52:00Z", "message": "charlie -> REVIEWING"}
        ],
        "file_ownership": {
            "sync/retry.dart": "alpha",
            "dashboard/": "bravo"
        }
    }
    """
    team_file = os.path.join(METRICS_DIR, "team-status.json")
    if os.path.exists(team_file):
        try:
            with open(team_file) as f:
                data = json.load(f)
            # Ensure required fields exist for the frontend
            data.setdefault("active", False)
            data.setdefault("teammates", [])
            data.setdefault("team_name", "")
            data.setdefault("coordination_log", [])
            data.setdefault("file_ownership", {})
            # Ensure each teammate has expected fields
            for tm in data.get("teammates", []):
                tm.setdefault("name", "unknown")
                tm.setdefault("brief", "--")
                tm.setdefault("phase", "--")
                tm.setdefault("elapsed", "--")
                tm.setdefault("tokens", 0)
                tm.setdefault("retries", 0)
                tm.setdefault("file_ownership", {})
            return data
        except Exception:
            pass
    return {"active": False, "teammates": [], "team_name": "", "coordination_log": [], "file_ownership": {}}


async def build_knowledge_state():
    """Build knowledge base state from local brain DB."""
    knowledge_db = os.path.join(os.path.expanduser("~"), ".igris", "memory", "knowledge.db")
    if not os.path.exists(knowledge_db):
        return {"status": "unavailable", "learnings_count": 0, "errors_count": 0, "patterns_count": 0, "recent": []}
    try:
        async with aiosqlite.connect(f"file:{knowledge_db}?mode=ro", uri=True) as db:
            db.row_factory = aiosqlite.Row
            # Counts
            cur = await db.execute("SELECT COUNT(*) as c FROM learnings")
            row = await cur.fetchone()
            learnings_count = row[0] if row else 0

            cur = await db.execute("SELECT COUNT(*) as c FROM errors")
            row = await cur.fetchone()
            errors_count = row[0] if row else 0

            # Pattern categories
            cur = await db.execute(
                "SELECT DISTINCT category FROM learnings WHERE category IS NOT NULL AND category != ''"
            )
            rows = await cur.fetchall()
            patterns_count = len(rows)

            # Recent learnings
            cur = await db.execute(
                "SELECT id, project, category, title, created_at FROM learnings ORDER BY created_at DESC LIMIT 10"
            )
            rows = await cur.fetchall()
            recent = [
                {"id": r[0], "project": r[1], "category": r[2], "title": r[3], "created_at": r[4]}
                for r in rows
            ]

            return {
                "status": "connected",
                "learnings_count": learnings_count,
                "errors_count": errors_count,
                "patterns_count": patterns_count,
                "recent": recent,
            }
    except Exception:
        return {"status": "unavailable", "learnings_count": 0, "errors_count": 0, "patterns_count": 0, "recent": []}


async def build_skill_heatmap(db, range_key="all"):
    """Build skill invocation heatmap."""
    try:
        if range_key == "today":
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            cursor = await db.execute(
                "SELECT skill_name, COUNT(*) as cnt FROM skill_invocations WHERE session_date = ? GROUP BY skill_name ORDER BY cnt DESC",
                (today,),
            )
        elif range_key == "week":
            week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
            cursor = await db.execute(
                "SELECT skill_name, COUNT(*) as cnt FROM skill_invocations WHERE session_date >= ? GROUP BY skill_name ORDER BY cnt DESC",
                (week_ago,),
            )
        else:
            cursor = await db.execute(
                "SELECT skill_name, COUNT(*) as cnt FROM skill_invocations GROUP BY skill_name ORDER BY cnt DESC"
            )
        rows = await cursor.fetchall()
        skills = {r[0]: r[1] for r in rows}
        total = sum(skills.values())
        return {"skills": skills, "total": total}
    except Exception as exc:
        logger.warning("build_skill_heatmap failed: %s", exc)
        return {"skills": {}, "total": 0}


async def build_filtered_totals(db: aiosqlite.Connection, range_key: str) -> dict:
    """Compute aggregate totals filtered by date range."""
    date_clause, date_params = build_date_where(range_key)

    async with db.execute(
        f"""SELECT COUNT(*) as total_events,
                  COALESCE(SUM(input_tokens), 0),
                  COALESCE(SUM(output_tokens), 0),
                  COALESCE(SUM(cache_read), 0),
                  COALESCE(SUM(cache_create), 0)
           FROM events WHERE event = 'stop' {date_clause}""",
        date_params,
    ) as cursor:
        row = await cursor.fetchone()

    async with db.execute(
        f"SELECT COUNT(*) FROM events WHERE event = 'stop' {date_clause}",
        date_params,
    ) as cursor:
        stop_row = await cursor.fetchone()

    return {
        "total_invocations": stop_row[0] if stop_row else 0,
        "total_input_tokens": row[1] if row else 0,
        "total_output_tokens": row[2] if row else 0,
        "total_cache_tokens": (row[3] + row[4]) if row else 0,
    }


async def build_filtered_recent_events(
    db: aiosqlite.Connection, range_key: str, limit: int = 50
) -> list:
    """Fetch recent events filtered by date range."""
    date_clause, date_params = build_date_where(range_key)
    events = []
    async with db.execute(
        f"""SELECT ts, event, agent, agent_id, raw_type, duration_s,
                  input_tokens, output_tokens, cache_read, cache_create
           FROM events WHERE 1=1 {date_clause}
           ORDER BY id DESC LIMIT ?""",
        (*date_params, limit),
    ) as cursor:
        async for row in cursor:
            events.append(
                {
                    "ts": row[0],
                    "event": row[1],
                    "agent": row[2],
                    "agent_id": row[3],
                    "raw_type": row[4],
                    "duration_s": row[5],
                    "input_tokens": row[6],
                    "output_tokens": row[7],
                    "cache_read": row[8],
                    "cache_create": row[9],
                }
            )
    return events


async def build_filtered_agents_state(
    db: aiosqlite.Connection, range_key: str
) -> dict:
    """Build agents state with filtered stats but all-time levels."""
    agents = {}

    # Load base agent list from metrics file
    if os.path.exists(METRICS_FILE):
        try:
            with open(METRICS_FILE, "r") as f:
                metrics = json.load(f)
            for name, data in metrics.get("agents", {}).items():
                agents[name] = {
                    "invocations": 0,
                    "total_input_tokens": 0,
                    "total_output_tokens": 0,
                    "total_cache_read_tokens": 0,
                    "total_cache_create_tokens": 0,
                    "avg_duration_seconds": 0,
                    "success_rate": data.get("success_rate", 1.0),
                    "last_used": None,
                    "active": False,
                }
        except (json.JSONDecodeError, OSError):
            pass

    # Get filtered stats from events table
    date_clause, date_params = build_date_where(range_key)
    async with db.execute(
        f"""SELECT agent,
                  COUNT(*) as invocations,
                  COALESCE(SUM(input_tokens), 0),
                  COALESCE(SUM(output_tokens), 0),
                  COALESCE(SUM(cache_read), 0),
                  COALESCE(SUM(cache_create), 0),
                  COALESCE(AVG(duration_s), 0),
                  MAX(ts) as last_used
           FROM events
           WHERE event = 'stop' {date_clause}
           GROUP BY agent""",
        date_params,
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name not in agents:
                agents[agent_name] = {
                    "success_rate": 1.0,
                    "active": False,
                }
            agents[agent_name]["invocations"] = row[1]
            agents[agent_name]["total_input_tokens"] = row[2]
            agents[agent_name]["total_output_tokens"] = row[3]
            agents[agent_name]["total_cache_read_tokens"] = row[4]
            agents[agent_name]["total_cache_create_tokens"] = row[5]
            agents[agent_name]["avg_duration_seconds"] = round(row[6], 2)
            agents[agent_name]["last_used"] = row[7]

    # ALL-TIME levels from agent_levels table (never filtered)
    async with db.execute(
        "SELECT agent, total_invocations, level_name, level_tier FROM agent_levels"
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name in agents:
                all_time_invocations = row[1]
                agents[agent_name]["level"] = get_level(all_time_invocations)

    # Check active agents (real-time, never filtered)
    async with db.execute(
        """SELECT agent, agent_id FROM events
           WHERE event = 'start'
           AND agent_id NOT IN (
               SELECT agent_id FROM events WHERE event = 'stop' AND agent_id != ''
           )
           AND agent_id != ''
           ORDER BY ts DESC"""
    ) as cursor:
        async for row in cursor:
            agent_name = row[0]
            if agent_name in agents:
                agents[agent_name]["active"] = True

    # Compute levels for agents without DB level data, and RPG stats
    for name, data in agents.items():
        if "level" not in data:
            data["level"] = get_level(0)
        data["rpg_stats"] = compute_rpg_stats(data, agents)

    return agents


async def build_filtered_state(app: FastAPI, range_key: str = "today") -> dict:
    """Build complete state payload filtered by date range."""
    db = app.state.db
    budget_config = app.state.budget_config

    if range_key == "all":
        agents = await build_agents_state(db)
        totals = await build_totals(db)
        recent_events = await build_recent_events(db)
    else:
        agents = await build_filtered_agents_state(db, range_key)
        totals = await build_filtered_totals(db, range_key)
        recent_events = await build_filtered_recent_events(db, range_key)

    budget = await build_budget_state(db, budget_config)  # Always daily
    context_window = await build_context_window_state(db)
    skill_heatmap = await build_skill_heatmap(db, range_key)

    return {
        "agents": agents,
        "budget": budget,
        "recent_events": recent_events,
        "totals": totals,
        "context_window": context_window,
        "skill_heatmap": skill_heatmap,
        "range": range_key,
    }


async def build_full_state(app: FastAPI) -> dict:
    """Build the complete state payload for API and WebSocket initial send."""
    db = app.state.db
    budget_config = app.state.budget_config

    agents = await build_agents_state(db)
    budget = await build_budget_state(db, budget_config)
    recent_events = await build_recent_events(db)
    totals = await build_totals(db)
    context_window = await build_context_window_state(db)
    skill_heatmap = await build_skill_heatmap(db)

    return {
        "agents": agents,
        "budget": budget,
        "recent_events": recent_events,
        "totals": totals,
        "context_window": context_window,
        "skill_heatmap": skill_heatmap,
    }


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialize DB, load state, start watcher."""
    # Initialize SQLite
    logger.info("Connecting to database: %s", DB_PATH)
    app.state.db = await aiosqlite.connect(DB_PATH)
    await init_db(app.state.db)

    # Verify skill_invocations table exists
    async with app.state.db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'"
    ) as cursor:
        row = await cursor.fetchone()
    if row:
        logger.info("skill_invocations table verified")
    else:
        logger.warning("skill_invocations table NOT found after init_db")

    # Load budget config
    app.state.budget_config = load_budget_config()
    logger.info(
        "Budget config: ceiling=%d, warn=%.0f%%, crit=%.0f%%",
        app.state.budget_config["daily_token_budget"],
        app.state.budget_config["warning_threshold"] * 100,
        app.state.budget_config["critical_threshold"] * 100,
    )

    # Load initial state from agent-metrics.json
    await load_metrics_state(app.state.db)

    # Sync from events.jsonl
    await sync_events_from_file(app.state.db)

    # Backfill context_window from events file if table is empty
    await backfill_context_window(app.state.db)

    # Fetch and cache pricing data
    app.state.pricing, app.state.pricing_source = await fetch_pricing()
    app.state.pricing_fetched_at = datetime.now(timezone.utc).isoformat()
    logger.info("Pricing cache loaded (%d models, source=%s)", len(app.state.pricing), app.state.pricing_source)

    # Initialize brain proxy client
    app.state.brain_config = load_brain_config()
    app.state.brain_client = (
        httpx.AsyncClient(timeout=10.0)
        if app.state.brain_config.get("url")
        else None
    )
    if app.state.brain_client:
        logger.info("Brain proxy enabled: [configured]")
    else:
        logger.info("Brain proxy disabled (no URL configured)")

    # Start file watcher background task
    watcher_task = asyncio.create_task(watch_events_file(app))
    pricing_task = asyncio.create_task(refresh_pricing_periodically(app))
    brain_task = asyncio.create_task(poll_brain(app))

    logger.info("Crimson Arena server ready")

    yield

    # Shutdown
    watcher_task.cancel()
    pricing_task.cancel()
    brain_task.cancel()
    try:
        await watcher_task
    except asyncio.CancelledError:
        pass
    try:
        await pricing_task
    except asyncio.CancelledError:
        pass
    try:
        await brain_task
    except asyncio.CancelledError:
        pass
    if app.state.brain_client:
        await app.state.brain_client.aclose()
    await app.state.db.close()
    logger.info("Crimson Arena server stopped")


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Crimson Arena - Igris AI Agent Dashboard",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — restrict to dashboard origin only
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8001", "http://localhost:8001"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request Models
# ---------------------------------------------------------------------------


class AgentEvent(BaseModel):
    """Validated event payload from agent_metrics.sh hook."""

    ts: str
    event: str = Field(..., pattern="^(start|stop|skill_invoke)$")
    skill_name: str = ""
    agent: str
    agent_id: str = ""
    raw_type: str = ""
    duration_s: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_create: int = 0
    context_used: int = 0
    context_max: int = 0
    context_remaining: int = 0
    model_id: str = ""
    context_breakdown: Optional[dict] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/")
async def serve_index():
    """Serve the dashboard frontend."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return JSONResponse(
        {"status": "ok", "message": "Crimson Arena server running. No frontend deployed yet."},
        status_code=200,
    )


@app.get("/api/state")
async def get_state(range: str = Query(default="today", pattern="^(today|week|all)$")):
    """Full current state filtered by time range."""
    state = await build_filtered_state(app, range_key=range)
    return JSONResponse(state)


@app.get("/api/agents")
async def get_agents(range: str = Query(default="today", pattern="^(today|week|all)$")):
    """Agent summary with levels and RPG stats, filtered by time range."""
    db = app.state.db
    if range == "all":
        agents = await build_agents_state(db)
    else:
        agents = await build_filtered_agents_state(db, range)
    return JSONResponse(agents)


@app.get("/api/budget")
async def get_budget():
    """Today's budget consumption vs ceiling."""
    db = app.state.db
    budget = await build_budget_state(db, app.state.budget_config)
    return JSONResponse(budget)


@app.get("/api/events")
async def get_events(
    limit: int = Query(default=50, ge=1, le=500),
    range: str = Query(default="today", pattern="^(today|week|all)$"),
):
    """Recent events filtered by time range."""
    db = app.state.db
    if range == "all":
        events = await build_recent_events(db, limit=limit)
    else:
        events = await build_filtered_recent_events(db, range, limit=limit)
    return JSONResponse(events)


@app.get("/api/pricing")
async def get_pricing():
    """Return cached Claude model pricing map."""
    pricing = getattr(app.state, "pricing", FALLBACK_PRICING)
    fetched_at = getattr(app.state, "pricing_fetched_at", None)
    source = getattr(app.state, "pricing_source", "fallback")
    return JSONResponse({
        "pricing": pricing,
        "fetched_at": fetched_at,
        "source": source,
    })


# ---------------------------------------------------------------------------
# Brain Proxy Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/brain/health")
async def brain_health(request: Request):
    """Check brain server health and return stats."""
    health = await brain_request(request.app, "/health")
    stats = await brain_request(request.app, "/api/brain-stats")
    if not health and not stats:
        return {"status": "offline", "message": "Brain server unreachable"}
    return {**(health or {}), **(stats or {}), "status": "ok"}


@app.get("/api/brain/instances")
async def brain_instances(request: Request):
    """List active Claude Code instances from brain server."""
    data = await brain_request(
        request.app, "/api/instances", params={"include_stale": "false"}
    )
    if data is None:
        return {"instances": [], "count": 0, "status": "offline"}
    return data


@app.get("/api/brain/instances/{instance_id}")
async def brain_instance_detail(instance_id: str, request: Request):
    """Get detail for a specific instance from brain server.

    Proxies to the brain server's instance endpoint. Returns 404 if
    the brain server is unreachable or the instance is not found.
    """
    data = await brain_request(
        request.app, f"/api/instances/{instance_id}"
    )
    if data is None:
        raise HTTPException(status_code=404, detail="Instance not found or brain offline")
    return data


@app.get("/api/brain/projects")
async def brain_projects(request: Request):
    """List registered projects from brain server."""
    data = await brain_request(request.app, "/api/projects")
    if data is None:
        return {"projects": [], "count": 0, "status": "offline"}
    return data


@app.get("/api/brain/briefs")
async def brain_briefs(
    request: Request,
    status: Optional[Literal["Ready", "In Progress", "Done", "Blocked", "Draft"]] = None,
    project: Optional[str] = Query(default=None, min_length=1, max_length=100),
):
    """List briefs from brain server, optionally filtered by status/project."""
    params = {}
    if status:
        params["status"] = status
    if project:
        params["project"] = project
    data = await brain_request(
        request.app, "/api/briefs", params=params if params else None
    )
    if data is None:
        return {"briefs": [], "summary": {}, "count": 0, "status": "offline"}
    return data


@app.get("/api/brain/sessions")
async def brain_sessions(request: Request, days: int = Query(default=7, ge=1, le=365)):
    """List recent sessions from brain server."""
    data = await brain_request(
        request.app, "/api/sessions", params={"days": str(days)}
    )
    if data is None:
        return {"sessions": [], "count": 0, "status": "offline"}
    return data


@app.get("/api/sync-status")
async def get_sync_status(request: Request):
    """Sync pipeline status from brain server."""
    return JSONResponse(await build_sync_status(request.app))


@app.get("/api/brain/instances/{instance_id}/agents")
async def brain_instance_agents(instance_id: str, request: Request):
    """Per-instance aggregated agent stats from brain server."""
    data = await brain_request(request.app, f"/api/instances/{instance_id}/agents")
    if data is None:
        return {"instance_id": instance_id, "agents": [], "status": "offline"}
    return data


@app.get("/api/brain/instances/{instance_id}/log")
async def brain_instance_log(
    instance_id: str,
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
):
    """Per-instance execution event log from brain server."""
    data = await brain_request(
        request.app,
        f"/api/instances/{instance_id}/log",
        params={"limit": str(limit)},
    )
    if data is None:
        return {"instance_id": instance_id, "events": [], "count": 0, "status": "offline"}
    return data


@app.get("/api/brain/agent-metrics/summary")
async def brain_agent_metrics_summary(request: Request):
    """Cross-instance agent performance summary from brain server."""
    data = await brain_request(request.app, "/api/agent-metrics/summary")
    if data is None:
        return {"agents": [], "recent_by_agent": {}, "status": "offline"}
    return data


@app.get("/api/team-status")
async def get_team_status():
    """Team mode status from file system."""
    return JSONResponse(build_team_status())


@app.get("/api/brain/knowledge")
async def get_brain_knowledge():
    """Knowledge base state from local brain DB."""
    return JSONResponse(await build_knowledge_state())


@app.get("/api/skills")
async def get_skills(range: str = "all"):
    """Skill invocation heatmap data."""
    db = app.state.db
    return JSONResponse(await build_skill_heatmap(db, range))


@app.post("/api/event")
async def post_event(event: AgentEvent):
    """Receive an event from the agent_metrics.sh hook.

    Inserts into SQLite, updates aggregates, and broadcasts
    to all connected WebSocket clients.
    """
    db = app.state.db
    event_dict = event.model_dump()

    try:
        await insert_event(db, event_dict)
    except Exception as exc:
        logger.error("Failed to insert event: %s", exc)
        return JSONResponse(
            {"status": "error", "message": "Failed to process event"},
            status_code=500,
        )

    # Broadcast skill event to WebSocket clients
    if event.event == "skill_invoke" and event.skill_name:
        try:
            await manager.broadcast({
                "type": "skill_event",
                "data": {"skill_name": event.skill_name, "ts": event.ts or datetime.now(timezone.utc).isoformat()},
            })
        except Exception:
            pass

    # Broadcast to WebSocket clients
    await manager.broadcast({"type": "event", "data": event_dict})

    return JSONResponse({"status": "ok"})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time dashboard updates.

    On connect: sends full state as initial message.
    On events: receives broadcasts from the ConnectionManager.
    """
    await manager.connect(websocket)

    try:
        # Send full state as initial bootstrap payload
        state = await build_filtered_state(app, range_key="today")
        await websocket.send_json({"type": "state", "data": state})

        # Send initial brain state if brain is configured
        if app.state.brain_config.get("url"):
            try:
                health = await brain_request(app, "/health")
                stats = await brain_request(app, "/api/brain-stats")
                instances = await brain_request(
                    app, "/api/instances", params={"include_stale": "false"}
                )
                projects = await brain_request(app, "/api/projects")
                briefs = await brain_request(app, "/api/briefs")
                sessions = await brain_request(
                    app, "/api/sessions", params={"days": "7"},
                )
                await websocket.send_json({
                    "type": "brain_state",
                    "data": {
                        "health": {**(health or {}), **(stats or {})},
                        "instances": instances,
                        "projects": projects,
                        "briefs": briefs,
                        "sessions": sessions,
                    },
                })
            except Exception as exc:
                logger.warning("Failed to send initial brain state: %s", exc)

        # Send initial new section data
        try:
            sync_data = await build_sync_status(app)
            await websocket.send_json({"type": "sync_status", "data": sync_data})
        except Exception:
            pass

        try:
            team_data = build_team_status()
            await websocket.send_json({"type": "team_status", "data": team_data})
        except Exception:
            pass

        try:
            knowledge_data = await build_knowledge_state()
            await websocket.send_json({"type": "brain_knowledge", "data": knowledge_data})
        except Exception:
            pass

        # Keep connection alive; read messages to detect disconnects
        while True:
            # Client may send ping/pong or other messages
            data = await websocket.receive_text()
            # Echo back pong for keepalive (support both raw "ping" and JSON {"type":"ping"})
            if data == "ping":
                await websocket.send_json({"type": "pong"})
            else:
                try:
                    parsed = json.loads(data)
                    if isinstance(parsed, dict) and parsed.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
                except (json.JSONDecodeError, TypeError):
                    pass

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        logger.error("WebSocket error during connection", exc_info=True)
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Mount static files (after routes so /api/* and /ws take precedence)
# ---------------------------------------------------------------------------
# Flutter Web builds expect assets served from root (assets/, canvaskit/, etc.).
# Mount at "/" so all static files are accessible without a /static prefix.
# The vanilla JS fallback also works fine with a root mount.
# This MUST be the last mount — FastAPI checks routes first, then falls through
# to the mounted StaticFiles app for anything not matched by an explicit route.

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


# ---------------------------------------------------------------------------
# Main entry point (for direct execution)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("DASHBOARD_PORT", "8001"))
    logger.info("Starting Crimson Arena on port %d", port)
    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
    )
