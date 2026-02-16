#!/usr/bin/env node
/**
 * Igris AI Centralized Brain MCP Server
 *
 * Exposes persistent memory, project management, and cross-project
 * intelligence via Model Context Protocol. Connects to the centralized
 * knowledge database at ~/.igris/memory/knowledge.db.
 *
 * Tools provided:
 * - igris_memory_store, igris_memory_search, igris_memory_recall
 * - igris_error_lookup
 * - igris_project_register, igris_project_list, igris_project_status
 * - igris_metrics_record, igris_metrics_query
 *
 * @version 4.0.0
 * @author Fifty.ai
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Tool handlers
import { handleMemoryStore, handleMemorySearch, handleMemoryRecall } from './tools/memory.js';
import type { MemoryStoreInput, MemorySearchInput, MemoryRecallInput } from './tools/memory.js';
import { handleErrorLookup } from './tools/errors.js';
import type { ErrorLookupInput } from './tools/errors.js';
import { handleProjectRegister, handleProjectList, handleProjectStatus } from './tools/projects.js';
import type { ProjectRegisterInput, ProjectListInput, ProjectStatusInput } from './tools/projects.js';
import { handleMetricsRecord, handleMetricsQuery } from './tools/metrics.js';
import type { MetricsRecordInput, MetricsQueryInput } from './tools/metrics.js';

// Staging processor
import { processStagingFiles } from './staging.js';

// Database lifecycle
import { closeDb } from './db.js';

/**
 * Igris Brain MCP Server
 *
 * Centralizes all brain tools and handles MCP protocol communication.
 */
class IgrisBrainServer {
  private server: Server;

  constructor() {
    this.server = new Server(
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

    this.setupHandlers();
  }

  /**
   * Set up MCP protocol handlers for listing and calling tools.
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
        ],
      };
    });

    // Execute tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
  }

  /**
   * Start the MCP server with stdio transport.
   * Processes pending staging files on startup.
   */
  async run(): Promise<void> {
    // Process any pending staging files before accepting connections
    try {
      processStagingFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[brain] Staging processing error: ${message}`);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Igris Brain MCP Server v4.0.0 started');

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
}

// Start server
const server = new IgrisBrainServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  closeDb();
  process.exit(1);
});
