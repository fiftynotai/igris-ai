/**
 * TD-350 — `igris sync push`: a push with no secret in any argument,
 * transcript or log.
 *
 * The verb reads `remote_brain.url` + `remote_brain.api_key` from config itself
 * and dispatches the EXISTING `igris_brain_push` handler IN PROCESS through the
 * FR-241 write bridge (`bootWriteEngine` + `gateway.dispatch`), so the BR-097
 * stamp rule stays in the handler and no push SQL is reproduced in the CLI.
 *
 * Harness (the FR-241 / FR-247 idioms):
 *   - HOME fenced (`fenceHome`) and `IGRIS_BRAIN_DIR = <HOME>/.igris`, so both
 *     the CLI (`configJsonPath`, `brainDbPath`) and the brain's own
 *     `loadAutoPushConfig` (`homedir()/.igris/config.json`) read the sandbox;
 *   - the brain is MIGRATED by the vendored engine (the same artifact the verb
 *     boots), then witness rows are written with a plain handle;
 *   - the remote is a loopback `/sync/push` fixture; S5 merges through the REAL
 *     vendored `processSyncPush` into a second DB (the BR-097 T7 two-DB idiom);
 *   - FETCH FENCE: `globalThis.fetch` allows ONLY the fixture's origin and
 *     COUNTS + refuses anything else (narrowed `auto-push-fence.ts` L2). Its
 *     refusal message starts `HTTP 4` so `fetchWithRetry` does not retry it.
 *     Every test asserts the refused count is 0.
 *
 * The CANARY is synthetic (`sk-td350-canary`); no real key is read anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fenceHome, restoreEnv, type HomeFence } from "./home-fence.js";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { bootWriteEngine, resetWriteEngine, writeEngineState } from "../lib/brain-write-bridge.js";

const CANARY = "sk-td350-canary";
const CLI_DIR = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const VENDORED_SYNC = join(CLI_DIR, "dist", "brain-mcp-server", "dist", "tools", "sync.js");
const VENDORED_ENGINE = join(CLI_DIR, "dist", "brain-mcp-server", "dist", "engine", "index.js");

/** The witness row: an approved learning (the push's `learnings` filter keeps only approved). */
const WITNESS = {
  project: "td350",
  category: "pattern",
  title: "td350 witness learning",
  content: "pushed by igris sync push",
  created_at: "2026-10-01 10:00:00",
};

type Mode = "ok" | "skip-learnings" | "fail-500" | "real" | "echo-401";

interface Remote {
  server: Server;
  url: string;
  pushes: Array<{ auth: string | undefined; tables: Record<string, unknown[]> }>;
  healthGets: number;
  mode: Mode;
  /** Mode "real": the remote DB `processSyncPush` merges into. */
  remoteDb?: Database.Database;
}

let fence: HomeFence;
let savedEnv: NodeJS.ProcessEnv;
let brainDir: string;
let remote: Remote | null = null;
let realFetch: typeof globalThis.fetch;
let refused: string[] = [];
let processSyncPush:
  | ((db: Database.Database, t: Record<string, Record<string, unknown>[]>) => unknown)
  | null = null;

async function startRemote(mode: Mode): Promise<Remote> {
  const r: Remote = {
    server: null as unknown as Server,
    url: "",
    pushes: [],
    healthGets: 0,
    mode,
  };
  r.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      r.healthGets++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "test" }));
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/sync/push") {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(body) as { tables: Record<string, Record<string, unknown>[]> };
      r.pushes.push({ auth: req.headers.authorization, tables: parsed.tables });
      if (r.mode === "echo-401") {
        // A hostile or misconfigured remote that reflects the credential back.
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end(`unauthorized: got ${String(req.headers.authorization)}`);
        return;
      }
      if (r.mode === "fail-500") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("fixture remote failure");
        return;
      }
      if (r.mode === "real") {
        const out = processSyncPush!(r.remoteDb!, parsed.tables) as { ok: boolean };
        res.writeHead(out.ok ? 200 : 207, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      const names = Object.keys(parsed.tables);
      const skipped: string[] = r.mode === "skip-learnings" ? names.filter((n) => n === "learnings") : [];
      const results: Record<string, { inserted: number; updated: number }> = {};
      for (const n of names) {
        if (!skipped.includes(n)) results[n] = { inserted: parsed.tables[n].length, updated: 0 };
      }
      const ok = skipped.length === 0;
      res.writeHead(ok ? 200 : 207, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, results, errors: {}, skipped }));
    });
  });
  await new Promise<void>((resolve) => r.server.listen(0, "127.0.0.1", resolve));
  r.url = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
  return r;
}

function dbPath(): string {
  return join(brainDir, "memory", "knowledge.db");
}

function writeConfig(url: string): void {
  writeFileSync(
    join(brainDir, "config.json"),
    JSON.stringify({ remote_brain: { url, api_key: CANARY } }, null, 2) + "\n",
  );
}

/** Migrate the sandbox brain with the vendored engine, then write the witness. */
async function seedBrain(): Promise<void> {
  mkdirSync(join(brainDir, "memory"), { recursive: true });
  if (!existsSync(dbPath())) new Database(dbPath()).close();
  const booted = await bootWriteEngine();
  expect(booted.ok, booted.ok ? "" : booted.reason).toBe(true);
  resetWriteEngine();
  const db = new Database(dbPath());
  try {
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, created_at, updated_at, review_status)
       VALUES (@project, @category, @title, @content, @created_at, @created_at, 'approved')`,
    ).run(WITNESS);
  } finally {
    db.close();
  }
}

function stamps(): Record<string, string> {
  const db = new Database(dbPath(), { readonly: true });
  try {
    const rows = db
      .prepare("SELECT table_name, last_push_at FROM sync_state WHERE remote_url = ?")
      .all(remote!.url) as Array<{ table_name: string; last_push_at: string }>;
    return Object.fromEntries(rows.map((r) => [r.table_name, r.last_push_at]));
  } finally {
    db.close();
  }
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under `dir` except the one that is SUPPOSED to hold the key. */
function filesHolding(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && p !== join(brainDir, "config.json")) {
        if (readFileSync(p).includes(needle)) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

/**
 * Run the verb in process, capturing BOTH streams AND `console.*`. Inside a
 * vitest worker `console` is routed by vitest rather than through
 * `process.stderr.write`, so the brain handler's `console.error` lines would
 * escape a stream spy alone. R1 (the built CLI as a child) is the
 * full-stream witness; this keeps the in-process cases honest too.
 */
async function runPush(opts: { dryRun?: boolean } = {}): Promise<{ code: number; out: string }> {
  const buf: string[] = [];
  const cap = (chunk: unknown): boolean => {
    buf.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  const line = (...a: unknown[]): void => {
    buf.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(cap),
    vi.spyOn(process.stderr, "write").mockImplementation(cap),
    vi.spyOn(console, "log").mockImplementation(line),
    vi.spyOn(console, "warn").mockImplementation(line),
    vi.spyOn(console, "error").mockImplementation(line),
  ];
  try {
    const { runSyncPush } = await import("../lib/sync/push.js");
    const code = await runSyncPush(opts);
    return { code, out: buf.join("") };
  } finally {
    for (const sp of spies) sp.mockRestore();
  }
}

beforeEach(() => {
  expect(existsSync(VENDORED_ENGINE), "vendored brain bundle not staged — run `npm run build` in cli/").toBe(true);
  savedEnv = { ...process.env };
  fence = fenceHome("igris-td350-home-");
  brainDir = join(homedir(), ".igris");
  mkdirSync(brainDir, { recursive: true });
  process.env.IGRIS_BRAIN_DIR = brainDir;
  delete process.env.IGRIS_DB_PATH;
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  resetWriteEngine();
  refused = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (remote !== null && url.startsWith(`${remote.url}/`)) return realFetch(input, init);
    refused.push(url);
    throw new Error(`HTTP 403 — TD-350 fetch fence refused ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  resetWriteEngine();
  closeBrainDb();
  if (remote !== null) {
    remote.remoteDb?.close();
    await new Promise<void>((resolve) => remote!.server.close(() => resolve()));
    remote = null;
  }
  restoreEnv(savedEnv);
  fence.release();
});

describe("TD-350 — `igris sync push` (in process, vendored handler)", () => {
  it("S1+S2: pushes with the config key on the wire and NOWHERE else; exit 0", async () => {
    remote = await startRemote("ok");
    writeConfig(remote.url);
    await seedBrain();

    const { code, out } = await runPush();
    expect(code, out).toBe(0);
    expect(out).toContain("Brain push completed successfully.");
    // S1 — the key reached the remote, as a header.
    expect(remote.pushes.length).toBeGreaterThan(0);
    for (const p of remote.pushes) expect(p.auth).toBe(`Bearer ${CANARY}`);
    const learnings = remote.pushes.flatMap((p) => (p.tables.learnings ?? []) as Array<{ title: string }>);
    expect(learnings.map((l) => l.title)).toContain(WITNESS.title);
    // S2 — and nowhere else: not in either stream, not in any file but config.json.
    expect(out).not.toContain(CANARY);
    expect(filesHolding(homedir(), CANARY)).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("S4: `sync status` then prints the stamp the push wrote (one reader, real timestamp)", async () => {
    remote = await startRemote("ok");
    writeConfig(remote.url);
    await seedBrain();
    expect((await runPush()).code).toBe(0);
    const learningsStamp = stamps().learnings;
    expect(learningsStamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const buf: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      buf.push(String(c));
      return true;
    });
    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      expect(await runSyncStatus({ projectSlug: "td350" })).toBe(0);
    } finally {
      o.mockRestore();
    }
    expect(buf.join("")).toContain(`last push:       ${learningsStamp} UTC`);
  });

  it("S5: the fixture remote merges through the REAL processSyncPush; the witness is THERE and the local stamp advanced", async () => {
    const mod = (await import(pathToFileURL(VENDORED_SYNC).href)) as { processSyncPush: typeof processSyncPush };
    processSyncPush = mod.processSyncPush;
    remote = await startRemote("real");
    writeConfig(remote.url);
    await seedBrain();
    // The remote is a byte copy of the migrated brain WITHOUT this push's rows:
    // delete the witness from the copy so its presence afterwards is the push.
    const remotePath = join(homedir(), "remote.db");
    copyFileSync(dbPath(), remotePath);
    remote.remoteDb = new Database(remotePath);
    remote.remoteDb.prepare("DELETE FROM learnings WHERE title = ?").run(WITNESS.title);
    expect(remote.remoteDb.prepare("SELECT COUNT(*) AS n FROM learnings WHERE title = ?").get(WITNESS.title)).toEqual({ n: 0 });
    expect(stamps().learnings).toBeUndefined();

    const { code, out } = await runPush();
    expect(code, out).toBe(0);
    expect(
      remote.remoteDb.prepare("SELECT project, content FROM learnings WHERE title = ?").get(WITNESS.title),
    ).toEqual({ project: WITNESS.project, content: WITNESS.content });
    expect(stamps().learnings).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(refused).toEqual([]);
  });

  it("S6: --dry-run — no request, no engine boot, DB bytes unchanged, key absent, exit 0", async () => {
    remote = await startRemote("ok");
    writeConfig(remote.url);
    await seedBrain();
    const before = sha(dbPath());

    const { code, out } = await runPush({ dryRun: true });
    expect(code, out).toBe(0);
    expect(out).toContain(`${remote.url}/sync/push`);
    expect(out).not.toContain(CANARY);
    expect(remote.pushes.length).toBe(0);
    expect(writeEngineState()).toBe("not-booted");
    expect(sha(dbPath())).toBe(before);
    expect(refused).toEqual([]);
  });

  it("S7: a 207 that SKIPS learnings → exit 1, the SKIPPED line printed, learnings NOT stamped, the rest stamped", async () => {
    remote = await startRemote("skip-learnings");
    writeConfig(remote.url);
    await seedBrain();

    const { code, out } = await runPush();
    expect(code, out).toBe(1);
    expect(out).toContain("not merged by the remote");
    expect(out).toMatch(/learnings: SKIPPED/);
    const s = stamps();
    expect(s.learnings).toBeUndefined();
    const others = Object.keys(remote.pushes[0].tables).filter((t) => t !== "learnings");
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) expect(s[t], t).toBeDefined();
    expect(out).not.toContain(CANARY);
  });

  // ~3.1 s by design: fetchWithRetry's fixed 1 s + 2 s backoff. Worst across
  // the nine archived full runs: 3635 ms (1-min peak 206) — 24% of the
  // suite's 15 s budget, so no explicit one.
  it("S8: the remote 500s (three attempts) → isError, exit 1, rows queued locally, key absent everywhere", async () => {
    remote = await startRemote("fail-500");
    writeConfig(remote.url);
    await seedBrain();

    const { code, out } = await runPush();
    expect(code, out).toBe(1);
    expect(out).toContain("Brain push failed");
    expect(out).toContain("[engine] Booting Brain Engine"); // console.* IS captured
    expect(remote.pushes.length).toBe(3); // fetchWithRetry: 1 + 2 retries
    const db = new Database(dbPath(), { readonly: true });
    try {
      const q = db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE table_name = 'learnings'").get() as { n: number };
      expect(q.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect(stamps()).toEqual({});
    expect(out).not.toContain(CANARY);
    expect(filesHolding(homedir(), CANARY)).toEqual([]);
  });

  // N7 (warden, 2026-10-01): a 4xx body is re-thrown by fetchWithRetry as
  // `HTTP <status>: <body>` and surfaces in the handler text the verb prints.
  // RED before the redaction in push.ts: the canary reached stderr verbatim.
  it("S11: a remote that ECHOES the bearer token in a 401 body never gets the key printed", async () => {
    remote = await startRemote("echo-401");
    writeConfig(remote.url);
    await seedBrain();

    const { code, out } = await runPush();
    expect(code, out).toBe(1);
    expect(remote.pushes.length).toBe(1); // a 4xx is not retried
    expect(out).toContain("HTTP 401");
    expect(out).not.toContain(CANARY);
    expect(out).toContain("[redacted]");
  });

  it("S9: remote unconfigured → exit 1, the engine is never booted", async () => {
    await seedBrain();
    const { code, out } = await runPush();
    expect(code).toBe(1);
    expect(out).toContain("remote_brain config not found");
    expect(writeEngineState()).toBe("not-booted");
  });

  it("S10: a non-local http:// remote is REFUSED before boot (L-858) — no request, no engine", async () => {
    writeConfig("http://brain.td350.invalid");
    await seedBrain();
    const { code, out } = await runPush();
    expect(code).toBe(1);
    expect(out).toContain("refusing to sync over http://");
    expect(out).not.toContain(CANARY);
    expect(writeEngineState()).toBe("not-booted");
    expect(refused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The BUILT CLI as a real process (BR-117 idiom): the verb's process lifetime,
// its argv surface, and its streams are what a skill sees.
// ---------------------------------------------------------------------------

const CLI_ENTRY = join(CLI_DIR, "dist", "index.js");
const DIST_FROM_SRC = ["index", "verbs/sync", "lib/sync/push", "lib/sync/status", "lib/brain-db"];
const STRIP_FROM_CHILD = /^(VITEST(_.*)?|TEST|NODE_ENV|NODE_OPTIONS|IGRIS_REAL_HOME)$/;

/**
 * TD-336's SPAWN half for the built-CLI children (async `spawn`, so vitest can
 * pre-empt; the TEST half is the suite's 15_000 `testTimeout`, which this must
 * stay under so the child's own output is what a hang reports). MEASURED
 * 2026-10-01 in two full-suite runs under K=2 burners (1-min load ~37): R1
 * 589 / 756 ms, S3 408 / 349 ms. 10_000 is ~13x the worst.
 */
const PUSH_CHILD_TIMEOUT_MS = 10_000;

/** Fail (never skip) when `cli/dist` predates a source these cases exercise. */
function assertDistFresh(): void {
  expect(existsSync(CLI_ENTRY), "cli/dist/index.js is absent — run `npm run build` in cli/").toBe(true);
  for (const m of DIST_FROM_SRC) {
    const js = join(CLI_DIR, "dist", `${m}.js`);
    expect(existsSync(js), `cli/dist/${m}.js is absent — run \`npm run build\` in cli/`).toBe(true);
    expect(
      statSync(js).mtimeMs >= statSync(join(CLI_DIR, "src", `${m}.ts`)).mtimeMs,
      `cli/dist is older than src/${m}.ts — run \`npm run build\` in cli/`,
    ).toBe(true);
  }
}

function runBuiltCli(args: string[], timeoutMs: number): Promise<{ status: number | null; signal: string | null; out: string }> {
  assertDistFresh();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIP_FROM_CHILD.test(k)) env[k] = v;
  }
  // The fence, re-asserted for the CHILD.
  expect(env.HOME).toBe(homedir());
  expect(env.IGRIS_BRAIN_DIR).toBe(join(env.HOME, ".igris"));
  expect(Object.keys(env).filter((k) => /^VITEST|^TEST$|^NODE_ENV$|^IGRIS_REAL_HOME$/.test(k))).toEqual([]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: homedir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, out }));
  });
}

describe("TD-350 — the BUILT `igris sync push` as a real process", () => {
  it("R1: exits 0 with the key on the wire only — never in the child's streams, never 134", async () => {
    remote = await startRemote("ok");
    writeConfig(remote.url);
    await seedBrain();
    const { status, signal, out } = await runBuiltCli(["sync", "push"], PUSH_CHILD_TIMEOUT_MS);
    const why = `child status=${status} signal=${signal}\n${out}`;
    expect(status, why).toBe(0);
    expect(status).not.toBe(134); // BR-060: a native-teardown abort reads as 134
    expect(signal).toBeNull();
    expect(out).toContain("Brain push completed successfully.");
    expect(out).not.toContain(CANARY);
    expect(remote.pushes.length).toBeGreaterThan(0);
    for (const p of remote.pushes) expect(p.auth).toBe(`Bearer ${CANARY}`);
    expect(filesHolding(homedir(), CANARY)).toEqual([]);
  });

  it("S3: the verb takes NO key argument — `sync push --api-key x` is a usage error and sends nothing", async () => {
    remote = await startRemote("ok");
    writeConfig(remote.url);
    await seedBrain();
    const { status, out } = await runBuiltCli(["sync", "push", "--api-key", "x"], PUSH_CHILD_TIMEOUT_MS);
    expect(status, out).not.toBe(0);
    expect(out).toContain("unknown option '--api-key'");
    expect(remote.pushes.length).toBe(0);
    expect(out).not.toContain(CANARY);
  });
});
