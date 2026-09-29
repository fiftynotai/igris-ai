/**
 * FR-273 — `relations/read.ts` is mechanically SELECT-only.
 *
 * The CLI hands this reader a `query_only` handle (`openBrainReadonly`), so a
 * write here would throw `SQLITE_READONLY` at the operator's /boot. The same
 * RULES as `tools/__tests__/pure-read-purity.test.ts` (the FR-240 fence) are
 * applied, plus an import allowlist bounding what the reader may reach, plus a
 * SELF-NEGATIVE CONTROL: the scanner must flag a synthetic module containing
 * every forbidden construct, so a rotted regex cannot pass silently.
 *
 * WHAT IT DOES NOT PROVE: that `tools/projects.js` (the disclosed transitive
 * reach, for the FR-274 watermark helpers) performs no write on the path this
 * reader calls. That is bounded by reading it: `checkKnowledgeWatermark` /
 * `renderKnowledgeWatermark` take no `db`, and `hasWatermarkColumns` /
 * `expandHome` are a `table_info` pragma read and a string function.
 *
 * @module engine/components/projects/__tests__/relations-read-purity.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RULES: { name: string; pattern: RegExp }[] = [
  { name: "imports db.js", pattern: /from\s+['"](?:\.\.\/)+db\.js['"]/ },
  { name: 'calls getDb(', pattern: /\bgetDb\s*\(/ },
  { name: 'UPDATE statement', pattern: /\bUPDATE\b/ },
  { name: 'INSERT statement', pattern: /\bINSERT\b/ },
  { name: 'DELETE statement', pattern: /\bDELETE\b/ },
  { name: 'CREATE statement', pattern: /\bCREATE\b/ },
  { name: 'REPLACE statement', pattern: /\bREPLACE\s+INTO\b/ },
  { name: '.run( on a statement', pattern: /\.run\s*\(/ },
  { name: '.exec( on a handle', pattern: /\.exec\s*\(/ },
  { name: 'db.transaction(', pattern: /\.transaction\s*\(/ },
  { name: 'db.pragma(', pattern: /\.pragma\s*\(/ },
];

function scanForViolations(src: string): string[] {
  const code = stripComments(src);
  return RULES.filter((r) => r.pattern.test(code)).map((r) => r.name);
}

const importsOf = (src: string): string[] =>
  [...stripComments(src).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const READ_TS = fileURLToPath(new URL('../relations/read.ts', import.meta.url));
const SCHEMA_TS = fileURLToPath(new URL('../relations/schema.ts', import.meta.url));

describe('FR-273 — relations/read.ts is a pure SELECT-only reader', () => {
  it('read.ts violates no rule', () => {
    expect(scanForViolations(readFileSync(READ_TS, 'utf-8'))).toEqual([]);
  });

  /**
   * Every entry justified:
   *  - `better-sqlite3` — TYPE-only (`import type`), erased at compile time.
   *  - `node:fs` — `existsSync` for `on_disk`.
   *  - `../../../../tools/projects.js` — the FR-274 watermark helpers (the
   *    disclosed transitive reach; see the header).
   *  - `./schema.js` — the seed ORDER only; asserted below to execute nothing.
   */
  it('read.ts imports only the allowlist', () => {
    const allowed = new Set(['better-sqlite3', 'node:fs', '../../../../tools/projects.js', './schema.js']);
    const imports = importsOf(readFileSync(READ_TS, 'utf-8'));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(allowed.has(i), i).toBe(true);
  });

  it('schema.ts (reached by read.ts) holds DDL as DATA only — it executes nothing and imports types only', () => {
    const code = stripComments(readFileSync(SCHEMA_TS, 'utf-8'));
    expect(code).not.toMatch(/\.(run|exec|prepare|pragma|transaction)\s*\(/);
    expect(code).not.toMatch(/\bgetDb\s*\(/);
    expect(importsOf(readFileSync(SCHEMA_TS, 'utf-8'))).toEqual(['../../../types.js']);
    expect(code).toMatch(/import type \{ Migration \}/);
  });

  it('SELF-NEGATIVE CONTROL: the scanner flags every forbidden construct', () => {
    const planted = [
      "import { getDb } from '../../../../db.js';",
      'const db = getDb();',
      "db.prepare('UPDATE t SET a = 1').run();",
      "db.prepare('INSERT INTO t VALUES (1)').run();",
      "db.prepare('DELETE FROM t').run();",
      "db.exec('CREATE TABLE x (a)');",
      "db.prepare('REPLACE INTO t VALUES (1)').run();",
      'db.transaction(() => {})();',
      "db.pragma('query_only = OFF');",
    ].join('\n');
    expect(scanForViolations(planted).sort()).toEqual(RULES.map((r) => r.name).sort());
    // …and comments are stripped, so documenting the rule is not a violation.
    expect(scanForViolations('/* UPDATE INSERT getDb() */\n// DELETE CREATE\nconst x = 1;')).toEqual([]);
  });
});
