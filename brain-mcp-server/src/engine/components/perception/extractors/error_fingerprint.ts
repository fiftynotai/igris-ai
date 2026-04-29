/**
 * Brain Engine v5.0 — Perception Rule Extractor: Error Fingerprint (FR-109)
 *
 * Captures novel error fingerprints — stack-trace-flavored or stderr-flavored
 * lines that look like real failures the engineer worked through. Each
 * fingerprint is normalized to a stable signature (drop line numbers,
 * timestamps, hex addresses) so the same error across runs collapses to
 * one candidate.
 *
 * Confidence 0.75 — between blocker_resolution (0.7) and LEARNED (0.85).
 * Stack traces are concrete and reusable; one-line error strings are still
 * informative even without explicit human annotation.
 *
 * @module engine/components/perception/extractors/error_fingerprint
 * @author Fifty.ai
 */

import type { PerceptionCandidate, TranscriptEvent } from '../types.js';

const ERROR_CONFIDENCE = 0.75;

/**
 * Match a typical error line. Anchored on common exception/error markers
 * so general "error" text in prose doesn't trigger.
 */
const ERROR_LINE_RE =
  /(?:^|\n)\s*((?:[A-Z][a-zA-Z]*Error|Exception|Traceback|TypeError|ReferenceError|SyntaxError|ValueError|RuntimeError|AttributeError|KeyError|IndexError|panic|fatal\s+error|fatal:)[^\n]{0,500})/g;

/**
 * Stack-frame heuristic: file:line:column pointers like `at foo (bar.ts:42:7)`
 * or Python-style `File "x.py", line 42, in y`. We capture the first 3 frames
 * after an error line for additional context.
 */
const STACK_FRAME_RE =
  /(?:\s+at\s+[^\n]{1,200})|(?:File\s+"[^"]{1,200}",\s+line\s+\d+(?:,\s+in\s+[^\n]{1,80})?)/g;

/**
 * Normalize an error line into a stable signature. Drops:
 *   - line:column pointers ("foo.ts:42:7" → "foo.ts:N:N")
 *   - hex addresses (0xdeadbeef → 0xN)
 *   - generated UUIDs and timestamps
 *   - paths leading up to the basename of common source files
 *
 * Two events with the same logical error produce the same signature even
 * if the stack frame numbers shift.
 */
export function normalizeErrorSignature(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, 'TIMESTAMP')
    .replace(/0x[0-9a-fA-F]+/g, '0xN')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Run the error-fingerprint extractor.
 *
 * Pure function. Per-run dedupe by signature (only the FIRST hit per
 * signature in the window emits a candidate) so a flaky test that throws
 * the same error 50 times produces ONE pending learning, not 50.
 *
 * @param events - Parsed transcript events to scan.
 * @returns Zero or more candidates with `source_extractor='rule:error_fingerprint'`.
 */
export function extractErrorFingerprints(events: TranscriptEvent[]): PerceptionCandidate[] {
  const candidates: PerceptionCandidate[] = [];
  if (events.length === 0) return candidates;

  const seenSignatures = new Set<string>();

  for (const event of events) {
    if (!event.content) continue;
    const errorMatches = Array.from(event.content.matchAll(ERROR_LINE_RE));
    if (errorMatches.length === 0) continue;

    for (const match of errorMatches) {
      const errorLine = (match[1] ?? '').trim();
      if (errorLine.length === 0) continue;

      const signature = normalizeErrorSignature(errorLine);
      if (signature.length === 0) continue;
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      // Capture the next ~3 stack frames after this error line for context.
      const tailStart = (match.index ?? 0) + (match[0]?.length ?? 0);
      const tail = event.content.slice(tailStart, tailStart + 1500);
      const frameMatches = Array.from(tail.matchAll(STACK_FRAME_RE)).slice(0, 3);
      const frames = frameMatches.map((f) => f[0]?.trim() ?? '').filter(Boolean);

      const titleBase = errorLine.length > 110 ? `${errorLine.slice(0, 107)}...` : errorLine;
      const title = `Error fingerprint: ${titleBase}`.slice(0, 120);

      const contentLines: string[] = [`Error: ${errorLine}`];
      if (frames.length > 0) {
        contentLines.push('', 'Stack frames:');
        contentLines.push(...frames.map((f) => `  ${f}`));
      }

      candidates.push({
        category: 'mistake',
        title,
        content: contentLines.join('\n'),
        tags: ['error-fingerprint', 'rule-extracted'],
        confidence: ERROR_CONFIDENCE,
        source_extractor: 'rule:error_fingerprint',
        evidence: {
          pattern: 'error_fingerprint',
          signature,
          role: event.role,
          timestamp: event.timestamp,
          tool_name: event.tool_name ?? null,
          frames,
        },
      });
    }
  }

  return candidates;
}
