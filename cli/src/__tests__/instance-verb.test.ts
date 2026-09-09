/**
 * TD-411 (C2) — `igris instance list` payload self-consistency.
 *
 * The defect these tests pin: `runInstance`'s list action spread the DB row and
 * merely ADDED a derived `liveness` object, so the JSON carried BOTH the stored
 * `liveness_status` (a write-time stamp, stale the moment the harness exits)
 * and the freshly derived `liveness.status`. `core/skills/hunt/SKILL.md` step 6
 * renders `{liveness_status}` by exactly that name, so `/hunt` could advertise
 * an exited harness as a live sibling holding a brief — the TD-411 symptom
 * surviving on a CLI-side surface.
 *
 * The fixture is DISCRIMINATING by construction: every seeded row stores
 * `liveness_status='alive'` while its owner metadata classifies as something
 * else. An arm check asserts the stored value really is `alive` before the
 * payload is inspected, so a fixture that quietly stopped disagreeing with the
 * classifier turns this file red rather than green.
 *
 * Real seeded brain DB via IGRIS_BRAIN_DIR (never a mock — #159); stdout is
 * captured from the real `process.stdout.write` the verb emits, so what is
 * asserted is the emitted payload and not an intermediate value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";

/** A pid that cannot be running (above every platform's pid_max). */
const DEAD_PID = 999_999_999;

const INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    machine_hostname TEXT NOT NULL,
    machine_os TEXT,
    project_slug TEXT,
    project_path TEXT,
    current_brief TEXT,
    current_phase TEXT,
    current_task TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
  ALTER TABLE instances ADD COLUMN harness TEXT;
  ALTER TABLE instances ADD COLUMN harness_session_id TEXT;
  ALTER TABLE instances ADD COLUMN owner_pid INTEGER;
  ALTER TABLE instances ADD COLUMN owner_started_at TEXT;
  ALTER TABLE instances ADD COLUMN liveness_method TEXT;
  ALTER TABLE instances ADD COLUMN liveness_status TEXT;
  ALTER TABLE instances ADD COLUMN liveness_checked_at TEXT;
  ALTER TABLE instances ADD COLUMN lease_expires_at TEXT;
  ALTER TABLE instances ADD COLUMN state_updated_at TEXT;
`;

interface PayloadRow {
  id: string;
  liveness_status: string;
  liveness_method: string;
  liveness_checked_at: string;
  liveness: { status: string; method: string; checked_at: string };
  [key: string]: unknown;
}

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function withDb(fn: (db: Database.Database) => void): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  fn(db);
  db.close();
}

/**
 * Seed two rows, both STORING `alive` and both classifying as something else:
 *
 *  - `i-local` is on THIS machine with a dead owner pid → derives `dead`.
 *  - `i-remote` is on another machine → derives `unknown_remote`, the class a
 *    peer machine's stored stamp gets wrong in the worse direction.
 */
function seedTwoStaleStamps(): void {
  withDb((db) => {
    db.exec(INSTANCES_DDL);
    const ins = db.prepare(
      `INSERT INTO instances
         (id, machine_hostname, project_slug, status, harness, owner_pid,
          owner_started_at, liveness_method, liveness_status, liveness_checked_at)
       VALUES (?, ?, ?, 'active', 'claude', ?, ?, 'pid_start_time', 'alive', '2020-01-01 00:00:00')`,
    );
    ins.run("i-local", hostname(), SLUG, DEAD_PID, "Fri Aug 21 12:52:34 2026");
    ins.run("i-remote", "some-other-host", SLUG, 4242, "Fri Aug 21 12:52:34 2026");
  });
}

/** Read the STORED stamps back — the arm check for the fixture. */
function storedStatuses(): Record<string, string | null> {
  const db = new Database(dbFile(), { readonly: true });
  const rows = db
    .prepare("SELECT id, liveness_status FROM instances")
    .all() as { id: string; liveness_status: string | null }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.id, r.liveness_status]));
}

/** Run `instance list` and parse the JSON the verb wrote to stdout. */
async function listPayload(): Promise<{ degraded: boolean; instances: PayloadRow[] }> {
  const { runInstance } = await import("../verbs/instance.js");
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    const code = runInstance({ action: "list", project: SLUG });
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join("").trim());
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-instance-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
  vi.restoreAllMocks();
});

describe("instance list — the payload carries the DERIVED liveness only (TD-411 C2)", () => {
  it("overwrites the stored stamp: a dead owner pid reads `dead`, never the stored `alive`", async () => {
    seedTwoStaleStamps();

    // ARM CHECK. Everything below is vacuous unless the stored stamp genuinely
    // disagrees with the classifier.
    expect(storedStatuses()).toEqual({ "i-local": "alive", "i-remote": "alive" });

    const payload = await listPayload();
    expect(payload.degraded).toBe(false);

    const local = payload.instances.find((r) => r.id === "i-local");
    expect(local).toBeDefined();
    // The key `/hunt` step 6 renders. Before the fix this was "alive".
    expect(local?.liveness_status).toBe("dead");
    expect(local?.liveness.status).toBe("dead");
    // ...and the two other stamp keys moved with it.
    expect(local?.liveness_method).toBe("pid_start_time");
    expect(local?.liveness_checked_at).not.toBe("2020-01-01 00:00:00");
  });

  it("the remote row reads `unknown_remote`, not the peer's stored `alive`", async () => {
    seedTwoStaleStamps();
    expect(storedStatuses()["i-remote"]).toBe("alive");

    const payload = await listPayload();
    const remote = payload.instances.find((r) => r.id === "i-remote");
    expect(remote?.liveness_status).toBe("unknown_remote");
    expect(remote?.liveness.status).toBe("unknown_remote");
    expect(remote?.liveness_method).toBe("remote");
  });

  it("LEAK GUARD: every `liveness_`-prefixed key equals its derived counterpart, and there are exactly three", async () => {
    seedTwoStaleStamps();
    expect(storedStatuses()).toEqual({ "i-local": "alive", "i-remote": "alive" });

    const payload = await listPayload();
    expect(payload.instances.length).toBe(2);

    for (const row of payload.instances) {
      // A NEW stored `liveness_*` column that gets spread through un-overwritten
      // reds here, not just the three keys known today.
      const stampKeys = Object.keys(row)
        .filter((k) => k.startsWith("liveness_"))
        .sort();
      expect(stampKeys).toEqual([
        "liveness_checked_at",
        "liveness_method",
        "liveness_status",
      ]);
      expect({
        status: row.liveness_status,
        method: row.liveness_method,
        checked_at: row.liveness_checked_at,
      }).toEqual(row.liveness);
      // And no stamp key survived at the stored value.
      expect(row.liveness_status).not.toBe("alive");
      expect(row.liveness_checked_at).not.toBe("2020-01-01 00:00:00");
    }
  });
});
