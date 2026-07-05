/**
 * `igris onboarding <status|welcomed|complete> [--json]` — FR-235 hidden verb.
 *
 * The harness-agnostic first-run signal the `/boot` Welcome and the `/setup`
 * skill branch on. Thin wrapper over the init-config onboarding helpers:
 *
 *   - `status`   → prints `{completed, boot_welcomed, first_run}` as a single
 *                  JSON object to STDOUT (first_run = !completed). A missing or
 *                  malformed config degrades to `{first_run:true, completed:false,
 *                  boot_welcomed:false}`. Exit 0 always.
 *   - `welcomed` → stamps `onboarding.boot_welcomed=true` (idempotent). Exit 0.
 *   - `complete` → stamps `onboarding.completed=true` (idempotent). Exit 0.
 *
 * Stdout stays a clean parseable digest (logs/notices go to stderr via
 * lib/log.ts) — modeled on the `detect` / `assess` verbs. The setters degrade
 * silently on a missing config (never throw); an unknown action → exit 2.
 */

import {
  readOnboardingState,
  setOnboardingComplete,
  setOnboardingWelcomed,
} from "../lib/init-config.js";
import { error as logError } from "../lib/log.js";

export interface OnboardingOptions {
  /** Emit the status digest as JSON to stdout (default ON — the boot/setup path). */
  json?: boolean;
}

/**
 * The `igris onboarding status` digest. `first_run` is the derived
 * `!completed` — the single boolean the boot/setup skills branch on.
 */
export interface OnboardingStatusDigest {
  completed: boolean;
  boot_welcomed: boolean;
  first_run: boolean;
}

/**
 * Run the onboarding verb. Returns the process exit code: 0 for the three known
 * actions (they never fail — a missing config is a degraded first-run, not an
 * error), 2 for an unknown action.
 */
export function runOnboarding(
  action: string,
  opts: OnboardingOptions = {},
): number {
  const json = opts.json !== false;
  switch (action) {
    case "status": {
      const state = readOnboardingState();
      const digest: OnboardingStatusDigest = {
        completed: state.completed,
        boot_welcomed: state.boot_welcomed,
        first_run: !state.completed,
      };
      if (json) process.stdout.write(JSON.stringify(digest) + "\n");
      return 0;
    }
    case "welcomed": {
      // Idempotent; degrades silently on a missing config (never throws).
      setOnboardingWelcomed();
      return 0;
    }
    case "complete": {
      setOnboardingComplete();
      return 0;
    }
    default: {
      logError(
        `unknown onboarding action '${action}' (expected status|welcomed|complete).`,
      );
      return 2;
    }
  }
}
