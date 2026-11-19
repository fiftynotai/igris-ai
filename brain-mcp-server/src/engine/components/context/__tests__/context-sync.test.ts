/**
 * TD-460 — `igris_context_sync`, the bidirectional context-doc reconciler.
 *
 * The brief's AC-3 is the reason this file exists: *"a producer and a consumer
 * both exist and are exercised — a doc authored on one machine is proven to
 * arrive on a second, or on a clean restore. A write path with no read path is
 * state A wearing state B's clothes."* `definition_files` is the cautionary
 * tale already shipped in this repo (rows in, JSON out, nothing ever written to
 * disk), so a test that only asserts the row appeared would be exactly the
 * thing the AC forbids.
 *
 * Why a SEPARATE file from `context.test.ts`: that file mocks `node:fs`
 * (`existsSync` / `readFileSync`) and `node:os` `homedir` at module scope for
 * the os/INDEX roster suites. The reconciler is a real-filesystem component —
 * it scans a directory, hashes bytes and writes files — so it needs the
 * TD-414 projection fixture (a hoisted HOME fence + `IGRIS_BRAIN_DIR` +
 * `mkdtemp`) instead, and the two fixtures cannot share a module.
 *
 * NOTHING here touches `~/.igris/memory/knowledge.db` or a real context doc.
 * Both brain roots are `mkdtemp` dirs under a fenced HOME; the AC-4 fixture is
 * a COPY of a real doc's byte shape, never the doc itself. A prior hunt in
 * this repo overwrote live operator state; this fixture is the guard against a
 * repeat.
 *
 * @module engine/components/context/__tests__/context-sync.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Fence HOME before ANY module loads. `cacheRoot()` reads `IGRIS_BRAIN_DIR` at
// call time and falls back to `os.homedir()`, so a fence set after import would
// leave the fallback pointing at the operator's real tree.
const { FAKE_HOME, REAL_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const REAL_HOME = process.env.HOME;
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'td460-home-'));
  process.env.HOME = FAKE_HOME;
  return { FAKE_HOME, REAL_HOME };
});

import { createEventBus } from '../../../bus.js';
import type { ComponentContext, EventBus, ToolDefinition } from '../../../types.js';
import { createContextComponent } from '../index.js';
import { contextDocDir } from '../../cache/handlers.js';
import { SYNC_TABLES, mergeRows } from '../../../../tools/sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The v1 `context_files` DDL, verbatim from the context component's migration.
 * Both brain roots get their own copy — the Phase-0 probe confirmed all three
 * generated statement shapes parse with an UNQUOTED `key` column on this DDL,
 * which is what let D-2 keep the v1 shape and ship no migration.
 */
const CONTEXT_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS context_files (
    id INTEGER PRIMARY KEY,
    project_slug TEXT NOT NULL,
    key TEXT NOT NULL,
    file_path TEXT,
    content TEXT,
    content_hash TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_slug, key)
  );
`;

/**
 * A doc whose byte shape is the one that breaks length-based comparisons: em
 * dashes, curly quotes, an arrow and an accented word. `octet_length()` and
 * `wc -c` disagree with `length()` on every one of these, which is why AC-4's
 * evidence is a byte comparison and never a count.
 */
const REAL_SHAPE_DOC = [
  '# Coding Guidelines',
  '',
  '**Rule:** a two-copy state has ONE writer — always.',
  '',
  'The classifier is the one place the rule lives; a “second” writer is the',
  'TD-414 bug again. Authority flows disk → row for a context doc, and row →',
  'disk for a brief. Naïve reversal of either is a defect.',
  '',
].join('\n');

const SHA = (s: string): string => createHash('sha256').update(s).digest('hex');

interface RecordingLog {
  info: string[];
  warn: string[];
  error: string[];
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CONTEXT_FILES_DDL);
  return db;
}

function makeCtx(db: Database.Database, bus: EventBus, log: RecordingLog): ComponentContext {
  return {
    storage: db as unknown as ComponentContext['storage'],
    bus,
    log: {
      info: (m: string) => { log.info.push(m); },
      warn: (m: string) => { log.warn.push(m); },
      error: (m: string) => { log.error.push(m); },
    },
    config: {},
  };
}

interface Digest {
  project: string;
  absorbed: string[];
  materialized: string[];
  unchanged: string[];
  backed_up: string[];
  refused: { key: string; reason: string }[];
}

/** Boot a context component against `root` + `db` and return its sync tool. */
function mountAt(root: string, db: Database.Database, bus: EventBus, log: RecordingLog): ToolDefinition {
  process.env.IGRIS_BRAIN_DIR = root;
  const comp = createContextComponent();
  comp.init(makeCtx(db, bus, log));
  const tool = comp.tools().find((t) => t.name === 'igris_context_sync');
  expect(tool, 'igris_context_sync must be registered').toBeDefined();
  return tool!;
}

function runSync(tool: ToolDefinition, project: string, force = false): Digest {
  const result = tool.handler(force ? { project, force } : { project }) as {
    content: { text: string }[];
    isError?: boolean;
  };
  expect(result.isError, result.content[0]?.text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Digest;
}

function putDoc(root: string, project: string, filename: string, text: string, mtime?: Date): string {
  const dir = join(root, 'projects', project, 'context');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, text, 'utf-8');
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

function rowFor(db: Database.Database, project: string, key: string) {
  return db.prepare(
    'SELECT project_slug, key, content, content_hash, updated_at, file_path FROM context_files WHERE project_slug = ? AND key = ?',
  ).get(project, key) as
    | { project_slug: string; key: string; content: string; content_hash: string; updated_at: string; file_path: string | null }
    | undefined;
}

// ---------------------------------------------------------------------------

describe('TD-460 — igris_context_sync (the round trip)', () => {
  let rootA: string;
  let rootB: string;
  let dbA: Database.Database;
  let dbB: Database.Database;
  let bus: EventBus;
  let log: RecordingLog;
  const savedBrainDir = process.env.IGRIS_BRAIN_DIR;

  afterAll(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    // The fence must be ARMED, or every write below lands in the real ~/.igris.
    expect(homedir()).toBe(FAKE_HOME);
    rootA = mkdtempSync(join(tmpdir(), 'td460-A-'));
    rootB = mkdtempSync(join(tmpdir(), 'td460-B-'));
    dbA = makeDb();
    dbB = makeDb();
    bus = createEventBus();
    log = { info: [], warn: [], error: [] };
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
    else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  });

  // -------------------------------------------------------------------------
  // AC-3 — the producer AND the consumer, both exercised.
  // -------------------------------------------------------------------------

  it('a doc authored under brain root A materialises byte-identically under a clean brain root B', () => {
    // --- 1. Machine A authors a doc on disk (the /ground or /hunt case). ----
    const srcPath = putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);

    // --- 2. The PRODUCER: disk -> row. ------------------------------------
    const toolA = mountAt(rootA, dbA, bus, log);
    const dA = runSync(toolA, 'p');
    expect(dA.absorbed).toEqual(['coding_guidelines.md']);
    expect(dA.materialized).toEqual([]);
    expect(dA.refused).toEqual([]);

    const rowA = rowFor(dbA, 'p', 'coding_guidelines.md');
    expect(rowA).toBeDefined();
    // The row carries the file's bytes, not a summary of them.
    expect(rowA!.content).toBe(REAL_SHAPE_DOC);
    // The hash is the same shape igris_context_register writes on this column
    // (sha256, first 16 hex chars) — two writers, one column, one format.
    expect(rowA!.content_hash).toBe(SHA(REAL_SHAPE_DOC).slice(0, 16));

    // --- 3. The REPLICATION HOP, through the REAL merge function. ----------
    // `mergeRows` is the code path BOTH `POST /sync/push` (processSyncPush) and
    // the CLI's boot-sync `mergePulledTables` run. A hand-copy of the row would
    // prove nothing about the declared column set; this proves the row survives
    // the transport that actually carries it.
    const cfg = SYNC_TABLES.find((t) => t.table === 'context_files');
    expect(cfg, 'context_files must be in SYNC_TABLES').toBeDefined();
    const wireRows = dbA.prepare(
      `SELECT ${cfg!.columns.join(', ')} FROM context_files WHERE project_slug = ?`,
    ).all('p') as Record<string, unknown>[];
    // What crosses the wire is exactly the declared set — `file_path` does not.
    expect(Object.keys(wireRows[0]).sort()).toEqual(
      ['content', 'content_hash', 'key', 'project_slug', 'updated_at'],
    );
    const merged = mergeRows(dbB, cfg!, wireRows);
    expect(merged.failed, JSON.stringify(merged.failures)).toBe(0);
    expect(merged.inserted).toBe(1);

    // --- 4. Machine B: the CLEAN-RESTORE condition. ------------------------
    // B has the row and NO context directory at all — the state a fresh
    // machine, or a restore, is actually in.
    expect(existsSync(join(rootB, 'projects', 'p', 'context'))).toBe(false);

    // --- 5. The CONSUMER: row -> disk. ------------------------------------
    const toolB = mountAt(rootB, dbB, bus, log);
    const dB = runSync(toolB, 'p');
    expect(dB.materialized).toEqual(['coding_guidelines.md']);
    expect(dB.absorbed).toEqual([]);
    expect(dB.backed_up).toEqual([]);

    const destPath = join(rootB, 'projects', 'p', 'context', 'coding_guidelines.md');
    expect(existsSync(destPath)).toBe(true);
    // BYTE identity, not length identity — the doc is full of non-ASCII.
    expect(Buffer.compare(readFileSync(srcPath), readFileSync(destPath))).toBe(0);
    // `file_path` did not travel: B rebuilt the path from its OWN root.
    expect(rowFor(dbB, 'p', 'coding_guidelines.md')!.file_path).toBeNull();
    expect(destPath.startsWith(rootB)).toBe(true);
  });

  it('the round trip is idempotent: a second pass on both machines writes nothing', () => {
    putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);
    const toolA = mountAt(rootA, dbA, bus, log);
    runSync(toolA, 'p');
    const stampAfterFirst = rowFor(dbA, 'p', 'coding_guidelines.md')!.updated_at;

    const second = runSync(toolA, 'p');
    expect(second.unchanged).toEqual(['coding_guidelines.md']);
    expect(second.absorbed).toEqual([]);
    expect(second.materialized).toEqual([]);
    // No re-absorb means no `updated_at` bump, which means no spurious delta
    // for the push watermark to carry every session.
    expect(rowFor(dbA, 'p', 'coding_guidelines.md')!.updated_at).toBe(stampAfterFirst);
  });

  // -------------------------------------------------------------------------
  // AC-4 — byte identity, proved by comparing BYTES.
  // -------------------------------------------------------------------------

  it('the stored row is byte-identical to the file, em-dashes included', () => {
    const p = putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);
    const toolA = mountAt(rootA, dbA, bus, log);
    runSync(toolA, 'p');

    const row = rowFor(dbA, 'p', 'coding_guidelines.md')!;
    const diskBytes = readFileSync(p);

    // The evidence: a byte comparison of the row's content against the file.
    expect(Buffer.compare(Buffer.from(row.content, 'utf-8'), diskBytes)).toBe(0);
    expect(SHA(row.content)).toBe(SHA(readFileSync(p, 'utf-8')));

    // The trap, recorded rather than relied on: the CHARACTER count and the
    // BYTE count differ for this content, so a `length()`-based check would
    // have passed on a truncated or re-encoded value.
    const chars = dbA.prepare('SELECT length(content) AS n FROM context_files WHERE key = ?')
      .get('coding_guidelines.md') as { n: number };
    expect(chars.n).toBeLessThan(diskBytes.length);
  });

  // -------------------------------------------------------------------------
  // The reconciler's action table (§D-1) — the arm that is NOT brief_files'.
  // -------------------------------------------------------------------------

  it('local-newer ABSORBS (disk -> row) instead of refusing, and emits context.registered', () => {
    // Machine A already replicated the doc; the operator then edits the FILE
    // with a plain Edit (the /hunt and /promote case — no brain tool involved).
    putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);
    const toolA = mountAt(rootA, dbA, bus, log);
    runSync(toolA, 'p');

    const emitted: { project: string; key: string }[] = [];
    bus.on('context.registered', (payload) => {
      emitted.push(payload.data as unknown as { project: string; key: string });
    });

    const edited = `${REAL_SHAPE_DOC}\nA later edit — made on disk, by no brain tool.\n`;
    putDoc(rootA, 'p', 'coding_guidelines.md', edited); // mtime = now

    const d = runSync(toolA, 'p');

    // brief_files would REFUSE and freeze here. Freezing is the TD-460 defect
    // one layer up: the replica would rot while looking healthy.
    expect(d.absorbed).toEqual(['coding_guidelines.md']);
    expect(d.materialized).toEqual([]);
    expect(rowFor(dbA, 'p', 'coding_guidelines.md')!.content).toBe(edited);
    // The emit is what makes it reach the VPS: sync's onImmediateEvent pushes
    // `context_files` on exactly this event.
    expect(emitted).toEqual([{ project: 'p', key: 'coding_guidelines.md' }]);
  });

  it('brain-newer materialises and BACKS UP the prior disk bytes first', () => {
    // A doc arrives from another machine while this machine holds an older
    // divergent copy.
    const older = new Date('2026-09-01T09:00:00Z');
    putDoc(rootB, 'p', 'coding_guidelines.md', 'stale local copy — older\n', older);
    dbB.prepare(
      `INSERT INTO context_files (project_slug, key, content, content_hash, updated_at)
       VALUES ('p', 'coding_guidelines.md', ?, ?, '2026-09-01 10:00:00')`,
    ).run(REAL_SHAPE_DOC, SHA(REAL_SHAPE_DOC).slice(0, 16));

    const toolB = mountAt(rootB, dbB, bus, log);
    const d = runSync(toolB, 'p');

    expect(d.materialized).toEqual(['coding_guidelines.md']);
    expect(d.backed_up).toEqual(['coding_guidelines.md']);

    const backupDir = join(rootB, 'projects', 'p', 'context-backups');
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    // The losing prose survives on the machine that held it. This is the whole
    // reason LWW is acceptable here: the failure is recoverable, not silent.
    expect(readFileSync(join(backupDir, backups[0]), 'utf-8')).toBe('stale local copy — older\n');
    expect(readFileSync(join(rootB, 'projects', 'p', 'context', 'coding_guidelines.md'), 'utf-8'))
      .toBe(REAL_SHAPE_DOC);
  });

  it('an unchanged doc does not bump its file mtime', () => {
    const older = new Date('2026-09-01T09:00:00Z');
    const p = putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC, older);
    const toolA = mountAt(rootA, dbA, bus, log);
    runSync(toolA, 'p');
    const before = statSync(p).mtimeMs;
    expect(runSync(toolA, 'p').unchanged).toEqual(['coding_guidelines.md']);
    expect(statSync(p).mtimeMs).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Scan scope and failure containment.
  // -------------------------------------------------------------------------

  it('scans exactly the *.md set the bundle carries, and no other file', () => {
    putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);
    putDoc(rootA, 'p', 'architecture_map.md', '# Map\n');
    putDoc(rootA, 'p', 'notes.txt', 'not a context doc\n');
    // A backup taken by an earlier run lives in a SIBLING dir, so it is not a
    // candidate — but a stray .bak inside context/ must not be one either.
    putDoc(rootA, 'p', 'coding_guidelines.md.2026-01-01.bak', 'old\n');

    const d = runSync(mountAt(rootA, dbA, bus, log), 'p');
    // Same filter as export.ts readContextDocs: the two transports carry the
    // same population, so they cannot disagree about which docs exist.
    expect(d.absorbed).toEqual(['architecture_map.md', 'coding_guidelines.md']);
  });

  it('a missing context directory is a clean no-op, not an error', () => {
    const d = runSync(mountAt(rootA, dbA, bus, log), 'p');
    expect(d).toMatchObject({
      project: 'p', absorbed: [], materialized: [], unchanged: [], backed_up: [], refused: [],
    });
  });

  it('one bad row is REFUSED per-doc; the good docs on either side still reconcile', () => {
    // A `key` that escapes the project dir — the traversal guard's job. It is
    // reachable only from a hand-edited or hostile row, which is exactly why
    // it must not abort the whole reconcile (a partial-failure fixture needs a
    // good item AFTER the bad one).
    putDoc(rootA, 'p', 'architecture_map.md', '# Map\n');
    for (const [key, content] of [['../escape.md', 'x'], ['zz_last.md', '# Last\n']]) {
      dbA.prepare(
        `INSERT INTO context_files (project_slug, key, content, content_hash, updated_at)
         VALUES ('p', ?, ?, 'h', '2026-09-01 10:00:00')`,
      ).run(key, content);
    }

    const d = runSync(mountAt(rootA, dbA, bus, log), 'p');

    expect(d.refused).toHaveLength(1);
    expect(d.refused[0].key).toBe('../escape.md');
    expect(d.refused[0].reason).toMatch(/Invalid path segment/);
    // Both good docs were still processed, and BOTH sit AFTER the bad key: the
    // keys are walked sorted and '../escape.md' sorts first ('.' 0x2E < 'a' < 'z'),
    // so nothing in this fixture precedes it. What that proves is the loop
    // CONTINUES past a refusal rather than aborting the project — which is the
    // property at issue; a doc positioned before the bad key would have been
    // processed before the throw either way.
    expect(d.absorbed).toEqual(['architecture_map.md']);
    expect(d.materialized).toEqual(['zz_last.md']);
    // Nothing escaped the project root.
    expect(existsSync(join(rootA, 'projects', 'escape.md'))).toBe(false);
    expect(readdirSync(contextDocDir('p')).sort()).toEqual(['architecture_map.md', 'zz_last.md']);
  });

  it('force materialises over a locally-newer file (backing it up), instead of absorbing', () => {
    putDoc(rootA, 'p', 'coding_guidelines.md', REAL_SHAPE_DOC);
    const toolA = mountAt(rootA, dbA, bus, log);
    runSync(toolA, 'p');
    putDoc(rootA, 'p', 'coding_guidelines.md', 'local divergence\n'); // now

    const d = runSync(toolA, 'p', true);

    expect(d.materialized).toEqual(['coding_guidelines.md']);
    expect(d.backed_up).toEqual(['coding_guidelines.md']);
    expect(d.absorbed).toEqual([]);
    expect(readFileSync(join(rootA, 'projects', 'p', 'context', 'coding_guidelines.md'), 'utf-8'))
      .toBe(REAL_SHAPE_DOC);
  });

  it('the tool declares the strict-input contract the gateway enforces', () => {
    const tool = mountAt(rootA, dbA, bus, log);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(['project']);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['force', 'project']);
  });
});
