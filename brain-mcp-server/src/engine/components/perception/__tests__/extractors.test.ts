/**
 * Perception rule extractors — unit tests (FR-109 Phase 1).
 *
 * Per-extractor coverage:
 *   - learned_marker: single, multiple, markdown, false-positive guard
 *   - retry_chain: simple, drift-tolerant, multi-FAIL handling
 *   - blocker_resolution: simple pair, unresolved drop, multi-pair
 *   - error_fingerprint: stack trace, dedupe, prose-word guard
 *
 * @module engine/components/perception/__tests__/extractors.test
 */

import { describe, it, expect } from 'vitest';
import { extractLearnedMarkers } from '../extractors/learned_marker.js';
import { extractRetryChains } from '../extractors/retry_chain.js';
import { extractBlockerResolutions } from '../extractors/blocker_resolution.js';
import { extractErrorFingerprints, normalizeErrorSignature } from '../extractors/error_fingerprint.js';
import {
  transcriptWithSingleLearned,
  transcriptWithMultipleLearned,
  transcriptWithMarkdownLearned,
  transcriptWithFalsePositive,
  transcriptWithRetryChain,
  transcriptWithRetryChainAndDrift,
  transcriptWithFailWithoutFix,
  transcriptWithBlockerResolution,
  transcriptWithUnresolvedBlocker,
  transcriptWithMultipleBlockerResolutions,
  transcriptWithTypeErrorFingerprint,
  transcriptWithDuplicateErrors,
  transcriptWithErrorWord,
  transcriptMultiExtractor,
} from './fixtures/synthetic-transcripts.js';

// ---------------------------------------------------------------------------
// learned_marker
// ---------------------------------------------------------------------------

describe('extractLearnedMarkers', () => {
  it('extracts a single LEARNED line at confidence 0.85', () => {
    const out = extractLearnedMarkers(transcriptWithSingleLearned);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.85);
    expect(out[0].source_extractor).toBe('rule:learned_marker');
    expect(out[0].title).toContain('migrations');
    expect(out[0].category).toBe('discovery');
    expect(out[0].evidence.marker).toBe('LEARNED:');
  });

  it('extracts each LEARNED bullet from a multi-marker message', () => {
    const out = extractLearnedMarkers(transcriptWithMultipleLearned);
    expect(out.length).toBeGreaterThanOrEqual(3);
    const titles = out.map((c) => c.title);
    expect(titles.some((t) => t.includes('parametrised SQL'))).toBe(true);
    expect(titles.some((t) => t.includes('rowid'))).toBe(true);
    expect(titles.some((t) => t.includes('iterate'))).toBe(true);
  });

  it('matches LEARNED inside markdown bullet lists', () => {
    const out = extractLearnedMarkers(transcriptWithMarkdownLearned);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('perception runner');
  });

  it('does NOT match `we learned that` in prose', () => {
    const out = extractLearnedMarkers(transcriptWithFalsePositive);
    expect(out).toHaveLength(0);
  });

  it('returns [] for empty input', () => {
    expect(extractLearnedMarkers([])).toHaveLength(0);
  });

  it('handles events with no content gracefully', () => {
    const out = extractLearnedMarkers([{ role: 'user', content: '', timestamp: '' }]);
    expect(out).toHaveLength(0);
  });

  it('caps title length at 120 chars', () => {
    const longBody = 'A'.repeat(500);
    const events = [{ role: 'assistant', content: `LEARNED: ${longBody}`, timestamp: '' }];
    const out = extractLearnedMarkers(events);
    expect(out[0].title.length).toBeLessThanOrEqual(120);
  });

  it('tags candidates with `learned` and `rule-extracted`', () => {
    const out = extractLearnedMarkers(transcriptWithSingleLearned);
    expect(out[0].tags).toContain('learned');
    expect(out[0].tags).toContain('rule-extracted');
  });
});

// ---------------------------------------------------------------------------
// retry_chain
// ---------------------------------------------------------------------------

describe('extractRetryChains', () => {
  it('captures a simple sentinel-FAIL → forger-fix → sentinel-PASS chain', () => {
    const out = extractRetryChains(transcriptWithRetryChain);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.6);
    expect(out[0].source_extractor).toBe('rule:retry_chain');
    expect(out[0].category).toBe('mistake');
    expect(out[0].content).toContain('Failure cue');
    expect(out[0].content).toContain('Resolution applied');
    // Subject extraction should pull `handleMemoryRecall` from the backticks.
    expect(out[0].title).toContain('handleMemoryRecall');
  });

  it('tolerates intervening events between fix and PASS', () => {
    const out = extractRetryChains(transcriptWithRetryChainAndDrift);
    expect(out).toHaveLength(1);
  });

  it('does NOT emit when a fix is missing between FAIL and PASS', () => {
    const out = extractRetryChains(transcriptWithFailWithoutFix);
    // first FAIL never reaches a fix; second FAIL has fix+PASS.
    expect(out).toHaveLength(1);
    expect(out[0].evidence.fail_excerpt).toContain('different failure');
  });

  it('returns [] for empty input', () => {
    expect(extractRetryChains([])).toHaveLength(0);
  });

  it('returns [] when transcript contains only PASS events', () => {
    const events = [
      { role: 'sentinel', content: 'verdict: PASS', timestamp: '' },
      { role: 'sentinel', content: 'verdict: PASS', timestamp: '' },
    ];
    expect(extractRetryChains(events)).toHaveLength(0);
  });

  it('falls back to generic subject when no anchor is available', () => {
    const events = [
      { role: 'sentinel', content: 'verdict: FAIL — something is broken', timestamp: '' },
      { role: 'forger', content: 'fixing...', timestamp: '' },
      { role: 'sentinel', content: 'verdict: PASS', timestamp: '' },
    ];
    const out = extractRetryChains(events);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('sentinel failure');
  });
});

// ---------------------------------------------------------------------------
// blocker_resolution
// ---------------------------------------------------------------------------

describe('extractBlockerResolutions', () => {
  it('captures a simple BLOCKER → RESOLUTION pair', () => {
    const out = extractBlockerResolutions(transcriptWithBlockerResolution);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.7);
    expect(out[0].source_extractor).toBe('rule:blocker_resolution');
    expect(out[0].category).toBe('discovery');
    expect(out[0].content).toContain('Blocker:');
    expect(out[0].content).toContain('Resolution:');
    expect(out[0].title).toContain('Resolved');
  });

  it('drops unmatched BLOCKER (no RESOLUTION) silently', () => {
    const out = extractBlockerResolutions(transcriptWithUnresolvedBlocker);
    expect(out).toHaveLength(0);
  });

  it('pairs multiple BLOCKER/RESOLUTION marks by recency', () => {
    const out = extractBlockerResolutions(transcriptWithMultipleBlockerResolutions);
    expect(out).toHaveLength(2);
    // Verify each candidate has paired blocker/resolution text in evidence.
    const evidence = out.map((c) => c.evidence as Record<string, unknown>);
    expect(evidence.every((e) => typeof e.blocker_text === 'string' && typeof e.resolution_text === 'string')).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(extractBlockerResolutions([])).toHaveLength(0);
  });

  it('does NOT match the word `blocker` inside running prose', () => {
    const events = [
      {
        role: 'user',
        content: 'we hit a blocker but it is unrelated to anything you can fix',
        timestamp: '',
      },
    ];
    expect(extractBlockerResolutions(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error_fingerprint
// ---------------------------------------------------------------------------

describe('extractErrorFingerprints', () => {
  it('captures a TypeError with stack frames', () => {
    const out = extractErrorFingerprints(transcriptWithTypeErrorFingerprint);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.75);
    expect(out[0].source_extractor).toBe('rule:error_fingerprint');
    expect(out[0].category).toBe('mistake');
    expect(out[0].title).toContain('TypeError');
    const frames = out[0].evidence.frames as string[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.includes('vector-search.ts'))).toBe(true);
  });

  it('dedupes identical error signatures within a single run', () => {
    const out = extractErrorFingerprints(transcriptWithDuplicateErrors);
    expect(out).toHaveLength(1);
  });

  it('does NOT match the word `error` in plain prose', () => {
    const out = extractErrorFingerprints(transcriptWithErrorWord);
    expect(out).toHaveLength(0);
  });

  it('returns [] for empty input', () => {
    expect(extractErrorFingerprints([])).toHaveLength(0);
  });

  it('captures multiple distinct errors in the same window', () => {
    const events = [
      { role: 'tool', content: 'TypeError: x is undefined at foo.ts:1:1', timestamp: '' },
      { role: 'tool', content: 'ReferenceError: y is not defined at bar.ts:2:2', timestamp: '' },
    ];
    const out = extractErrorFingerprints(events);
    expect(out).toHaveLength(2);
  });
});

describe('normalizeErrorSignature', () => {
  it('drops line:column numbers', () => {
    const sig = normalizeErrorSignature("at foo (bar.ts:42:7) at baz (qux.ts:101:3)");
    expect(sig).not.toContain('42:7');
    expect(sig).not.toContain('101:3');
    expect(sig).toContain('N');
  });

  it('drops hex addresses', () => {
    const sig = normalizeErrorSignature("crash at 0xdeadbeef and 0x1234");
    expect(sig).not.toContain('0xdeadbeef');
    expect(sig).toContain('0xN');
  });

  it('drops UUIDs', () => {
    const sig = normalizeErrorSignature("session 550e8400-e29b-41d4-a716-446655440000 errored");
    expect(sig).not.toContain('550e8400');
    expect(sig).toContain('UUID');
  });

  it('drops timestamps', () => {
    const sig = normalizeErrorSignature("at 2026-04-29T10:00:00Z something failed");
    expect(sig).not.toContain('2026-04-29');
    expect(sig).toContain('TIMESTAMP');
  });

  it('produces stable signature across line-number drift', () => {
    const a = normalizeErrorSignature('at foo.ts:42:7');
    const b = normalizeErrorSignature('at foo.ts:99:1');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-extractor against one transcript
// ---------------------------------------------------------------------------

describe('rule extractors — combined run', () => {
  it('produces candidates from all four extractors against transcriptMultiExtractor', () => {
    const learned = extractLearnedMarkers(transcriptMultiExtractor);
    const retry = extractRetryChains(transcriptMultiExtractor);
    const blockers = extractBlockerResolutions(transcriptMultiExtractor);
    const errors = extractErrorFingerprints(transcriptMultiExtractor);

    expect(learned.length).toBeGreaterThanOrEqual(1);
    expect(retry.length).toBeGreaterThanOrEqual(1);
    expect(blockers.length).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const all = [...learned, ...retry, ...blockers, ...errors];
    const sources = new Set(all.map((c) => c.source_extractor));
    expect(sources.size).toBeGreaterThanOrEqual(4);
  });
});
