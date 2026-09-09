/**
 * BR-100 — the CLI copy of the machine-identity module.
 *
 *   1. PURE REGION replay from the brain's fixture table
 *      (`brain-mcp-server/src/__tests__/fixtures/machine-identity-fixtures.json`,
 *      read by fs path — zero cross-imports, coding_guidelines §13). The brain
 *      suite replays the same table; the parity test pins the region bytes.
 *   2. `sameMachineSql` — the CLI-only predicate renderer (column-tolerant).
 *   3. The CLI I/O shell under `IGRIS_BRAIN_DIR`: absent/malformed never
 *      created or clobbered, idempotent mint, sibling keys preserved, mode 600,
 *      `wx` lock degrades to `id: null`, stale lock broken.
 *   4. **AC-2** — the identity survives a hostname change: `os.hostname` is
 *      stubbed to two values across two WRITES and ONE reader
 *      (`buildCognitionHealthDigest`) sees both rows as this machine's.
 *
 * `node:os` is mocked with a spread of the real module so only `hostname` is a
 * spy; the module under test reads it at CALL time (a bound named import would
 * not see the second value — the whole reason AC-2 is a test and not a claim).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, hostname: vi.fn(() => actual.hostname()) };
});

import {
  ensureMachineIdentity,
  isSameMachine,
  readMachineIdentity,
  resolveIdentity,
  sameMachineSql,
  withMintedId,
  withObservedHostname,
  type MachineIdentity,
} from "../lib/machine-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "brain-mcp-server",
  "src",
  "__tests__",
  "fixtures",
  "machine-identity-fixtures.json",
);

interface Fixtures {
  resolve: Array<{ name: string; config: unknown; liveHostname: string; expected: MachineIdentity }>;
  sameMachine: Array<{
    name: string;
    row: { machine_id?: string | null; machine_hostname: string | null };
    me: MachineIdentity;
    expected: boolean;
  }>;
  observe: Array<{
    name: string;
    config: Record<string, unknown>;
    host: string;
    expected: { changed: boolean; aliases: string[] };
  }>;
}

const FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixtures;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

let tmpRoot: string;
let savedHome: string | undefined;
let savedBrainDir: string | undefined;

beforeEach(() => {
  // Individually, never `process.env = saved` — that swaps in a plain object
  // and a later HOME assignment never reaches `os.homedir()` (libuv getenv).
  savedHome = process.env.HOME;
  savedBrainDir = process.env.IGRIS_BRAIN_DIR;
  tmpRoot = mkdtempSync(join(os.tmpdir(), "br100-cli-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  expect(process.env.IGRIS_BRAIN_DIR).toBe(tmpRoot); // the fence is ARMED
  vi.mocked(os.hostname).mockReset();
  vi.mocked(os.hostname).mockImplementation(() => "host-1");
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function cfgPath(): string {
  return join(tmpRoot, "config.json");
}

// ---------------------------------------------------------------------------
// 1. Pure region replay
// ---------------------------------------------------------------------------

describe("BR-100 pure region — fixture replay (CLI copy)", () => {
  it("replays the SAME table the brain suite replays (non-trivial, both verdicts present)", () => {
    expect(FIXTURES.resolve.length).toBeGreaterThanOrEqual(8);
    expect(FIXTURES.sameMachine.some((c) => c.expected)).toBe(true);
    expect(FIXTURES.sameMachine.some((c) => !c.expected)).toBe(true);
  });

  for (const c of FIXTURES.resolve) {
    it(`resolveIdentity: ${c.name}`, () => {
      expect(resolveIdentity(c.config, c.liveHostname)).toEqual(c.expected);
    });
  }
  for (const c of FIXTURES.sameMachine) {
    it(`isSameMachine: ${c.name}`, () => {
      expect(isSameMachine(c.row, c.me)).toBe(c.expected);
    });
  }
  for (const c of FIXTURES.observe) {
    it(`withObservedHostname: ${c.name}`, () => {
      const out = withObservedHostname(c.config, c.host);
      expect(out.changed).toBe(c.expected.changed);
      expect((out.next.machine as { aliases: unknown }).aliases).toEqual(c.expected.aliases);
    });
  }

  it("withMintedId keeps siblings + aliases and stamps id / minted_at", () => {
    const next = withMintedId({ remote_brain: { url: "u" }, machine: { aliases: ["A"] } }, "X", "T");
    expect(next).toEqual({ remote_brain: { url: "u" }, machine: { id: "X", aliases: ["A"], minted_at: "T" } });
  });
});

// ---------------------------------------------------------------------------
// 2. sameMachineSql
// ---------------------------------------------------------------------------

describe("sameMachineSql — id wins, alias fallback only on NULL, column-tolerant", () => {
  const me: MachineIdentity = { machine_id: "X", hostname: "H", aliases: ["A", "H"] };

  it("with the column: `(machine_id = ? OR (machine_id IS NULL AND machine_hostname IN (?, ?)))`", () => {
    const q = sameMachineSql(me, true);
    expect(q.sql).toBe("(machine_id = ? OR (machine_id IS NULL AND machine_hostname IN (?, ?)))");
    expect(q.params).toEqual(["X", "A", "H"]);
  });

  it("a table alias prefixes every column reference", () => {
    const q = sameMachineSql(me, true, "e");
    expect(q.sql).toBe("(e.machine_id = ? OR (e.machine_id IS NULL AND e.machine_hostname IN (?, ?)))");
  });

  it("without the column (older brain): the hostname-only form — today's predicate widened to the aliases", () => {
    const q = sameMachineSql(me, false);
    expect(q.sql).toBe("machine_hostname IN (?, ?)");
    expect(q.params).toEqual(["A", "H"]);
  });

  it("with no minted id the id leg binds NULL, so `machine_id = NULL` matches nothing — a row carrying an id is never mine", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (machine_id TEXT, machine_hostname TEXT)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("Y", "H");
    db.prepare("INSERT INTO t VALUES (?, ?)").run(null, "H");
    const q = sameMachineSql({ machine_id: null, hostname: "H", aliases: ["H"] }, true);
    const rows = db.prepare(`SELECT machine_id FROM t WHERE ${q.sql}`).all(...q.params) as { machine_id: string | null }[];
    expect(rows).toEqual([{ machine_id: null }]);
    db.close();
  });

  it("executes: id-match, NULL+alias, and the AC-5 foreign-id collision, against a real table", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n INTEGER, machine_id TEXT, machine_hostname TEXT)");
    const ins = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
    ins.run(1, "X", "zzz"); // mine by id
    ins.run(2, null, "A"); // mine by alias
    ins.run(3, "Y", "H"); // foreign id colliding with my hostname → NOT mine
    ins.run(4, null, "vps"); // inbound, unattributed → NOT mine
    const q = sameMachineSql(me, true, "t");
    const rows = db.prepare(`SELECT n FROM t WHERE ${q.sql} ORDER BY n`).all(...q.params) as { n: number }[];
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. CLI I/O shell
// ---------------------------------------------------------------------------

describe("BR-100 CLI I/O shell", () => {
  it("absent config.json → no mint, no file created", () => {
    const me = ensureMachineIdentity();
    expect(me).toEqual({ machine_id: null, hostname: "host-1", aliases: ["host-1"] });
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("malformed config.json → untouched (byte witness), legacy posture", () => {
    writeFileSync(cfgPath(), "{ nope");
    const before = sha(cfgPath());
    expect(ensureMachineIdentity().machine_id).toBeNull();
    expect(sha(cfgPath())).toBe(before);
  });

  it("mints once (uuid v4), seeds aliases, preserves sibling keys in order, mode 600", () => {
    writeFileSync(cfgPath(), JSON.stringify({ version: "7.0.0", remote_brain: { url: "https://x", api_key: "k" } }, null, 2) + "\n");
    const a = ensureMachineIdentity();
    const b = ensureMachineIdentity();
    expect(a.machine_id).toMatch(UUID_V4);
    expect(b.machine_id).toBe(a.machine_id);
    const stored = JSON.parse(readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(["version", "remote_brain", "machine"]);
    expect(stored.remote_brain).toEqual({ url: "https://x", api_key: "k" });
    expect((stored.machine as { aliases: string[] }).aliases).toEqual(["host-1"]);
    if (process.platform !== "win32") expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it("readMachineIdentity never writes and unions the live hostname in memory", () => {
    writeFileSync(cfgPath(), JSON.stringify({ machine: { id: "X", aliases: ["old"] } }) + "\n");
    const before = sha(cfgPath());
    expect(readMachineIdentity()).toEqual({ machine_id: "X", hostname: "host-1", aliases: ["old", "host-1"] });
    expect(sha(cfgPath())).toBe(before);
  });

  it("under a test runner with IGRIS_BRAIN_DIR unset the WRITER is contained (a fake HOME config stays byte-identical)", () => {
    const fakeHome = mkdtempSync(join(os.tmpdir(), "br100-home-"));
    try {
      mkdirSync(join(fakeHome, ".igris"), { recursive: true });
      const witness = join(fakeHome, ".igris", "config.json");
      writeFileSync(witness, "{}\n");
      const w = sha(witness);
      process.env.HOME = fakeHome;
      delete process.env.IGRIS_BRAIN_DIR;
      expect(ensureMachineIdentity().machine_id).toBeNull();
      expect(sha(witness)).toBe(w);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("a HELD lock → id:null, no write, no throw, one stderr line", () => {
    writeFileSync(cfgPath(), "{}\n");
    writeFileSync(`${cfgPath()}.lock`, "held");
    const before = sha(cfgPath());
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const me = ensureMachineIdentity();
      expect(me.machine_id).toBeNull();
      expect(sha(cfgPath())).toBe(before);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("a STALE lock (> 5 s) is broken and the mint proceeds", () => {
    writeFileSync(cfgPath(), "{}\n");
    const lock = `${cfgPath()}.lock`;
    writeFileSync(lock, "1");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    expect(ensureMachineIdentity().machine_id).toMatch(UUID_V4);
    expect(existsSync(lock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. AC-2 — the identity survives a hostname change (two writes, one reader)
// ---------------------------------------------------------------------------

const COGNITION_INSTANCES_DDL = `
  CREATE TABLE cognition_instances (
    id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
    gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
    driver TEXT NOT NULL, driver_ref TEXT,
    output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`;
/** event_log at monitoring v2 (BR-100) — the `machine_id` column present. */
const EVENT_LOG_V2_DDL = `
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
    component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), machine_id TEXT
  );`;

describe("AC-2 — identity survives a network change + rename (DEMONSTRATED)", () => {
  it("two writes under hostnames A then B; one reader attributes both to this machine", async () => {
    // Sandbox brain: roster + event_log(v2) + the gate ON.
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const dbPath = join(tmpRoot, "memory", "knowledge.db");
    const db = new Database(dbPath);
    db.exec(COGNITION_INSTANCES_DDL);
    db.exec(EVENT_LOG_V2_DDL);
    db.prepare(
      `INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, gate_default, driver, output, produced)
       VALUES ('synapse', 'cognition.synapse', 'cognition.synapse', '["cognition.synapse.enabled"]', 0, 'manual', ?, ?)`,
    ).run("suggestions[source_module='synapse']", "suggestions[source_module='synapse']");
    writeFileSync(cfgPath(), JSON.stringify({ cognition: { synapse: { enabled: true } } }) + "\n");

    // A writer stamps a row exactly the way lifecycle.ts does: from `ensureMachineIdentity()`.
    const stamp = db.prepare(
      `INSERT INTO event_log (event_name, component, machine_hostname, machine_id, created_at)
       VALUES (?, 'cognition.synapse', ?, ?, ?)`,
    );
    const write = (name: string, me: MachineIdentity, at: string): void => {
      stamp.run(name, me.hostname, me.machine_id, at);
    };
    const now = Date.now();

    vi.mocked(os.hostname).mockImplementation(() => "A");
    const meA = ensureMachineIdentity();
    write("cognition.synapse.run_started", meA, new Date(now - 4000).toISOString());
    write("cognition.synapse.run_succeeded", meA, new Date(now - 3000).toISOString());

    vi.mocked(os.hostname).mockImplementation(() => "B");
    const meB = ensureMachineIdentity();
    write("cognition.synapse.run_started", meB, new Date(now - 2000).toISOString());
    const lastAt = new Date(now - 1000).toISOString();
    write("cognition.synapse.run_succeeded", meB, lastAt);
    db.close();

    // The identity is ONE id across both writes; the alias list carries both names.
    expect(meA.machine_id).toMatch(UUID_V4);
    expect(meB.machine_id).toBe(meA.machine_id);
    expect(meB.aliases).toEqual(["A", "B"]);
    expect(meA.hostname).toBe("A");
    expect(meB.hostname).toBe("B");

    // ONE reader, under the second name, sees BOTH writes.
    const { buildCognitionHealthDigest } = await import("../verbs/cognition.js");
    const d = buildCognitionHealthDigest({ identity: readMachineIdentity() });
    expect(d.degraded).toBe(false);
    expect(d.hostname).toBe("B");
    const row = d.instances.find((i) => i.id === "synapse");
    expect(row?.status).toBe("ok");
    expect(row?.runs_today).toBe(2);
    expect(row?.last_run_at).toBe(lastAt);
  });
});
