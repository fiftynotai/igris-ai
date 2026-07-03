/**
 * FTS5 Query Sanitizer Tests (TD-290)
 *
 * `sanitizeFts5Query` must neutralize the ENTIRE class of FTS5-special /
 * bareword-invalid input so that no user query can reach `MATCH` and raise a
 * syntax error. These tests freeze the whitelist contract:
 *   - `?` (the char the old denylist missed) is stripped
 *   - a pure-punctuation query collapses to the empty string
 *   - a word-with-punctuation degrades to a safe bareword
 *   - normal multi-word queries are unchanged (minus boolean operators)
 *
 * @module utils/__tests__/fts5.test
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFts5Query } from '../fts5.js';

describe('sanitizeFts5Query (TD-290)', () => {
  // -------------------------------------------------------------------------
  // The regression: `?` used to survive the denylist and reach MATCH '?'.
  // -------------------------------------------------------------------------
  it('strips a literal question mark', () => {
    expect(sanitizeFts5Query('?')).toBe('');
    expect(sanitizeFts5Query('what?')).toBe('what');
    expect(sanitizeFts5Query('how do I do this?')).toBe('how do I do this');
  });

  // -------------------------------------------------------------------------
  // Pure-punctuation queries must collapse to empty (so callers hit the
  // `!sanitized` / `if (sanitized)` guard and degrade gracefully).
  // -------------------------------------------------------------------------
  it('collapses pure-punctuation queries to the empty string', () => {
    expect(sanitizeFts5Query('???')).toBe('');
    expect(sanitizeFts5Query('()')).toBe('');
    expect(sanitizeFts5Query('*')).toBe('');
    expect(sanitizeFts5Query('"":,()')).toBe('');
    expect(sanitizeFts5Query('!@#$%^&*()')).toBe('');
    expect(sanitizeFts5Query('   ')).toBe('');
    expect(sanitizeFts5Query('')).toBe('');
  });

  // -------------------------------------------------------------------------
  // Every FTS5-special / bareword-invalid char is neutralized to a space,
  // leaving safe barewords behind.
  // -------------------------------------------------------------------------
  it('neutralizes the full FTS5-special character set into barewords', () => {
    expect(sanitizeFts5Query('foo"bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo:bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo(bar)')).toBe('foo bar');
    expect(sanitizeFts5Query('foo*')).toBe('foo');
    expect(sanitizeFts5Query('+foo -bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo^bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo~bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo@bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo#bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo\\bar')).toBe('foo bar');
    // Characters the OLD denylist did NOT cover — now neutralized too.
    expect(sanitizeFts5Query('foo?bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo.bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo!bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo/bar')).toBe('foo bar');
    expect(sanitizeFts5Query('foo;bar')).toBe('foo bar');
    expect(sanitizeFts5Query('a<b>c')).toBe('a b c');
  });

  // -------------------------------------------------------------------------
  // Normal queries pass through unchanged (whitespace collapsed).
  // -------------------------------------------------------------------------
  it('leaves normal multi-word queries unchanged', () => {
    expect(sanitizeFts5Query('SQLite WAL optimization')).toBe('SQLite WAL optimization');
    expect(sanitizeFts5Query('  pagination   test  learning ')).toBe('pagination test learning');
    expect(sanitizeFts5Query('react_hooks')).toBe('react_hooks'); // underscore preserved
    expect(sanitizeFts5Query('café über naïve')).toBe('café über naïve'); // unicode letters
    expect(sanitizeFts5Query('version 3 14')).toBe('version 3 14'); // digits preserved
  });

  // -------------------------------------------------------------------------
  // Boolean operators are still stripped (behavior preserved from denylist).
  // -------------------------------------------------------------------------
  it('strips FTS5 boolean keywords (case-insensitive), preserving surrounding words', () => {
    expect(sanitizeFts5Query('cats AND dogs')).toBe('cats dogs');
    expect(sanitizeFts5Query('cats or dogs')).toBe('cats dogs');
    expect(sanitizeFts5Query('cats NOT dogs')).toBe('cats dogs');
    expect(sanitizeFts5Query('cats NEAR dogs')).toBe('cats dogs');
    // Not a standalone keyword — must NOT be stripped mid-word.
    expect(sanitizeFts5Query('android developer')).toBe('android developer');
  });
});
