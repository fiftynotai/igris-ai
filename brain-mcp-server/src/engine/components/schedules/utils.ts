/**
 * Brain Engine v5.0 — Schedules Component Utilities
 *
 * Shared helper functions used by both handlers.ts and daemon.ts.
 * Centralizes timestamp generation, ID generation, and retry logic
 * to avoid duplication.
 *
 * @module engine/components/schedules/utils
 * @author Fifty.ai
 */

import { randomUUID } from 'node:crypto';
import { executeHandler } from './handlers.js';

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Current timestamp in ISO 8601 format.
 *
 * All schedule timestamps use ISO format (e.g. "2026-02-25T10:30:00.000Z")
 * for consistent lexicographic comparison with cron.ts nextRunAfter() output.
 */
export function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

/** Generate a schedule ID: sch- prefix + first 8 chars of a UUID */
export function generateScheduleId(): string {
  return 'sch-' + randomUUID().substring(0, 8);
}

/** Generate a run ID: run- prefix + first 8 chars of a UUID */
export function generateRunId(): string {
  return 'run-' + randomUUID().substring(0, 8);
}

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

/**
 * Execute a schedule handler with retry support.
 *
 * Retries on failure up to max_retries additional attempts (so total attempts
 * = max_retries + 1). Uses linear backoff: delay = 1000ms * attempt_number.
 *
 * @param schedule - The schedule row from the database
 * @param dispatchTool - Optional function to dispatch MCP tool calls
 * @returns The final outcome and the attempt number that produced it
 */
export async function executeWithRetries(
  schedule: Record<string, unknown>,
  dispatchTool?: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null,
): Promise<{ outcome: { status: string; result?: string; error?: string }; attempt: number }> {
  const maxRetries = (schedule.max_retries as number) || 0;
  let attempt = 1;
  let outcome = await executeHandler(schedule, dispatchTool);

  while (outcome.status === 'failed' && attempt < maxRetries + 1) {
    attempt++;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    outcome = await executeHandler(schedule, dispatchTool);
  }

  return { outcome, attempt };
}
