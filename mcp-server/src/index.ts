#!/usr/bin/env node
/**
 * Igris AI MCP Server
 *
 * Exposes Igris AI capabilities via Model Context Protocol:
 * - Brief management (BR, FR, TD, MG, TS briefs)
 * - Session tracking and recovery
 * - File operations (via stdio)
 * - Git operations
 * - LangChain/LangGraph workflows
 *
 * @version 3.0.0
 * @author Fifty.ai
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Tool handlers
import { registerBriefTools } from './tools/briefs.js';
import { registerSessionTools } from './tools/session.js';
import { registerFileTools } from './tools/files.js';

/**
 * Main MCP Server instance
 */
class IgrisMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'igris-ai',
        version: '3.0.0',
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
   * Set up MCP protocol handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Brief management tools
          {
            name: 'igris_brief_list',
            description: 'List Igris briefs with optional filters (type, status, priority)',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['BR', 'FR', 'TD', 'MG', 'TS', 'PI', 'DU', 'PF', 'AC'],
                  description: 'Filter by brief type',
                },
                status: {
                  type: 'string',
                  enum: ['Ready', 'In Progress', 'Done', 'Draft'],
                  description: 'Filter by status',
                },
                priority: {
                  type: 'string',
                  enum: ['P0', 'P1', 'P2', 'P3'],
                  description: 'Filter by priority',
                },
              },
            },
          },
          {
            name: 'igris_brief_read',
            description: 'Read a specific Igris brief by ID',
            inputSchema: {
              type: 'object',
              properties: {
                brief_id: {
                  type: 'string',
                  description: 'Brief ID (e.g., BR-001, MG-002)',
                },
              },
              required: ['brief_id'],
            },
          },
          {
            name: 'igris_brief_create',
            description: 'Create a new Igris brief',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['BR', 'FR', 'TD', 'MG', 'TS'],
                  description: 'Brief type',
                },
                title: {
                  type: 'string',
                  description: 'Brief title',
                },
                priority: {
                  type: 'string',
                  enum: ['P0', 'P1', 'P2', 'P3'],
                  description: 'Priority level',
                },
                problem: {
                  type: 'string',
                  description: 'Problem description',
                },
                goal: {
                  type: 'string',
                  description: 'Goal/expected outcome',
                },
              },
              required: ['type', 'title', 'priority', 'problem', 'goal'],
            },
          },

          // Session management tools
          {
            name: 'igris_session_get',
            description: 'Get current Igris session state',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'igris_session_update',
            description: 'Update Igris session state',
            inputSchema: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  description: 'Session status update',
                },
                next_steps: {
                  type: 'string',
                  description: 'Next steps when resuming',
                },
              },
            },
          },

          // File operations
          {
            name: 'igris_file_read',
            description: 'Read a file from the Igris project',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative path from project root',
                },
              },
              required: ['path'],
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
          case 'igris_brief_list':
            return await registerBriefTools().list(args);

          case 'igris_brief_read':
            return await registerBriefTools().read(args);

          case 'igris_brief_create':
            return await registerBriefTools().create(args);

          case 'igris_session_get':
            return await registerSessionTools().get(args);

          case 'igris_session_update':
            return await registerSessionTools().update(args);

          case 'igris_file_read':
            return await registerFileTools().read(args);

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
   * Start the MCP server with stdio transport
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Server is now running and listening on stdio
    console.error('Igris AI MCP Server v3.0.0 started');
  }
}

// Start server
const server = new IgrisMCPServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
