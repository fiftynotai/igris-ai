/**
 * TD-468 — `extractParentBriefId` admits a LETTERED parent.
 *
 * The `Parent:` matcher captured `[A-Z]{2,3}-\d+`, which stops at the digits:
 * `**Parent:** FR-110c (...)` yielded `FR-110` and the edges component wrote a
 * `parent_of` edge to the wrong brief. Measured 2026-09-14 on the brain: seven
 * brief files in two projects name a lettered parent (fifty-dev FR-115,
 * FR-112a/b/c, TD-008, FR-114; mbrgea-ai TD-152). The widened capture is
 * `([A-Z]{2,3}-\d+[a-z]?)\b` — one optional lowercase letter, then a word
 * boundary so a longer suffix is REFUSED whole rather than truncated.
 *
 * Mocks copied from ac-gate-note.test.ts: importing tools/briefs.js pulls in
 * db.js and the vector layer; neither may reach the operator's home here.
 *
 * @module tools/__tests__/extract-parent-brief-id
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbeddingInto: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { extractParentBriefId } from '../briefs.js';

describe('extractParentBriefId — lettered parents (TD-468)', () => {
  it('the REAL fifty-dev FR-115 line -> FR-110c, not FR-110 (RED at HEAD)', () => {
    // brief_files fifty-dev/FR-115, line 8, verbatim.
    const line =
      '- **Parent:** FR-110c (StatusPill primitive), FR-112a (lifecycleState data shape), FR-114 (card themes)';
    expect(extractParentBriefId(line)).toBe('FR-110c');
  });

  it('the REAL mbrgea-ai TD-152 header -> FR-003b (RED at HEAD)', () => {
    // brief_files mbrgea-ai/TD-152, line 9, verbatim.
    expect(extractParentBriefId('- **Parent Brief:** FR-003b')).toBe('FR-003b');
  });

  it('a numbered parent is unchanged', () => {
    expect(extractParentBriefId('**Parent Brief:** FR-100')).toBe('FR-100');
    expect(extractParentBriefId('Parent: TD-057')).toBe('TD-057');
    expect(extractParentBriefId('## Parent: MG-013')).toBe('MG-013');
  });

  it('a numbered parent followed by prose is not glued into a suffix', () => {
    expect(extractParentBriefId('**Parent:** FR-100 and FR-101')).toBe('FR-100');
    expect(extractParentBriefId('**Parent Brief:** FR-100.')).toBe('FR-100');
  });

  it('a TWO-letter suffix is refused whole, never truncated to the parent', () => {
    // `\b` after `[a-z]?`: FR-003bx can match neither FR-003b (followed by a
    // word char) nor FR-003 (followed by a word char).
    expect(extractParentBriefId('**Parent Brief:** FR-003bx')).toBeNull();
  });

  it('RECORDED LIMIT, not endorsed: the fifty-dev outlier FR-112b-redo resolves to FR-112b', () => {
    // The admitted shape is one lowercase letter (the measured population);
    // `-redo` is a hyphenated word suffix, and `-` is a word boundary, so the
    // id-shaped prefix is what the matcher sees. fifty-dev can re-key the row.
    expect(extractParentBriefId('**Parent:** FR-112b-redo')).toBe('FR-112b');
  });

  it('RECORDED LIMIT: the pre-existing `i` flag admits a non-canonical case, and the widening changes WHAT it admits', () => {
    // The `i` flag is pre-existing (fr-003 passed at 505499d). What TD-468
    // changes is the VALUE such an input yields: at HEAD `FR-003B` matched as
    // `FR-003` (the \d+ stopped before the B); with `[a-z]?` under `i`, the B
    // is now consumed and the result is `FR-003B`. This assertion is therefore
    // NEW behaviour, not a pre-existing one — an earlier title here said
    // "unchanged by TD-468", which was false. Neither value is a canonical id;
    // folding case is a different brief's decision.
    expect(extractParentBriefId('**Parent Brief:** FR-003B')).toBe('FR-003B');
  });

  it('no Parent line -> null', () => {
    expect(extractParentBriefId('')).toBeNull();
    expect(extractParentBriefId('# FR-1\n\nno parent here')).toBeNull();
  });
});
