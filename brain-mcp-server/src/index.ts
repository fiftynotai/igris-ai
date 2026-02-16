#!/usr/bin/env node
/**
 * Igris AI Centralized Brain MCP Server
 *
 * Exposes persistent memory, project management, and cross-project
 * intelligence via Model Context Protocol. Connects to the centralized
 * knowledge database at ~/.igris/memory/knowledge.db.
 *
 * Supports two transport modes:
 * - stdio  (default) — for local Claude Code integration
 * - http   (--http)  — for remote/VPS access via Streamable HTTP
 *
 * Tools provided:
 * - igris_memory_store, igris_memory_search, igris_memory_recall
 * - igris_pattern_suggest
 * - igris_error_lookup
 * - igris_project_register, igris_project_list, igris_project_status
 * - igris_metrics_record, igris_metrics_query, igris_metrics_velocity
 * - igris_session_sync, igris_session_recall
 * - igris_brief_sync, igris_brief_dashboard
 *
 * @version 4.0.0
 * @author Fifty.ai
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Request, Response, NextFunction } from 'express';

// Tool handlers
import { handleMemoryStore, handleMemorySearch, handleMemoryRecall, handlePatternSuggest } from './tools/memory.js';
import type { MemoryStoreInput, MemorySearchInput, MemoryRecallInput, PatternSuggestInput } from './tools/memory.js';
import { handleErrorLookup } from './tools/errors.js';
import type { ErrorLookupInput } from './tools/errors.js';
import { handleProjectRegister, handleProjectList, handleProjectStatus } from './tools/projects.js';
import type { ProjectRegisterInput, ProjectListInput, ProjectStatusInput } from './tools/projects.js';
import { handleMetricsRecord, handleMetricsQuery, handleMetricsVelocity } from './tools/metrics.js';
import type { MetricsRecordInput, MetricsQueryInput, MetricsVelocityInput } from './tools/metrics.js';
import { handleSessionSync, handleSessionRecall } from './tools/sessions.js';
import type { SessionSyncInput, SessionRecallInput } from './tools/sessions.js';
import { handleBriefSync, handleBriefDashboard } from './tools/briefs.js';
import type { BriefSyncInput, BriefDashboardInput } from './tools/briefs.js';

// Staging processor
import { processStagingFiles } from './staging.js';

// Database lifecycle
import { closeDb } from './db.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ServerConfig {
  mode: 'stdio' | 'http';
  port: number;
  apiKey: string | undefined;
}

/**
 * Parse CLI arguments and environment variables to build the server config.
 *
 * Precedence (highest to lowest):
 *   1. CLI flags: --http, --port <number>
 *   2. Environment variables: BRAIN_HTTP, BRAIN_PORT, BRAIN_API_KEY
 *   3. Defaults: mode=stdio, port=3001, apiKey=undefined
 */
function parseConfig(): ServerConfig {
  const args = process.argv.slice(2);

  let mode: 'stdio' | 'http' = 'stdio';
  let port = 3001;
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

  return { mode, port, apiKey };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured MCP Server instance with all Igris Brain tools
 * registered. Each call returns an independent server, which is important
 * for the HTTP transport where every session gets its own Server.
 */
function createBrainServer(): Server {
  const server = new Server(
    {
      name: 'igris-brain',
      version: '4.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ------------------------------------------------------------------
  // List available tools
  // ------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // === Memory Tools ===
        {
          name: 'igris_memory_store',
          description: 'Store a learning in the Igris knowledge database. Use this to persist patterns, decisions, discoveries, mistakes, and optimizations for future recall.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug (e.g., "igris-ai", "my-app")',
              },
              category: {
                type: 'string',
                enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
                description: 'Category of the learning',
              },
              title: {
                type: 'string',
                description: 'Short descriptive title for the learning',
              },
              content: {
                type: 'string',
                description: 'Full content/description of the learning',
              },
              tags: {
                type: 'string',
                description: 'Comma-separated tags (e.g., "sqlite,fts5,performance")',
              },
              tech_stack: {
                type: 'string',
                description: 'Technologies involved (e.g., "typescript,sqlite")',
              },
              source_brief: {
                type: 'string',
                description: 'Brief ID that generated this learning (e.g., "BR-008")',
              },
              scope: {
                type: 'string',
                enum: ['local', 'global'],
                description: 'Scope: "local" for project-specific, "global" for cross-project relevance. Default: "local"',
              },
            },
            required: ['project', 'category', 'title', 'content'],
          },
        },
        {
          name: 'igris_memory_search',
          description: 'Full-text search across all learnings in the Igris knowledge database. Supports filtering by project and scope. Returns results ranked by relevance.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: 'Search query (FTS5 syntax supported: AND, OR, NOT, phrases)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit for cross-project search)',
              },
              scope: {
                type: 'string',
                enum: ['local', 'global'],
                description: 'Filter by scope: "global" for cross-project learnings only (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'igris_memory_recall',
          description: 'Contextual recall of relevant learnings for the current project. Combines project-local and global learnings matching the given context. Updates access counts for returned results.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to recall learnings for',
              },
              context: {
                type: 'string',
                description: 'What you are currently working on — used for FTS5 relevance matching',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 5)',
              },
            },
            required: ['project', 'context'],
          },
        },

        // === Error Tools ===
        {
          name: 'igris_error_lookup',
          description: 'Look up known solutions for an error, or store a new error/solution pair. Uses fingerprinting to match errors regardless of file paths or line numbers. When called without a solution, searches for matching errors. When called with a solution, stores or updates the error record.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message: {
                type: 'string',
                description: 'The error message to look up or store',
              },
              project: {
                type: 'string',
                description: 'Project slug where the error occurred',
              },
              solution: {
                type: 'string',
                description: 'The solution to store for this error (optional — omit to search)',
              },
            },
            required: ['message', 'project'],
          },
        },

        // === Project Tools ===
        {
          name: 'igris_project_register',
          description: 'Register a project in the Igris brain. Creates or updates the project record. Call this when Igris is installed in a new project.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              slug: {
                type: 'string',
                description: 'Unique project slug (e.g., "igris-ai", "my-flutter-app")',
              },
              name: {
                type: 'string',
                description: 'Human-readable project name',
              },
              path: {
                type: 'string',
                description: 'Absolute path to the project directory',
              },
              tech_stack: {
                type: 'string',
                description: 'Comma-separated technologies (e.g., "dart,flutter,firebase")',
              },
            },
            required: ['slug', 'name', 'path'],
          },
        },
        {
          name: 'igris_project_list',
          description: 'List all projects registered in the Igris brain, optionally filtered by status.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                enum: ['active', 'archived', 'inactive'],
                description: 'Filter by project status (optional — omit to list all)',
              },
            },
          },
        },
        {
          name: 'igris_project_status',
          description: 'Get a detailed status dashboard for a specific project, including learning count, error count, and recent agent metrics.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              slug: {
                type: 'string',
                description: 'Project slug to query',
              },
            },
            required: ['slug'],
          },
        },

        // === Metrics Tools ===
        {
          name: 'igris_metrics_record',
          description: 'Record an agent performance metric. Call this after each agent action to track success rates, durations, and retry counts.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              agent: {
                type: 'string',
                description: 'Agent name (e.g., "architect", "forger", "sentinel")',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID being worked on (e.g., "BR-008")',
              },
              action: {
                type: 'string',
                description: 'Action performed (e.g., "plan", "implement", "test", "review")',
              },
              result: {
                type: 'string',
                enum: ['success', 'failure', 'partial', 'blocked'],
                description: 'Outcome of the action',
              },
              duration_ms: {
                type: 'number',
                description: 'Duration of the action in milliseconds',
              },
              retry_count: {
                type: 'number',
                description: 'Number of retries before reaching this result',
              },
            },
            required: ['project', 'agent', 'action', 'result'],
          },
        },
        {
          name: 'igris_metrics_query',
          description: 'Query agent performance metrics with summary statistics. Shows success rate by agent, average duration, and recent entries.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              agent: {
                type: 'string',
                description: 'Filter by agent name (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of recent entries to return (default: 20)',
              },
            },
          },
        },
        {
          name: 'igris_metrics_velocity',
          description: 'Generate a velocity dashboard showing brief completion rates per week, average completion time, agent utilization, and week-over-week trends.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit for all projects)',
              },
              days: {
                type: 'number',
                description: 'Time window in days (default: 30)',
              },
            },
          },
        },
        {
          name: 'igris_pattern_suggest',
          description: 'Suggest relevant patterns for the current context. Searches learnings via FTS5, includes global-scope patterns, and loads matching patterns from the starter-patterns library. Optionally filters by tech stack.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to search patterns for',
              },
              context: {
                type: 'string',
                description: 'What you are currently working on — used for pattern matching',
              },
              tech_stack: {
                type: 'string',
                description: 'Filter by technology (e.g., "typescript", "sqlite") — optional',
              },
            },
            required: ['project', 'context'],
          },
        },

        // === Session Tools ===
        {
          name: 'igris_session_sync',
          description: 'Sync a session snapshot to the Igris brain. Called by /rest to record what you were working on. Closes any existing open session for the project before creating a new one.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Active brief ID (optional)',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase (optional)',
              },
              mode: {
                type: 'string',
                description: 'Session mode (e.g., "HUNT", "REST")',
              },
              summary: {
                type: 'string',
                description: 'Brief description of work done this session',
              },
            },
            required: ['project', 'summary'],
          },
        },
        {
          name: 'igris_session_recall',
          description: 'Recall recent sessions across all projects. Called by /awaken to show cross-project context. Returns sessions grouped by day.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              days: {
                type: 'number',
                description: 'Number of days to look back (default: 7)',
              },
            },
          },
        },

        // === Brief Tools ===
        {
          name: 'igris_brief_sync',
          description: 'Sync a brief status change to the Igris brain. Called when brief status changes during /hunt, /rest, or /archive. Uses upsert to maintain one record per project+brief_id.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "MG-010")',
              },
              brief_type: {
                type: 'string',
                description: 'Brief type (e.g., "Bug", "Migration", "Feature")',
              },
              title: {
                type: 'string',
                description: 'Brief title',
              },
              status: {
                type: 'string',
                description: 'Brief status (e.g., "Ready", "In Progress", "Done")',
              },
              priority: {
                type: 'string',
                description: 'Priority level (e.g., "P0", "P1-High")',
              },
              effort: {
                type: 'string',
                description: 'Effort estimate (e.g., "S-Small", "L-Large")',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase (e.g., "BUILDING", "TESTING")',
              },
            },
            required: ['project', 'brief_id', 'title', 'status'],
          },
        },
        {
          name: 'igris_brief_dashboard',
          description: 'Display a cross-project brief dashboard showing all tracked briefs with status counts. Supports filtering by status and project.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                description: 'Filter by brief status (optional)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
            },
          },
        },
      ],
    };
  });

  // ------------------------------------------------------------------
  // Execute tool calls
  // ------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Memory tools
        case 'igris_memory_store':
          return handleMemoryStore(args as unknown as MemoryStoreInput);
        case 'igris_memory_search':
          return handleMemorySearch(args as unknown as MemorySearchInput);
        case 'igris_memory_recall':
          return handleMemoryRecall(args as unknown as MemoryRecallInput);

        // Error tools
        case 'igris_error_lookup':
          return handleErrorLookup(args as unknown as ErrorLookupInput);

        // Project tools
        case 'igris_project_register':
          return handleProjectRegister(args as unknown as ProjectRegisterInput);
        case 'igris_project_list':
          return handleProjectList(args as unknown as ProjectListInput);
        case 'igris_project_status':
          return handleProjectStatus(args as unknown as ProjectStatusInput);

        // Metrics tools
        case 'igris_metrics_record':
          return handleMetricsRecord(args as unknown as MetricsRecordInput);
        case 'igris_metrics_query':
          return handleMetricsQuery(args as unknown as MetricsQueryInput);
        case 'igris_metrics_velocity':
          return handleMetricsVelocity(args as unknown as MetricsVelocityInput);

        // Pattern tools
        case 'igris_pattern_suggest':
          return handlePatternSuggest(args as unknown as PatternSuggestInput);

        // Session tools
        case 'igris_session_sync':
          return handleSessionSync(args as unknown as SessionSyncInput);
        case 'igris_session_recall':
          return handleSessionRecall(args as unknown as SessionRecallInput);

        // Brief tools
        case 'igris_brief_sync':
          return handleBriefSync(args as unknown as BriefSyncInput);
        case 'igris_brief_dashboard':
          return handleBriefDashboard(args as unknown as BriefDashboardInput);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${message}`,
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
 */
async function runStdio(): Promise<void> {
  // Process any pending staging files before accepting connections
  try {
    processStagingFiles();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[brain] Staging processing error: ${message}`);
  }

  const server = createBrainServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Igris Brain MCP Server v4.0.0 started (stdio)');

  // Clean up on exit
  process.on('SIGINT', () => {
    closeDb();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeDb();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** Maximum concurrent sessions to prevent memory exhaustion. */
const MAX_SESSIONS = 100;

/** Session idle timeout: 30 minutes of inactivity. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Rate limit: max auth failures per IP before temporary block. */
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_FAIL_MAX = 10;

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
  // Process any pending staging files before accepting connections
  try {
    processStagingFiles();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[brain] Staging processing error: ${message}`);
  }

  // Parse allowed hosts from env, default to localhost variants
  const allowedHosts = process.env.BRAIN_ALLOWED_HOSTS
    ? process.env.BRAIN_ALLOWED_HOSTS.split(',').map(h => h.trim())
    : undefined;
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts });

  // Rate limiting: track auth failures per IP
  const authFailures: Record<string, { count: number; resetAt: number }> = {};

  // API key middleware — applied to /mcp routes only
  if (config.apiKey) {
    const expectedToken = `Bearer ${config.apiKey}`;

    app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
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

      const auth = req.headers.authorization ?? '';
      if (!safeCompare(auth, expectedToken)) {
        // Track failure
        if (!authFailures[ip] || now >= (authFailures[ip].resetAt)) {
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
    });
  } else {
    console.error('[brain] WARNING: No BRAIN_API_KEY set. Server is running without authentication.');
  }

  // Session management: map session IDs to their transports + last-activity timestamps
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionActivity: Record<string, number> = {};

  // Periodic session cleanup (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const sid of Object.keys(sessionActivity)) {
      if (now - sessionActivity[sid] > SESSION_TTL_MS) {
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
    res.json({ status: 'ok', version: '4.0.0' });
  });

  // POST /mcp — main MCP request handler
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        // Existing session — update activity, route to its transport
        sessionActivity[sessionId] = Date.now();
        const transport = transports[sessionId];
        await transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Enforce max sessions
        if (Object.keys(transports).length >= MAX_SESSIONS) {
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
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
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
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    sessionActivity[sessionId] = Date.now();
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Start listening
  app.listen(config.port, () => {
    console.error(`Igris Brain MCP Server v4.0.0 started (http, port ${config.port})`);
  });

  // Graceful shutdown
  const shutdown = async () => {
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
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseConfig();

if (config.mode === 'http') {
  runHttp(config).catch((error) => {
    console.error('Fatal error:', error);
    closeDb();
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error('Fatal error:', error);
    closeDb();
    process.exit(1);
  });
}
