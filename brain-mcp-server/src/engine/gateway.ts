/**
 * Brain Engine v5.0 — API Gateway
 *
 * Dynamic tool registry that replaces the two 27-case switch statements
 * in the monolithic index.ts. Tools are registered by domain components
 * and dispatched by name via a Map lookup.
 *
 * @module engine/gateway
 * @author Fifty.ai
 */

import type { ToolDefinition, ToolResult } from './types.js';

/** MCP tool schema shape returned by ListToolsRequestSchema handler */
export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Create an API gateway for routing tool calls to component handlers.
 */
export function createGateway() {
  const toolMap = new Map<string, ToolDefinition>();

  /**
   * Register tools from a component.
   * Throws if a tool name is already registered (duplicate detection).
   */
  function register(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      if (toolMap.has(tool.name)) {
        throw new Error(`Duplicate tool registration: "${tool.name}"`);
      }
      toolMap.set(tool.name, tool);
    }
  }

  /**
   * List all registered tools in MCP schema format.
   * Returns the exact structure expected by ListToolsRequestSchema.
   */
  function listTools(): McpToolSchema[] {
    const result: McpToolSchema[] = [];
    for (const tool of toolMap.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: tool.inputSchema.properties,
          ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
        },
      });
    }
    return result;
  }

  /**
   * Dispatch a tool call to its handler.
   *
   * @param name - The tool name
   * @param args - The parsed arguments
   * @returns The tool result (MCP response format)
   * @throws Error if tool is not found
   */
  async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args);
  }

  /**
   * Get the number of registered tools.
   */
  function toolCount(): number {
    return toolMap.size;
  }

  /**
   * Check if a tool is registered.
   */
  function hasTool(name: string): boolean {
    return toolMap.has(name);
  }

  return {
    register,
    listTools,
    dispatch,
    toolCount,
    hasTool,
  };
}

/** Type of the gateway returned by createGateway */
export type ApiGateway = ReturnType<typeof createGateway>;
