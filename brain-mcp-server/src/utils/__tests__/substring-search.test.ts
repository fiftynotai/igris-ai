/**
 * FR-246 — the `q` substring filter is a FILTER, and says so.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *  1. LIKE wildcards in operator input are NEUTRALISED. `?q=%` must match rows
 *     containing a literal per-cent sign, not every row. A filter that silently
 *     matches everything is worse than one that errors, because the operator
 *     reads the full list as a result.
 *  2. The `search` block is `null` when there is no `q` and names its fields
 *     when there is — the payload field `G-BR-13b` asserts against, so that
 *     "this is substring matching, not recall" is a machine-checkable claim
 *     rather than a sentence somebody has to keep true by hand.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * That the three readers actually USE these helpers with an `ESCAPE` clause —
 * the helper cannot enforce its own call sites. **Siblings:** the `q` cases in
 * `memory-read.test.ts`, `suggestions-read.test.ts` and
 * `goals/__tests__/read.test.ts`, each of which runs the wildcard case through
 * real SQL.
 *
 * @module utils/__tests__/substring-search.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { likePattern, substringReport, LIKE_ESCAPE_CLAUSE } from '../substring-search.js';

describe('likePattern — wildcards in operator input are inert', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE t (v TEXT)`);
  for (const v of ['plain row', '100% done', 'snake_case name', 'back\\slash', 'nothing special']) {
    db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
  }

  const search = (q: string): string[] =>
    (
      db
        .prepare(`SELECT v FROM t WHERE LOWER(v) LIKE ? ${LIKE_ESCAPE_CLAUSE} ORDER BY v`)
        .all(likePattern(q)) as { v: string }[]
    ).map((r) => r.v);

  it('"%" matches only rows containing a literal per-cent sign', () => {
    expect(search('%')).toEqual(['100% done']);
    // The mutation this guards against, spelled out: an UNESCAPED pattern would
    // return all five. Asserted so the difference is visible, not implied.
    const unescaped = (
      db.prepare('SELECT v FROM t WHERE v LIKE ?').all('%%') as { v: string }[]
    ).length;
    expect(unescaped).toBe(5);
  });

  it('"_" matches only rows containing a literal underscore', () => {
    expect(search('_')).toEqual(['snake_case name']);
  });

  it('a backslash matches only rows containing a literal backslash', () => {
    expect(search('\\')).toEqual(['back\\slash']);
  });

  it('ordinary text still matches as a substring, case-insensitively', () => {
    expect(search('PLAIN')).toEqual(['plain row']);
    expect(search('row')).toEqual(['plain row']);
  });
});

describe('substringReport — the payload field a gate can assert', () => {
  it('is null when no q was supplied, and for whitespace-only q', () => {
    expect(substringReport(undefined, ['title'])).toBeNull();
    expect(substringReport('', ['title'])).toBeNull();
    expect(substringReport('   ', ['title'])).toBeNull();
  });

  it('names the mode and the fields when a q was supplied', () => {
    expect(substringReport('kiln', ['title', 'evidence'])).toEqual({
      mode: 'substring',
      fields: ['title', 'evidence'],
    });
  });
});
