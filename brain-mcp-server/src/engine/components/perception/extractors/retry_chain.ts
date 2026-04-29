/**
 * Brain Engine v5.0 — Perception Rule Extractor: Retry Chain (FR-109)
 *
 * Detects sequences where a sentinel role rejected work (FAIL / RED /
 * "tests failed" / etc.) and a subsequent forger turn applied a fix that
 * was then accepted. The body of the fix is captured as a learning — these
 * are the "what we got wrong the first time" patterns most worth surfacing.
 *
 * Confidence 0.6 — lower than LEARNED (no human annotation) but still useful
 * because the FAIL→PASS shape is structurally evidence of a real fix.
 *
 * @module engine/components/perception/extractors/retry_chain
 * @author Fifty.ai
 */

import type { PerceptionCandidate, TranscriptEvent } from '../types.js';

/** Confidence for a successfully-paired FAIL → fix → PASS chain. */
const RETRY_CONFIDENCE = 0.6;

/**
 * Anchored failure markers from sentinel/test output. Order independent —
 * `match.toLowerCase()` is the equality check.
 */
const FAILURE_MARKERS = [
  'fail',
  'failed',
  'failing',
  'red',
  'error',
  'tests failed',
  'lint failed',
  'sentinel: fail',
  'verdict: fail',
  'verdict: red',
];

/** Markers that confirm a fix landed. Same matching rules. */
const SUCCESS_MARKERS = [
  'pass',
  'passed',
  'passing',
  'green',
  'tests passed',
  'lint passed',
  'sentinel: pass',
  'verdict: pass',
  'verdict: green',
  'all tests pass',
];

function eventMentions(event: TranscriptEvent, markers: readonly string[]): boolean {
  if (!event.content) return false;
  const lc = event.content.toLowerCase();
  return markers.some((m) => lc.includes(m));
}

function isSentinelLike(event: TranscriptEvent): boolean {
  // Treat 'tool', 'sentinel', 'system' roles as oracles. Also recognize
  // assistant turns whose content explicitly self-identifies as sentinel.
  const role = (event.role ?? '').toLowerCase();
  if (role === 'sentinel' || role === 'tool' || role === 'system') return true;
  return /sentinel\s*:|verdict\s*:/i.test(event.content ?? '');
}

function isForgerLike(event: TranscriptEvent): boolean {
  const role = (event.role ?? '').toLowerCase();
  if (role === 'forger' || role === 'assistant') return true;
  return /forger\s*:/i.test(event.content ?? '');
}

/**
 * Walk the transcript looking for the [sentinel-FAIL] → [forger-fix] →
 * [sentinel-PASS] triple. State machine:
 *
 *   IDLE        -> on FAIL emit, advance to AWAIT_FIX storing fail event
 *   AWAIT_FIX   -> on forger turn, advance to AWAIT_PASS storing fix event
 *                  (other events stay in AWAIT_FIX)
 *   AWAIT_PASS  -> on PASS emit, finalize candidate, return to IDLE
 *                  on another FAIL, replace fail event, return to AWAIT_FIX
 *
 * We allow at most 8 intervening events between fix and pass before resetting,
 * because the conversation drifts into unrelated work otherwise.
 *
 * @param events - Parsed transcript events to scan.
 * @returns Zero or more candidates with `source_extractor='rule:retry_chain'`.
 */
export function extractRetryChains(events: TranscriptEvent[]): PerceptionCandidate[] {
  const candidates: PerceptionCandidate[] = [];
  if (events.length === 0) return candidates;

  type State =
    | { kind: 'IDLE' }
    | { kind: 'AWAIT_FIX'; fail: TranscriptEvent }
    | { kind: 'AWAIT_PASS'; fail: TranscriptEvent; fix: TranscriptEvent; eventsSinceFix: number };

  let state: State = { kind: 'IDLE' };
  const MAX_DRIFT = 8;

  for (const event of events) {
    const isFail = isSentinelLike(event) && eventMentions(event, FAILURE_MARKERS);
    const isPass = isSentinelLike(event) && eventMentions(event, SUCCESS_MARKERS);
    const isFix = isForgerLike(event) && !isFail && !isPass;

    if (state.kind === 'IDLE') {
      if (isFail) state = { kind: 'AWAIT_FIX', fail: event };
      continue;
    }

    if (state.kind === 'AWAIT_FIX') {
      if (isFix) {
        state = { kind: 'AWAIT_PASS', fail: state.fail, fix: event, eventsSinceFix: 0 };
      } else if (isFail) {
        // Re-rooting on a fresher fail keeps the chain pointed at the latest
        // problem — older unfixed fails are dropped silently.
        state = { kind: 'AWAIT_FIX', fail: event };
      }
      continue;
    }

    // state.kind === 'AWAIT_PASS'
    if (isPass) {
      candidates.push(buildCandidate(state.fail, state.fix));
      state = { kind: 'IDLE' };
      continue;
    }
    if (isFail) {
      state = { kind: 'AWAIT_FIX', fail: event };
      continue;
    }
    state.eventsSinceFix += 1;
    if (state.eventsSinceFix > MAX_DRIFT) {
      state = { kind: 'IDLE' };
    }
  }

  return candidates;
}

function buildCandidate(fail: TranscriptEvent, fix: TranscriptEvent): PerceptionCandidate {
  const failExcerpt = (fail.content ?? '').slice(0, 200).trim();
  const fixExcerpt = (fix.content ?? '').slice(0, 1500).trim();

  // Title: short, action-oriented summary built from the failure cue.
  // We try to surface a concrete subject (test name, file name) but fall
  // back to a generic "Fix applied after sentinel failure" if no anchor
  // is available.
  const subject = extractSubject(failExcerpt) ?? 'sentinel failure';
  const title = `Fix applied after ${subject}`.slice(0, 120);

  return {
    category: 'mistake',
    title,
    content: [
      `Failure cue: ${failExcerpt}`,
      '',
      'Resolution applied:',
      fixExcerpt,
    ].join('\n'),
    tags: ['retry-chain', 'rule-extracted'],
    confidence: RETRY_CONFIDENCE,
    source_extractor: 'rule:retry_chain',
    evidence: {
      pattern: 'sentinel_fail_to_pass',
      fail_role: fail.role,
      fix_role: fix.role,
      fail_timestamp: fail.timestamp,
      fix_timestamp: fix.timestamp,
      fail_excerpt: failExcerpt,
      fix_excerpt: fixExcerpt,
    },
  };
}

/**
 * Try to pull a concrete subject from the failure cue: a quoted test name,
 * a backticked symbol, a file path, or a similar anchor. Returns null when
 * no clean anchor exists so the caller can fall back to a generic phrase.
 */
function extractSubject(failText: string): string | null {
  // Backticked identifier (e.g. ``handleMemoryRecall``).
  const backticked = failText.match(/`([^`\n]{2,80})`/);
  if (backticked) return backticked[1];
  // Quoted test name (e.g. "should ratify clean reply").
  const quoted = failText.match(/"([^"\n]{2,80})"/);
  if (quoted) return quoted[1];
  // File path with extension (.ts, .tsx, .py, .md, .sh, .yml, .json).
  const filePath = failText.match(/[\w./_-]+\.(ts|tsx|js|mjs|cjs|py|md|sh|yml|yaml|json)/);
  if (filePath) return filePath[0];
  return null;
}
