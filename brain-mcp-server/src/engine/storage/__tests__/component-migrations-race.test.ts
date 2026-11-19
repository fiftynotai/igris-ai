/**
 * FR-276 — runComponentMigrations under a cross-process race.
 *
 * The CLI's attention actions and engine boot both run the component runner,
 * so two processes on one brain can each read the same version and then both
 * try the next migration. A bare `ALTER TABLE ... ADD COLUMN` (attention v2)
 * then fails in the loser with `duplicate column name`. The runner re-reads the
 * version under the write lock and skips what another connection applied.
 *
 * @module engine/storage/__tests__/component-migrations-race.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runComponentMigrations } from '../sqlite.js';
import { attentionMigrations } from '../../components/attention/schema.js';
import type { Migration } from '../../types.js';

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two connections to one file-backed brain, with the engine's journal settings. */
function twoConnections(): [Database.Database, Database.Database] {
  const dir = mkdtempSync(join(tmpdir(), 'fr276-migration-race-'));
  dirs.push(dir);
  const open = () => {
    const db = new Database(join(dir, 'brain.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    dbs.push(db);
    return db;
  };
  return [open(), open()];
}

/**
 * Wrap `db` so the runner's FIRST version read returns its value and then
 * `afterFirstRead` runs: the other process migrates between this connection's
 * read and its migration. Later reads pass through untouched.
 */
function readThenInterleave(db: Database.Database, afterFirstRead: () => void): Database.Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (fired || !sql.includes('MAX(version)')) return statement;
          return {
            get: (...args: unknown[]) => {
              const row = statement.get(...args);
              fired = true;
              afterFirstRead();
              return row;
            },
          };
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const versions = (db: Database.Database, component: string) =>
  (db.prepare('SELECT version FROM engine_migrations WHERE component = ? ORDER BY version').all(component) as { version: number }[]).map(r => r.version);

describe('FR-276 component migrations across two connections', () => {
  it('a connection that read v1 before another applied attention v2 skips v2 instead of throwing', () => {
    const [a, b] = twoConnections();
    runComponentMigrations(a, 'attention', attentionMigrations.slice(0, 1));
    expect(versions(b, 'attention')).toEqual([1]);

    // B reads v1, then A applies v2, then B continues its own run.
    const racingB = readThenInterleave(b, () => runComponentMigrations(a, 'attention', attentionMigrations));
    expect(() => runComponentMigrations(racingB, 'attention', attentionMigrations)).not.toThrow();

    expect(versions(b, 'attention')).toEqual([1, 2]);
    const columns = (b.prepare('PRAGMA table_info(attention_events)').all() as { name: string }[]).filter(c => c.name === 'selection');
    expect(columns).toHaveLength(1);
  });

  it('skips every version the other connection applied, and still applies the ones it did not', () => {
    const [a, b] = twoConnections();
    const applied: number[] = [];
    const posts: number[] = [];
    const chain: Migration[] = [1, 2, 3].map(version => ({
      version,
      description: `fixture v${version}`,
      sql: `ALTER TABLE race_fixture ADD COLUMN c${version} TEXT;`,
      post: () => { posts.push(version); },
    }));
    a.exec('CREATE TABLE race_fixture (id INTEGER PRIMARY KEY)');
    runComponentMigrations(a, 'race_fixture', chain.slice(0, 1));

    // A reaches v2 while B still believes v1; B must skip v2 and apply v3 itself.
    const racingB = readThenInterleave(b, () => runComponentMigrations(a, 'race_fixture', chain.slice(0, 2)));
    expect(() => runComponentMigrations(racingB, 'race_fixture', chain.map(m => ({ ...m, post: () => { applied.push(m.version); } })))).not.toThrow();

    expect(versions(a, 'race_fixture')).toEqual([1, 2, 3]);
    // B's post-check runs only for the migration B itself applied.
    expect(applied).toEqual([3]);
    expect(posts).toEqual([1, 2]);
  });

  it('does not run pre() for a version another connection already applied, so a schema-sensitive pre-flight cannot abort later migrations', () => {
    const [a, b] = twoConnections();
    const hasColumn = (db: Database.Database, name: string) =>
      (db.prepare('PRAGMA table_info(race_fixture)').all() as { name: string }[]).some(c => c.name === name);
    const preCalls: Array<{ by: string; version: number }> = [];
    // v2's pre-flight refuses a schema that already has its column (a stale-schema
    // guard): run on a version that was applied elsewhere, it would abort the chain.
    const chain = (by: string): Migration[] => [1, 2, 3].map(version => ({
      version,
      description: `fixture v${version}`,
      sql: `ALTER TABLE race_fixture ADD COLUMN c${version} TEXT;`,
      ...(version === 2
        ? { pre: (db: unknown) => { preCalls.push({ by, version }); return !hasColumn(db as Database.Database, 'c2'); } }
        : {}),
    }));
    a.exec('CREATE TABLE race_fixture (id INTEGER PRIMARY KEY)');
    runComponentMigrations(a, 'race_fixture', chain('a').slice(0, 1));

    // B reads v1, then A applies v2 (its pre-flight passes on the v1 schema).
    const racingB = readThenInterleave(b, () => runComponentMigrations(a, 'race_fixture', chain('a').slice(0, 2)));
    runComponentMigrations(racingB, 'race_fixture', chain('b'));

    // B skips v2 entirely — no pre-flight on the already-migrated schema — and applies v3.
    expect(versions(a, 'race_fixture')).toEqual([1, 2, 3]);
    expect(hasColumn(a, 'c3')).toBe(true);
    expect(preCalls).toEqual([{ by: 'a', version: 2 }]);
  });

  it('applies pending migrations in order without a race, and a second run is a no-op', () => {
    const [a] = twoConnections();
    runComponentMigrations(a, 'attention', attentionMigrations);
    expect(versions(a, 'attention')).toEqual([1, 2]);
    expect(() => runComponentMigrations(a, 'attention', attentionMigrations)).not.toThrow();
    expect(versions(a, 'attention')).toEqual([1, 2]);
  });
});
