/**
 * Brain Engine v5.0 — Perception Rule Extractor: Blocker Resolution (FR-109)
 *
 * Detects "we hit X, fixed it by Y" patterns by scanning for blocker
 * declarations followed by a corresponding resolution within the same
 * transcript window. Captures the resolution as a learning so future
 * sessions can find "how we got past this when we hit it before."
 *
 * Confidence 0.7 — pattern is structurally clear (BLOCKER → resolution)
 * but the resolution narrative quality varies, so it sits below LEARNED's
 * 0.85.
 *
 * @module engine/components/perception/extractors/blocker_resolution
 * @author Fifty.ai
 */

import type { PerceptionCandidate, TranscriptEvent } from '../types.js';

const BLOCKER_CONFIDENCE = 0.7;

/**
 * Anchored blocker markers. Position-aware so `BLOCKED:` at the start of
 * a line beats a stray "blocked" mid-sentence. Matches Markdown bullet
 * styles seen in BLOCKERS.md and chat status updates.
 */
const BLOCKER_RE =
  /(?:^|[*\-#\s])(?:BLOCKER|BLOCKED(?:\s+BY)?|BLOCKING\s+ISSUE|BLOCKED)\s*:\s*(.+?)(?=$|\n)/gim;

/**
 * Anchored resolution markers. Same anchoring rules. Both UNBLOCKED and
 * RESOLVED form because both appear in the wild.
 */
const RESOLUTION_RE =
  /(?:^|[*\-#\s])(?:UNBLOCKED|RESOLVED|FIXED|UNBLOCK|RESOLUTION)\s*:\s*(.+?)(?=$|\n)/gim;

/**
 * Run the blocker-resolution extractor.
 *
 * Approach: collect all BLOCKER lines and all RESOLUTION lines in the
 * window (with their event indices), then pair them by proximity — each
 * resolution is paired with the most-recent unpaired blocker. Unmatched
 * blockers/resolutions are dropped (no candidate emitted) — a lone
 * "BLOCKER:" without resolution is not actionable as a learning.
 *
 * Pure function — same input produces same output, no I/O.
 *
 * @param events - Parsed transcript events to scan.
 * @returns Zero or more candidates with `source_extractor='rule:blocker_resolution'`.
 */
export function extractBlockerResolutions(events: TranscriptEvent[]): PerceptionCandidate[] {
  const candidates: PerceptionCandidate[] = [];
  if (events.length === 0) return candidates;

  interface Marker {
    eventIndex: number;
    body: string;
    event: TranscriptEvent;
  }

  const blockers: Marker[] = [];
  const resolutions: Marker[] = [];

  events.forEach((event, eventIndex) => {
    if (!event.content) return;
    const blockerMatches = Array.from(event.content.matchAll(BLOCKER_RE));
    for (const m of blockerMatches) {
      const body = (m[1] ?? '').trim();
      if (body.length === 0) continue;
      blockers.push({ eventIndex, body, event });
    }
    const resolutionMatches = Array.from(event.content.matchAll(RESOLUTION_RE));
    for (const m of resolutionMatches) {
      const body = (m[1] ?? '').trim();
      if (body.length === 0) continue;
      resolutions.push({ eventIndex, body, event });
    }
  });

  if (blockers.length === 0 || resolutions.length === 0) return candidates;

  // Pair each resolution with the most-recent unpaired blocker that came BEFORE it.
  // O(N+M) two-pointer over already-sorted arrays (events were iterated in order).
  const paired = new Set<number>(); // blocker indices already consumed
  for (const resolution of resolutions) {
    let matchIndex = -1;
    for (let i = blockers.length - 1; i >= 0; i--) {
      if (paired.has(i)) continue;
      if (blockers[i].eventIndex <= resolution.eventIndex) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) continue;
    paired.add(matchIndex);
    candidates.push(buildCandidate(blockers[matchIndex], resolution));
  }

  return candidates;
}

function buildCandidate(
  blocker: { body: string; event: TranscriptEvent },
  resolution: { body: string; event: TranscriptEvent },
): PerceptionCandidate {
  const titleSubject = blocker.body.length > 80 ? `${blocker.body.slice(0, 77)}...` : blocker.body;
  const title = `Resolved: ${titleSubject}`.slice(0, 120);

  return {
    category: 'discovery',
    title,
    content: [
      'Blocker:',
      blocker.body,
      '',
      'Resolution:',
      resolution.body,
    ].join('\n'),
    tags: ['blocker-resolution', 'rule-extracted'],
    confidence: BLOCKER_CONFIDENCE,
    source_extractor: 'rule:blocker_resolution',
    evidence: {
      pattern: 'blocker_resolution_pair',
      blocker_role: blocker.event.role,
      resolution_role: resolution.event.role,
      blocker_timestamp: blocker.event.timestamp,
      resolution_timestamp: resolution.event.timestamp,
      blocker_text: blocker.body,
      resolution_text: resolution.body,
    },
  };
}
