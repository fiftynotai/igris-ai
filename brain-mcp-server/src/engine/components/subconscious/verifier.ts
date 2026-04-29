/**
 * Brain Engine v5.0 — Conflict Verifier (FR-108)
 *
 * Optional LLM verification gate that ratifies (or vetoes) heuristic
 * conflict candidates produced by `detectors/conflict.ts`. The verifier
 * is **purely additive**: when no `claude` CLI is present (e.g. on the
 * VPS), or when a call fails for any reason, candidates surface
 * unchanged. The only path that suppresses a candidate is a clean,
 * parse-successful `{is_conflict: false, ...}` reply — we never silently
 * drop a heuristic signal due to LLM unreachability.
 *
 * Phase 0 empirical findings (claude -p, version 2.1.123, macOS):
 *   - `claude -p` accepts the prompt body via stdin and returns the
 *     model's reply on stdout. Default (no `--output-format`) emits the
 *     reply as bare text — when we ask for JSON, we get bare JSON.
 *   - `--output-format json` wraps the reply in an envelope:
 *       {"type":"result","subtype":"success","is_error":false,
 *        "result":"<actual model text>", ...}
 *     We do NOT pass this flag by default (extra wrapping just to unwrap),
 *     but the extractor handles it for forward-compat.
 *   - Realistic prompt latency: ~3-7s warm. We budget 45s per call.
 *   - Exit code 0 on success.
 *
 * Defensive defaults (per plan §"Failure modes"):
 *   - CLI missing → `noopVerifier` returns `is_conflict=true` so the
 *     heuristic signal still surfaces (with `verifier_status='cli_missing'`).
 *   - Spawn / timeout / parse failure → same: keep the candidate, tag the
 *     evidence so downstream triage can see the verifier didn't get a
 *     chance to weigh in.
 *   - Only an explicit, parsed `{is_conflict: false, ...}` rejects.
 *
 * @module engine/components/subconscious/verifier
 * @author Fifty.ai
 */

import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Outcome of a verifier call. `status` is a diagnostic that lets callers
 * distinguish a clean true/false reply from a defensive default produced
 * because something went wrong upstream.
 */
export interface VerifierResult {
  is_conflict: boolean;
  reason: string;
  status: 'verified' | 'cli_missing' | 'spawn_failed' | 'timeout' | 'parse_failed';
}

/** Pair input — just the fields the prompt template renders. */
export interface VerifierLearning {
  id: number;
  content: string;
  created_at: string;
}

/** Verifier signature — async because the real one shells out. */
export type ConflictVerifier = (
  a: VerifierLearning,
  b: VerifierLearning,
) => Promise<VerifierResult>;

// ---------------------------------------------------------------------------
// Noop / fallback verifier
// ---------------------------------------------------------------------------

/**
 * Default verifier used when the `claude` CLI is absent.
 *
 * Returns `is_conflict=true` unconditionally so heuristic candidates pass
 * through unchanged — the runner enriches `evidence.verifier_status` so
 * downstream readers can tell the suggestion was NOT ratified by an LLM.
 */
export const noopVerifier: ConflictVerifier = async () => ({
  is_conflict: true,
  reason: 'verifier disabled (no claude CLI)',
  status: 'cli_missing',
});

// ---------------------------------------------------------------------------
// CLI presence probe
// ---------------------------------------------------------------------------

/** Cached probe result so we only fork `claude --version` once per process. */
let _cliAvailable: boolean | null = null;

/**
 * Probe whether the `claude` CLI is callable. Cached after the first call.
 * Returns `false` on any exception, missing-binary, or non-zero exit.
 *
 * The probe uses `spawnSync` with a tight 5s timeout — this runs at
 * component init time, not in the hot path, so blocking is acceptable.
 */
export function isClaudeCliAvailable(): boolean {
  if (_cliAvailable !== null) return _cliAvailable;
  try {
    const result = spawnSync('claude', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf-8',
    });
    _cliAvailable = result.status === 0;
  } catch {
    _cliAvailable = false;
  }
  return _cliAvailable;
}

/** Reset the cached probe — used by tests so the cache doesn't leak across files. */
export function resetClaudeCliProbeCache(): void {
  _cliAvailable = null;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the verification prompt. Single-message, JSON-only response shape.
 * Exposed for testing; production callers use the factory below.
 */
export function buildPrompt(a: VerifierLearning, b: VerifierLearning): string {
  return [
    'You are reviewing two learnings stored in a knowledge base. Determine if they are contradictory.',
    '',
    `LEARNING A (id=${a.id}, stored ${a.created_at}):`,
    a.content,
    '',
    `LEARNING B (id=${b.id}, stored ${b.created_at}):`,
    b.content,
    '',
    'Are these claims contradictory? A contradiction means both cannot be true simultaneously about the same project, scope, or technical fact. Surface-level vocabulary differences without semantic conflict are NOT contradictions.',
    '',
    'Reply with ONLY a JSON object on a single line. No prose, no code fences, no explanation.',
    '',
    '{"is_conflict": true|false, "reason": "<one sentence>"}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON extractor
// ---------------------------------------------------------------------------

/**
 * Robust extraction of `{is_conflict, reason}` from the verifier's stdout.
 *
 * Tries (in order):
 *   1. Parse the whole stdout as JSON. Handles bare JSON ("{...}") AND
 *      the `--output-format json` envelope ({"result": "...", ...}) — for
 *      the envelope we recurse on the `result` field.
 *   2. Find the first `{...}` block via regex and parse that.
 *   3. Strip ```json / ``` fences then retry (1).
 *
 * On unrecoverable failure: returns the defensive default
 * `{is_conflict: true, status: 'parse_failed', reason: ...}` so the
 * heuristic candidate still surfaces.
 */
export function extractJsonReply(stdout: string): VerifierResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {
      is_conflict: true,
      reason: 'empty stdout from verifier',
      status: 'parse_failed',
    };
  }

  // Strategy 1: parse whole stdout.
  const direct = tryParseAndCoerce(trimmed);
  if (direct) return direct;

  // Strategy 2: regex-find first {...} block. Non-greedy on the inner
  // capture so we don't slurp the entire stdout when there's noise after
  // the JSON. We anchor on a balanced-brace match via a single-pass
  // counter rather than relying on regex (which can't balance braces).
  const match = findFirstJsonObject(trimmed);
  if (match) {
    const parsed = tryParseAndCoerce(match);
    if (parsed) return parsed;
  }

  // Strategy 3: strip code fences then retry.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (stripped !== trimmed) {
    const reFenced = tryParseAndCoerce(stripped);
    if (reFenced) return reFenced;
    const reMatch = findFirstJsonObject(stripped);
    if (reMatch) {
      const parsed = tryParseAndCoerce(reMatch);
      if (parsed) return parsed;
    }
  }

  return {
    is_conflict: true,
    reason: `parse failed (stdout did not yield {is_conflict, reason}): ${truncate(trimmed, 120)}`,
    status: 'parse_failed',
  };
}

/**
 * Try to parse `text` as JSON and coerce it into a `VerifierResult`.
 * Handles two shapes:
 *   - Bare reply: `{is_conflict, reason}` — coerced directly.
 *   - `--output-format json` envelope: `{result: "<json text>"}` — recurses
 *     on the `result` field.
 * Returns `null` if the text can't be parsed or doesn't match either shape.
 */
function tryParseAndCoerce(text: string): VerifierResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Envelope shape — recurse on inner `result`.
  if (typeof obj.result === 'string' && (obj.type === 'result' || 'is_error' in obj)) {
    const inner = obj.result;
    return extractJsonReply(inner);
  }

  // Bare shape — must have `is_conflict` boolean.
  if (typeof obj.is_conflict !== 'boolean') return null;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return {
    is_conflict: obj.is_conflict,
    reason,
    status: 'verified',
  };
}

/**
 * Find the first balanced `{...}` block in a string. Walks character by
 * character tracking brace depth so we don't trip over braces inside JSON
 * string literals. Returns `null` if no balanced block is found.
 */
function findFirstJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (start === -1) continue;
      depth -= 1;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.substring(0, max - 3)}...`;
}

// ---------------------------------------------------------------------------
// Claude headless verifier factory
// ---------------------------------------------------------------------------

export interface ClaudeHeadlessVerifierOptions {
  /** Hard wall-clock budget per call. Default 45_000 (45s). */
  timeoutMs?: number;
  /** Override the binary name — primarily for testing. */
  command?: string;
  /** Override argv — primarily for testing. */
  args?: string[];
}

/**
 * Build a verifier that shells out to `claude -p`. Streams the prompt to
 * stdin (avoids ARG_MAX issues with long learning content), reads stdout
 * to a buffer, and parses with the robust extractor above.
 *
 * Concurrency note: each call spawns one subprocess. The runner invokes
 * this sequentially over candidates. Worst-case 5 pairs × 10 projects ×
 * 30s ≈ 25 min — well under the 6-hour cron interval. If profiling shows
 * pipeline duration becomes a concern, batching via `Promise.all` is a
 * future TD candidate (recorded in the runner comment).
 *
 * Failure handling:
 *   - SIGTERM at `timeoutMs`, hard SIGKILL 5s later.
 *   - Any spawn error / non-zero exit → `status: 'spawn_failed'`,
 *     `is_conflict: true` (defensive — surface the candidate).
 *   - Empty stdout → `status: 'parse_failed'`, `is_conflict: true`.
 */
export function makeClaudeHeadlessVerifier(
  opts: ClaudeHeadlessVerifierOptions = {},
): ConflictVerifier {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const command = opts.command ?? 'claude';
  const args = opts.args ?? ['-p'];

  return async (a, b) => {
    const prompt = buildPrompt(a, b);

    return new Promise<VerifierResult>((resolve) => {
      let settled = false;
      const settle = (r: VerifierResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let child;
      try {
        child = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        settle({
          is_conflict: true,
          reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          status: 'spawn_failed',
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      // Timeout: SIGTERM, then SIGKILL 5s later if still alive.
      const softTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already dead — ignore.
        }
        const hardTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already dead — ignore.
          }
        }, 5_000);
        // If the close handler fires before the hard kill, clear it.
        child.once('close', () => clearTimeout(hardTimer));
        settle({
          is_conflict: true,
          reason: `verifier timeout after ${timeoutMs}ms`,
          status: 'timeout',
        });
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(softTimer);
        settle({
          is_conflict: true,
          reason: `spawn error: ${err.message}`,
          status: 'spawn_failed',
        });
      });

      child.on('close', (code) => {
        clearTimeout(softTimer);
        if (code !== 0) {
          settle({
            is_conflict: true,
            reason: `non-zero exit (${String(code)}): ${truncate(stderr.trim(), 200)}`,
            status: 'spawn_failed',
          });
          return;
        }
        settle(extractJsonReply(stdout));
      });

      // Write prompt to stdin and close — `claude -p` reads to EOF.
      try {
        child.stdin?.end(prompt);
      } catch (err) {
        clearTimeout(softTimer);
        settle({
          is_conflict: true,
          reason: `stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
          status: 'spawn_failed',
        });
      }
    });
  };
}
