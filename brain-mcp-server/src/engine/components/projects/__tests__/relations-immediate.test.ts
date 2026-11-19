/**
 * FR-273 (sentinel F-R4-2) — `declareRelation`, `removeRelation` and `addKind`
 * take their write lock with BEGIN IMMEDIATE, so a writer on ANOTHER connection
 * (the CLI write door beside a running MCP server) makes them WAIT and then
 * answer in-band from the committed state.
 *
 * Two real connections on one WAL file DB. A child process opens its own
 * handle, takes `BEGIN IMMEDIATE`, says "locked", holds the lock briefly, then
 * commits a CONFLICTING row. The parent calls the write core while the lock is
 * held (busy_timeout 5000). With IMMEDIATE the parent's BEGIN waits for the
 * commit and reads the new row; with a DEFERRED transaction it reads a snapshot
 * first and its write fails with SQLITE_BUSY_SNAPSHOT (a thrown error) — which is
 * what these tests exclude. The hold is a fixed 400 ms: the parent's first
 * statement runs within milliseconds of "locked", well inside it, and the
 * parent's busy_timeout (5 s) is far above it.
 *
 * @module engine/components/projects/__tests__/relations-immediate.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { bootRelationsDb, cleanupRelationsFixtures, registerProject, tmpRoot, insertEdge } from './relations-fixture.js';
import { declareRelation, removeRelation } from '../relations/write.js';
import { addKind } from '../relations/kinds.js';

afterEach(() => cleanupRelationsFixtures());

const SQLITE = createRequire(import.meta.url).resolve('better-sqlite3');
const HOLD_MS = 400;

interface Held { done: Promise<number> }

/** Start a child holding BEGIN IMMEDIATE on `dbPath`; resolves once it holds the lock. */
async function holdThenCommit(dbPath: string, sql: string): Promise<Held> {
  const src = `
    const D = require(${JSON.stringify(SQLITE)});
    const db = new D(${JSON.stringify(dbPath)});
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});
    db.exec(${JSON.stringify(sql)});
    db.exec('COMMIT');
    db.close();`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));
  await new Promise<void>((res, rej) => {
    child.stdout.once('data', () => res());
    child.once('exit', (c) => rej(new Error(`child exited ${c} before locking`)));
  });
  return { done };
}

function fileDb(): { db: Database.Database; path: string } {
  const path = join(tmpRoot(), 'brain.db');
  const db = bootRelationsDb({ dbPath: path });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const root = tmpRoot();
  registerProject(db, root, 'app-a');
  registerProject(db, root, 'pkg-b');
  return { db, path };
}

describe('the write core takes BEGIN IMMEDIATE (F-R4-2)', () => {
  it('declareRelation waits for a concurrent writer and updates ITS committed row in-band', async () => {
    const { db, path } = fileDb();
    const held = await holdThenCommit(path,
      "INSERT INTO project_relations (from_slug, kind, to_slug, detail) VALUES ('app-a', 'uses_package', 'pkg-b', '{\"by\":\"A\"}')");
    const r = declareRelation(db, { from: 'app-a', kind: 'uses_package', to: 'pkg-b', detail: { by: 'B' } });
    expect(await held.done).toBe(0);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.data.outcome).toBe('updated'); // it SAW A's row: it waited, then read
    expect(db.prepare('SELECT detail FROM project_relations').all()).toEqual([{ detail: '{"by":"B"}' }]);
  });

  it('removeRelation waits and sees the concurrent tombstone (idempotent no-op, in-band)', async () => {
    const { db, path } = fileDb();
    insertEdge(db, { from: 'app-a', kind: 'uses_package', to: 'pkg-b' });
    const held = await holdThenCommit(path,
      "UPDATE project_relations SET removed_at = '2026-09-29 12:00:00', updated_at = '2026-09-29 12:00:00'");
    const r = removeRelation(db, { from: 'app-a', kind: 'uses_package', to: 'pkg-b' });
    expect(await held.done).toBe(0);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.data.outcome).toBe('unchanged');
    expect(db.prepare('SELECT removed_at FROM project_relations').get()).toEqual({ removed_at: '2026-09-29 12:00:00' });
  });

  it('addKind waits and refuses the concurrently-committed name as a collision, in-band', async () => {
    const { db, path } = fileDb();
    const held = await holdThenCommit(path,
      "INSERT INTO project_relation_kinds (name, meaning, direction, forward_label, inverse_label, example) VALUES ('deploys_to', 'm', 'd', 'f', 'i', 'e')");
    const r = await addKind(db, {
      name: 'deploys_to', meaning: "A is deployed onto B's hosting infrastructure", direction: 'A → B',
      forward_label: 'deploys to', inverse_label: 'hosts', example: 'x deploys_to y',
    }, { embed: null, unavailableReason: 'off' });
    expect(await held.done).toBe(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toMatchObject({ code: 'name_collision', existing: 'deploys_to' });
  });
});
