#!/usr/bin/env node
/**
 * Igris AI Centralized Brain MCP Server v7.0
 *
 * Modular engine architecture. Domain components are loaded via the
 * component registry, tools are dispatched through the API gateway,
 * and the event bus wires cross-component communication.
 *
 * Supports two transport modes:
 * - stdio  (default) — for local Claude Code integration
 * - http   (--http)  — for remote/VPS access via Streamable HTTP
 *
 * @version 7.0.0
 * @author fifty.dev
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// Engine — replaces monolithic tool imports
import { errMsg } from './engine/helpers.js';
import { bootEngine } from './engine/index.js';
import type { Engine, EngineConfig } from './engine/index.js';

// REST API helpers (used by HTTP endpoints, not MCP tools)
import { handleAgentEvent, handleAgentEventList, handleAgentEventLog, handleAgentMetricsSummary, handleAgentMetricsByProject } from './tools/agent_events.js';
import type { AgentEventInput } from './tools/agent_events.js';
import { handleInstanceRemove, handleInstanceHeartbeat } from './tools/instances.js';
import { handleProjectBudget, handleProjectBudgetSet } from './tools/projects.js';
import { handleBriefVelocity } from './tools/briefs.js';
import { handleMetricsRecord } from './tools/metrics.js';
import type { MetricsRecordInput } from './tools/metrics.js';

// Sync tables config (used by HTTP /sync/push and /sync/pull endpoints)
import { SYNC_TABLES, processSyncPush } from './tools/sync.js';

// Database lifecycle
import { getDb, closeDb, DB_PATH, BRAIN_DIR } from './db.js';
import * as os from 'node:os';

// stdio lifecycle — teardown, per-client pidfile registry, stale-instance reaper (BR-067)
import {
  installStdioTeardown,
  registerInstance,
  deregisterInstance,
  reapStaleInstances,
} from './stdio-lifecycle.js';

/** Timestamp when this server process started, used for uptime calculation. */
const SERVER_START_TIME = Date.now();

/** Valid project slug format: lowercase alphanumeric with hyphens, 1-64 chars. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ServerConfig {
  mode: 'stdio' | 'http';
  port: number;
  host: string | undefined;
  apiKey: string | undefined;
}

/**
 * Parse CLI arguments and environment variables to build the server config.
 *
 * Precedence (highest to lowest):
 *   1. CLI flags: --http, --port <number>, --host <host>
 *   2. Environment variables: BRAIN_HTTP, BRAIN_PORT, BRAIN_HOST, BRAIN_API_KEY
 *   3. Defaults: mode=stdio, port=3001, host=undefined, apiKey=undefined
 */
function parseConfig(): ServerConfig {
  const args = process.argv.slice(2);

  let mode: 'stdio' | 'http' = 'stdio';
  let port = 3001;
  let host: string | undefined;
  const apiKey = process.env.BRAIN_API_KEY || undefined;

  // CLI: --http flag
  if (args.includes('--http')) {
    mode = 'http';
  }

  // CLI: --port <number>
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && portIdx + 1 < args.length) {
    const parsed = Number(args[portIdx + 1]);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed;
    }
  }

  // CLI: --host <host>
  const hostIdx = args.indexOf('--host');
  if (hostIdx !== -1 && hostIdx + 1 < args.length) {
    const parsed = args[hostIdx + 1].trim();
    if (parsed) {
      host = parsed;
    }
  }

  // Env fallbacks (only when CLI didn't set them)
  if (mode === 'stdio' && process.env.BRAIN_HTTP) {
    mode = 'http';
  }
  if (portIdx === -1 && process.env.BRAIN_PORT) {
    const parsed = Number(process.env.BRAIN_PORT);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed;
    }
  }
  if (hostIdx === -1 && process.env.BRAIN_HOST) {
    const parsed = process.env.BRAIN_HOST.trim();
    if (parsed) {
      host = parsed;
    }
  }

  return { mode, port, host, apiKey };
}

// ---------------------------------------------------------------------------
// Engine singleton — booted once, shared across stdio and HTTP transports
// ---------------------------------------------------------------------------

let _engine: Engine | null = null;

/**
 * Get or boot the engine singleton.
 * Lazily initializes on first call with the default DB path.
 */
function getEngine(): Engine {
  if (!_engine) {
    const config: EngineConfig = {
      dbPath: DB_PATH,
      components: {
        memory: { enabled: true },
        errors: { enabled: true },
        projects: { enabled: true },
        metrics: { enabled: true },
        sessions: { enabled: true },
        briefs: { enabled: true },
        tasks: { enabled: true },
        instances: { enabled: true },
        sync: { enabled: true },
        cache: { enabled: true },
        schedules: { enabled: true },
        coordination: { enabled: true },
        monitoring: { enabled: true },
      },
    };
    _engine = bootEngine(config);
  }
  return _engine;
}

// ---------------------------------------------------------------------------
// Direct tool dispatch (bypass MCP transport)
// ---------------------------------------------------------------------------

/**
 * Dispatch a tool call directly, bypassing the MCP transport layer.
 *
 * Used as a fallback when no active MCP sessions exist (e.g. after a server
 * restart) and Claude Code sends tool calls without re-initializing first.
 * Delegates to the engine gateway.
 */
async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const engine = getEngine();
    return await engine.gateway.dispatch(name, args);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${errMsg(error)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured MCP Server instance with all Igris Brain tools
 * registered via the engine gateway. Each call returns an independent server,
 * which is important for the HTTP transport where every session gets its own Server.
 */
function createBrainServer(): Server {
  const engine = getEngine();

  const server = new Server(
    {
      name: 'igris-brain',
      version: '7.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ------------------------------------------------------------------
  // List available tools — delegated to gateway
  // ------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: engine.gateway.listTools() };
  });

  // ------------------------------------------------------------------
  // Execute tool calls — delegated to gateway
  // ------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      return await engine.gateway.dispatch(name, args as Record<string, unknown>);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${errMsg(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

/**
 * Run the brain server with stdio transport (default, local mode).
 *
 * BR-067 lifecycle hardening:
 *   - On boot, opportunistically reap provably-orphaned stale instances
 *     (alive server whose recorded parent is dead) — never SIGKILL, never
 *     `pkill`, never a server whose parent is still alive.
 *   - Register a per-client pidfile so the next process's reaper can find
 *     this instance.
 *   - Wire stdin EOF/close → graceful shutdown so this server exits when
 *     its Claude Code client disconnects (the H2 leak fix), sharing one
 *     idempotent shutdown function with the SIGINT/SIGTERM handlers.
 */
async function runStdio(): Promise<void> {
  // BR-067 Phase 4: opportunistic stale-instance reap on boot. Runs before
  // engine boot so a leak that has already accumulated is bounded even if
  // this boot itself were to fail later. Cheap (a few pidfile reads).
  try {
    const swept = reapStaleInstances();
    if (swept.reaped.length > 0 || swept.prunedStale.length > 0) {
      console.error(
        `[brain] reap sweep: SIGTERM'd ${swept.reaped.length} orphan(s), ` +
        `pruned ${swept.prunedStale.length} stale pidfile(s), ` +
        `left ${swept.skippedAlive.length} live instance(s) untouched`,
      );
    }
  } catch (err) {
    console.error(`[brain] reap sweep failed (non-fatal): ${errMsg(err)}`);
  }

  // Boot engine (also bridges db.ts)
  const engine = getEngine();

  const server = createBrainServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Igris Brain MCP Server v7.0.0 started (stdio)');

  // BR-067 Phase 4: register a per-client pidfile (keyed by parent PID).
  // Registration failure is non-fatal — the server still serves.
  const ppid = process.ppid;
  registerInstance({
    pid: process.pid,
    ppid,
    started_at: new Date().toISOString(),
    db_path: DB_PATH,
  });

  // BR-067 Phase 2: one idempotent shutdown wired to stdin EOF/close AND
  // SIGINT/SIGTERM. The stdin handlers are the leak fix — a client that
  // simply exits (no signal) now reliably tears down its server.
  installStdioTeardown({
    onShutdown: () => {
      deregisterInstance(ppid);
      engine.shutdown();
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** Rate limit: max auth failures per IP before temporary block. */
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_FAIL_MAX = 10;
const AUTH_FAIL_MAP_MAX = 10_000;

/**
 * Timing-safe comparison of two strings.
 * Returns false if lengths differ or contents mismatch.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Run the brain server with Streamable HTTP transport (remote/VPS mode).
 *
 * Each MCP session gets its own Server + Transport pair. Sessions are tracked
 * in an in-memory map keyed by session ID with TTL-based cleanup.
 */
async function runHttp(config: ServerConfig): Promise<void> {
  // Boot engine (also bridges db.ts)
  const engine = getEngine();

  // Require API key for HTTP mode — refuse to start without auth
  if (!config.apiKey) {
    console.error('[brain] FATAL: BRAIN_API_KEY is required for HTTP mode. Set the BRAIN_API_KEY environment variable.');
    process.exit(1);
  }

  // Create Express app WITHOUT global express.json() middleware.
  // createMcpExpressApp adds app.use(express.json()) which consumes the
  // request body for ALL routes, breaking route-specific parsers like
  // /sync/push's express.json({ limit: '50mb' }). Instead, we add
  // express.json() only to routes that need it (POST /mcp, POST /sync/push).
  const app = express();

  // Rate limiting: track auth failures per IP
  const authFailures: Record<string, { count: number; resetAt: number }> = {};

  // API key middleware — reusable across /mcp and /sync routes
  const expectedToken = `Bearer ${config.apiKey}`;

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    // Check rate limit
    const now = Date.now();
    const entry = authFailures[ip];
    if (entry && entry.count >= AUTH_FAIL_MAX && now < entry.resetAt) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Too many failed authentication attempts' },
        id: null,
      });
      return;
    }

    // Accept both Authorization: Bearer <key> and X-API-Key: <key>
    const xApiKey = req.headers['x-api-key'];
    const auth = typeof xApiKey === 'string' && xApiKey
      ? `Bearer ${xApiKey}`
      : (req.headers.authorization ?? '');
    if (!safeCompare(auth, expectedToken)) {
      // Track failure (with map size cap)
      if (!authFailures[ip] || now >= (authFailures[ip].resetAt)) {
        // Evict oldest entries if map is at capacity
        if (Object.keys(authFailures).length >= AUTH_FAIL_MAP_MAX) {
          let oldestIp = '';
          let oldestReset = Infinity;
          for (const [k, v] of Object.entries(authFailures)) {
            if (v.resetAt < oldestReset) {
              oldestReset = v.resetAt;
              oldestIp = k;
            }
          }
          if (oldestIp) delete authFailures[oldestIp];
        }
        authFailures[ip] = { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS };
      } else {
        authFailures[ip].count++;
      }

      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: Invalid or missing API key' },
        id: null,
      });
      return;
    }

    // Reset failures on successful auth
    delete authFailures[ip];
    next();
  };

  app.use('/mcp', authMiddleware);
  app.use('/sync', authMiddleware);
  app.use('/api', authMiddleware);

  // Session management: map session IDs to their transports + last-activity timestamps.
  // The SDK's StreamableHTTPServerTransport validates session IDs internally via the
  // Web Standard Request object (built from rawHeaders). Claude Code's HTTP client does
  // not reliably send mcp-session-id on subsequent requests, so we inject it into both
  // req.headers and req.rawHeaders before forwarding to the transport.
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionActivity: Record<string, number> = {};

  // Periodic session cleanup (every 5 minutes).
  // Sessions idle for 2+ hours are cleaned up. The extended TTL (from 30min
  // to 2h) prevents premature session loss during long Claude Code sessions
  // where gaps between MCP calls can exceed 30 minutes.
  const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const sid of Object.keys(sessionActivity)) {
      if (now - sessionActivity[sid] > SESSION_IDLE_TTL_MS) {
        console.error(`[brain] Closing idle session: ${sid}`);
        const transport = transports[sid];
        if (transport) {
          transport.close().catch(() => {});
          delete transports[sid];
        }
        delete sessionActivity[sid];
      }
    }
    // Clean expired rate limit entries
    for (const ip of Object.keys(authFailures)) {
      if (now >= authFailures[ip].resetAt) {
        delete authFailures[ip];
      }
    }
  }, 5 * 60 * 1000);

  // Health endpoint (no auth required, minimal info)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // -----------------------------------------------------------------------
  // REST API endpoints — lightweight JSON views into the brain database.
  // Protected by authMiddleware via app.use('/api', ...) above.
  // -----------------------------------------------------------------------

  // GET /api/instances — list all live instances with stale-marking
  app.get('/api/instances', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const includeStale = req.query.include_stale === 'true';

      // Purge instances stale for >4 hours
      db.prepare(
        "DELETE FROM instances WHERE last_heartbeat_at < datetime('now', '-240 minutes')"
      ).run();

      // Purge agent_events older than 7 days
      db.prepare(
        "DELETE FROM agent_events WHERE created_at < datetime('now', '-7 days')"
      ).run();

      db.prepare(
        `UPDATE instances SET status = 'stale' WHERE last_heartbeat_at < datetime('now', '-45 minutes') AND status != 'stale'`
      ).run();

      const whereClause = includeStale ? '' : "WHERE status != 'stale'";
      const rows = db.prepare(
        `SELECT id, machine_hostname, machine_os, project_slug, project_path, current_brief, current_phase, current_task, status, last_heartbeat_at, started_at FROM instances ${whereClause} ORDER BY last_heartbeat_at DESC`
      ).all();
      res.json({ instances: rows, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/instances error:', message);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /api/instances/:id — deregister an instance
  app.delete('/api/instances/:id', (req: Request, res: Response) => {
    try {
      const result = handleInstanceRemove({ instance_id: req.params.id as string });
      res.json({ ok: true, message: typeof result.content?.[0]?.text === 'string' ? result.content[0].text : 'Instance removed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] DELETE /api/instances/:id error:', message);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/instances/heartbeat — register/update worker instance
  app.post('/api/instances/heartbeat', express.json(), (req: Request, res: Response) => {
    try {
      if (!req.body.machine_hostname) {
        res.status(400).json({ error: 'Missing required field: machine_hostname' });
        return;
      }
      const result = handleInstanceHeartbeat(req.body);
      const text = result.content[0].text;
      const idMatch = text.match(/:\s*(.+)$/);
      const instanceId = idMatch ? idMatch[1].trim() : null;
      res.json({ ok: true, message: text, instance_id: instanceId });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] POST /api/instances/heartbeat error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/projects — list all registered projects
  app.get('/api/projects', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT slug, name, path, tech_stack, status, registered_at, last_session_at FROM projects ORDER BY last_session_at DESC`
      ).all();
      res.json({ projects: rows, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/projects error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/briefs — list briefs with optional status/project filters
  app.get('/api/briefs', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const conditions: string[] = [];
      const params: string[] = [];

      const statusFilter = req.query.status as string | undefined;
      if (statusFilter) {
        conditions.push('status = ?');
        params.push(statusFilter);
      }

      const projectFilter = req.query.project as string | undefined;
      if (projectFilter) {
        conditions.push('project = ?');
        params.push(projectFilter);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const rows = db.prepare(
        `SELECT project, brief_id, brief_type, title, status, priority, effort, phase, updated_at FROM brief_status ${whereClause} ORDER BY updated_at DESC`
      ).all(...params);

      const summaryRows = db.prepare(
        `SELECT status, COUNT(*) as count FROM brief_status GROUP BY status`
      ).all() as { status: string; count: number }[];

      const summary: Record<string, number> = {};
      for (const row of summaryRows) {
        summary[row.status] = row.count;
      }

      res.json({ briefs: rows, summary, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/briefs error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/briefs/velocity — brief completion velocity metrics
  app.get('/api/briefs/velocity', (req: Request, res: Response) => {
    try {
      const project = req.query.project as string | undefined;
      const weeks = req.query.weeks ? parseInt(req.query.weeks as string, 10) || 4 : undefined;
      const data = handleBriefVelocity({ project, weeks });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/briefs/velocity error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/sessions — list recent sessions with configurable time window
  app.get('/api/sessions', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const days = Math.min(365, Math.max(1, parseInt(req.query.days as string, 10) || 7));
      const rows = db.prepare(
        `SELECT id, project, brief_id, phase, mode, summary, started_at, ended_at FROM sessions WHERE started_at >= datetime('now', '-' || ? || ' days') ORDER BY started_at DESC`
      ).all(days);
      res.json({ sessions: rows, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/sessions error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/brain-stats — aggregate counts, DB size, and uptime
  app.get('/api/brain-stats', (_req: Request, res: Response) => {
    try {
      const db = getDb();

      const ALLOWED_COUNT_TABLES = new Set([
        'projects',
        'learnings',
        'errors',
        'sessions',
        'instances',
        'brief_status',
        'agent_metrics',
        'sync_queue',
      ]);

      const countTable = (table: string): number => {
        if (!ALLOWED_COUNT_TABLES.has(table)) {
          throw new Error(`countTable: invalid table name "${table}"`);
        }
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        return row.c;
      };

      let dbSizeBytes = 0;
      try {
        dbSizeBytes = statSync(DB_PATH).size;
      } catch {
        // DB file may not be accessible; default to 0
      }

      res.json({
        version: '7.0.0',
        db_size_bytes: dbSizeBytes,
        counts: {
          projects: countTable('projects'),
          learnings: countTable('learnings'),
          errors: countTable('errors'),
          sessions: countTable('sessions'),
          instances: countTable('instances'),
          briefs: countTable('brief_status'),
        },
        uptime_seconds: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/brain-stats error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/sync-status — sync pipeline status for dashboard
  app.get('/api/sync-status', (_req: Request, res: Response) => {
    try {
      const db = getDb();

      // Get counts by status from sync_queue
      const statusCounts = db.prepare(
        `SELECT status, COUNT(*) as count FROM sync_queue GROUP BY status`
      ).all() as { status: string; count: number }[];

      const pending = statusCounts.find(r => r.status === 'pending')?.count ?? 0;
      const retrying = statusCounts.find(r => r.status === 'retrying')?.count ?? 0;
      const sent = statusCounts.find(r => r.status === 'sent')?.count ?? 0;
      const failed = statusCounts.find(r => r.status === 'failed')?.count ?? 0;

      // Get last push/pull timestamps from sync_state
      const syncTimes = db.prepare(
        `SELECT MAX(last_push_at) as last_push, MAX(last_pull_at) as last_pull FROM sync_state`
      ).get() as { last_push: string | null; last_pull: string | null };

      res.json({
        last_push: syncTimes.last_push ?? null,
        last_pull: syncTimes.last_pull ?? null,
        queue_depth: pending + retrying,
        pending,
        retrying,
        sent,
        failed,
      });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/sync-status error:', message);
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Engine event & task endpoints — dashboard data feeds
  // -----------------------------------------------------------------------

  // GET /api/events — query the event_log table with filters and pagination
  app.get('/api/events', (req: Request, res: Response) => {
    try {
      const db = getDb();

      const eventName = req.query.event_name as string | undefined;
      const component = req.query.component as string | undefined;
      const project = req.query.project as string | undefined;
      const since = req.query.since as string | undefined;
      const until = req.query.until as string | undefined;
      const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 100), 1000);
      const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (eventName) {
        conditions.push('event_name = ?');
        params.push(eventName);
      }
      if (component) {
        conditions.push('component = ?');
        params.push(component);
      }
      if (project) {
        conditions.push('project_slug = ?');
        params.push(project);
      }
      const instanceId = req.query.instance_id as string | undefined;
      if (instanceId) {
        conditions.push('instance_id = ?');
        params.push(instanceId);
      }
      if (since) {
        conditions.push('created_at >= ?');
        params.push(since);
      }
      if (until) {
        conditions.push('created_at <= ?');
        params.push(until);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const events = db.prepare(
        `SELECT id, event_name, component, payload, machine_hostname, project_slug, instance_id, created_at FROM event_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM event_log ${whereClause}`
      ).get(...params) as { total: number };

      res.json({ events, total: countRow.total, limit, offset });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/events error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/events/stream — SSE endpoint streaming real-time engine events
  app.get('/api/events/stream', (req: Request, res: Response) => {
    try {
      const componentFilter = req.query.component as string | undefined;
      const projectFilter = req.query.project as string | undefined;

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Subscribe to all engine events via wildcard
      const handler = (payload: { event: string; data: Record<string, unknown>; timestamp: string }) => {
        try {
          if (res.writableEnded) return;

          // Extract component from event name (e.g. "tasks.created" -> "tasks")
          const eventComponent = payload.event.split('.')[0];

          // Apply optional filters
          if (componentFilter && eventComponent !== componentFilter) return;
          if (projectFilter) {
            const payloadProject = payload.data.project_slug ?? payload.data.project;
            if (payloadProject && payloadProject !== projectFilter) return;
          }

          const sseData = JSON.stringify({
            event_name: payload.event,
            component: eventComponent,
            payload: payload.data,
            timestamp: payload.timestamp,
          });
          res.write(`data: ${sseData}\n\n`);
        } catch {
          // Silently ignore write errors (client may have disconnected)
        }
      };

      engine.bus.on('*', handler);

      // Keepalive every 25 seconds to prevent TCP idle timeout
      const keepaliveTimer = setInterval(() => {
        try {
          if (!res.writableEnded) {
            res.write(': keepalive\n\n');
          } else {
            clearInterval(keepaliveTimer);
          }
        } catch {
          clearInterval(keepaliveTimer);
        }
      }, 25_000);

      // Clean up on client disconnect
      res.on('close', () => {
        engine.bus.off('*', handler);
        clearInterval(keepaliveTimer);
      });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/events/stream error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Agent Event endpoints — live agent lifecycle tracking for dashboard
  // -----------------------------------------------------------------------

  // POST /api/agent-event — Record an agent execution event
  app.post('/api/agent-event', express.json(), (req: Request, res: Response) => {
    try {
      const args = req.body as AgentEventInput;

      if (!args.instance_id || !args.agent || !args.event_type) {
        res.status(400).json({ error: 'Missing required fields: instance_id, agent, event_type' });
        return;
      }

      const result = handleAgentEvent(args);
      const idMatch = result.content[0].text.match(/id: (\d+)/);
      const insertedId = idMatch ? parseInt(idMatch[1], 10) : null;

      res.status(201).json({ ok: true, id: insertedId });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] POST /api/agent-event error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/instances/:id/agents — Per-instance agent stats (aggregated)
  app.get('/api/instances/:id/agents', (req: Request, res: Response) => {
    try {
      const data = handleAgentEventList({ instance_id: req.params.id as string });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/instances/:id/agents error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/instances/:id/log — Execution log (recent events)
  app.get('/api/instances/:id/log', (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Math.min(1000, Math.max(1, parseInt(req.query.limit as string, 10) || 50)) : undefined;
      const data = handleAgentEventLog({ instance_id: req.params.id as string, limit });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/instances/:id/log error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/agent-metrics/summary — Cross-instance agent performance
  // Optional query param: ?project_slug=<slug> to filter by project
  app.get('/api/agent-metrics/summary', (req: Request, res: Response) => {
    try {
      const projectSlug = req.query.project_slug as string | undefined;
      const data = handleAgentMetricsSummary(
        projectSlug ? { project_slug: projectSlug } : undefined
      );
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/agent-metrics/summary error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/agent-metrics/by-project — Per-project breakdown for a specific agent
  // Required query param: ?agent=<agent_name>
  app.get('/api/agent-metrics/by-project', (req: Request, res: Response) => {
    const agent = req.query.agent as string | undefined;
    if (!agent) {
      res.status(400).json({ error: 'Missing required query parameter: agent' });
      return;
    }
    try {
      const data = handleAgentMetricsByProject({ agent });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/agent-metrics/by-project error:', message);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/metrics — Record an agent performance metric (used by SubagentStop hook)
  app.post('/api/metrics', express.json(), (req: Request, res: Response) => {
    try {
      const args = req.body as MetricsRecordInput;

      if (!args.project || !args.agent || !args.action || !args.result) {
        res.status(400).json({ error: 'Missing required fields: project, agent, action, result' });
        return;
      }

      const validResults = ['success', 'failure', 'partial', 'blocked'];
      if (!validResults.includes(args.result)) {
        res.status(400).json({ error: `Invalid result: ${args.result}. Must be one of: ${validResults.join(', ')}` });
        return;
      }

      const result = handleMetricsRecord(args);
      const idMatch = result.content[0].text.match(/ID: (\d+)/);
      const insertedId = idMatch ? parseInt(idMatch[1], 10) : null;

      res.status(201).json({ ok: true, id: insertedId });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] POST /api/metrics error:', message);
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // HTTP Hook Event Ingestion (FR-088)
  // -----------------------------------------------------------------------

  /**
   * Agent name normalization map: Claude Code built-in agent names to
   * Igris canonical agent names. Same mapping as agent_metrics.sh.
   */
  const AGENT_NAME_MAP: Record<string, string> = {
    planner: 'architect',
    coder: 'forger',
    tester: 'sentinel',
    reviewer: 'warden',
    debugger: 'mender',
    explorer: 'seeker',
    Explore: 'seeker',
    'claude-code-guide': 'seeker',
    documenter: 'forger',
    releaser: 'forger',
    auditor: 'warden',
    ideator: 'architect',
  };

  /**
   * Agent-to-action mapping for metrics recording.
   */
  const AGENT_ACTION_MAP: Record<string, string> = {
    architect: 'plan',
    forger: 'implement',
    sentinel: 'test',
    warden: 'review',
    mender: 'debug',
    seeker: 'research',
    sage: 'advise',
  };

  /**
   * Parse the last_assistant_message to determine success or failure.
   * Returns 'success' or 'failure'.
   */
  function parseAgentResult(lastMsg: string | undefined): 'success' | 'failure' {
    if (!lastMsg) return 'success';
    const lower = lastMsg.toLowerCase();

    const failIndicators = [
      'fail', 'failed', 'failure',
      'reject', 'rejected',
      'error', 'errors found',
      'blocked',
      'not pass', 'did not pass',
      'tests failing',
    ];
    const passIndicators = [
      'pass', 'passed', 'success',
      'approve', 'approved',
      'complete', 'completed',
      'all tests pass',
      'lgtm', 'looks good',
    ];

    const hasFail = failIndicators.some(ind => lower.includes(ind));
    const hasPass = passIndicators.some(ind => lower.includes(ind));

    if (hasFail && !hasPass) return 'failure';
    if (hasFail && hasPass) {
      // Ambiguous: check last occurrence position
      const lastFailPos = Math.max(...failIndicators.map(ind => lower.lastIndexOf(ind)).filter(p => p >= 0));
      const lastPassPos = Math.max(...passIndicators.map(ind => lower.lastIndexOf(ind)).filter(p => p >= 0));
      return lastPassPos > lastFailPos ? 'success' : 'failure';
    }
    return 'success';
  }

  /**
   * Read the active brief ID from a session file content string.
   */
  function extractBriefFromSession(sessionContent: string): string {
    for (const line of sessionContent.split('\n')) {
      if (line.includes('Active Brief') || line.includes('Last Active')) {
        const match = line.match(/([A-Z]+-\d+)/);
        if (match) return match[1];
      }
    }
    return '';
  }

  /**
   * Read the instance ID from a session file content string.
   */
  function extractInstanceIdFromSession(sessionContent: string): string {
    for (const line of sessionContent.split('\n')) {
      if (line.includes('Instance ID')) {
        const match = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) return match[1];
      }
    }
    return '';
  }

  // POST /api/hooks/event — Ingest raw Claude Code hook payloads (FR-088)
  //
  // Accepts the JSON that Claude Code sends to HTTP hooks and routes it
  // to the appropriate brain tables based on hook_event_name.
  //
  // Query params:
  //   ?project=<slug> — project slug (set statically in settings.json URL)
  //
  // Supported hook_event_name values:
  //   - SubagentStart   → agent_events (start) + event_log
  //   - SubagentStop    → agent_events (stop) + agent_metrics + event_log
  //   - TaskCompleted   → event_log (team.task_completed) — quality gate result
  //   - TeammateIdle    → event_log (team.teammate_idle) — work assignment result
  //   - Stop            → event_log (session.stop)
  app.post('/api/hooks/event', express.json(), (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      const hookEvent = body.hook_event_name as string | undefined;

      if (!hookEvent) {
        res.status(400).json({ error: 'Missing hook_event_name field' });
        return;
      }

      const db = getDb();
      const hostname = os.hostname();
      const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      const projectSlug = (req.query.project as string) || '';

      // Read session file for instance_id and brief_id if project is known
      let instanceId = '';
      let briefId = '';
      if (projectSlug) {
        try {
          const sessionPath = path.join(BRAIN_DIR, 'cache', projectSlug, 'session', 'CURRENT_SESSION.md');
          if (existsSync(sessionPath)) {
            const content = readFileSync(sessionPath, 'utf-8');
            instanceId = extractInstanceIdFromSession(content);
            briefId = extractBriefFromSession(content);
          }
        } catch { /* session file read is best-effort */ }
      }

      const results: { table: string; id: number | bigint | null }[] = [];

      if (hookEvent === 'SubagentStart') {
        const rawAgentType = (body.agent_type as string) || (body.agent_id as string) || 'unknown';
        const agentType = AGENT_NAME_MAP[rawAgentType] ?? rawAgentType;

        // Insert into agent_events
        if (instanceId) {
          const aeResult = db.prepare(`
            INSERT INTO agent_events
              (instance_id, agent, event_type, phase, brief_id,
               duration_ms, input_tokens, output_tokens, cache_read, cache_create,
               result, error_message, metadata)
            VALUES (?, ?, 'start', NULL, ?, 0, 0, 0, 0, 0, NULL, NULL, '{}')
          `).run(instanceId, agentType, briefId);
          results.push({ table: 'agent_events', id: aeResult.lastInsertRowid });
        }

        // Insert into event_log
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES ('agent.start', 'hooks', ?, ?, ?, ?, ?)
        `).run(
          JSON.stringify({ agent: agentType, raw_type: rawAgentType, hook: 'SubagentStart' }),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({ ok: true, hook: hookEvent, agent: agentType, results });

      } else if (hookEvent === 'SubagentStop') {
        const rawAgentType = (body.agent_type as string) || (body.agent_id as string) || 'unknown';
        const agentType = AGENT_NAME_MAP[rawAgentType] ?? rawAgentType;
        const lastMsg = body.last_assistant_message as string | undefined;
        const agentResult = parseAgentResult(lastMsg);
        const action = AGENT_ACTION_MAP[agentType] ?? 'execute';

        // Token parsing from transcript is not possible server-side (local file),
        // so we accept zeros here. The main_agent_metrics.sh command hook handles
        // transcript parsing separately and posts to /api/metrics.
        // If the hook payload includes token data in the future, we'll use it.

        // Insert into agent_events
        if (instanceId) {
          const aeResult = db.prepare(`
            INSERT INTO agent_events
              (instance_id, agent, event_type, phase, brief_id,
               duration_ms, input_tokens, output_tokens, cache_read, cache_create,
               result, error_message, metadata)
            VALUES (?, ?, 'stop', NULL, ?, 0, 0, 0, 0, 0, ?, NULL, '{}')
          `).run(instanceId, agentType, briefId, agentResult);
          results.push({ table: 'agent_events', id: aeResult.lastInsertRowid });
        }

        // Insert into agent_metrics
        if (projectSlug) {
          try {
            const mResult = db.prepare(`
              INSERT INTO agent_metrics (project, agent, brief_id, action, result, duration_ms, retry_count)
              VALUES (?, ?, ?, ?, ?, 0, 0)
            `).run(projectSlug, agentType, briefId, action, agentResult);
            results.push({ table: 'agent_metrics', id: mResult.lastInsertRowid });
          } catch { /* metrics insert is best-effort */ }
        }

        // Insert into event_log
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES ('agent.stop', 'hooks', ?, ?, ?, ?, ?)
        `).run(
          JSON.stringify({ agent: agentType, raw_type: rawAgentType, result: agentResult, hook: 'SubagentStop' }),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({ ok: true, hook: hookEvent, agent: agentType, result: agentResult, results });

      } else if (hookEvent === 'TaskCompleted') {
        const taskId = body.task_id as string | undefined;
        const gateResult = (body.gate_result as string) || 'unknown';

        // Insert into event_log
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES ('team.task_completed', 'hooks', ?, ?, ?, ?, ?)
        `).run(
          JSON.stringify({ task_id: taskId, gate_result: gateResult, hook: 'TaskCompleted' }),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({ ok: true, hook: hookEvent, gate_result: gateResult, results });

      } else if (hookEvent === 'TeammateIdle') {
        const teammateId = body.teammate_id as string | undefined;
        const assignedTaskId = body.assigned_task_id as string | undefined;
        const assignedTaskTitle = body.assigned_task_title as string | undefined;

        // Insert into event_log
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES ('team.teammate_idle', 'hooks', ?, ?, ?, ?, ?)
        `).run(
          JSON.stringify({
            teammate_id: teammateId,
            assigned_task_id: assignedTaskId,
            assigned_task_title: assignedTaskTitle,
            hook: 'TeammateIdle',
          }),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({
          ok: true,
          hook: hookEvent,
          assigned: !!assignedTaskId,
          assigned_task_id: assignedTaskId || null,
          results,
        });

      } else if (hookEvent === 'Stop') {
        const sessionId = body.session_id as string | undefined;

        // Insert into event_log
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES ('session.stop', 'hooks', ?, ?, ?, ?, ?)
        `).run(
          JSON.stringify({ session_id: sessionId, hook: 'Stop' }),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({ ok: true, hook: hookEvent, results });

      } else {
        // Unknown hook event — log it generically
        const elResult = db.prepare(`
          INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
          VALUES (?, 'hooks', ?, ?, ?, ?, ?)
        `).run(
          `hook.${hookEvent.toLowerCase()}`, JSON.stringify(body),
          hostname, projectSlug || null, instanceId || null, now
        );
        results.push({ table: 'event_log', id: elResult.lastInsertRowid });

        res.status(201).json({ ok: true, hook: hookEvent, results });
      }
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] POST /api/hooks/event error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/projects/:slug/budget — Per-project token usage and budget config
  app.get('/api/projects/:slug/budget', (req: Request, res: Response) => {
    if (!SLUG_RE.test(req.params.slug as string)) {
      res.status(400).json({ error: 'Invalid project slug format' });
      return;
    }
    try {
      const data = handleProjectBudget({ slug: req.params.slug as string });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/projects/:slug/budget error:', message);
      res.status(500).json({ error: message });
    }
  });

  // PUT /api/projects/:slug/budget — Set/update project budget threshold
  app.put('/api/projects/:slug/budget', express.json(), (req: Request, res: Response) => {
    if (!SLUG_RE.test(req.params.slug as string)) {
      res.status(400).json({ error: 'Invalid project slug format' });
      return;
    }
    try {
      const { budget_limit, budget_period } = req.body;
      if (typeof budget_limit !== 'number' || budget_limit < 0) {
        res.status(400).json({ error: 'budget_limit must be a non-negative number' });
        return;
      }
      const data = handleProjectBudgetSet({
        slug: req.params.slug as string,
        budget_limit,
        budget_period,
      });
      res.json(data);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] PUT /api/projects/:slug/budget error:', message);
      res.status(500).json({ error: message });
    }
  });

  // POST /mcp — main MCP request handler
  // Route-specific JSON parsing (not global) to avoid consuming body for other routes
  app.post('/mcp', express.json(), async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        // Existing session — update activity, route to its transport
        sessionActivity[sessionId] = Date.now();
        const transport = transports[sessionId];
        await transport.handleRequest(req, res, req.body);
      } else if (isInitializeRequest(req.body)) {
        // Initialize request (with or without session ID) — create new session
        if (Object.keys(transports).length >= 100) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Service Unavailable: Maximum session limit reached' },
            id: null,
          });
          return;
        }

        // New session — create transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
            sessionActivity[sid] = Date.now();
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            delete sessionActivity[sid];
          }
        };

        const server = createBrainServer();
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (connectErr) {
          // Clean up orphan session on failure
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            delete sessionActivity[sid];
          }
          throw connectErr;
        }
      } else {
        // Non-initialize request without valid session ID.
        // Two fallback strategies:
        //   1. If active sessions exist, inject session ID and route via transport
        //   2. If NO sessions exist (e.g. after server restart), dispatch tool calls directly
        const activeSessions = Object.keys(transports);
        if (activeSessions.length > 0) {
          // Fallback A: inject session ID into an existing session
          const fallbackSid = activeSessions[activeSessions.length - 1];
          console.error(`[brain] No session ID in request — injecting session ${fallbackSid}`);
          sessionActivity[fallbackSid] = Date.now();
          req.headers['mcp-session-id'] = fallbackSid;
          req.rawHeaders.push('mcp-session-id', fallbackSid);
          await transports[fallbackSid].handleRequest(req, res, req.body);
        } else {
          // Fallback B: no active sessions — direct tool execution
          // Claude Code doesn't re-initialize after server restarts, so we
          // bypass the MCP transport and call tool handlers directly.
          const body = req.body;
          if (body && body.method === 'tools/call' && body.params) {
            const { name, arguments: toolArgs } = body.params;
            console.error(`[brain] Direct dispatch (no session): ${name}`);
            const result = await dispatchToolCall(name, toolArgs || {});
            res.json({
              jsonrpc: '2.0',
              result,
              id: body.id ?? null,
            });
          } else {
            // For non-tool-call methods (tools/list, etc.), auto-create a
            // session transparently and route the request through it. This
            // prevents Claude Code from losing MCP connectivity after a
            // server restart when it sends tools/list without re-initializing.
            console.error(`[brain] Auto-creating session for method: ${body?.method}`);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid: string) => {
                transports[sid] = transport;
                sessionActivity[sid] = Date.now();
              },
            });
            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                delete transports[sid];
                delete sessionActivity[sid];
              }
            };
            const server = createBrainServer();
            try {
              await server.connect(transport);
              await transport.handleRequest(req, res, req.body);
            } catch (connectErr) {
              // Clean up orphan session on failure
              const sid = transport.sessionId;
              if (sid) {
                delete transports[sid];
                delete sessionActivity[sid];
              }
              throw connectErr;
            }
          }
        }
      }
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  // Sends periodic keepalive comments to prevent TCP idle timeouts.
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Resolve the target session ID — explicit or fallback to most recent
    let targetSid: string | undefined = undefined;
    if (sessionId && transports[sessionId]) {
      targetSid = sessionId;
    } else {
      const activeSessions = Object.keys(transports);
      if (activeSessions.length > 0) {
        targetSid = activeSessions[activeSessions.length - 1];
        req.headers['mcp-session-id'] = targetSid;
        req.rawHeaders.push('mcp-session-id', targetSid);
      }
    }

    if (!targetSid) {
      res.status(400).send('No active session');
      return;
    }

    sessionActivity[targetSid] = Date.now();

    // Start SSE keepalive interval — send a comment every 25s to prevent
    // TCP idle timeout (typically 60-300s depending on network/proxy).
    const keepaliveTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(':keepalive\n\n');
          if (targetSid) {
            sessionActivity[targetSid] = Date.now();
          }
        } else {
          clearInterval(keepaliveTimer);
        }
      } catch {
        clearInterval(keepaliveTimer);
      }
    }, 25_000);

    // Clear keepalive on connection close
    res.on('close', () => {
      clearInterval(keepaliveTimer);
    });

    await transports[targetSid].handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      try {
        await transports[sessionId].handleRequest(req, res);
      } catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
          res.status(500).send('Error processing session termination');
        }
      }
    } else {
      res.status(400).send('Invalid or missing session ID');
    }
  });

  // -----------------------------------------------------------------------
  // Sync endpoints — used by igris_brain_push / igris_brain_pull across
  // brain instances. Protected by the same auth middleware as /mcp.
  // -----------------------------------------------------------------------

  // POST /sync/push — receive pushed data from a remote brain, merge locally.
  //
  // BR-066: per-table isolation. Each table's mergeRows runs in its OWN
  // transaction with its OWN try/catch. A row-level crash (e.g. an
  // unbindable Buffer-wrapped column value) aborts only the offending
  // table's transaction — sibling tables in the same chunk still merge.
  // The response carries `results` for successful tables and `errors` for
  // failed ones, plus a per-table `failures` array of row-level errors
  // bubbled up from mergeRows. Status code is 207 Multi-Status when any
  // table errored, 200 OK otherwise — both are 2xx so existing callers
  // that check `response.ok` continue to work.
  //
  // BR-064 (defense-in-depth): if a SYNC_TABLES entry's table is missing
  // from the local schema (partial migration), skip it with a stderr log
  // rather than throwing. Mirrors the activeSyncTables filter in
  // handleBrainPush.
  app.post('/sync/push', express.json({ limit: '50mb' }), (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { tables } = req.body as {
        tables: Record<string, Record<string, unknown>[]>;
      };

      if (!tables || typeof tables !== 'object') {
        res.status(400).json({ error: 'Missing or invalid "tables" field' });
        return;
      }

      const { results, errors, ok } = processSyncPush(db, tables);
      // 207 Multi-Status when any table errored; still in 2xx range so
      // `response.ok` is true — internal callers (handleBrainPush,
      // handleSyncQueueDrain, pushTables auto-push) inspect the body.
      const status = ok ? 200 : 207;
      res.status(status).json({ ok, results, errors });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] Sync push error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // GET /sync/pull — serve local rows changed since per-table timestamps
  app.get('/sync/pull', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const tables: Record<string, Record<string, unknown>[]> = {};

      for (const config of SYNC_TABLES) {
        const sinceParam = _req.query[`since_${config.table}`] as string | undefined;
        const since = sinceParam ?? '1970-01-01T00:00:00';

        const cols = config.columns.join(', ');
        const rows = db.prepare(
          `SELECT ${cols} FROM ${config.table} WHERE ${config.timestampCol} > ?`
        ).all(since) as Record<string, unknown>[];

        if (rows.length > 0) {
          tables[config.table] = rows;
        }
      }

      res.json({ tables });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] Sync pull error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // -----------------------------------------------------------------------
  // File sync endpoints (BR-023)
  // Push/pull flat files (events.jsonl, agent-metrics.json, budget.json)
  // -----------------------------------------------------------------------

  /**
   * Map file_type to relative path under BRAIN_DIR (~/.igris/ on VPS).
   *
   * Local hooks write to ~/.igris/projects/{project}/metrics/ (per-project).
   * VPS stores metrics globally under BRAIN_DIR/cache/metrics/ because the
   * file-push payload has no project identifier — all projects merge into
   * the same files on the server side.
   *
   * Future enhancement: add a "project" field to the file-push API so the
   * VPS can store metrics per-project (cache/{project}/metrics/).
   */
  const FILE_TYPE_PATHS: Record<string, string> = {
    events: 'cache/metrics/events.jsonl',
    agent_metrics: 'cache/metrics/agent-metrics.json',
    budget: 'cache/metrics/budget.json',
  };

  // POST /sync/file-push — receive file content and write to VPS path
  app.post('/sync/file-push', express.json({ limit: '50mb' }), (req: Request, res: Response) => {
    try {
      const { file_type, content } = req.body as { file_type: string; content: string };

      if (!file_type || typeof content !== 'string') {
        res.status(400).json({ error: 'Missing or invalid "file_type" or "content" field' });
        return;
      }

      const relativePath = FILE_TYPE_PATHS[file_type];
      if (!relativePath) {
        res.status(400).json({ error: `Unknown file_type: ${file_type}. Valid types: events, agent_metrics, budget` });
        return;
      }

      const filePath = path.join(BRAIN_DIR, relativePath);
      const dirPath = path.dirname(filePath);
      const tmpPath = filePath + '.tmp';

      // Create directories if needed
      mkdirSync(dirPath, { recursive: true });

      // Write atomically: write to .tmp, then rename
      writeFileSync(tmpPath, content, 'utf8');
      renameSync(tmpPath, filePath);

      const bytesWritten = Buffer.byteLength(content, 'utf8');

      // Update sync_state on VPS side
      const db = getDb();
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      db.prepare(`
        INSERT INTO sync_state (remote_url, table_name, last_push_at)
        VALUES ('local', ?, ?)
        ON CONFLICT(remote_url, table_name)
        DO UPDATE SET last_push_at = excluded.last_push_at
      `).run(`file:${file_type}`, now);

      res.json({ ok: true, file_type, bytes_written: bytesWritten });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] POST /sync/file-push error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // GET /sync/file-pull/:type — return file content
  app.get('/sync/file-pull/:type', (req: Request, res: Response) => {
    try {
      const fileType = req.params.type as string;
      const relativePath = FILE_TYPE_PATHS[fileType];

      if (!relativePath) {
        res.status(400).json({ error: `Unknown file type: ${fileType}. Valid types: events, agent_metrics, budget` });
        return;
      }

      const filePath = path.join(BRAIN_DIR, relativePath);

      if (!existsSync(filePath)) {
        res.status(404).json({ error: `File not found: ${fileType}` });
        return;
      }

      const content = readFileSync(filePath, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');

      res.json({ file_type: fileType, content, size });
    } catch (err) {
      const message = errMsg(err);
      console.error(`[brain] GET /sync/file-pull/${req.params.type} error:`, message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Content sync API endpoints (FR-037, FR-038, FR-039)
  // -----------------------------------------------------------------------

  // GET /api/briefs/:project/:briefId/content — retrieve brief file content
  app.get('/api/briefs/:project/:briefId/content', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT brief_id, filename, content, content_hash, updated_at FROM brief_files WHERE project = ? AND brief_id = ?`
      ).get(req.params.project, req.params.briefId) as Record<string, unknown> | undefined;

      if (!row) {
        res.status(404).json({ error: 'Brief file not found' });
        return;
      }

      res.json(row);
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/briefs/:project/:briefId/content error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/sessions/:project/files — retrieve all session files for a project
  app.get('/api/sessions/:project/files', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT filename, content, content_hash, updated_at FROM session_files WHERE project = ? ORDER BY updated_at DESC`
      ).all(req.params.project) as Record<string, unknown>[];

      res.json({ files: rows, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/sessions/:project/files error:', message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/definitions — retrieve definition files with optional type filter
  app.get('/api/definitions', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const typeFilter = req.query.type as string | undefined;

      let rows: Record<string, unknown>[];
      if (typeFilter) {
        rows = db.prepare(
          `SELECT type, name, filename, content, content_hash, version, updated_at FROM definition_files WHERE type = ? ORDER BY type, name`
        ).all(typeFilter) as Record<string, unknown>[];
      } else {
        rows = db.prepare(
          `SELECT type, name, filename, content, content_hash, version, updated_at FROM definition_files ORDER BY type, name`
        ).all() as Record<string, unknown>[];
      }

      res.json({ definitions: rows, count: rows.length });
    } catch (err) {
      const message = errMsg(err);
      console.error('[brain] GET /api/definitions error:', message);
      res.status(500).json({ error: message });
    }
  });

  // Start listening
  const onListening = () => {
    const bind = config.host ? `${config.host}:${config.port}` : `port ${config.port}`;
    console.error(`Igris Brain MCP Server v7.0.0 started (http, ${bind})`);
  };
  if (config.host) {
    app.listen(config.port, config.host, onListening);
  } else {
    app.listen(config.port, onListening);
  }

  // Graceful shutdown
  const shutdownHttp = async () => {
    console.error('Shutting down HTTP server...');
    clearInterval(cleanupInterval);
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
        delete transports[sid];
        delete sessionActivity[sid];
      } catch (err) {
        console.error(`Error closing session ${sid}:`, err);
      }
    }
    engine.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdownHttp);
  process.on('SIGTERM', shutdownHttp);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseConfig();

if (config.mode === 'http') {
  runHttp(config).catch((error) => {
    console.error('Fatal error:', error);
    if (_engine) _engine.shutdown();
    else closeDb();
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error('Fatal error:', error);
    if (_engine) _engine.shutdown();
    else closeDb();
    process.exit(1);
  });
}
