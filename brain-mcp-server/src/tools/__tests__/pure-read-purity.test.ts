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

/**
 * The modules the pure-read-layer contract covers, by name.
 *
 * Three at FR-240; `suggestions-read.ts` joins them at FR-241, which is what
 * makes the FR-241 write door safe to sit beside: the triage surface BROWSES
 * through this layer on a `query_only` handle and only MUTATES through the
 * gateway, so a bug in the browse path cannot become a write.
 */
const PURE_READERS: { label: string; url: URL }[] = [
  { label: 'tools/briefs-read.ts', url: new URL('../briefs-read.ts', import.meta.url) },
  { label: 'tools/memory-read.ts', url: new URL('../memory-read.ts', import.meta.url) },
  {
    label: 'engine/components/goals/read.ts',
    url: new URL('../../engine/components/goals/read.ts', import.meta.url),
  },
  {
    label: 'tools/suggestions-read.ts',
    url: new URL('../suggestions-read.ts', import.meta.url),
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
   *  - `../../helpers.js` / `../engine/helpers.js` — the SAME file, reached from
   *    the two directory depths this set spans (`engine/components/goals/` and
   *    `tools/`). It exports `WhereBuilder` + the result formatters and imports
   *    `type { ToolResult } from './types.js'` and nothing else — a type-only
   *    edge, erased at compile time. No `db.js` edge, no import-time side
   *    effect. Verified by reading `engine/helpers.ts`, not assumed from the
   *    name (L-711).
   *  - `../utils/substring-search.js` / `../../../utils/substring-search.js` —
   *    FR-246. The SAME file from the two directory depths this set spans. It
   *    holds one interface, one string constant and two pure string functions;
   *    it has **no imports at all**, so it cannot reach `db.js` transitively.
   *    Verified by reading it (L-711), not inferred from "utils".
   *  - `./memory-read.js` — FR-246, and the one entry that needs its own
   *    argument because it is an edge BETWEEN two members of this layer, which
   *    the other entries are not. `briefs-read.ts` imports the `RetrievalReport`
   *    SHAPE from it with `import type`, so the edge is erased at compile time
   *    and no runtime dependency exists in `dist/`. It is allowed rather than
   *    avoided because the alternative — a second hand-copied definition of the
   *    same report — is the drift this layer's MAINTAINING row exists to stop.
   *    Note what this entry does NOT license: a VALUE import from
   *    `memory-read.js` would also pass this allowlist, because the specifier is
   *    all the scan can see. It stays safe because `memory-read.ts` is itself in
   *    `PURE_READERS` and is scanned by the same RULES — do not add an entry
   *    here for a module that is not covered by that loop.
   *  - `../edges/node-project.js` — BR-083. `goals/read.ts` calls
   *    `edgeProjectPredicate(db, 'e', 'bs')` so it can PROBE for the
   *    `edges@4` qualifier columns instead of assuming them; a brain that
   *    predates the migration must degrade, not throw `no such column`.
   *    Justified by READING it (L-711), not by the name: the module has
   *    **exactly one import**, `import type Database from 'better-sqlite3'`,
   *    which is type-only and erased at compile time — so it cannot reach
   *    `db.js` transitively. Every export takes `db` as a parameter; there is
   *    no singleton and no import-time side effect. Asserted below, because a
   *    claim in a comment is not a gate.
   */
  const ALLOWED_IMPORTS = new Set([
    'better-sqlite3',
    '../utils/fts5.js',
    '../utils/embeddings.js',
    '../utils/vector-search.js',
    '../utils/hybrid-search.js',
    '../utils/substring-search.js',
    '../../../utils/substring-search.js',
    '../../helpers.js',
    '../engine/helpers.js',
    './memory-read.js',
    '../edges/node-project.js',
  ]);

  /** Every `from '…'` specifier in a source file, comments stripped. */
  const importsOf = (url: URL): string[] => {
    const src = stripComments(readFileSync(fileURLToPath(url), 'utf-8'));
    return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  };

  /**
   * The allowlist's justification for `substring-search.js` is "it has no
   * imports, so it cannot reach `db.js` transitively". That is a CLAIM about a
   * file, and a claim in a comment is not a gate — the whole point of this
   * suite. So it is asserted.
   *
   * PROVES: the FR-246 helper cannot acquire a transitive edge without this
   * going red. Does NOT prove anything about the helper's behaviour — that is
   * `substring-search.test.ts`'s job.
   */
  it('the FR-246 substring helper is import-free, so its allowlist entry cannot hide a transitive edge', () => {
    const helper = new URL('../../utils/substring-search.ts', import.meta.url);
    expect(importsOf(helper)).toEqual([]);
    // Self-negative-control: the SAME extractor over a file that certainly has
    // imports must be non-empty. Without this, a regex that stopped matching
    // would make the assertion above pass by returning nothing at all.
    expect(importsOf(new URL('../briefs-read.ts', import.meta.url)).length).toBeGreaterThan(0);
  });

  /**
   * The SAME standard applied to BR-083's entry. Its justification is "exactly
   * one import, and that one is type-only" — a CLAIM about a file, so it is
   * asserted rather than trusted.
   *
   * PROVES: `node-project.ts` cannot acquire a transitive edge to `db.js` (or
   * anything else) without this going red, which is what makes it safe for a
   * PURE_READER to import. Does NOT prove anything about `qualifyNodeProject`'s
   * behaviour — that is `node-project.test.ts`'s job.
   */
  it('BR-083 node-project has exactly one import, and it is type-only', () => {
    const url = new URL(
      '../../engine/components/edges/node-project.ts',
      import.meta.url,
    );
    const src = stripComments(readFileSync(fileURLToPath(url), 'utf-8'));
    const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    expect(
      specifiers,
      'node-project.ts gained an import — re-justify its allowlist entry or ' +
        'remove it. A PURE_READER may only reach modules that cannot reach db.js.',
    ).toEqual(['better-sqlite3']);
    // ...and it must stay TYPE-only, or the erased-at-compile-time argument dies.
    expect(
      /import\s+type\s+Database\s+from\s+'better-sqlite3'/.test(src),
      'the better-sqlite3 import is no longer `import type` — it now exists at ' +
        'runtime in dist/, so the allowlist justification no longer holds',
    ).toBe(true);
  });

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

  /**
   * The corpus floor (the `gateway-strict-input.test.ts` discipline). Every
   * assertion above is a per-file loop; a loop over an empty or shrunken array
   * passes vacuously, and this file's whole job is to grow with the layer.
   *
   * Asserting the NAMES rather than only the count is what makes a silently
   * dropped entry visible: a count-only floor is satisfiable by swapping a
   * reader out for any other file.
   */
  it('the scan has a corpus — every reader in the layer is in it', () => {
    const labels = PURE_READERS.map((r) => r.label);
    for (const expected of [
      'tools/briefs-read.ts',
      'tools/memory-read.ts',
      'engine/components/goals/read.ts',
      'tools/suggestions-read.ts',
    ]) {
      expect(labels, `${expected} is not scanned`).toContain(expected);
    }
    // And the files really exist, so a typo'd URL cannot pass as "clean".
    for (const reader of PURE_READERS) {
      expect(
        readFileSync(fileURLToPath(reader.url), 'utf-8').length,
        reader.label,
      ).toBeGreaterThan(500);
    }
  });
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
