/**
 * TD-440 AC-5 — every `suggestions` writer stamps its producer, with the RIGHT
 * value.
 *
 * WHY THIS IS DERIVED AND NOT A LIST. The point of `source_instance` is that
 * grouping by `source_module` reads as one producer per LLM label — 195
 * distinct labels over 358 rows (TD-437's audit, 2026-09-01) — when there are
 * six producer values across eight writer sites. A producer facet is only
 * trustworthy if EVERY writer fills it: one that does not lands its rows in the
 * `(unattributed)` bucket and quietly understates whoever they belong to. A
 * hand-list of the eight sites would pass forever while a ninth shipped
 * unstamped, so the writer set is re-derived from the source on every run.
 * This is the same reason `MAINTAINING` carries the rule rather than the count.
 *
 * WHY IT CHECKS THE VALUE AND NOT THE COLUMN NAME. A first version of this
 * file asserted only that the INSERT's COLUMN LIST contains `source_instance`
 * and that the VALUES clause is non-empty. That gate cannot fail on the two
 * defects it exists to prevent: `cartographer.ts` stamping `''` (which IS the
 * `(unattributed)` bucket this file's opening paragraph names) and
 * `cartographer.ts` stamping `'curator'` (silent mis-attribution) both left
 * the whole brain suite at 2948 passed / 0 red. The L-1463 class — a guard
 * that cannot observe the thing it claims to guard. So the statement is
 * PARSED: the column list and the values list are split on top-level commas,
 * their lengths must agree, and the value sitting at `source_instance`'s index
 * is resolved to a string — a `'literal'` directly, or a bound `?` followed
 * back through the `.run(...)` argument at the matching placeholder index to
 * the `const` that supplies it.
 *
 * WHERE THE EXPECTED VALUE COMES FROM. Not a map — a rule over the file's
 * location, so a ninth writer is covered the day it lands:
 *   - a cognition extractor (`engine/components/cognition/extractors/X.ts`)
 *     stamps `X`, its own instance id;
 *   - anything else under `engine/components/C/` stamps `C`, the OWNING
 *     component — `janitor/hygiene.ts` and `janitor/emergence.ts` are
 *     deterministic sweeps rather than cognition instances, and an operator
 *     looking for their rows looks for `janitor`.
 * A writer outside both shapes has no derivable id and FAILS rather than
 * skipping, which is the "key map that throws" shape: adding a writer
 * somewhere new is red, not invisible.
 *
 * @module engine/components/subconscious/__tests__/source-instance.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { subconsciousMigrations } from '../schema.js';

/** `vitest`'s cwd is the package root, so `src` resolves from there. */
const SRC = join(process.cwd(), 'src');
const COMPONENTS = join('engine', 'components');
const EXTRACTORS = join(COMPONENTS, 'cognition', 'extractors');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing — SQL first, then the TypeScript that binds it
// ---------------------------------------------------------------------------

/**
 * The balanced-paren span starting at the first `(` at or after `from`.
 * Single-quoted SQL literals are opaque, so `datetime('now')` nests correctly.
 */
function sqlParenSpan(text: string, from: number): { inner: string; end: number } {
  const open = text.indexOf('(', from);
  if (open === -1) throw new Error('no "(" found');
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  throw new Error('unbalanced parentheses');
}

/**
 * Split a SQL list on TOP-LEVEL commas. A comma inside nested parens or inside
 * a quoted literal belongs to its term — `datetime('now', ?)` is ONE value.
 * Empty terms are KEPT so a malformed list reds the arity check rather than
 * being silently compacted into a well-formed one.
 */
function splitSqlList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/**
 * Split a TypeScript argument list on top-level commas. Unlike the SQL
 * splitter this must survive all three quote characters, backslash escapes and
 * `[]`/`{}` nesting — `` `+${PENDING_TTL_DAYS} days` `` is one argument, and
 * so is `JSON.stringify({ a: 1, b: 2 })`.
 */
function splitTsArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** The balanced-paren span of a TypeScript call starting at the `(` at `open`. */
function tsParenSpan(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced call parentheses');
}

/**
 * Resolve `const NAME = '<value>'` anywhere in the tree. Throws on 0 hits and
 * on hits that disagree — an unresolvable binding must be a failure, never a
 * skipped site.
 */
function resolveStringConst(name: string): string {
  const found = new Set<string>();
  const re = new RegExp(`\\bconst\\s+${name}\\b[^=\\n]*=\\s*(['"])([^'"]*)\\1`);
  for (const file of walk(SRC)) {
    const m = re.exec(readFileSync(file, 'utf-8'));
    if (m) found.add(m[2] as string);
  }
  if (found.size !== 1) {
    throw new Error(`${name} resolves to ${found.size} distinct string constants`);
  }
  return [...found][0] as string;
}

interface WriteSite {
  /** Path relative to `src`. */
  file: string;
  /** The INSERT statement text, from `INSERT INTO suggestions` to the closing backtick. */
  statement: string;
  /** The remainder of the file after the statement — where `.run(...)` lives. */
  rest: string;
}

/**
 * Every production `INSERT INTO suggestions` in the tree. `suggestions_new` is
 * excluded by the word boundary — it is the v3 table-rebuild's scratch table,
 * not a producer.
 */
function writeSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf-8');
    const re = /INSERT INTO suggestions\b(?!_)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // The statement runs to the end of the template literal it lives in.
      const end = text.indexOf('`', m.index);
      sites.push({
        file: file.slice(SRC.length + 1),
        statement: text.slice(m.index, end === -1 ? m.index + 800 : end),
        rest: end === -1 ? '' : text.slice(end + 1),
      });
    }
  }
  return sites;
}

/** The producer id a writer's LOCATION obliges it to stamp. Throws if none. */
function expectedProducer(file: string): string {
  if (file.startsWith(EXTRACTORS + sep)) {
    const tail = file.slice(EXTRACTORS.length + 1);
    if (tail.includes(sep)) {
      throw new Error(`${file}: an extractor must be a direct child of ${EXTRACTORS}`);
    }
    return tail.replace(/\.ts$/, '');
  }
  if (file.startsWith(COMPONENTS + sep)) {
    return file.slice(COMPONENTS.length + 1).split(sep)[0] as string;
  }
  throw new Error(
    `${file}: no producer id is derivable for this location. A new ` +
      `suggestions writer must live under ${COMPONENTS}${sep}<component>${sep} ` +
      `(stamps <component>) or ${EXTRACTORS}${sep}<id>.ts (stamps <id>) — or ` +
      `this rule needs extending, deliberately, in the same commit.`,
  );
}

/** The string a site actually stamps into `source_instance`, as written. */
function stampedValue(site: WriteSite): string {
  const cols = sqlParenSpan(site.statement, 0);
  const columns = splitSqlList(cols.inner).map((c) => c.trim());
  const valuesAt = site.statement.indexOf('VALUES', cols.end);
  if (valuesAt === -1) throw new Error(`${site.file}: no VALUES clause`);
  const values = splitSqlList(sqlParenSpan(site.statement, valuesAt).inner);

  if (columns.length !== values.length) {
    throw new Error(
      `${site.file}: ${columns.length} columns but ${values.length} values — ` +
        `the index mapping below would be meaningless`,
    );
  }
  const idx = columns.indexOf('source_instance');
  if (idx === -1) throw new Error(`${site.file}: no source_instance column`);
  const raw = (values[idx] as string).trim();

  const literal = /^'([^']*)'$/.exec(raw);
  if (literal) return literal[1] as string;

  if (raw === '?') {
    // Which bind parameter is it? Every `?` before this value, INCLUDING the
    // ones nested in `datetime('now', ?)`, consumes an argument slot.
    const before = values.slice(0, idx).join(',');
    const bindIndex = (before.match(/\?/g) ?? []).length;
    const runAt = site.rest.indexOf('.run(');
    if (runAt === -1) throw new Error(`${site.file}: a bound stamp with no .run(...)`);
    const args = splitTsArgs(tsParenSpan(site.rest, runAt + '.run'.length));
    const arg = args[bindIndex];
    if (arg === undefined) {
      throw new Error(`${site.file}: bind index ${bindIndex} past ${args.length} args`);
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(arg)) {
      throw new Error(
        `${site.file}: the source_instance argument is \`${arg}\`, not a bare ` +
          `identifier this gate can resolve. Bind a module const instead.`,
      );
    }
    return resolveStringConst(arg);
  }

  throw new Error(
    `${site.file}: source_instance is \`${raw}\` — the gate reads a quoted ` +
      `literal or a single bound \`?\`, and anything else could be a runtime ` +
      `value it cannot check.`,
  );
}

// ---------------------------------------------------------------------------

describe('TD-440 AC-5 — producer attribution is total', () => {
  const sites = writeSites();

  it('finds the production writers at all (the arming check)', () => {
    // If the regex stops matching, every assertion below passes vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sites.map((s) => [s.file, s] as const))(
    'every INSERT names source_instance — %s',
    (_file, site) => {
      expect(site.statement).toContain('source_instance');
    },
  );

  it.each(sites.map((s) => [s.file, s] as const))(
    'stamps the producer its location obliges — %s',
    (file, site) => {
      const expected = expectedProducer(file);
      const stamped = stampedValue(site);
      // Non-empty FIRST, and said separately, because `''` is not merely the
      // wrong value: it is exactly the `(unattributed)` facet bucket.
      expect(
        stamped,
        `${file} stamps an EMPTY source_instance — its rows land in the ` +
          `(unattributed) bucket, which is the defect this column exists to fix`,
      ).not.toBe('');
      expect(
        stamped,
        `${file} stamps '${stamped}' but its location obliges '${expected}' — ` +
          `a mis-stamp is silent: the rows are attributed to the wrong producer ` +
          `and BOTH facet counts are wrong`,
      ).toBe(expected);
    },
  );

  it('the deterministic janitor sweeps stamp the OWNING component, not an instance', () => {
    // The positive control on the non-extractor branch of `expectedProducer`.
    // `janitor/hygiene.ts` and `janitor/emergence.ts` are not cognition
    // instances — they are deterministic sweeps inside the janitor component —
    // so they stamp `janitor`, the thing an operator would look for.
    const sweeps = sites.filter((s) => s.file.startsWith(join(COMPONENTS, 'janitor') + sep));
    expect(sweeps.length).toBe(2);
    for (const s of sweeps) expect(stampedValue(s), s.file).toBe('janitor');
  });

  it('the producer VOCABULARY is smaller than the writer set, which is the point', () => {
    // Not a hand-count: both numbers are derived. The claim is the RELATION —
    // `janitor` is stamped by three sites — and it is what makes the facet a
    // coarser cut than `source_module` rather than another free-text axis.
    const stamps = sites.map((s) => stampedValue(s));
    expect(new Set(stamps).size).toBeLessThan(stamps.length);
    for (const s of stamps) expect(s).toMatch(/^[a-z_]+$/);
  });
});

describe('TD-440 AC-5 — the column accepts and preserves the stamp', () => {
  it('round-trips a producer id through the v5 schema', () => {
    const db = new Database(':memory:');
    try {
      for (const m of subconsciousMigrations) db.exec(m.sql);
      db.prepare(
        `INSERT INTO suggestions
           (source_module, project_slug, title, evidence, priority, status, source_instance)
         VALUES ('edge_inference', NULL, 't', '{}', 'low', 'pending', 'synapse')`,
      ).run();
      const row = db.prepare(`SELECT source_instance FROM suggestions`).get() as {
        source_instance: string;
      };
      expect(row.source_instance).toBe('synapse');
    } finally {
      db.close();
    }
  });

  it('a pre-v5 row reads as NULL and is NOT backfilled', () => {
    // Deliberate: attributing historical rows would need a hand-list of the
    // sibling `source_module` literals over an OPEN registry. They surface in
    // the empty-string facet bucket instead, which is honest.
    const db = new Database(':memory:');
    try {
      for (const m of subconsciousMigrations) db.exec(m.sql);
      db.prepare(
        `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
         VALUES ('legacy_label', 'p', 't', '{}', 'low', 'pending')`,
      ).run();
      const row = db.prepare(`SELECT source_instance FROM suggestions`).get() as {
        source_instance: string | null;
      };
      expect(row.source_instance).toBeNull();
    } finally {
      db.close();
    }
  });
});
