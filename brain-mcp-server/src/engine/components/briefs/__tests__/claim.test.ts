/**
 * Briefs Component — claim/release behavior tests (FR-127)
 *
 * Verifies the atomic brief-claim gate: handleBriefClaim + handleBriefRelease.
 *
 * The core invariant is the concurrent-claim proof — two instances claiming
 * the SAME brief: the first succeeds, the second's conditional UPDATE affects
 * 0 rows and returns claimed=false. This is the multi-harness hard gate.
 *
 * @module engine/components/briefs/__tests__/claim.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock the db module so the FR-127 handlers resolve getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../../../db.js';
import { handleBriefClaim, handleBriefRelease } from '../handlers.js';
import { briefMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Legacy `brief_status` DDL — byte-equivalent to `db.ts` schema_version v2.
 * The briefs v2 migration only ALTERs this table; the test creates it first
 * (reproducing the legacy-migrateSchema-before-component-migrations ordering).
 */
const LEGACY_BRIEF_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
`;

/** Create an in-memory DB with brief_status + briefMigrations applied. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(LEGACY_BRIEF_STATUS_DDL);
  for (const migration of briefMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

/** Insert a brief_status row with sensible defaults. */
function insertBrief(
  db: Database.Database,
  briefId: string,
  project = 'igris-ai',
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status)
     VALUES (?, ?, ?, 'Ready')`,
  ).run(project, briefId, `Brief ${briefId}`);
}

const INSTANCE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INSTANCE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Parse a handler's JSON success payload. */
function payloadOf(result: { content: { text: string }[]; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FR-127 brief claim/release gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------

  it('unclaimed brief -> claim succeeds, columns set, reentrant false', () => {
    insertBrief(db, 'FR-001');

    const result = handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-001',
      instance_id: INSTANCE_A,
    });
    expect(result.isError).toBeFalsy();

    const payload = payloadOf(result);
    expect(payload.claimed).toBe(true);
    expect(payload.reentrant).toBe(false);
    expect(payload.claimed_by).toBe(INSTANCE_A);
    expect(payload.claimed_at).toBeTruthy();

    const row = db
      .prepare(`SELECT claimed_by, claimed_at FROM brief_status WHERE brief_id = 'FR-001'`)
      .get() as { claimed_by: string; claimed_at: string };
    expect(row.claimed_by).toBe(INSTANCE_A);
    expect(row.claimed_at).toBeTruthy();
  });

  it('concurrent-claim proof (AC): a 2nd instance cannot claim a brief A holds', () => {
    insertBrief(db, 'FR-002');

    const first = payloadOf(handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-002',
      instance_id: INSTANCE_A,
    }));
    expect(first.claimed).toBe(true);

    // Instance B attempts the SAME brief — the conditional UPDATE affects 0
    // rows. The hard gate: B gets claimed=false and cannot proceed.
    const second = handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-002',
      instance_id: INSTANCE_B,
    });
    expect(second.isError).toBeFalsy(); // claimed=false is a SUCCESS, not an error
    const secondPayload = payloadOf(second);
    expect(secondPayload.claimed).toBe(false);
    expect(secondPayload.reentrant).toBe(false);
    expect(secondPayload.held_by).toBe(INSTANCE_A);
    expect(secondPayload.held_since).toBeTruthy();

    // A's claim is untouched.
    const row = db
      .prepare(`SELECT claimed_by FROM brief_status WHERE brief_id = 'FR-002'`)
      .get() as { claimed_by: string };
    expect(row.claimed_by).toBe(INSTANCE_A);
  });

  it('re-entrancy (AC): the same instance re-claiming gets claimed=true, reentrant=true', () => {
    insertBrief(db, 'FR-003');

    const first = payloadOf(handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-003',
      instance_id: INSTANCE_A,
    }));
    expect(first.claimed).toBe(true);
    expect(first.reentrant).toBe(false);
    const firstClaimedAt = first.claimed_at;

    // Re-claim by the SAME instance — predicate (claimed_by = self) is true.
    const second = payloadOf(handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-003',
      instance_id: INSTANCE_A,
    }));
    expect(second.claimed).toBe(true);
    expect(second.reentrant).toBe(true);
    // claimed_at is refreshed and is a valid ISO timestamp >= the first.
    expect(second.claimed_at >= firstClaimedAt).toBe(true);
  });

  it('claim of a non-existent brief returns errorResult', () => {
    const result = handleBriefClaim({
      project: 'igris-ai',
      brief_id: 'FR-DOES-NOT-EXIST',
      instance_id: INSTANCE_A,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Brief not found');
  });

  it('claim with missing fields returns errorResult', () => {
    const result = handleBriefClaim({ project: 'igris-ai', brief_id: 'FR-001' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required fields');
  });

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  it('release by owner -> released=true, claimed_by back to NULL', () => {
    insertBrief(db, 'FR-010');
    handleBriefClaim({ project: 'igris-ai', brief_id: 'FR-010', instance_id: INSTANCE_A });

    const result = handleBriefRelease({
      project: 'igris-ai',
      brief_id: 'FR-010',
      instance_id: INSTANCE_A,
    });
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).released).toBe(true);

    const row = db
      .prepare(`SELECT claimed_by, claimed_at FROM brief_status WHERE brief_id = 'FR-010'`)
      .get() as { claimed_by: string | null; claimed_at: string | null };
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it('release scoped to owner: B cannot release A\'s claim', () => {
    insertBrief(db, 'FR-011');
    handleBriefClaim({ project: 'igris-ai', brief_id: 'FR-011', instance_id: INSTANCE_A });

    const result = handleBriefRelease({
      project: 'igris-ai',
      brief_id: 'FR-011',
      instance_id: INSTANCE_B,
    });
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).released).toBe(false); // not B's claim

    // A's claim is untouched.
    const row = db
      .prepare(`SELECT claimed_by FROM brief_status WHERE brief_id = 'FR-011'`)
      .get() as { claimed_by: string };
    expect(row.claimed_by).toBe(INSTANCE_A);
  });

  it('idempotent release: releasing a brief with no claim is a success (released=false)', () => {
    insertBrief(db, 'FR-012');

    const result = handleBriefRelease({
      project: 'igris-ai',
      brief_id: 'FR-012',
      instance_id: INSTANCE_A,
    });
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).released).toBe(false);
  });

  it('release of a non-existent brief returns errorResult', () => {
    const result = handleBriefRelease({
      project: 'igris-ai',
      brief_id: 'FR-DOES-NOT-EXIST',
      instance_id: INSTANCE_A,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Brief not found');
  });

  it('release with missing fields returns errorResult', () => {
    const result = handleBriefRelease({ project: 'igris-ai', brief_id: 'FR-012' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required fields');
  });

  // -------------------------------------------------------------------------
  // Handoff sequences
  // -------------------------------------------------------------------------

  it('sequential handoff (AC): A claims -> A releases -> B claims the same brief cleanly', () => {
    insertBrief(db, 'FR-020');

    expect(payloadOf(handleBriefClaim({
      project: 'igris-ai', brief_id: 'FR-020', instance_id: INSTANCE_A,
    })).claimed).toBe(true);

    expect(payloadOf(handleBriefRelease({
      project: 'igris-ai', brief_id: 'FR-020', instance_id: INSTANCE_A,
    })).released).toBe(true);

    const bClaim = payloadOf(handleBriefClaim({
      project: 'igris-ai', brief_id: 'FR-020', instance_id: INSTANCE_B,
    }));
    expect(bClaim.claimed).toBe(true);
    expect(bClaim.reentrant).toBe(false);
    expect(bClaim.claimed_by).toBe(INSTANCE_B);
  });

  it('stale-reclaim sequence: release(staleHolder) then claim(newInstance) succeeds', () => {
    // Simulates /hunt step 6.5's operator-confirmed reclaim: the skill
    // releases with the STALE holder's instance_id, then claims with its own.
    insertBrief(db, 'FR-030');
    handleBriefClaim({ project: 'igris-ai', brief_id: 'FR-030', instance_id: INSTANCE_A });

    // Operator confirms reclaim — /hunt releases with the stale holder's id.
    expect(payloadOf(handleBriefRelease({
      project: 'igris-ai', brief_id: 'FR-030', instance_id: INSTANCE_A,
    })).released).toBe(true);

    // Then claims with the new (live) instance's id.
    const reclaim = payloadOf(handleBriefClaim({
      project: 'igris-ai', brief_id: 'FR-030', instance_id: INSTANCE_B,
    }));
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.claimed_by).toBe(INSTANCE_B);
  });
});
