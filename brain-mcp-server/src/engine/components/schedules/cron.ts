/**
 * Brain Engine v7.0 — Minimal 5-Field Cron Parser
 *
 * Parses standard 5-field cron expressions (minute, hour, day-of-month,
 * month, day-of-week) and computes the next occurrence after a given date.
 *
 * Supported field syntax: *, N, N,M, N-M, * /N, N-M/S
 *
 * NO external dependencies — fully inline implementation.
 *
 * @module engine/components/schedules/cron
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed cron schedule — each field is a set of valid values */
export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

// ---------------------------------------------------------------------------
// Field Ranges
// ---------------------------------------------------------------------------

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },   // minutes
  { min: 0, max: 23 },   // hours
  { min: 1, max: 31 },   // days of month
  { min: 1, max: 12 },   // months
  { min: 0, max: 6 },    // days of week (0=Sunday)
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field token into a set of values.
 *
 * Supports: *, N, N,M, N-M, * /N, N-M/S
 *
 * @param token - The raw field string
 * @param range - The valid range for this field
 * @returns A Set of matching integer values
 * @throws Error on invalid syntax or out-of-range values
 */
function parseField(token: string, range: FieldRange): Set<number> {
  const result = new Set<number>();

  // Handle comma-separated sub-expressions: "1,5,10" or "1-5,10"
  const parts = token.split(',');

  for (const part of parts) {
    // Check for step syntax: "*/2" or "1-10/3"
    const stepSplit = part.split('/');

    if (stepSplit.length > 2) {
      throw new Error(`Invalid cron field: "${token}" (too many / characters)`);
    }

    const base = stepSplit[0];
    const step = stepSplit.length === 2 ? parseInt(stepSplit[1], 10) : 1;

    if (isNaN(step) || step < 1) {
      throw new Error(`Invalid step value in cron field: "${token}"`);
    }

    if (base === '*') {
      // Wildcard: all values in range, optionally with step
      for (let i = range.min; i <= range.max; i += step) {
        result.add(i);
      }
    } else if (base.includes('-')) {
      // Range: "1-5" or "1-10/3"
      const [startStr, endStr] = base.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range in cron field: "${token}"`);
      }
      if (start < range.min || end > range.max || start > end) {
        throw new Error(
          `Range out of bounds in cron field: "${token}" (valid: ${range.min}-${range.max})`
        );
      }

      for (let i = start; i <= end; i += step) {
        result.add(i);
      }
    } else {
      // Single value: "5"
      const value = parseInt(base, 10);
      if (isNaN(value) || value < range.min || value > range.max) {
        throw new Error(
          `Value out of range in cron field: "${token}" (valid: ${range.min}-${range.max})`
        );
      }

      if (stepSplit.length === 2) {
        // Single value with step: "5/2" means starting at 5, every 2
        for (let i = value; i <= range.max; i += step) {
          result.add(i);
        }
      } else {
        result.add(value);
      }
    }
  }

  if (result.size === 0) {
    throw new Error(`Cron field produced no values: "${token}"`);
  }

  return result;
}

/**
 * Parse and validate a 5-field cron expression.
 *
 * Format: "minute hour day-of-month month day-of-week"
 *
 * @param expr - The cron expression string
 * @returns A parsed CronSchedule
 * @throws Error on invalid expression
 */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: "${expr}" (expected 5 fields, got ${fields.length})`
    );
  }

  return {
    minutes: parseField(fields[0], FIELD_RANGES[0]),
    hours: parseField(fields[1], FIELD_RANGES[1]),
    daysOfMonth: parseField(fields[2], FIELD_RANGES[2]),
    months: parseField(fields[3], FIELD_RANGES[3]),
    daysOfWeek: parseField(fields[4], FIELD_RANGES[4]),
  };
}

// ---------------------------------------------------------------------------
// Next Occurrence
// ---------------------------------------------------------------------------

/**
 * Compute the next occurrence of a cron schedule after a given date.
 *
 * Algorithm: Advance from after + 1 minute (seconds zeroed) through
 * months, days, hours, minutes until a match is found. Caps at 4 years
 * forward to prevent infinite loops.
 *
 * @param schedule - A parsed CronSchedule
 * @param after - The reference date (next occurrence is strictly after this)
 * @returns The next matching Date
 * @throws Error if no match is found within 4 years
 */
export function nextOccurrence(schedule: CronSchedule, after: Date): Date {
  // Start from after + 1 minute, zero seconds and milliseconds
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Cap at 4 years (366 * 4 = 1464 days) to prevent infinite loops
  const cap = new Date(after.getTime());
  cap.setFullYear(cap.getFullYear() + 4);

  while (cursor.getTime() <= cap.getTime()) {
    // Check month
    const month = cursor.getMonth() + 1; // JS months are 0-indexed
    if (!schedule.months.has(month)) {
      // Advance to next month
      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day — both dayOfMonth AND dayOfWeek must match.
    // NOTE: Uses AND logic for dayOfMonth/dayOfWeek when both are non-wildcard.
    // POSIX cron (vixie) uses OR semantics — this is a deliberate deviation.
    // Rationale: AND is more intuitive for scheduling ("3rd AND Monday" vs
    // "3rd OR Monday").
    const dayOfMonth = cursor.getDate();
    const dayOfWeek = cursor.getDay(); // 0=Sunday

    if (!schedule.daysOfMonth.has(dayOfMonth) || !schedule.daysOfWeek.has(dayOfWeek)) {
      // Advance to next day
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    const hour = cursor.getHours();
    if (!schedule.hours.has(hour)) {
      // Advance to next hour
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    const minute = cursor.getMinutes();
    if (!schedule.minutes.has(minute)) {
      // Advance to next minute
      cursor.setMinutes(cursor.getMinutes() + 1);
      cursor.setSeconds(0, 0);
      continue;
    }

    // All fields match
    return new Date(cursor.getTime());
  }

  throw new Error('No cron match found within 4 years');
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Parse a cron expression and compute the next run time.
 *
 * @param cronExpr - A 5-field cron expression
 * @param afterIso - ISO string to compute next run after (default: now)
 * @returns ISO string of the next occurrence
 */
export function nextRunAfter(cronExpr: string, afterIso?: string): string {
  const schedule = parseCron(cronExpr);
  const after = afterIso ? new Date(afterIso) : new Date();
  return nextOccurrence(schedule, after).toISOString();
}
