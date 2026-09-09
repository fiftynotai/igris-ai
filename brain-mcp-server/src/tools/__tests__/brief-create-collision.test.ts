/**
 * TD-395 — the create-collision guard on `igris_brief_create`.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Brief-id allocation is client-side (`max+1` from a read), so two sessions
 * that both read before either writes mint the SAME id. Both statements in
 * `handleBriefCreate` were `ON CONFLICT ... DO UPDATE` upserts, so the loser's
 * brief was destroyed with NO error on either table. TD-395's incident table
 * records four occurrences on igris-ai — TD-387, TD-402, TD-403, FR-261 — the
 * last of which left no recoverable copy in the brain.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 *  - the race shape (same id, DIFFERENT content) is refused, and the FIRST
 *    brief's rows are still intact afterwards — asserted on the ROWS, because
 *    a return value cannot tell you what is in the table;
 *  - an identical re-create still SUCCEEDS (idempotency is what `/register`
 *    replays and the offline queue drain depend on);
 *  - the refusal names the NEXT FREE ID, derived over BOTH tables;
 *  - `igris_brief_update` still rewrites content, which is its job.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That two OS processes racing on one file cannot both reach the INSERT.
 *    The guard turns a silent overwrite into a refusal the loser can retry
 *    from; it does not make the id allocation atomic. TD-395's option 2
 *    (server-side allocation) would, and is DEFERRED: it changes the tool's
 *    input contract, and every skill that names an id in prose before calling
 *    would have to be swept. Option 3 (overwrite history) is DEFERRED too —
 *    with the write refused there is no longer an overwrite to recover from,
 *    and it would grow the brain on every create.
 *  - Anything about the `brief.created` emit — that is the component-level
 *    describe block at the bottom of this file.
 *
 * @module tools/__tests__/brief-create-collision.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) => Buffer.from(e.buffer)),
  processInBatches: vi.fn(async () => ({ succeeded: 0, failed: 0 })),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

// The embed/similarity block is OFF for this suite: `isVectorSearchAvailable`
// returns false, so `handleBriefCreate` skips it entirely. That keeps every
// assertion below about the two tables and nothing else.
vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbeddingInto: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import { handleBriefCreate, handleBriefUpdate, nextFreeBriefId } from '../briefs.js';
import { createBriefsComponent } from '../../engine/components/briefs/index.js';
import type { ComponentContext } from '../../engine/types.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      UNIQUE(project, brief_id)
    );

    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);
  return db;
}

const PROJECT = 'igris-ai';

/** Session A's brief — the body a racing second create used to destroy. */
const BODY_A = '# TD-001 — the repo-URL feature\n\nSession A wrote this body.\n';
/** Session B's brief — a DIFFERENT brief that raced onto the same id. */
const BODY_B = '# TD-001 — a Canvas brief\n\nSession B wrote this, minutes later.\n';

interface FileRow {
  content: string;
  content_hash: string;
  filename: string;
}
interface StatusRow {
  title: string;
  priority: string | null;
  status: string;
}

function fileRow(db: Database.Database, briefId: string): FileRow | undefined {
  return db
    .prepare('SELECT content, content_hash, filename FROM brief_files WHERE project = ? AND brief_id = ?')
    .get(PROJECT, briefId) as FileRow | undefined;
}

function statusRow(db: Database.Database, briefId: string): StatusRow | undefined {
  return db
    .prepare('SELECT title, priority, status FROM brief_status WHERE project = ? AND brief_id = ?')
    .get(PROJECT, briefId) as StatusRow | undefined;
}

function rowCounts(db: Database.Database): { files: number; status: number } {
  return {
    files: (db.prepare('SELECT COUNT(*) AS n FROM brief_files').get() as { n: number }).n,
    status: (db.prepare('SELECT COUNT(*) AS n FROM brief_status').get() as { n: number }).n,
  };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const textOf = (r: ToolResult): string => r.content[0].text;

/** Session A mints TD-001. Returns nothing; assert on the rows. */
async function createA(briefId = 'TD-001'): Promise<ToolResult> {
  return (await handleBriefCreate({
    project: PROJECT,
    brief_id: briefId,
    title: 'Repo URL on the project record',
    content: BODY_A,
    brief_type: 'Feature',
    priority: 'P2',
  })) as ToolResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TD-395 — igris_brief_create refuses a colliding id', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as never);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  /**
   * THE RACE SHAPE. This is the incident, reduced: two sessions, one id, two
   * different bodies. Before the guard the second call returned
   * "Brief created successfully." and `brief_files.content` held BODY_B —
   * session A's brief was gone with no error anywhere.
   *
   * The row assertions are the load-bearing ones. A guard that refused in its
   * RETURN VALUE while still writing one of the two tables would pass a
   * message-only test and make the failure mode worse (that is the TD-402
   * chimera: metadata from one brief over the body of another).
   */
  it('refuses the second create and leaves BOTH tables holding the first brief', async () => {
    await createA();
    const before = fileRow(db, 'TD-001');
    expect(before?.content).toBe(BODY_A);

    const second = (await handleBriefCreate({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Canvas rendering for the dashboard',
      content: BODY_B,
      brief_type: 'Feature',
      priority: 'P1',
    })) as ToolResult;

    // 1. It refused, machine-detectably.
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('Refused: brief id collision');

    // 2. brief_files is untouched — content AND hash, not just content.
    const after = fileRow(db, 'TD-001');
    expect(after?.content).toBe(BODY_A);
    expect(after?.content_hash).toBe(before?.content_hash);

    // 3. brief_status is untouched — the chimera check. `priority` is asserted
    //    as well as `title` because TD-365's ON CONFLICT arm blanks the
    //    secondary metadata columns, so a half-applied write shows up here.
    const status = statusRow(db, 'TD-001');
    expect(status?.title).toBe('Repo URL on the project record');
    expect(status?.priority).toBe('P2-Medium');

    // 4. Nothing was inserted anywhere either.
    expect(rowCounts(db)).toEqual({ files: 1, status: 1 });
  });

  /** The refusal has to be usable: the existing title identifies what is there. */
  it('names the existing brief and both content hashes', async () => {
    await createA();
    const existingHash = fileRow(db, 'TD-001')!.content_hash;

    const second = (await handleBriefCreate({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Canvas rendering for the dashboard',
      content: BODY_B,
    })) as ToolResult;

    const text = textOf(second);
    expect(text).toContain('Repo URL on the project record');
    expect(text).toContain(existingHash.substring(0, 12));
  });

  /**
   * THE POINT OF THE MESSAGE. A caller told only "that id is taken" must
   * re-derive the next id — by re-running the very read that lost the race.
   * So the refusal names the id to re-mint on, and it is derived over BOTH
   * tables: a body-less `brief_status` row (what `igris_brief_sync` and a
   * remote pull leave behind) still holds its id.
   */
  it('names the next free id, derived over brief_files AND brief_status', async () => {
    await createA();
    // A metadata-only row at a HIGHER number — invisible to a brief_files-only
    // scan, and handing it out as "free" would mint the next collision.
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, 'TD-009', 'body-less row', 'Ready')`,
    ).run(PROJECT);

    const second = (await handleBriefCreate({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Canvas rendering for the dashboard',
      content: BODY_B,
    })) as ToolResult;

    expect(textOf(second)).toContain('TD-010');
    // ...and the id it named is genuinely free in both tables.
    expect(fileRow(db, 'TD-010')).toBeUndefined();
    expect(statusRow(db, 'TD-010')).toBeUndefined();
  });

  /**
   * IDEMPOTENCY. `/register` replays and the offline `sync data` queue drain
   * re-issue the SAME create. A guard that broke this would trade one data
   * loss for another, so an identical re-create is not a collision.
   */
  it('allows an identical re-create (same content hash)', async () => {
    await createA();
    const replay = await createA();

    expect(replay.isError).toBeFalsy();
    expect(textOf(replay)).toContain('Brief created successfully');
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_A);
    expect(rowCounts(db)).toEqual({ files: 1, status: 1 });
  });

  /**
   * THE RECORDED DECISION: the guard keys on CONTENT, not on metadata. Same
   * body + a corrected title upserts, because that is the shape TD-402's own
   * recovery needed (its title described a different brief than its body) and
   * because no content can be lost on that path.
   */
  it('upserts metadata when the content hash matches', async () => {
    await createA();

    const fix = (await handleBriefCreate({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Repo URL on the project record (corrected)',
      content: BODY_A,
      priority: 'P1',
    })) as ToolResult;

    expect(fix.isError).toBeFalsy();
    expect(statusRow(db, 'TD-001')?.title).toBe('Repo URL on the project record (corrected)');
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_A);
  });

  /**
   * THE STATED LIMIT, pinned so it cannot drift into a silent refusal. A
   * `brief_status` row with no `brief_files` row holds no content, so a create
   * there destroys nothing — and refusing would break the legitimate
   * "status arrived first (remote pull / `igris_brief_sync`), body follows"
   * path. Metadata-only collision is NOT guarded; that is a limit, not a bug.
   */
  it('creates over a body-less brief_status row', async () => {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, 'TD-001', 'pulled title', 'Ready')`,
    ).run(PROJECT);

    const created = await createA();

    expect(created.isError).toBeFalsy();
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_A);
    expect(statusRow(db, 'TD-001')?.title).toBe('Repo URL on the project record');
  });

  /** A first create on an empty brain is not a collision. */
  it('creates normally when nothing exists', async () => {
    const created = await createA();
    expect(created.isError).toBeFalsy();
    expect(rowCounts(db)).toEqual({ files: 1, status: 1 });
  });

  /**
   * An id outside the `PREFIX-NNN` shape still gets the protection — only the
   * next-free-id line degrades, because there is no family to count within.
   */
  it('refuses a non PREFIX-NNN id and says it cannot name a successor', async () => {
    await createA('spike-notes');

    const second = (await handleBriefCreate({
      project: PROJECT,
      brief_id: 'spike-notes',
      title: 'Something else',
      content: BODY_B,
    })) as ToolResult;

    expect(second.isError).toBe(true);
    expect(fileRow(db, 'spike-notes')?.content).toBe(BODY_A);
    expect(textOf(second)).toContain('not a PREFIX-NNN id');
  });

  /**
   * THE COMPLEMENT. `igris_brief_update` is the tool that legitimately
   * rewrites a brief; the guard must not reach it. Pinned, not assumed — an
   * over-broad guard here would break every `/hunt` that edits a brief body.
   */
  it('does not touch igris_brief_update, which still rewrites content', async () => {
    await createA();

    const updated = handleBriefUpdate({
      project: PROJECT,
      brief_id: 'TD-001',
      content: BODY_B,
      title: 'Retitled by update',
    }) as ToolResult;

    expect(updated.isError).toBeFalsy();
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_B);
    expect(statusRow(db, 'TD-001')?.title).toBe('Retitled by update');
  });

  /** A collision in ANOTHER project is not this project's collision. */
  it('scopes the guard to (project, brief_id)', async () => {
    await createA();

    const other = (await handleBriefCreate({
      project: 'moca-ai-agent',
      brief_id: 'TD-001',
      title: 'A different project entirely',
      content: BODY_B,
    })) as ToolResult;

    expect(other.isError).toBeFalsy();
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_A);
  });
});

describe('TD-395 — nextFreeBriefId', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  const seedStatus = (briefId: string, project = PROJECT): void => {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, 'x', 'Ready')`,
    ).run(project, briefId);
  };
  const seedFile = (briefId: string, project = PROJECT): void => {
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
       VALUES (?, ?, ?, 'x.md', 'x', 'h')`,
    ).run(`${project}:${briefId}`, project, briefId);
  };

  it('returns the max of the family plus one', () => {
    seedStatus('TD-001');
    seedStatus('TD-007');
    expect(nextFreeBriefId(db, PROJECT, 'TD-001')).toBe('TD-008');
  });

  it('counts ids that exist only in brief_files', () => {
    seedStatus('TD-001');
    seedFile('TD-042');
    expect(nextFreeBriefId(db, PROJECT, 'TD-001')).toBe('TD-043');
  });

  it('ignores other prefixes and other projects', () => {
    seedStatus('TD-001');
    seedStatus('FR-900');
    seedStatus('TD-500', 'moca-ai-agent');
    expect(nextFreeBriefId(db, PROJECT, 'TD-001')).toBe('TD-002');
  });

  it('preserves the zero padding of the id it was asked about', () => {
    seedStatus('TD-0001');
    expect(nextFreeBriefId(db, PROJECT, 'TD-0001')).toBe('TD-0002');
  });

  it('is total for an id that is not present at all', () => {
    expect(nextFreeBriefId(db, PROJECT, 'TD-050')).toBe('TD-051');
  });

  it('returns null for an id outside the PREFIX-NNN shape', () => {
    expect(nextFreeBriefId(db, PROJECT, 'spike-notes')).toBeNull();
  });
});

/**
 * The emit gate. `igris_brief_create`'s component handler emits `brief.created`
 * AFTER the handler returns, and several components listen — derive the set
 * with `grep -rn "bus.on('brief.created'" src/engine/components` rather than
 * trusting a number here. `cache` warms a file cache, `edges` writes a
 * `parent_of` edge, `monitoring` INSERTs into event_log, and `sync` pushes the
 * brief's rows to the remote brain. Emitting on a REFUSED create would push the
 * OTHER session's brief off the machine under the refused brief's event — a
 * write, and an egress, for a brief that was not created.
 */
describe('TD-395 — a refused create emits no brief.created', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as never);
  });
  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  function componentWithBus(): {
    call: (args: Record<string, unknown>) => Promise<ToolResult>;
    emitted: { event: string; payload: unknown }[];
  } {
    const emitted: { event: string; payload: unknown }[] = [];
    const component = createBriefsComponent();
    component.init!({
      storage: {} as never,
      bus: {
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
        on: () => undefined,
        off: () => undefined,
      } as unknown as ComponentContext['bus'],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      config: {},
    });
    const tool = component.tools!().find((t) => t.name === 'igris_brief_create')!;
    return {
      call: (args) => tool.handler(args) as Promise<ToolResult>,
      emitted,
    };
  }

  it('emits on a successful create and not on a refused one', async () => {
    const { call, emitted } = componentWithBus();

    const first = await call({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Repo URL on the project record',
      content: BODY_A,
    });
    expect(first.isError).toBeFalsy();
    // Arm check: without this the "no emit" assertion below is satisfiable by
    // a bus that never receives anything.
    expect(emitted.map((e) => e.event)).toEqual(['brief.created']);

    const second = await call({
      project: PROJECT,
      brief_id: 'TD-001',
      title: 'Canvas rendering for the dashboard',
      content: BODY_B,
    });
    expect(second.isError).toBe(true);
    expect(emitted.map((e) => e.event)).toEqual(['brief.created']);
    expect(fileRow(db, 'TD-001')?.content).toBe(BODY_A);
  });
});
