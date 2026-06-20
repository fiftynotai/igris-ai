/**
 * FR-195 (M2) — housekeeping H0–H3 idempotency + crash-robustness matrix.
 *
 * The SECOND-highest-value test (the plan's 7-scenario matrix). Each scenario
 * seeds a real brain DB (IGRIS_BRAIN_DIR, never a mock — #159) + the on-disk
 * <IGRIS_BRAIN_DIR>/projects/<slug>/session/{,archive,instances}/ tree, runs
 * `runHousekeeping`, and asserts BOTH the DB state flips and the on-disk file
 * moves/rolls.
 *
 * The two hardest invariants this test proves:
 *   (a) H2 HEADER-GUARD idempotency: a digest pre-seeded with `## <filename>`
 *       (simulating a crash AFTER append, BEFORE delete) → the re-run SKIPS the
 *       append (no duplicate section) and converges (individual file gone).
 *   (b) H2 CRASH-SIM: rolling file A and leaving file B (a crash between two
 *       files) → a re-run completes B, and A is NOT double-rolled (its header
 *       appears exactly once in the month digest).
 *
 * Plus the Lock-2 testable property: H1 archives a rested file ONLY when a
 * newer rested file from a DIFFERENT instance proves it was consumed; an
 * ABANDONED-LIVE file is NEVER archived by H0/H1.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HousekeepingDigest } from "../types.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SESSION_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS session_files (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, filename)
  );
  ALTER TABLE session_files ADD COLUMN instance_id TEXT;
  ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live'
    CHECK (state IN ('live','rested','archived'));
`;

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
    last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
`;

const SLUG = "demo";

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function sessionDir(): string {
  return join(tmpRoot, "projects", SLUG, "session");
}
function archiveDir(): string {
  return join(sessionDir(), "archive");
}
function instancesDir(): string {
  return join(sessionDir(), "instances");
}

/** Seed DB schema (no rows). Caller adds rows via withDb. */
function seedSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(SESSION_FILES_DDL);
  db.exec(INSTANCES_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

function insertSessionFile(
  db: Database.Database,
  row: {
    id: string;
    filename: string;
    content?: string;
    instance_id?: string | null;
    state?: string;
    updated_at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    SLUG,
    row.filename,
    row.content ?? "body-" + row.id,
    "hash-" + row.id,
    row.updated_at ?? "2026-06-01 00:00:00",
    row.instance_id ?? null,
    row.state ?? "live",
  );
}

function readDbRow(
  filename: string,
): { state: string; instance_id: string | null } | undefined {
  const db = new Database(dbFile());
  const row = db
    .prepare("SELECT state, instance_id FROM session_files WHERE project = ? AND filename = ?")
    .get(SLUG, filename) as { state: string; instance_id: string | null } | undefined;
  db.close();
  return row;
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

async function run(opts: {
  rollDays?: number;
  ceiling?: number;
} = {}): Promise<HousekeepingDigest> {
  const { runHousekeeping } = await import("../verbs/housekeeping.js");
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    captured += typeof c === "string" ? c : c.toString();
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = runHousekeeping({ project: SLUG, ...opts });
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  expect(code).toBe(0);
  return JSON.parse(captured.trim()) as HousekeepingDigest;
}

/** Write an individual archive file and backdate its mtime by `daysAgo`. */
function writeArchiveFile(name: string, content: string, daysAgo: number): void {
  mkdirSync(archiveDir(), { recursive: true });
  const p = join(archiveDir(), name);
  writeFileSync(p, content, "utf-8");
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(p, when, when);
}

/** List the INDIVIDUAL archive files (exclude YYYY-MM.md digests). */
function individualArchiveFiles(): string[] {
  if (!existsSync(archiveDir())) return [];
  return readdirSync(archiveDir())
    .filter((n) => n.endsWith(".md") && !/^\d{4}-\d{2}\.md$/.test(n))
    .sort();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-housekeeping-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  for (const k of ["CLAUDECODE", "GEMINI_CLI", "CODEX_SESSION", "OPENCODE"]) {
    delete process.env[k];
  }
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// Scenario 7 — DB absent → degraded, exit 0 (never block). (Run first: cheapest.)
// ---------------------------------------------------------------------------
describe("housekeeping — degraded", () => {
  it("7. brain DB absent → degraded:true, noop:true, exit 0", async () => {
    // No seedSchema() → no DB file.
    const d = await run();
    expect(d.degraded).toBe(true);
    expect(d.noop).toBe(true);
    expect(d.h0_legacy_retired).toBe(false);
    expect(d.h1_archived).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — cost guard: empty archive + no rested → noop.
// ---------------------------------------------------------------------------
describe("housekeeping — cost guard", () => {
  it("6. empty archive + no rested files → noop:true, no writes", async () => {
    seedSchema();
    // Only a LIVE file (never touched by housekeeping).
    withDb((db) =>
      insertSessionFile(db, {
        id: "live",
        filename: "instances/i-live.md",
        instance_id: "i-live",
        state: "live",
      }),
    );
    const d = await run();
    expect(d.noop).toBe(true);
    expect(d.h0_legacy_retired).toBe(false);
    expect(d.h1_archived).toEqual([]);
    expect(d.h2_rolled).toBe(0);
    expect(d.h3_ceiling_rolled).toBe(0);
    // The LIVE row is UNTOUCHED.
    expect(readDbRow("instances/i-live.md")?.state).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Scenario 1 — H0 legacy retirement + run-twice idempotency.
// ---------------------------------------------------------------------------
describe("housekeeping — H0 legacy retirement", () => {
  it("1. legacy CURRENT_SESSION.md → archived + moved; run twice → no-op", async () => {
    seedSchema();
    withDb((db) =>
      insertSessionFile(db, {
        id: "legacy",
        filename: "CURRENT_SESSION.md",
        instance_id: null, // the legacy marker
        state: "live",
        content: "LEGACY RESUME CONTENT",
        updated_at: "2026-06-02 09:00:00",
      }),
    );
    // The on-disk legacy file at the live location.
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(join(sessionDir(), "CURRENT_SESSION.md"), "LEGACY RESUME CONTENT", "utf-8");

    const first = await run();
    expect(first.h0_legacy_retired).toBe(true);

    // DB row flipped to archived, instance_id still NULL (Lock 1 — never set).
    const row = readDbRow("CURRENT_SESSION.md");
    expect(row?.state).toBe("archived");
    expect(row?.instance_id).toBeNull();

    // On-disk file MOVED to archive (live location gone, archive copy present).
    expect(existsSync(join(sessionDir(), "CURRENT_SESSION.md"))).toBe(false);
    const archived = individualArchiveFiles().filter((n) => n.startsWith("CURRENT_SESSION-"));
    expect(archived.length).toBe(1);
    expect(readFileSync(join(archiveDir(), archived[0]), "utf-8")).toContain("LEGACY RESUME CONTENT");

    // Run twice → idempotent no-op (already archived).
    await closeBrainDb();
    const second = await run();
    expect(second.h0_legacy_retired).toBe(false);
    // Still exactly one archived copy (not re-moved/duplicated).
    expect(individualArchiveFiles().filter((n) => n.startsWith("CURRENT_SESSION-")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — H1 supersession + the Lock-2 testable property.
// ---------------------------------------------------------------------------
describe("housekeeping — H1 supersession (Lock-2)", () => {
  it("2. superseded rested → archived; non-superseded rested → untouched; abandoned-live → untouched", async () => {
    seedSchema();
    withDb((db) => {
      // R-old: rested, instance i-1, OLDER.
      insertSessionFile(db, {
        id: "r-old",
        filename: "instances/i-1.md",
        instance_id: "i-1",
        state: "rested",
        updated_at: "2026-06-01 08:00:00",
        content: "OLD RESTED",
      });
      // R-new: rested, instance i-2 (DIFFERENT), NEWER → supersedes R-old.
      insertSessionFile(db, {
        id: "r-new",
        filename: "instances/i-2.md",
        instance_id: "i-2",
        state: "rested",
        updated_at: "2026-06-03 08:00:00",
        content: "NEW RESTED",
      });
      // Abandoned LIVE: a live file whose owner is absent → NEVER archived by H1.
      insertSessionFile(db, {
        id: "aband",
        filename: "instances/i-crash.md",
        instance_id: "i-crash",
        state: "live",
        updated_at: "2026-06-02 08:00:00",
        content: "ABANDONED LIVE",
      });
    });
    // On-disk live files for the two rested instances.
    mkdirSync(instancesDir(), { recursive: true });
    writeFileSync(join(instancesDir(), "i-1.md"), "OLD RESTED", "utf-8");
    writeFileSync(join(instancesDir(), "i-2.md"), "NEW RESTED", "utf-8");
    writeFileSync(join(instancesDir(), "i-crash.md"), "ABANDONED LIVE", "utf-8");

    const d = await run();

    // R-old (i-1) was superseded → archived.
    expect(readDbRow("instances/i-1.md")?.state).toBe("archived");
    expect(d.h1_archived.some((n) => n.startsWith("i-1-"))).toBe(true);
    // The on-disk file moved to archive; the live location is gone.
    expect(existsSync(join(instancesDir(), "i-1.md"))).toBe(false);
    expect(individualArchiveFiles().some((n) => n.startsWith("i-1-"))).toBe(true);

    // R-new (i-2) is the NEWEST rested → NOT superseded → untouched.
    expect(readDbRow("instances/i-2.md")?.state).toBe("rested");
    expect(existsSync(join(instancesDir(), "i-2.md"))).toBe(true);

    // Abandoned LIVE → NEVER archived by H1 (no superseding rested file).
    expect(readDbRow("instances/i-crash.md")?.state).toBe("live");
    expect(existsSync(join(instancesDir(), "i-crash.md"))).toBe(true);
  });

  it("2b. a SAME-instance newer rested does NOT count as supersession", async () => {
    seedSchema();
    withDb((db) => {
      // Two rested files from the SAME instance — neither supersedes the other
      // (supersession requires a DIFFERENT instance to prove a read happened).
      insertSessionFile(db, {
        id: "a",
        filename: "instances/i-1.md",
        instance_id: "i-1",
        state: "rested",
        updated_at: "2026-06-01 08:00:00",
      });
      insertSessionFile(db, {
        id: "b",
        filename: "instances/i-1-dup.md",
        instance_id: "i-1",
        state: "rested",
        updated_at: "2026-06-05 08:00:00",
      });
    });
    const d = await run();
    expect(d.h1_archived).toEqual([]);
    expect(readDbRow("instances/i-1.md")?.state).toBe("rested");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — H2 30-day roll + the HEADER-GUARD idempotency (HARDEST #1).
// ---------------------------------------------------------------------------
describe("housekeeping — H2 30-day roll + header-guard", () => {
  it("3a. an individual file >30d is rolled into <YYYY-MM>.md with a header, then deleted", async () => {
    seedSchema();
    // An archive file whose FILENAME-SUFFIX timestamp (the authoritative
    // <rested_at> per §3.8) is >30d in the past relative to "now". The mtime is
    // also backdated but the suffix takes precedence — so we choose an old
    // suffix (2026-04-01) to make the age unambiguous regardless of the run date.
    writeArchiveFile("i-7-2026-04-01T080000.md", "RESUME SEVEN", 80);

    const d = await run();
    expect(d.h2_rolled).toBe(1);

    // The month digest is bucketed by the SUFFIX month (2026-04), carrying the
    // file under its header exactly once.
    const digest = readFileSync(join(archiveDir(), "2026-04.md"), "utf-8");
    expect(digest).toContain("## i-7-2026-04-01T080000.md");
    expect(digest).toContain("RESUME SEVEN");
    // The individual file is gone.
    expect(existsSync(join(archiveDir(), "i-7-2026-04-01T080000.md"))).toBe(false);
  });

  it("3b. HEADER-GUARD: a digest already carrying the header → append SKIPPED (no duplicate), file converged", async () => {
    seedSchema();
    const fname = "i-8-2026-04-01T080000.md";
    // Pre-seed the month digest WITH the header (simulates a crash AFTER append,
    // BEFORE the individual-file delete). Bucketed by the suffix month (2026-04).
    mkdirSync(archiveDir(), { recursive: true });
    writeFileSync(
      join(archiveDir(), "2026-04.md"),
      `## ${fname}\nRESUME EIGHT (already rolled)\n`,
      "utf-8",
    );
    // The individual file still exists (the crash left it undeleted), >30d via suffix.
    writeArchiveFile(fname, "RESUME EIGHT (duplicate body)", 80);

    const d = await run();
    expect(d.h2_rolled).toBe(1); // it WAS processed (converged)

    const digest = readFileSync(join(archiveDir(), "2026-04.md"), "utf-8");
    // The header appears EXACTLY ONCE — the append was skipped (no duplicate).
    const headerCount = digest.split("\n").filter((l) => l === `## ${fname}`).length;
    expect(headerCount).toBe(1);
    // The original (already-rolled) body is what remains; the duplicate body was NOT appended.
    expect(digest).toContain("RESUME EIGHT (already rolled)");
    expect(digest).not.toContain("RESUME EIGHT (duplicate body)");
    // The individual file is now deleted (converged).
    expect(existsSync(join(archiveDir(), fname))).toBe(false);
  });

  it("3c. a fresh (<30d) individual file is NOT rolled", async () => {
    seedSchema();
    // Suffix within 30d of now AND a recent mtime → neither path rolls it. Use a
    // sliding recent date derived from now so the test is date-robust.
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const y = recent.getUTCFullYear();
    const mo = String(recent.getUTCMonth() + 1).padStart(2, "0");
    const da = String(recent.getUTCDate()).padStart(2, "0");
    const fname = `i-9-${y}-${mo}-${da}T080000.md`;
    writeArchiveFile(fname, "RECENT", 5);
    const d = await run();
    expect(d.h2_rolled).toBe(0);
    expect(existsSync(join(archiveDir(), fname))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — H2 CRASH-SIM: roll A, leave B → re-run completes B, A not double-rolled (HARDEST #2).
// ---------------------------------------------------------------------------
describe("housekeeping — H2 crash simulation", () => {
  it("4. roll A then leave B (simulated crash) → re-run completes B, A not double-rolled", async () => {
    seedSchema();
    // Two old files in the same month (suffix 2026-04 → unambiguously >30d).
    writeArchiveFile("i-A-2026-04-01T080000.md", "BODY A", 80);
    writeArchiveFile("i-B-2026-04-02T080000.md", "BODY B", 80);

    // FIRST run rolls BOTH (the normal path). To simulate the crash we instead
    // model the post-crash state directly: A already rolled+deleted, B still
    // present, and the digest carrying A's header (the append-then-delete left
    // A done, B untouched).
    mkdirSync(archiveDir(), { recursive: true });
    writeFileSync(
      join(archiveDir(), "2026-04.md"),
      "## i-A-2026-04-01T080000.md\nBODY A\n",
      "utf-8",
    );
    // Remove the individual A (it was deleted before the crash); keep B.
    const fs = await import("node:fs");
    fs.rmSync(join(archiveDir(), "i-A-2026-04-01T080000.md"), { force: true });
    expect(existsSync(join(archiveDir(), "i-B-2026-04-02T080000.md"))).toBe(true);

    // RE-RUN completes the sweep.
    const d = await run();
    // Only B remained to roll.
    expect(d.h2_rolled).toBe(1);

    const digest = readFileSync(join(archiveDir(), "2026-04.md"), "utf-8");
    // A's header appears EXACTLY ONCE (NOT double-rolled).
    expect(digest.split("\n").filter((l) => l === "## i-A-2026-04-01T080000.md").length).toBe(1);
    // B is now rolled.
    expect(digest).toContain("## i-B-2026-04-02T080000.md");
    expect(digest).toContain("BODY B");
    // Both individual files are gone.
    expect(existsSync(join(archiveDir(), "i-A-2026-04-01T080000.md"))).toBe(false);
    expect(existsSync(join(archiveDir(), "i-B-2026-04-02T080000.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — H3 150-file ceiling.
// ---------------------------------------------------------------------------
describe("housekeeping — H3 ceiling valve", () => {
  it("5. 160 RECENT individual files → rolled down to <=150 oldest-first", async () => {
    seedSchema();
    // 160 files all within 30 days (so H2 does NOT roll them — H3 must).
    // Backdate by an increasing number of HOURS so the oldest are deterministic.
    for (let i = 0; i < 160; i++) {
      const idx = String(i).padStart(3, "0");
      // All in 2026-06, recent (a few days old), staggered by hours.
      writeArchiveFile(`i-${idx}-2026-06-15T080000.md`, `BODY ${idx}`, 1);
      // Re-backdate mtime by i hours so sort order is stable oldest-first.
      const p = join(archiveDir(), `i-${idx}-2026-06-15T080000.md`);
      const when = new Date(Date.now() - (1 * 24 * 60 + (160 - i) * 60) * 60 * 1000);
      utimesSync(p, when, when);
    }
    expect(individualArchiveFiles().length).toBe(160);

    const d = await run({ rollDays: 30 }); // H2 rolls nothing (all <30d)
    expect(d.h2_rolled).toBe(0);
    expect(d.h3_ceiling_rolled).toBe(10); // 160 - 150
    expect(individualArchiveFiles().length).toBe(150);
  });
});
