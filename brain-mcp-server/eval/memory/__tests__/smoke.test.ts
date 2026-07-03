/**
 * FR-188 — Eval suite smoke + parser unit tests.
 *
 * Two layers:
 *  1. Pure parser unit tests (fast) — parseRankedIds / parseNoAnswer against
 *     fixed envelope samples incl. the Promoted/no-Content recall variant and
 *     each no-answer sentinel.
 *  2. Child-process micro-run — spawns run.ts on a 5-row corpus in a fresh node
 *     process (fresh getDb singleton). Asserts the one-command path produces a
 *     well-formed scorecard, the gate leaks zero pending ids, and the deferred
 *     markers are present. Bounded corpus ⇒ bounded embedding cost for CI.
 *
 * @module eval/memory/__tests__/smoke
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRankedIds, parseNoAnswer, envelopeText } from '../src/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(__dirname, '..'); // eval/memory
const brainRoot = path.resolve(evalRoot, '..', '..'); // brain-mcp-server
const tsxBin = path.join(brainRoot, 'node_modules', '.bin', 'tsx');
const runPath = path.join(evalRoot, 'src', 'run.ts');

// ---------------------------------------------------------------------------
// 1. Parser unit tests (pure, fast)
// ---------------------------------------------------------------------------

describe('parseRankedIds', () => {
  it('extracts ids from a recall envelope in rank order', () => {
    const text = [
      'Recalled 2 relevant learning(s) for "aurora-mobile" (hybrid, use igris_memory_get for full content):',
      '',
      '--- Recall 1 ---',
      'ID: 7',
      'Project: aurora-mobile',
      'Title: A',
      'Content: something',
      '',
      '--- Recall 2 ---',
      'ID: 3',
      'Project: aurora-mobile',
      'Title: B',
      'Content: other',
    ].join('\n');
    expect(parseRankedIds(text)).toEqual([7, 3]);
  });

  it('handles the Promoted (no Content line) recall variant', () => {
    const text = [
      'Recalled 1 relevant learning(s) for "x" (hybrid, use igris_memory_get for full content):',
      '',
      '--- Recall 1 ---',
      'ID: 42',
      'Project: x',
      'Title: Promoted one',
      'Promoted: → context/coding_guidelines.md (this standard now lives in the doc; see it there)',
      'Tags: (none)',
    ].join('\n');
    expect(parseRankedIds(text)).toEqual([42]);
  });

  it('returns [] for a no-answer envelope', () => {
    expect(parseRankedIds('No relevant learnings found for project "x" with context "y".')).toEqual([]);
  });
});

describe('parseNoAnswer', () => {
  it('detects the recall sentinel', () => {
    expect(parseNoAnswer('No relevant learnings found for project "x" with context "y".')).toBe(true);
  });
  it('detects the search/hybrid sentinel', () => {
    expect(parseNoAnswer('No learnings found matching "kubernetes".')).toBe(true);
    expect(parseNoAnswer('No learnings found matching the query.')).toBe(true);
  });
  it('is false when results are present', () => {
    expect(parseNoAnswer('Found 3 learning(s) matching "x":\n\n--- Result 1 ---\nID: 1')).toBe(false);
    expect(parseNoAnswer('Recalled 1 relevant learning(s) for "x"')).toBe(false);
  });
});

describe('envelopeText', () => {
  it('joins content text blocks', () => {
    expect(envelopeText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  });
});

// ---------------------------------------------------------------------------
// 2. Child-process micro-run
// ---------------------------------------------------------------------------

function writeMicroFixtures(dir: string): {
  corpus: string; queryset: string; noAnswer: string; gating: string; promotion: string;
} {
  const corpus = path.join(dir, 'corpus.json');
  const queryset = path.join(dir, 'queryset.jsonl');
  const noAnswer = path.join(dir, 'no_answer.jsonl');
  const gating = path.join(dir, 'gating.json');
  const promotion = path.join(dir, 'promotion.json');

  fs.writeFileSync(corpus, JSON.stringify([
    { key: 'M-01', project: 'aurora-mobile', category: 'pattern', title: 'Debounce the dashboard refresh', content: 'Collapse a burst of refresh intents into a single fetch with a trailing timer so tab flicking does not hammer the endpoint.' },
    { key: 'M-02', project: 'nimbus-api', category: 'pattern', title: 'Reject bad bodies at the boundary', content: 'Untrusted request payloads are parsed into typed shapes at the first handler and anything failing the contract is refused before business logic runs.' },
    { key: 'M-03', project: 'aurora-mobile', category: 'pattern', title: 'Replay card tokenization with backoff', content: 'Transient gateway timeouts during card enrollment clear when the call is replayed with randomized spacing capped at five attempts.', review_status: 'pending_review', source_extractor: 'llm' },
    { key: 'M-P1', project: 'aurora-mobile', category: 'pattern', title: 'Validate configuration on startup', content: 'Read every required setting once when the process boots and fail loudly if anything is missing so a bad deploy dies immediately.' },
    { key: 'M-P2', project: 'nimbus-api', category: 'pattern', title: 'Validate configuration on startup', content: 'Read every required setting once when the process boots and fail loudly if anything is missing so a bad deploy dies immediately here.' },
  ]));

  fs.writeFileSync(queryset, [
    JSON.stringify({ qid: 'Q1', project: 'aurora-mobile', query: 'How do we stop the home screen from spamming the server on rapid tab changes?', target_keys: ['M-01'], sibling_keys: [], author: 'smoke' }),
    JSON.stringify({ qid: 'Q2', project: 'nimbus-api', query: 'Where do we refuse malformed request input before real work runs?', target_keys: ['M-02'], sibling_keys: [], author: 'smoke' }),
  ].join('\n'));

  fs.writeFileSync(noAnswer, JSON.stringify({ qid: 'N1', project: 'aurora-mobile', query: 'How do we breed koi carp in an outdoor pond over winter?' }) + '\n');

  fs.writeFileSync(gating, JSON.stringify({ cases: [
    { key: 'M-03', project: 'aurora-mobile', query: 'How do we recover from a card enrollment timeout at the gateway?' },
  ] }));

  fs.writeFileSync(promotion, JSON.stringify({ cases: [
    { id: 'true_dup', keys: ['M-P1', 'M-P2'], title: 'Validate configuration on startup', expect: 'promote' },
  ] }));

  return { corpus, queryset, noAnswer, gating, promotion };
}

describe('run.ts micro-run', () => {
  it('produces a well-formed scorecard with all MVP dims, zero gate leaks, and deferred markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igris_eval_smoke_'));
    const fx = writeMicroFixtures(dir);
    const outJson = path.join(dir, 'scorecard.json');

    execFileSync(tsxBin, [
      runPath,
      '--corpus', fx.corpus,
      '--queryset', fx.queryset,
      '--no-answer', fx.noAnswer,
      '--gating', fx.gating,
      '--promotion', fx.promotion,
      '--out', outJson,
      '--k', '10',
    ], { cwd: brainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const s = JSON.parse(fs.readFileSync(outJson, 'utf8'));

    // All MVP dimensions present.
    expect(s.dimensions.recall).toBeDefined();
    expect(s.dimensions.no_answer).toBeDefined();
    expect(s.dimensions.gating).toBeDefined();
    expect(s.dimensions.promotion).toBeDefined();

    // Structure sanity.
    expect(s.dimensions.recall.n).toBe(2);
    expect(s.headline).toHaveProperty('blind_low_band_hit_at_5');
    expect(typeof s.vector_channel).toBe('boolean');

    // The gate must leak nothing (pending M-03 never surfaces).
    expect(s.dimensions.gating.leaked_count).toBe(0);
    expect(s.dimensions.gating.get_returns_all).toBe(true);

    // Deferred markers present (no silent scope-cut).
    const deferredDims = s.deferred.map((d: { dimension: string }) => d.dimension);
    expect(deferredDims).toContain('4-affinity-boost-ab');
    expect(deferredDims).toContain('5-dedup-correctness');
    expect(deferredDims).toContain('8-staleness');

    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});
