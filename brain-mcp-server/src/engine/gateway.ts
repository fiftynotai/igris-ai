/**
 * Brain Engine v7.0 — API Gateway
 *
 * Dynamic tool registry that replaces the two 27-case switch statements
 * in the monolithic index.ts. Tools are registered by domain components
 * and dispatched by name via a Map lookup.
 *
 * See ../../CLAUDE.md for the strict-input contract this gateway enforces (TD-128).
 *
 * @module engine/gateway
 * @author fifty.dev
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
    additionalProperties?: boolean;
  };
}

/**
 * Internal record stored in the gateway's tool map. Wraps a ToolDefinition
 * with pre-computed allow-set and strict-mode flag so dispatch hot-path is
 * one Set.has() per arg key.
 */
interface RegisteredTool extends ToolDefinition {
  /** Pre-computed Set of keys from inputSchema.properties (for O(1) membership) */
  _allowedKeys: Set<string>;
  /** True iff the schema declares additionalProperties: false (TD-128 strict-input contract) */
  _strict: boolean;
  /**
   * Pre-computed copy of `inputSchema.required` (BR-080). Empty array when the
   * schema declares no required keys. Cached at register() for the same reason
   * `_allowedKeys` is: dispatch stays a straight-line walk with no schema
   * re-reads.
   */
  _required: string[];
}

/**
 * TD-128 reject-mode active. Throws on extras for any tool with
 * `additionalProperties: false`.
 *
 * Flag is retained (vs. inlining the throw) so a single-line revert is
 * available if a production incident emerges. When `false`, unknown args
 * on strict tools emit a console.warn but the call proceeds. When `true`,
 * unknown args on strict tools throw a JSON-RPC-friendly error.
 */
const REJECT_EXTRAS = true;

/**
 * Create an API gateway for routing tool calls to component handlers.
 */
export function createGateway() {
  const toolMap = new Map<string, RegisteredTool>();

  /**
   * Register tools from a component.
   * Throws if a tool name is already registered (duplicate detection).
   *
   * Pre-computes the allow-set and strict-mode flag at registration so
   * dispatch is a single Set.has() per arg key (TD-128).
   */
  function register(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      if (toolMap.has(tool.name)) {
        throw new Error(`Duplicate tool registration: "${tool.name}"`);
      }
      const allowedKeys = new Set<string>(Object.keys(tool.inputSchema.properties));
      const strict = tool.inputSchema.additionalProperties === false;
      // BR-080: `required` was declared by 75 registered tools and enforced by
      // none — listTools() forwarded it to clients, but dispatch never read it.
      // Cache it here so the missing-required check costs one array walk.
      const required = tool.inputSchema.required ?? [];
      toolMap.set(tool.name, {
        ...tool,
        _allowedKeys: allowedKeys,
        _strict: strict,
        _required: required,
      });
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
          ...(tool.inputSchema.additionalProperties === false
            ? { additionalProperties: false as const }
            : {}),
        },
      });
    }
    return result;
  }

  /**
   * Dispatch a tool call to its handler.
   *
   * @param name - The tool name
   * @param args - The parsed arguments. An omitted (or null) MCP
   *   `params.arguments` is normalised to `{}` before any read (TD-321), so
   *   every walk and the handler itself see an object.
   * @returns The tool result (MCP response format)
   * @throws Error if tool is not found, if a declared `required` key is absent
   *   (BR-080), or (when REJECT_EXTRAS) if a strict tool receives an unknown
   *   arg key.
   */
  async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    // BR-080: missing-required contract — the symmetric half of TD-128.
    //
    // Runs BEFORE the extras walk so a call that is both missing a required
    // key AND carrying an extra reports the more actionable failure first.
    //
    // Presence (`key in args`), NOT truthiness: a legitimate `""`, `0` or
    // `false` argument satisfies a `required` declaration. `!args[key]` would
    // reject those.
    //
    // SECRETS: this error interpolates key NAMES only, never `args[key]`.
    // `api_key` is one of the names this guard prints — a value interpolation
    // here would put a live secret into a JSON-RPC error envelope, a log line,
    // and any transcript the caller keeps. Do not add one.
    //
    // TD-321: the omitted-`arguments` normalisation, applied ONCE for every
    // read below.
    //
    // `params.arguments` is OPTIONAL in the MCP spec and neither entrypoint in
    // `src/index.ts` defaults it, so `args` genuinely arrives as `undefined`
    // (or `null`) from a real client. Every read that follows — the required
    // walk, the TD-128 extras walk, and the handler call — goes through this
    // stand-in, which makes an absent argument map exactly equivalent to `{}`
    // for all 108 registered tools (FR-267, 2026-08-26; `gateway-tool-count.test.ts` pins it).
    //
    // BR-080 introduced this stand-in for the required walk only and did not
    // forward it, which left a residual: the extras walk still ran
    // `Object.keys(args)` on the original, so the 75 tools that declare
    // `required` were saved by the throw above while the other 37 fell into
    // `TypeError: Cannot convert undefined or null to object` — the exact
    // symptom class this guard exists to replace. Forwarding closes it.
    //
    // `??` and not a spread, on purpose: a supplied args object must reach the
    // handler by IDENTITY. Copying here would silently change what a handler
    // that mutates or compares by reference observes.
    const suppliedArgs = (args ?? {}) as Record<string, unknown>;
    for (const key of tool._required) {
      if (!(key in suppliedArgs)) {
        throw new Error(
          `${name}: missing required argument '${key}'. Required: ${tool._required.join(', ')}. (strict-input contract; BR-080)`,
        );
      }
    }
    // TD-128: strict-input contract. Reject-mode active (M4) — any extra arg
    // on a tool whose schema declares `additionalProperties: false` throws.
    if (tool._strict) {
      for (const key of Object.keys(suppliedArgs)) {
        if (!tool._allowedKeys.has(key)) {
          if (REJECT_EXTRAS) {
            throw new Error(
              `${name}: unknown argument '${key}'. Accepted keys: ${[...tool._allowedKeys].join(', ')}. (strict-input contract; TD-128)`,
            );
          }
          // Warn-mode fallback (REJECT_EXTRAS=false) — gateway has no logger
          // handle (createGateway takes no ComponentContext), so console.warn
          // is the available channel.
          // eslint-disable-next-line no-console
          console.warn(
            `[TD-128] ${name}: unknown argument '${key}' (warn-only; reject-mode disabled)`,
          );
        }
      }
    }
    return tool.handler(suppliedArgs);
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
