/**
 * Brain Engine v5.0 — Shared Handler Helpers
 *
 * Common utility functions used across engine component handlers.
 * Centralizes errorResult, successResult, and now() to eliminate
 * DRY violations.
 *
 * @module engine/helpers
 * @author Fifty.ai
 */

import type { ToolResult } from './types.js';

/** Return an error ToolResult */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/** Return a success ToolResult with text */
export function successResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/** Current timestamp in ISO 8601 format */
export function now(): string {
  return new Date().toISOString();
}

/** Extract message from an unknown error */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// WhereBuilder
// ---------------------------------------------------------------------------

/**
 * Builder for parameterized WHERE clauses.
 *
 * Eliminates the duplicated conditions/params pattern across handler files.
 * Supports conditional (value !== undefined) and unconditional additions.
 */
export class WhereBuilder {
  private conditions: string[] = [];
  private params: unknown[] = [];

  /** Add a condition if value is not undefined */
  add(condition: string, value: unknown): this {
    if (value !== undefined) {
      this.conditions.push(condition);
      this.params.push(value);
    }
    return this;
  }

  /** Add a condition unconditionally */
  addAlways(condition: string, ...values: unknown[]): this {
    this.conditions.push(condition);
    this.params.push(...values);
    return this;
  }

  /** Build the WHERE clause string (empty string if no conditions) */
  toSQL(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }

  /** Get the parameter values array */
  values(): unknown[] {
    return this.params;
  }
}
