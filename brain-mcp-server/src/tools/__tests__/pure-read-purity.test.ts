/**
 * FR-240 G-RO-4 — the pure `db`-param read layer is mechanically pure.
 *
 * MAINTAINING's whole-graph row states the contract in prose: *"keep the pure
 * module free of a `db.js` import — the pure-layer/wrapper split is what makes
 * a second consumer possible."* `architecture_map.md` § "Brain Engine — Pure
 * Data Layer vs MCP Wrapper" adds *"verify with a grep, not by intent."* This
 * file is that grep.
 *
 * WHAT THIS GATE PROVES
 * ---------------------
 * That none of the three FR-240 readers imports the `db.js` singleton, calls
 * `getDb()`, or issues a write statement — so the FR-238 dashboard's
 * `query_only = ON` handle cannot be handed to a reader that would throw
 * `SQLITE_READONLY` at the operator, and no reader can quietly re-acquire the
 * read-WRITE singleton behind the caller's back.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That the WRAPPERS still emit the same bytes. **Sibling:**
 *    `wrapper-wire-parity.test.ts`.
 *  - That the readers return correct rows. **Siblings:** `briefs-read.test.ts`,
 *    `memory-read.test.ts`, `../../engine/components/goals/__tests__/read.test.ts`.
 *  - That the CLI's server layer holds no SQL — the symmetric fence on the other
 *    side of the boundary. **Sibling:** `cli/src/__tests__/dashboard-server.test.ts`
 *    ("the server layer holds zero SQL").
 *  - That a reader cannot write via a helper it calls. The scan is textual and
 *    per-file; transitive reach is bounded instead by the import allowlist
 *    asserted below.
 *
 * SELF-NEGATIVE-CONTROL (FR-239 learning 1094)
 * --------------------------------------------
 * A scan whose only observed outcome is "pass" is indistinguishable from a scan
 * whose regexes never match anything. The last describe block runs the SAME
 * `scanForViolations` function over a synthetic module that contains every
 * forbidden construct and asserts each one is flagged. If the scanner rots, that
 * block goes red before the real modules do.
 *
 * @module tools/__tests__/pure-read-purity.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The three modules the FR-240 contract covers, by name. */
const PURE_READERS: { label: string; url: URL }[] = [
  { label: 'tools/briefs-read.ts', url: new URL('../briefs-read.ts', import.meta.url) },
  { label: 'tools/memory-read.ts', url: new URL('../memory-read.ts', import.meta.url) },
  {
    label: 'engine/components/goals/read.ts',
    url: new URL('../../engine/components/goals/read.ts', import.meta.url),
  },
];

/**
 * Strip block and line comments.
 *
 * Load-bearing: every one of these modules DOCUMENTS the rule it obeys, and
 * those doc comments necessarily name `db.js`, `getDb()` and `UPDATE`. A scan
 * that did not strip comments would be a scan that forbids explaining itself.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  // The singleton import, in either relative form the two directory depths use.
  { name: "imports '../db.js'", pattern: /from\s+['"]\.\.\/db\.js['"]/ },
  { name: "imports '../../../db.js'", pattern: /from\s+['"](?:\.\.\/)+db\.js['"]/ },
  { name: 'calls getDb(', pattern: /\bgetDb\s*\(/ },
  { name: 'UPDATE statement', pattern: /\bUPDATE\b/ },
  { name: 'INSERT statement', pattern: /\bINSERT\b/ },
  { name: 'DELETE statement', pattern: /\bDELETE\b/ },
  { name: 'CREATE statement', pattern: /\bCREATE\b/ },
  // `.run()` is better-sqlite3's WRITE verb. A reader uses `.get()`/`.all()`.
  { name: '.run( on a statement', pattern: /\.run\s*\(/ },
  { name: 'db.transaction(', pattern: /\.transaction\s*\(/ },
  { name: 'db.pragma(', pattern: /\.pragma\s*\(/ },
];

/** Return the names of every rule the source violates. */
function scanForViolations(src: string): string[] {
  const code = stripComments(src);
  return RULES.filter((r) => r.pattern.test(code)).map((r) => r.name);
}

describe('FR-240 — the pure read layer imports no singleton and issues no writes', () => {
  for (const reader of PURE_READERS) {
    it(`${reader.label} is pure`, () => {
      const src = readFileSync(fileURLToPath(reader.url), 'utf-8');
      expect(scanForViolations(src)).toEqual([]);
    });
  }

  /**
   * The textual scan cannot see through an import. This allowlist is the
   * complementary fence: it bounds WHICH modules a reader may reach at all, so
   * a future `import { bump } from './writes.js'` fails here even though the
   * write itself lives in another file.
   *
   * Every entry is justified:
   *  - `better-sqlite3` — TYPE-only (`import type`), erased at compile time.
   *  - `../utils/{fts5,embeddings,vector-search,hybrid-search}.js` — the recall
   *    machinery. None imports `db.js`; all take a `db` param or are pure.
   *  - `../../helpers.js` — `WhereBuilder` + result formatters over `./types.js`
   *    only. No `db.js` edge, no import-time side effect.
   */
  const ALLOWED_IMPORTS = new Set([
    'better-sqlite3',
    '../utils/fts5.js',
    '../utils/embeddings.js',
    '../utils/vector-search.js',
    '../utils/hybrid-search.js',
    '../../helpers.js',
  ]);

  for (const reader of PURE_READERS) {
    it(`${reader.label} imports only allowlisted modules`, () => {
      const src = stripComments(readFileSync(fileURLToPath(reader.url), 'utf-8'));
      const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const spec of specifiers) {
        expect(ALLOWED_IMPORTS.has(spec), `unexpected import: ${spec}`).toBe(true);
      }
    });
  }
});

describe('the purity scanner can actually fail (self-negative-control)', () => {
  /**
   * A synthetic module carrying one instance of every forbidden construct.
   * If a rule's regex is broken, its name is missing from the reported set and
   * this test fails — which is the only way "the three readers are clean" is
   * distinguishable from "the scanner is inert".
   */
  const DIRTY_FIXTURE = `
    import { getDb } from '../db.js';
    export function impure(db) {
      const handle = getDb();
      handle.pragma('journal_mode = WAL');
      db.prepare('UPDATE learnings SET access_count = access_count + 1').run(1);
      db.prepare('INSERT INTO learnings (id) VALUES (?)').run(2);
      db.prepare('DELETE FROM learnings WHERE id = ?').run(3);
      db.prepare('CREATE TABLE t (a INT)').run();
      db.transaction(() => {})();
    }
  `;

  it('flags every rule on a deliberately impure module', () => {
    const flagged = scanForViolations(DIRTY_FIXTURE);
    for (const rule of RULES) {
      expect(flagged, `rule "${rule.name}" did not fire`).toContain(rule.name);
    }
  });

  it('does NOT flag a module that only TALKS about writes in comments', () => {
    const commentaryOnly = `
      /** This reader must not UPDATE, INSERT or DELETE, and must not call getDb(). */
      // It also must not import from '../db.js'.
      import type Database from 'better-sqlite3';
      export function clean(db: Database.Database) {
        return db.prepare('SELECT 1').get();
      }
    `;
    expect(scanForViolations(commentaryOnly)).toEqual([]);
  });
});
