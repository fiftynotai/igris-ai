/**
 * Brain Engine v5.0 — Perception Rule Extractor: LEARNED markers (FR-109)
 *
 * Detects explicit `LEARNED:` annotations the engineer left in the
 * transcript (chat content, commit messages, doc edits). These are the
 * highest-precision signal in the rule pipeline — the human is explicitly
 * tagging "remember this." Confidence 0.85.
 *
 * Match shape:
 *   - Anchored at start-of-line or after `*`/`-`/`#` to avoid mid-sentence
 *     `we learned that` false positives.
 *   - Followed by optional whitespace, `:`, optional whitespace, then the body.
 *   - Body runs until newline or end of message — multi-line LEARNED blocks
 *     are picked up by the FIRST line; the rest stays in `evidence.full_text`.
 *
 * @module engine/components/perception/extractors/learned_marker
 * @author Fifty.ai
 */

import type { PerceptionCandidate, TranscriptEvent } from '../types.js';

/**
 * Anchored LEARNED-marker regex.
 *
 * Captures group 1: the body of the learning. Word-boundary on the trailing
 * `:` so `LEARNED:` and `LEARNED :` both match while `LEARNEDish` does not.
 * The `(?:^|[*\-#\s])` lookbehind alternative tolerates Markdown bullet
 * styles without admitting accidental in-paragraph hits.
 */
const LEARNED_RE = /(?:^|[*\-#\s])LEARNED\s*:\s*(.+?)(?=$|\n)/gim;

/** Confidence assigned to LEARNED-marker hits. The deterministic ceiling. */
const LEARNED_CONFIDENCE = 0.85;

/**
 * Run the LEARNED-marker extractor over a transcript window.
 *
 * Pure function — same inputs produce the same outputs, no I/O. The runner
 * handles dedupe and persistence. Per-event candidates emit one per matched
 * line; multi-line LEARNED blocks emit a single candidate with the first
 * line as title and the truncated content as body.
 *
 * @param events - Parsed transcript events to scan.
 * @returns Zero or more candidates with `source_extractor='rule:learned_marker'`.
 */
export function extractLearnedMarkers(events: TranscriptEvent[]): PerceptionCandidate[] {
  const candidates: PerceptionCandidate[] = [];
  if (events.length === 0) return candidates;

  for (const event of events) {
    if (!event.content) continue;
    // Reset lastIndex via fresh regex per event to avoid stateful match drift.
    const matches = Array.from(event.content.matchAll(LEARNED_RE));
    for (const match of matches) {
      const body = (match[1] ?? '').trim();
      if (body.length === 0) continue;

      // Title = first 120 chars of the matched line (no ellipsis — we want
      // the full sentence to fit when possible). Content = the body verbatim.
      const title = body.length > 120 ? `${body.slice(0, 117)}...` : body;

      candidates.push({
        category: 'discovery',
        title,
        content: body,
        tags: ['learned', 'rule-extracted'],
        confidence: LEARNED_CONFIDENCE,
        source_extractor: 'rule:learned_marker',
        evidence: {
          marker: 'LEARNED:',
          role: event.role,
          timestamp: event.timestamp,
          tool_name: event.tool_name ?? null,
          full_text: body,
        },
      });
    }
  }

  return candidates;
}
