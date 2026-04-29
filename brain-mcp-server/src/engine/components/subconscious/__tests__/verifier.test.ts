/**
 * Verifier — unit tests (FR-108)
 *
 * Covers the JSON extractor, the noop fallback, the CLI presence probe,
 * and the headless verifier subprocess shape (using a test-only command
 * that's deterministic and fast — no real `claude` invocation).
 *
 * @module engine/components/subconscious/__tests__/verifier.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPrompt,
  extractJsonReply,
  isClaudeCliAvailable,
  makeClaudeHeadlessVerifier,
  noopVerifier,
  resetClaudeCliProbeCache,
} from '../verifier.js';

// ---------------------------------------------------------------------------
// extractJsonReply
// ---------------------------------------------------------------------------

describe('extractJsonReply', () => {
  it('parses bare JSON', () => {
    const result = extractJsonReply('{"is_conflict": true, "reason": "x"}');
    expect(result.is_conflict).toBe(true);
    expect(result.reason).toBe('x');
    expect(result.status).toBe('verified');
  });

  it('parses bare JSON with whitespace and newlines', () => {
    const result = extractJsonReply('\n  {"is_conflict": false, "reason": "different"}  \n');
    expect(result.is_conflict).toBe(false);
    expect(result.status).toBe('verified');
  });

  it('parses ```json fenced block', () => {
    const stdout = '```json\n{"is_conflict": true, "reason": "y"}\n```';
    const result = extractJsonReply(stdout);
    expect(result.is_conflict).toBe(true);
    expect(result.reason).toBe('y');
    expect(result.status).toBe('verified');
  });

  it('parses ``` (no language) fenced block', () => {
    const stdout = '```\n{"is_conflict": false, "reason": "z"}\n```';
    const result = extractJsonReply(stdout);
    expect(result.is_conflict).toBe(false);
    expect(result.status).toBe('verified');
  });

  it('parses JSON with leading prose by finding the first balanced object', () => {
    const stdout = 'Sure, here is the answer:\n{"is_conflict": true, "reason": "yes"}';
    const result = extractJsonReply(stdout);
    expect(result.is_conflict).toBe(true);
    expect(result.reason).toBe('yes');
    expect(result.status).toBe('verified');
  });

  it('parses --output-format json envelope by recursing on result field', () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"is_conflict": false, "reason": "envelope-wrapped"}',
    });
    const result = extractJsonReply(envelope);
    expect(result.is_conflict).toBe(false);
    expect(result.reason).toBe('envelope-wrapped');
    expect(result.status).toBe('verified');
  });

  it('returns parse_failed defensive default for empty stdout', () => {
    const result = extractJsonReply('');
    expect(result.is_conflict).toBe(true); // defensive — preserve heuristic
    expect(result.status).toBe('parse_failed');
  });

  it('returns parse_failed defensive default for garbage stdout', () => {
    const result = extractJsonReply('hello world this is not json');
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('parse_failed');
  });

  it('returns parse_failed when JSON is missing is_conflict field', () => {
    const result = extractJsonReply('{"foo": "bar"}');
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('parse_failed');
  });

  it('returns parse_failed when is_conflict is not a boolean', () => {
    const result = extractJsonReply('{"is_conflict": "yes", "reason": "x"}');
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('parse_failed');
  });

  it('handles JSON with nested braces inside string literals', () => {
    const stdout = '{"is_conflict": true, "reason": "see {nested} text"}';
    const result = extractJsonReply(stdout);
    expect(result.is_conflict).toBe(true);
    expect(result.reason).toBe('see {nested} text');
    expect(result.status).toBe('verified');
  });

  it('handles defaults when reason is absent', () => {
    const result = extractJsonReply('{"is_conflict": false}');
    expect(result.is_conflict).toBe(false);
    expect(result.reason).toBe('');
    expect(result.status).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// noopVerifier
// ---------------------------------------------------------------------------

describe('noopVerifier', () => {
  it('returns is_conflict=true with cli_missing status', async () => {
    const result = await noopVerifier(
      { id: 1, content: 'a', created_at: 'now' },
      { id: 2, content: 'b', created_at: 'now' },
    );
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('cli_missing');
    expect(result.reason).toContain('verifier disabled');
  });
});

// ---------------------------------------------------------------------------
// isClaudeCliAvailable
// ---------------------------------------------------------------------------

describe('isClaudeCliAvailable', () => {
  beforeEach(() => {
    resetClaudeCliProbeCache();
  });

  it('returns a boolean (no throw)', () => {
    const result = isClaudeCliAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('caches the probe result across calls', () => {
    const first = isClaudeCliAvailable();
    const second = isClaudeCliAvailable();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('renders both learnings with ids and content', () => {
    const prompt = buildPrompt(
      { id: 7, content: 'use React', created_at: '2026-01-01' },
      { id: 9, content: 'use SvelteKit', created_at: '2026-02-01' },
    );
    expect(prompt).toContain('id=7');
    expect(prompt).toContain('id=9');
    expect(prompt).toContain('use React');
    expect(prompt).toContain('use SvelteKit');
    expect(prompt).toContain('2026-01-01');
    expect(prompt).toContain('2026-02-01');
  });

  it('includes the JSON-only response instruction', () => {
    const prompt = buildPrompt(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(prompt).toContain('JSON object');
    expect(prompt).toContain('is_conflict');
  });
});

// ---------------------------------------------------------------------------
// makeClaudeHeadlessVerifier — using a deterministic stub command
// ---------------------------------------------------------------------------

describe('makeClaudeHeadlessVerifier', () => {
  it('returns parsed JSON when the subprocess emits a clean reply', async () => {
    // Use `node` as the stub command. We pass an `-e` script that ignores
    // stdin and prints a fixed JSON reply to stdout. This validates the
    // spawn/stdin/stdout/parse path without requiring `claude`.
    const verifier = makeClaudeHeadlessVerifier({
      command: 'node',
      args: ['-e', 'process.stdout.write(\'{"is_conflict": false, "reason": "stub"}\')'],
      timeoutMs: 5_000,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(false);
    expect(result.reason).toBe('stub');
    expect(result.status).toBe('verified');
  });

  it('returns spawn_failed status when the binary is missing', async () => {
    const verifier = makeClaudeHeadlessVerifier({
      command: '/nonexistent/binary/12345',
      args: [],
      timeoutMs: 5_000,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(true); // defensive default
    expect(result.status).toBe('spawn_failed');
  });

  it('returns spawn_failed status when the subprocess exits non-zero', async () => {
    const verifier = makeClaudeHeadlessVerifier({
      command: 'node',
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 5_000,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('spawn_failed');
  });

  it('returns parse_failed status when the subprocess emits garbage', async () => {
    const verifier = makeClaudeHeadlessVerifier({
      command: 'node',
      args: ['-e', 'process.stdout.write("not json at all")'],
      timeoutMs: 5_000,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('parse_failed');
  });

  it('returns timeout status when the subprocess hangs', async () => {
    // Spawn a node process that reads stdin and then sleeps forever.
    // Force a tight 200ms timeout so the test stays fast.
    const verifier = makeClaudeHeadlessVerifier({
      command: 'node',
      args: [
        '-e',
        // Read stdin, then enter a busy wait that ignores SIGTERM-receive
        // by NOT registering a handler — the default term will land
        // eventually, but the `setInterval` keeps the event loop alive
        // so the soft timer in the verifier can fire first.
        'process.stdin.on("data", () => {}); setInterval(() => {}, 1000);',
      ],
      timeoutMs: 200,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(true);
    expect(result.status).toBe('timeout');
  }, 10_000);

  it('handles fenced JSON output from the subprocess', async () => {
    const verifier = makeClaudeHeadlessVerifier({
      command: 'node',
      args: [
        '-e',
        'process.stdout.write(\'```json\\n{"is_conflict": true, "reason": "fenced"}\\n```\')',
      ],
      timeoutMs: 5_000,
    });
    const result = await verifier(
      { id: 1, content: 'a', created_at: 'x' },
      { id: 2, content: 'b', created_at: 'y' },
    );
    expect(result.is_conflict).toBe(true);
    expect(result.reason).toBe('fenced');
    expect(result.status).toBe('verified');
  });
});
