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
import { registerGitTools } from './tools/git.js';
import { registerLangChainTools } from './tools/langchain.js';
import { registerLangGraphTools } from './tools/langgraph.js';

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
          {
            name: 'igris_brief_update',
            description: 'Update an existing brief (status, priority)',
            inputSchema: {
              type: 'object',
              properties: {
                brief_id: {
                  type: 'string',
                  description: 'Brief ID (e.g., BR-001)',
                },
                status: {
                  type: 'string',
                  enum: ['Ready', 'In Progress', 'Done', 'Draft'],
                  description: 'New status',
                },
                priority: {
                  type: 'string',
                  enum: ['P0', 'P1', 'P2', 'P3'],
                  description: 'New priority',
                },
              },
              required: ['brief_id'],
            },
          },
          {
            name: 'igris_brief_archive',
            description: 'Archive a completed brief (must be Status: Done)',
            inputSchema: {
              type: 'object',
              properties: {
                brief_id: {
                  type: 'string',
                  description: 'Brief ID to archive',
                },
              },
              required: ['brief_id'],
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

          // Git operations
          {
            name: 'igris_git_status',
            description: 'Get git status (short format)',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'igris_git_diff',
            description: 'Get git diff',
            inputSchema: {
              type: 'object',
              properties: {
                file: {
                  type: 'string',
                  description: 'Specific file to diff (optional)',
                },
                staged: {
                  type: 'boolean',
                  description: 'Show staged changes (--staged)',
                },
              },
            },
          },
          {
            name: 'igris_git_log',
            description: 'Get git commit history',
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Number of commits to show (default: 10)',
                },
              },
            },
          },
          {
            name: 'igris_git_commit',
            description: 'Create a git commit',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Commit message',
                },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Files to stage (optional)',
                },
              },
              required: ['message'],
            },
          },

          // LangChain AI tools
          {
            name: 'igris_langchain_generate_brief',
            description: 'Generate brief using LangChain AI analysis',
            inputSchema: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: 'Natural language description of the issue/feature',
                },
                type: {
                  type: 'string',
                  enum: ['BR', 'FR', 'TD'],
                  description: 'Brief type (default: BR)',
                },
              },
              required: ['description'],
            },
          },
          {
            name: 'igris_langchain_analyze_code',
            description: 'Analyze code using LangChain RAG',
            inputSchema: {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Path to file to analyze',
                },
                question: {
                  type: 'string',
                  description: 'Question about the code',
                },
              },
              required: ['file_path', 'question'],
            },
          },

          // LangGraph agent tools
          {
            name: 'igris_langgraph_code_review',
            description: 'Run autonomous code review agent',
            inputSchema: {
              type: 'object',
              properties: {
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Files to review',
                },
                guidelines_path: {
                  type: 'string',
                  description: 'Path to coding guidelines',
                },
              },
              required: ['files'],
            },
          },
          {
            name: 'igris_langgraph_implementation',
            description: 'Run autonomous implementation agent',
            inputSchema: {
              type: 'object',
              properties: {
                brief_id: {
                  type: 'string',
                  description: 'Brief to implement',
                },
                instructions: {
                  type: 'string',
                  description: 'Additional implementation instructions',
                },
              },
              required: ['brief_id'],
            },
          },
          {
            name: 'igris_langgraph_planning',
            description: 'Run autonomous planning agent',
            inputSchema: {
              type: 'object',
              properties: {
                goal: {
                  type: 'string',
                  description: 'Planning goal',
                },
                context: {
                  type: 'string',
                  description: 'Additional context',
                },
              },
              required: ['goal'],
            },
          },
        ],
      };
    });

    // Execute tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const briefTools = registerBriefTools();
        const sessionTools = registerSessionTools();
        const fileTools = registerFileTools();
        const gitTools = registerGitTools();
        const langchainTools = registerLangChainTools();
        const langgraphTools = registerLangGraphTools();

        switch (name) {
          // Brief tools
          case 'igris_brief_list':
            return await briefTools.list(args);
          case 'igris_brief_read':
            return await briefTools.read(args);
          case 'igris_brief_create':
            return await briefTools.create(args);
          case 'igris_brief_update':
            return await briefTools.update(args);
          case 'igris_brief_archive':
            return await briefTools.archive(args);

          // Session tools
          case 'igris_session_get':
            return await sessionTools.get(args);
          case 'igris_session_update':
            return await sessionTools.update(args);

          // File tools
          case 'igris_file_read':
            return await fileTools.read(args);

          // Git tools
          case 'igris_git_status':
            return await gitTools.status(args);
          case 'igris_git_diff':
            return await gitTools.diff(args);
          case 'igris_git_log':
            return await gitTools.log(args);
          case 'igris_git_commit':
            return await gitTools.commit(args);

          // LangChain tools
          case 'igris_langchain_generate_brief':
            return await langchainTools.generateBrief(args);
          case 'igris_langchain_analyze_code':
            return await langchainTools.analyzeCode(args);

          // LangGraph tools
          case 'igris_langgraph_code_review':
            return await langgraphTools.codeReview(args);
          case 'igris_langgraph_implementation':
            return await langgraphTools.implementation(args);
          case 'igris_langgraph_planning':
            return await langgraphTools.planning(args);

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
