/**
 * FR-188 — Safe handler invocation.
 *
 * The shipped read handlers are NOT uniformly defensive: `handleMemoryRecall`
 * wraps its FTS5 MATCH in a try/catch and falls back to the vector channel,
 * but `handleMemorySearch` / `handleMemoryHybridSearch` let an FTS5 syntax
 * error propagate (e.g. a query containing a literal `?`, which
 * `sanitizeFts5Query` does not strip). The eval must not crash on that — and,
 * more usefully, it should RECORD the throw as a first-class outcome, because a
 * channel that throws on ordinary punctuation is itself an eval finding.
 *
 * @module eval/memory/invoke
 */

import { envelopeText } from './parse.js';

export interface SafeCall {
  text: string;
  errored: boolean;
  error?: string;
}

type Envelope = { content: { type: string; text: string }[] };

/** Invoke a (sync or async) handler, capturing a throw instead of propagating it. */
export async function safeInvoke(fn: () => Envelope | Promise<Envelope>): Promise<SafeCall> {
  try {
    const res = await fn();
    return { text: envelopeText(res), errored: false };
  } catch (e) {
    return { text: '', errored: true, error: e instanceof Error ? e.message : String(e) };
  }
}
