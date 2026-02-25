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
