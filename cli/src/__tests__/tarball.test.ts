/**
 * tarball.ts tests — M1.2.
 *
 * Mocks ONLY at the network boundary (`httpsGetFn`) per L-159 — no
 * `vi.mock` of the module under test. Real `node:fs` against tmp,
 * real fixtures from `cli/src/__tests__/fixtures/tarballs/*.tar.gz`.
 *
 * The malicious-fixture test (`zip-slip rejection`) is the gating test
 * for M1; M1.1 implementation MUST pass it before any other M1 sub-step
 * lands. Run via:
 *   npx vitest run src/__tests__/tarball.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  fetchAndExtract,
  fetchAndExtractFromFile,
  hashTarballFile,
  NetworkError,
  TarballError,
  wipeDir,
  ZipSlipError,
} from "../lib/tarball.js";

const FIXTURES = join(__dirname, "fixtures", "tarballs");
const CLEAN = join(FIXTURES, "clean-core.tar.gz");
const ZIPSLIP = join(FIXTURES, "zip-slip.tar.gz");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-tarball-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function streamFile(path: string): () => Promise<Readable> {
  return () => Promise.resolve(createReadStream(path));
}

describe("tarball — clean fixture extraction", () => {
  it("extracts core/ contents into destDir/core/ and reports file count", async () => {
    const dest = join(workDir, "core.new");
    const result = await fetchAndExtract({
      url: "https://example.invalid/test.tar.gz",
      destDir: dest,
      httpsGetFn: streamFile(CLEAN),
    });
    expect(result.fileCount).toBeGreaterThan(0);
    // GitHub-style top-level prefix is stripped: core/ lands directly under dest.
    expect(existsSync(join(dest, "core", "SOUL.md"))).toBe(true);
    expect(existsSync(join(dest, "core", "agents", "manifest.yaml"))).toBe(true);
    expect(existsSync(join(dest, "core", "skills", "demo", "SKILL.md"))).toBe(true);
    // FR-187: the layered core/os/ set replaces the retired rule + monolith.
    expect(existsSync(join(dest, "core", "os", "INDEX.md"))).toBe(true);
    expect(existsSync(join(dest, "core", "os", "standards.md"))).toBe(true);
    expect(existsSync(join(dest, "core", "hooks", "canonical-settings.json"))).toBe(true);
    expect(existsSync(join(dest, "core", "scripts", "verify_mirror.sh"))).toBe(true);
  });

  it("returns a stable contentSha256 (matches direct hash of the gzipped bytes)", async () => {
    const dest = join(workDir, "core.new");
    const result = await fetchAndExtract({
      url: "https://example.invalid/test.tar.gz",
      destDir: dest,
      httpsGetFn: streamFile(CLEAN),
    });
    expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const directHash = await hashTarballFile(CLEAN);
    expect(result.contentSha256).toBe(directHash);
  });

  it("non-core entries are skipped (allow-list enforced)", async () => {
    // Build a tarball with a top-level prefix dir containing both
    // core/ AND README.md / cli/ — assert only core/ lands.
    const synth = await buildSyntheticTarballWithExtras(workDir);
    const dest = join(workDir, "extract-allowlist");
    await fetchAndExtractFromFile(synth, dest);
    expect(existsSync(join(dest, "core", "SOUL.md"))).toBe(true);
    // README.md and cli/ at the same level should NOT have landed
    expect(existsSync(join(dest, "README.md"))).toBe(false);
    expect(existsSync(join(dest, "cli"))).toBe(false);
  });

  it("destDir is created if missing", async () => {
    const dest = join(workDir, "nested", "deep", "core.new");
    expect(existsSync(dest)).toBe(false);
    await fetchAndExtract({
      url: "x",
      destDir: dest,
      httpsGetFn: streamFile(CLEAN),
    });
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).isDirectory()).toBe(true);
  });
});

describe("tarball — zip-slip rejection (CRITICAL gate for M1)", () => {
  it("rejects an archive with `../etc/passwd` entries; throws ZipSlipError; no partial extraction", async () => {
    const dest = join(workDir, "core.new");
    let thrown: unknown = null;
    try {
      await fetchAndExtractFromFile(ZIPSLIP, dest);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    // Either ZipSlipError directly or a TarballError wrapping it; the
    // critical assertion is "extraction was rejected".
    const isZipSlip = thrown instanceof ZipSlipError;
    const isTarballError = thrown instanceof TarballError;
    expect(isZipSlip || isTarballError).toBe(true);

    // CRITICAL: nothing escaped to /etc/passwd or /tmp/igris-zip-slip-pwn.
    // We can't audit /etc/, but we can audit /tmp/ for the pwn file.
    expect(existsSync("/tmp/igris-zip-slip-pwn")).toBe(false);

    // The dest dir might exist (we called ensureDestDir before extraction),
    // but it MUST NOT contain any malicious file. The innocent
    // entry inside core/ was packaged INTENTIONALLY to ensure that
    // partial extraction is forbidden — if we see it on disk, the
    // fetcher silently extracted past the zip-slip rejection.
    if (existsSync(dest)) {
      const entries = readdirSync(dest);
      // We allow the dest dir to exist but it must be empty OR contain
      // ONLY the partial state at the moment of rejection. The strict
      // assertion is "no `core/SOUL.md` from the malicious fixture".
      const corePath = join(dest, "core", "SOUL.md");
      // It's acceptable for `core/` to have been mkdir'd as part of
      // streaming, but `SOUL.md` itself is the marker that the
      // innocent entry was committed to disk — a partial extraction.
      // Strict mode aborts the whole archive on first reject; tar
      // streams entry order matters. Our zip-slip fixture orders
      // unsafe entries FIRST, so the innocent one never lands.
      expect(existsSync(corePath)).toBe(false);
      // Reassuring belt-and-braces:
      void entries;
    }
  });

  it("rejects entries with absolute paths starting with `/`", async () => {
    // Build a tarball with a single entry `/abs/path` — we use the
    // helper that writes ustar headers manually.
    const malicious = buildAbsoluteEntryTarball(workDir);
    const dest = join(workDir, "abs-test");
    let thrown: unknown = null;
    try {
      await fetchAndExtractFromFile(malicious, dest);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(
      thrown instanceof ZipSlipError || thrown instanceof TarballError,
    ).toBe(true);
  });
});

describe("tarball — network error propagation", () => {
  it("surfaces NetworkError when httpsGetFn throws a NetworkError-shaped error", async () => {
    const dest = join(workDir, "ne-test");
    const errorFn = () =>
      Promise.reject(new NetworkError("HTTP 500 fixture", 500));
    let thrown: unknown = null;
    try {
      await fetchAndExtract({
        url: "x",
        destDir: dest,
        httpsGetFn: errorFn,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect((thrown as NetworkError).status).toBe(500);
  });

  it("surfaces a generic TarballError when the stream emits a non-tar payload", async () => {
    const dest = join(workDir, "garbage-test");
    const streamFn = () =>
      Promise.resolve(Readable.from([Buffer.from("not a tarball")]));
    let thrown: unknown = null;
    try {
      await fetchAndExtract({
        url: "x",
        destDir: dest,
        httpsGetFn: streamFn,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TarballError);
  });
});

describe("tarball — utility surface", () => {
  it("hashTarballFile errors when the file does not exist", async () => {
    let thrown: unknown = null;
    try {
      await hashTarballFile("/this/path/does/not/exist/12345");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TarballError);
  });

  it("wipeDir is a no-op on missing path; recursive on present path", () => {
    const dir = join(workDir, "to-wipe");
    expect(() => wipeDir(dir)).not.toThrow();
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file"), "x");
    wipeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("fetchAndExtractFromFile errors when path is not a file", async () => {
    const dirPath = join(workDir, "is-a-dir");
    require("node:fs").mkdirSync(dirPath, { recursive: true });
    let thrown: unknown = null;
    try {
      await fetchAndExtractFromFile(dirPath, join(workDir, "dest"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TarballError);
  });
});

// ----------------------------------------------------------------------
// TD-168: the CLI npm package bundles brain-mcp-server under
// cli/dist/brain-mcp-server/. `npm pack --dry-run --json` lists every file
// that WOULD ship in the published tarball; we assert the bundled MCP is
// in that manifest. The test depends on `cli/dist/` being built (CI runs
// `npm run build` before `npm test`) — it SKIPS with a clear message when
// the build has not run, so a bare `vitest` against unbuilt src/ is green.
// ----------------------------------------------------------------------
describe("tarball — bundled MCP in the npm pack manifest (TD-168)", () => {
  // cli/ root: this test file is at cli/src/__tests__/tarball.test.ts.
  const cliRoot = join(__dirname, "..", "..");
  const bundleDir = join(cliRoot, "dist", "brain-mcp-server");
  const bundledEntry = join(bundleDir, "dist", "index.js");

  /** True when `npm run build` has staged the brain bundle. */
  function bundleBuilt(): boolean {
    if (existsSync(bundledEntry)) return true;
    console.warn(
      "[tarball TD-168] skipped: cli/dist/brain-mcp-server/dist/index.js " +
        "absent — run `npm run build` in cli/ before this test.",
    );
    return false;
  }

  // `npm pack --dry-run` runs npm + spawns a child; modest headroom
  // over vitest's 5 s default is enough now that node_modules is
  // excluded from the manifest (BR-068).
  //
  // TD-336 UPDATE — that "modest headroom" was reasoned about before anyone
  // measured it. These two TD-168 tests each spawn their OWN un-memoised
  // `npm pack` and carry 15_000; under the sustained 8-way load that motivated
  // TD-336 they measured 9464 ms and 7256 ms — 63% and 48% of that budget, for
  // the SAME operation that now carries PACK_TIMEOUT_MS = 30_000 seven hundred
  // lines below. They are not reconciled here deliberately: they pass no
  // `timeout` in their own options objects, so swapping the constant in would
  // give them one half of a two-half contract whose docblock insists on both.
  // TD-344 owns doing it properly. Do not "harmonize" these to
  // PACK_TIMEOUT_MS without also adding options.timeout at :276 and :362.
  //
  // TD-378 UPDATE — DONE, both halves, because the prediction came true and
  // stopped being a flake. `npm pack --dry-run` was TIMED three times back to
  // back on an otherwise idle machine: **16.53 s, 19.43 s, 19.92 s**, against
  // TD-336's measurements of 9464 ms and 7256 ms for the same operation under
  // EIGHT-WAY LOAD. The pack has roughly doubled in wall clock as the tarball
  // grew this session (796 -> 801 entries, ~1.86 -> ~1.93 MB), so 15_000 is now
  // exceeded on an IDLE machine, every run. These two stopped being
  // intermittent and became reliably red.
  //
  // So both halves of the contract land together, as the paragraph above
  // demands: `PACK_TIMEOUT_MS` replaces the two literals AND each `it` gains
  // the matching `options.timeout`. Harmonising one without the other is what
  // that sentence exists to prevent, and it is still the right warning — it is
  // just no longer a reason to wait.
  it("npm pack --dry-run includes dist/brain-mcp-server/dist/index.js", async () => {
    if (!bundleBuilt()) return;
    const cp = await import("node:child_process");

    const out = cp.execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: cliRoot, encoding: "utf-8" },
    );
    const parsed = JSON.parse(out) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(parsed.length).toBeGreaterThan(0);
    const filePaths = parsed[0].files.map((f) => f.path);
    expect(
      filePaths.includes("dist/brain-mcp-server/dist/index.js"),
    ).toBe(true);
    expect(
      filePaths.includes("dist/brain-mcp-server/package.json"),
    ).toBe(true);
  }, PACK_TIMEOUT_MS);

  // BR-068: the bundle must vendor its production node_modules so the
  // igris-brain MCP can resolve @modelcontextprotocol/sdk on spawn.
  it("bundle vendors node_modules/@modelcontextprotocol/sdk (BR-068)", () => {
    if (!bundleBuilt()) return;
    expect(
      existsSync(
        join(
          bundleDir,
          "node_modules",
          "@modelcontextprotocol",
          "sdk",
          "package.json",
        ),
      ),
    ).toBe(true);
  });

  // BR-068: the bundled entrypoint must boot without a module-resolution
  // error. The brain MCP is a stdio server that idles until killed, so a
  // `timeout`-kill is treated as PASS (server booted OK) and any
  // ERR_MODULE_NOT_FOUND in stderr is FAIL.
  //
  // TD-426 HARDENING (re-lands TD-387's, whose commit 8d66b44 never reached
  // develop) — this test previously spawned the child with the REAL `HOME`
  // and only `IGRIS_BRAIN_DIR`, which the bundled server ignored for its DB
  // path: every `cd cli && npm test` on a machine with a pending migration
  // migrated the operator's live `~/.igris/memory/knowledge.db`, exactly like
  // the build smoke guard did (instances v3 on 2026-08-26, v4 on 2026-08-27).
  // It is now hermetic — a fake `HOME` plus an `IGRIS_BRAIN_DIR` sandbox, with
  // `IGRIS_DB_PATH` stripped so this is a probe of the IGRIS_BRAIN_DIR tier
  // ALONE (the build guard sets both seams; the tier is held here) — and it
  // asserts WHERE the DB landed:
  //   - the sandbox DB was created (the child honoured IGRIS_BRAIN_DIR),
  //   - the fake-HOME default path was NOT touched (no escape), and
  //   - the child PRINTED the sandbox path (`[brain] db: <path>`), the line
  //     cli/scripts/smoke-bundled-mcp.sh parses.
  // Pre-created `memory/` parents on BOTH paths: better-sqlite3 creates the DB
  // file but never its parent directory, and a missing parent makes bootEngine
  // throw — which would masquerade as a clean early exit here. POSIX-only
  // seam: `os.homedir()` follows `$HOME` on darwin/linux.
  //
  // Red-first against HEAD 812ae57's bundle (2026-08-27): `[brain] db:` absent
  // from stderr, the sandbox DB absent, the fake-HOME DB created.
  //
  // SPAWN SHAPE (TD-426, measured 2026-08-27): with a piped or /dev/null stdin
  // the child sees EOF at once and BR-067's stdin teardown exits it 0 within
  // ~1 s, AFTER the engine boot (getEngine() runs before the teardown is
  // installed) — so the healthy path is a clean exit, not a timeout kill, and
  // the previous `execFileSync` version only read `stderr` inside its `catch`,
  // i.e. it was the empty string on every healthy run (harmless for the
  // BR-068 negative match, fatal for a positive one). `spawnSync` returns
  // stderr on BOTH paths. TD-336: `options.timeout` still SIGTERMs a hung
  // child; the per-test PACK_TIMEOUT_MS is the outer half.
  it("bundled entry spawns clean and stays in its sandbox — no ERR_MODULE_NOT_FOUND, no live-brain escape, prints the DB it opened (BR-068 + TD-426)", async () => {
    if (!bundleBuilt()) return;
    const cp = await import("node:child_process");

    const fakeHome = mkdtempSync(join(tmpdir(), "igris-mcp-spawn-home-"));
    const brainDir = mkdtempSync(join(tmpdir(), "igris-mcp-spawn-test-"));
    const fakeDefaultDb = join(fakeHome, ".igris", "memory", "knowledge.db");
    const sandboxDb = join(brainDir, "memory", "knowledge.db");
    try {
      // Pre-create BOTH memory/ parents (see docblock).
      mkdirSync(join(fakeHome, ".igris", "memory"), { recursive: true });
      mkdirSync(join(brainDir, "memory"), { recursive: true });

      // Hermetic child env: fake HOME + sandbox brain dir; IGRIS_DB_PATH and
      // IGRIS_PIDS_DIR stripped (IGRIS_DB_PATH outranks IGRIS_BRAIN_DIR by
      // contract — an ambient value would silently retarget the child and
      // turn this tier probe into a probe of the wrong tier).
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        IGRIS_BRAIN_DIR: brainDir,
      };
      delete childEnv.IGRIS_DB_PATH;
      delete childEnv.IGRIS_PIDS_DIR;

      const res = cp.spawnSync("node", [bundledEntry], {
        timeout: 4000,
        encoding: "utf-8",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr = res.stderr ?? "";
      // Healthy outcomes: exited 0 on stdin EOF, or idled until the timeout
      // kill. Anything else (a crash exit code) is a failed boot.
      expect(
        res.status === 0 || res.signal === "SIGTERM",
        `bundle boot failed: status=${res.status} signal=${res.signal}\n${stderr}`,
      ).toBe(true);
      expect(stderr).not.toMatch(
        /ERR_MODULE_NOT_FOUND|Cannot find package/,
      );
      // TD-426: the child must SAY which DB it opened, and it must be the
      // sandbox — this is the line the build guard parses.
      expect(stderr).toContain(`[brain] db: ${sandboxDb}`);
      // …the boot must have used the SANDBOX brain dir…
      expect(existsSync(sandboxDb)).toBe(true);
      // …and must NOT have touched the (fake-)HOME default path. Before the
      // resolveDbPath() fix this is exactly where the child wrote — this
      // assertion is the red-then-green pivot.
      expect(existsSync(fakeDefaultDb)).toBe(false);
      // pidsDir() mirrors the middle tier: no registry under the fake HOME.
      expect(existsSync(join(fakeHome, ".igris", "brain-mcp-server.pids"))).toBe(false);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, PACK_TIMEOUT_MS);

  // BR-068: the vendored node_modules is a build/CI artifact only — it
  // MUST NOT ship in the published tarball (platform-locked native
  // addons + ~54 MB bloat; the `postinstall` hook rebuilds it fresh on
  // the user's machine). The tarball ships only the bundle's dist/ +
  // package.json + package-lock.json — which is all `npm ci` needs.
  it("npm pack manifest excludes bundled node_modules, keeps lockfile (BR-068)", async () => {
    if (!bundleBuilt()) return;
    const cp = await import("node:child_process");

    const out = cp.execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: cliRoot, encoding: "utf-8" },
    );
    const parsed = JSON.parse(out) as Array<{
      files: Array<{ path: string }>;
    }>;
    const filePaths = parsed[0].files.map((f) => f.path);
    // node_modules under the bundle must be ABSENT from the tarball.
    const nodeModulesEntries = filePaths.filter((p) =>
      p.startsWith("dist/brain-mcp-server/node_modules/"),
    );
    expect(nodeModulesEntries).toEqual([]);
    // The manifest + lockfile MUST ship — the postinstall `npm ci`
    // needs both to rebuild node_modules on the user's machine.
    expect(
      filePaths.includes("dist/brain-mcp-server/package.json"),
    ).toBe(true);
    expect(
      filePaths.includes("dist/brain-mcp-server/package-lock.json"),
    ).toBe(true);
  }, PACK_TIMEOUT_MS);
});

// ----------------------------------------------------------------------
// Helpers — synthetic tarball builders for tests that the committed
// fixtures don't already cover.
// ----------------------------------------------------------------------

async function buildSyntheticTarballWithExtras(work: string): Promise<string> {
  // Use GNU tar to package a tree containing core/ + non-core files.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const cp = await import("node:child_process");

  const stage = path.join(work, "stage-extras");
  const prefix = "igris-ai-fakesha";
  const root = path.join(stage, prefix);
  fs.mkdirSync(path.join(root, "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "core", "SOUL.md"), "soul\n");
  fs.writeFileSync(path.join(root, "README.md"), "readme\n");
  fs.mkdirSync(path.join(root, "cli", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "cli", "src", "index.ts"), "// cli\n");

  const out = path.join(work, "extras.tar.gz");
  cp.execFileSync("tar", ["-czf", out, "-C", stage, prefix]);
  return out;
}

function buildAbsoluteEntryTarball(work: string): string {
  // Reuse the same manual ustar approach the fixture builder uses.
  const fs = require("node:fs");
  const path = require("node:path");

  function tarHeader(name: string, size: number): Buffer {
    const buf = Buffer.alloc(512);
    buf.write(name.slice(0, 100), 0, 100, "utf-8");
    buf.write("0000644\0", 100, 8, "utf-8");
    buf.write("0001750\0", 108, 8, "utf-8");
    buf.write("0001750\0", 116, 8, "utf-8");
    buf.write(size.toString(8).padStart(11, "0") + " ", 124, 12, "utf-8");
    const mtime = Math.floor(Date.now() / 1000);
    buf.write(mtime.toString(8).padStart(11, "0") + " ", 136, 12, "utf-8");
    buf.write("        ", 148, 8, "utf-8");
    buf.write("0", 156, 1, "utf-8");
    buf.write("ustar\0", 257, 6, "utf-8");
    buf.write("00", 263, 2, "utf-8");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    const chk = sum.toString(8).padStart(6, "0") + "\0 ";
    buf.write(chk, 148, 8, "utf-8");
    return buf;
  }

  function entry(name: string, content: string): Buffer {
    const data = Buffer.from(content, "utf-8");
    const h = tarHeader(name, data.length);
    const padLen = (512 - (data.length % 512)) % 512;
    return Buffer.concat([h, data, Buffer.alloc(padLen)]);
  }

  const archive = Buffer.concat([
    entry("/etc/igris-pwn-test", "PWNED\n"),
    Buffer.alloc(1024),
  ]);
  const gz = gzipSync(archive);
  const out = path.join(work, "abs-only.tar.gz");
  fs.writeFileSync(out, gz);
  return out;
}

// ---------------------------------------------------------------------------
// FR-238 (T9) — the PUBLISHED PACKAGE MANIFEST.
//
// `cli/package.json` `files` lists `"dist"`, so `dist/dashboard/**` ships with
// no manifest change. That is convenient and it is also exactly why it needs a
// test: nothing declares the dashboard, so nothing would notice it silently
// disappearing (a `files` edit, an `.npmignore`, a build-order change).
//
// This asserts against `npm pack --dry-run --json` — the real packer, not a
// reimplementation of its glob semantics.
// ---------------------------------------------------------------------------

interface PackEntry {
  path: string;
  size: number;
}
interface PackReport {
  entryCount: number;
  size: number;
  unpackedSize: number;
  files: PackEntry[];
}

/**
 * The dashboard packed-size gate is **one number: a hard ceiling of +150 KB**
 * over `PACK_BASELINE_PACKED`, asserted below. (It read +550 KB from TD-329
 * until TD-374 RE-BASED the baseline to a clean measurement and re-derived the
 * grant; +150 KB over the new origin is a LARGER absolute cap than +550 KB was
 * over the old one. The TD-329 provenance immediately below narrates the
 * +400 -> +550 history and is correct as history.) An ordinary CLI change does not
 * fail the suite; a bundle that doubles does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CEILING WAS RAISED ONCE, DELIBERATELY (TD-329, 2026-08-02)
 * ─────────────────────────────────────────────────────────────────────────────
 * +400 KB -> +550 KB. This is an OPERATOR decision with a named date, not a
 * precedent that the number moves whenever it binds. It was raised BEFORE the
 * work that needed it, with the estimate on the record, rather than after a
 * failing assertion — which is the distinction that matters.
 *
 *   the ask:   "the dashboard is an essential tool, so it justifies going as
 *              much as it needs to deliver the full functionality we are
 *              trying to cover" — operator, 2026-08-02
 *   the state: +376.4 KB spent, 23.6 KB left
 *   the need:  ~83-115 KB for the five remaining GL-006 briefs, estimated
 *              against each one's nearest SHIPPED analogue (FR-246 ~ FR-240's
 *              48 KB shape; FR-247 ~ FR-241's 39 KB shape)
 *   the grant: +550 KB, leaving 173.6 KB — covers the estimate with real
 *              margin and still FAILS on a surprise
 *
 * Why 550 and not a bigger round number: FR-239 proposed exactly +550 KB
 * BEFORE measuring, then landed at +283.4 KB and did not need it (the story is
 * three paragraphs below). It is a figure this repo already considered and
 * rejected on evidence, which makes it the honest ask rather than an invented
 * one.
 *
 * THE INSTRUCTION INVERTS, IT DOES NOT DISAPPEAR. The next brief that runs out
 * still cuts scope or vendors less. What this raise buys is room for work that
 * was already planned and estimated — it does not make the number negotiable.
 * A brief that blows through the remaining headroom (see the per-brief ledger
 * below for the current figure — deliberately NOT restated here, because a
 * claim that carries its own copy of the number is the learning-1131 trap)
 * has done something wrong and the suite must say so. This gate has caught all three of: a stray runtime dependency,
 * a vendored asset creeping into `files`, and a ~90 MB HuggingFace model cache
 * downloading itself during a test run.
 *
 * WHY THERE IS ONLY ONE NUMBER NOW — read this before adding a second.
 * FR-238 shipped a PAIR: a +250 KB "budget" and a +400 KB asserted ceiling.
 * FR-239's plan (D4) proposed raising the ceiling to +550 KB, reasoning that
 * the operator's budget increase to +400 KB left budget == ceiling and so
 * nothing for the gate to trip on.
 *
 * That argument was made BEFORE the change was measured, and measurement
 * refuted it. **FR-239 lands at +283.4 KB** — it clears the ORIGINAL +400 KB
 * ceiling with ~117 KB to spare and never came near it. Loosening a gate by
 * 150 KB on behalf of a change that never approached it is how a gate stops
 * meaning anything, so the ceiling was restored to +400 KB.
 *
 * The soft "budget" is retired rather than restored, and that is deliberate:
 * two numbers where only ONE is asserted is exactly what produced this drift.
 * The +550 figure survived in three separate places after the constant went
 * back to 400 — here, `docs/dashboard.md`, and MAINTAINING row 108 — because a
 * number nothing executes has no way to be caught when it goes stale. What
 * replaces it is the asserted ceiling plus a recorded MEASUREMENT.
 *
 * Measured, cumulative over the family (`cd cli && npm pack --dry-run --json`):
 *   FR-238 shipped      +187.9 KB
 *   FR-239 shipped      +283.4 KB   (force-graph +55.3 KB measured in
 *                                    isolation; ~+40 KB paint layer, view,
 *                                    CSS and tests)
 *   FR-240 shipped      +331.8 KB   measured 2026-07-30 at the END of the
 *                                   warden pass, after the LAST code-touching
 *                                   step: 1_641_599 packed / 6_439_794
 *                                   unpacked / 786 entries. FR-240's OWN
 *                                   contribution is therefore +48.4 KB — four
 *                                   views, a markdown renderer, the shared
 *                                   record components and three vendored brain
 *                                   read modules, for about a sixth of what
 *                                   FR-239 spent. D4 (no markdown dependency)
 *                                   is most of the reason.
 *   FR-241 shipped      +370.6 KB   measured 2026-07-31 at the END of phase 7,
 *                                   after its LAST code-touching step:
 *                                   1_681_309 packed / 6_572_495 unpacked /
 *                                   792 entries. FR-241's OWN contribution is
 *                                   therefore +38.8 KB (39_710 B over FR-240's
 *                                   1_641_599) for the whole write path: the
 *                                   write bridge, the triage endpoint, the
 *                                   triage view with its pure model and tiered
 *                                   confirm dialog, the lifted project-scope
 *                                   layer, and two more vendored brain modules
 *                                   (`tools/suggestions-read.js` plus the
 *                                   `engine/index.js` the write door boots).
 *   headroom remaining  ~29.4 KB    (30_142 B under the THEN-CURRENT +400 KB)
 *
 * BR-082 MEASURED LAST TOO, after its final code-touching step:
 *   packed              1_684_456    unpacked 6_579_731, 792 entries (UNCHANGED
 *                                    entry count — it added no file to the pack)
 *   cumulative delta    +373.6 KB    (382_605 B over PACK_BASELINE_PACKED)
 *   BR-082's own share  +3_147 B     against FR-241's 1_681_309
 *   headroom remaining  ~26.4 KB     (26_995 B under the THEN-CURRENT +400 KB)
 *
 * BR-082 DELETED a client implementation and still grew the tarball, which is
 * the FR-241 phase-7 lesson repeating: Vite MINIFIES the client so comments
 * there cost zero, while `tsc` preserves the comments added to `cli/src/lib/**`
 * verbatim into `dist/lib/**`. Deleting client code does not buy packed
 * headroom; documenting server code spends it.
 *
 * TD-326 MEASURED LAST as well, after its final code-touching step:
 *   packed              1_687_293    unpacked 6_588_345, 792 entries (UNCHANGED
 *                                    again — it added no file to the pack)
 *   cumulative delta    +376.4 KB    (385_442 B over PACK_BASELINE_PACKED)
 *   TD-326's own share  +2_837 B     against BR-082's 1_684_456
 *   headroom remaining  ~23.6 KB     (24_158 B under the THEN-CURRENT +400 KB)
 *                                    -> 173.6 KB (177_758 B) under TD-329's +550
 *
 * TD-328 MEASURED LAST as well, after its final code-touching step:
 *   packed              1_712_208    unpacked 6_665_472, 793 entries (+1 — the
 *                                    FIRST entry-count change since FR-241)
 *   cumulative delta    +400.7 KB    (410_357 B over PACK_BASELINE_PACKED)
 *   TD-328's own share  +24_915 B    against TD-326's 1_687_293  (24.3 KB)
 *   headroom remaining  ~149.3 KB    (152_843 B under TD-329's +550)
 *
 *   (Moved +2_505 B during warden's round: the B1 fix — the script had been
 *   calling getDb(), which MIGRATES the DB it was supposed to be reading — plus
 *   the comment edits that came with it. `tsc` carries all of it into `dist/`.
 *   Measure-LAST earning its keep for a fourth brief running.)
 *
 * FR-244 MEASURED LAST as well, after its final code-touching step:
 *   packed              1_714_296    unpacked 6_671_517, 793 entries (UNCHANGED
 *                                    — it added no file to the package)
 *   cumulative delta    +402.8 KB    (412_445 B over PACK_BASELINE_PACKED)
 *   FR-244's own share  +2_088 B     against TD-328's 1_712_208  (2.04 KB)
 *   headroom remaining  ~147.2 KB    (150_755 B under TD-329's +550)
 *
 *   (Moved +1_912 B during the review round, from 176 B to 2_088 B — a
 *   TWELVEFOLD increase, and worth the line because of WHERE it came from.
 *   The code fix in that round was one CSS declaration (`pointer-events: none`
 *   on the density banner) which Vite minifies to nothing. Essentially all of
 *   it is the FR-244 entry added to `cli/CHANGELOG.md`, which `files` carries
 *   and which therefore SHIPS. The operator called that trade explicitly:
 *   consistency with the five sibling briefs' changelog entries is worth more
 *   than the bytes, and "defer it to /release" is how it gets forgotten. This
 *   is the same lesson TD-326 recorded — a structural argument that a review
 *   round is byte-free is only as good as its enumeration of `files` — landing
 *   for the second time on the same file.)
 *
 * FR-245 MEASURED LAST as well, after its final code-touching step:
 *   packed              1_717_994    unpacked 6_684_920, 793 entries (UNCHANGED
 *                                    — it added no file to the package)
 *   cumulative delta    +406.4 KB    (416_143 B over PACK_BASELINE_PACKED)
 *   FR-245's own share  +3_698 B     against FR-244's 1_714_296  (3.61 KB)
 *   headroom remaining  ~143.6 KB    (147_057 B under TD-329's +550)
 *
 *   (Estimated at +6-12 KB and spent 3.61 KB, and the reason is the one this
 *   ledger keeps re-teaching from the other direction: FR-245 wrote ~1,900
 *   lines, and almost all of them landed where nothing packed can see them.
 *   The whole feature — a pure column model, two hooks, a board component, a
 *   180-line CSS block and a comment-dense rewrite of the briefs page — is
 *   `cli/dashboard/src/**`, which Vite MINIFIES, so its comment density costs
 *   ~0. The browser gate grew a twelfth gate and eight mutations in
 *   `cli/scripts/`, which `files` does not carry; three suites grew in
 *   the test globs under `src` and under `dashboard/src`, both excluded from
 *   `dist` (spelled in prose, not literally: the pattern contains a star-slash
 *   pair that would terminate this comment — the trap this file's own glob note
 *   below records, walked into once while writing this row and caught by `tsc`); `docs/` and `MAINTAINING.md` are outside the package. It added NO
 *   endpoint by design (D1), so `cli/src/lib/**` — the expensive surface, where
 *   `tsc` preserves every comment into `dist/` — is untouched, and so is the
 *   vendored `dist/brain-mcp-server/**` that TD-328 discovered the hard way.
 *   What it DID spend: the app chunk and its `cli/CHANGELOG.md` entry, which
 *   SHIPS. Roughly the FR-244 shape at twice the size, for the same reasons.
 *
 *   RE-MEASURED after the review round — two further browser-gate mutations, a
 *   new behavioural check, and three comment/figure corrections — and the
 *   packed total is UNCHANGED at 1_717_994, with the built chunk byte-identical
 *   at 549_831 B. That is not luck and it is not an excuse to skip the
 *   re-measure: every edit in that round landed in `cli/scripts/` (not packed),
 *   in a test (excluded from `dist`), in `docs/`, or in a source COMMENT that
 *   Vite minifies away. Contrast FR-244, whose review round moved its own share
 *   twelvefold on one changelog entry. The rule is the same either way — run
 *   the measurement, then write the number.
 *
 *   (SUPERSEDED BY FR-246's READING BELOW — at FR-245 the chunk was 549_831 B
 *   with 10_169 B of slack. Kept as the provenance of that figure, not as the
 *   current one.)
 *
 * FR-266 MEASURED LAST, after its final code-touching step:
 *   packed              1_982_588    unpacked 7_634_086, 809 entries
 *   FR-266's own share  +9_343 B     (9.12 KB) against HEAD's 1_973_245,
 *                                    MEASURED by stashing the working tree,
 *                                    rebuilding both artifacts, packing, and
 *                                    restoring — NOT by subtracting from the
 *                                    previous ledger entry, which is several
 *                                    briefs stale. The HEAD arm reproduced the
 *                                    pre-change bundle figures exactly
 *                                    (INITIAL 285_689 / TOTAL 573_322), which
 *                                    is what says the stash was clean.
 *   entries             +5           804 -> 809, and ALL FIVE are accounted for:
 *                                    `dist/lib/dashboard/cognition-read.js` and
 *                                    its `.js.map` (2), plus three new dashboard
 *                                    assets (3) — the `Diagnostics` route chunk,
 *                                    the hoisted `api` chunk and the hoisted
 *                                    `Badge` chunk. The brief's four OTHER new
 *                                    files are tests or client sources: two live
 *                                    under a test glob and two are bundled into
 *                                    the assets above.
 *   cumulative delta    +116.4 KB    (119_168 B over PACK_BASELINE_PACKED)
 *   headroom remaining  ~33.6 KB     (34_432 B under TD-374's +150)
 *
 *   THIS ROW WAS RE-MEASURED IN A LATER REVIEW ROUND, AND THE MOVE IS THE
 *   'MEASURE LAST' RULE BITING RATHER THAN AN ERROR. The first reading was
 *   1_982_495. A subsequent round corrected two arithmetic claims, one of them
 *   in `cli/CHANGELOG.md` — which `package.json` `files` NAMES, so it SHIPS —
 *   and the packed total moved +92 B on prose alone. A THIRD round corrected
 *   false COUNT-WORDS, two of them in `cli/src/lib/**` (`routes.ts` and
 *   `brain-write-bridge.ts`), whose comments `tsc` preserves into `dist/`:
 *   +1 B more, to 1_982_588. Entry count did not move on either occasion.
 *   That is precisely why this file's head directive says the figure is stale
 *   the moment another round touches the changelog: a review round is a
 *   code-touching step for this measurement even when it changes no code.
 *   `tarball.test.ts` itself is under a test glob `tsconfig` excludes from
 *   `dist`, so writing THIS row cannot move the number it records — verified
 *   by re-packing after the edit.
 *
 *   EVERY SUBTRACTION IS RE-DERIVED FROM THE TWO OPERANDS BESIDE IT:
 *   1_982_588 - 1_973_245 = 9_343; 1_982_588 - 1_863_420 = 119_168;
 *   150*1024 - 119_168 = 34_432; 809 - 804 = 5.
 *
 *   WHERE THE 9_343 B WENT, and the split is the instructive part. This brief
 *   added a whole route, a panel, an endpoint, four test files and a browser-gate
 *   target — and most of that is unpacked surface: `cli/scripts/browser-gate.mjs`
 *   is not in `files`; the four suites live under test globs `tsconfig` excludes
 *   from `dist`; `docs/` and `MAINTAINING.md` are outside the package. What DID
 *   cost is `cli/src/lib/**` (one new module plus a handler, and `tsc` PRESERVES
 *   comments into `dist/` and pays for them TWICE, in `.js` and `.js.map`), the
 *   three new minified dashboard assets, and `cli/CHANGELOG.md`, which SHIPS.
 *   `brain-mcp-server/**` was not touched at all — the zero that keeps this row
 *   small, exactly as it did for FR-247.
 *
 *   THE OTHER TWO CEILINGS ARE NOT THIS ONE, and FR-266 is the brief where the
 *   difference bites. TOTAL JS came out at 580_979 B against a 586_923 B ceiling
 *   — **5_944 B of slack**, versus 33.6 KB here. The JS ceiling is now the
 *   binding budget for a dashboard brief by a factor of ~6, and it is the one to
 *   plan against. See `dashboard-chunks.test.ts` for why `MEASURED_*` was NOT
 *   re-based to make that number look better.
 *
 * TD-420 MEASURED LAST, after its final code-touching step:
 *   packed              1_983_869    unpacked 7_637_162, 809 entries (UNCHANGED
 *                                    — the brief's one new file is
 *                                    `src/__tests__/dashboard-count-derivation.test.ts`,
 *                                    which `tsconfig` excludes from `dist`, and
 *                                    every other edit is to a file that already
 *                                    packed)
 *   TD-420's own share  +1_281 B     (1.25 KB) against HEAD's 1_982_588,
 *                                    MEASURED by stashing the working tree,
 *                                    rebuilding both artifacts, packing, and
 *                                    restoring — NOT by subtracting from the
 *                                    previous ledger entry. The HEAD arm
 *                                    reproduced FR-266's recorded figures
 *                                    EXACTLY (1_982_588 packed / 7_634_086
 *                                    unpacked / 809 entries, bundle INITIAL
 *                                    286_070 / TOTAL 580_979), which is what
 *                                    says the stash was clean.
 *   cumulative delta    +117.6 KB    (120_449 B over PACK_BASELINE_PACKED)
 *   headroom remaining  ~32.4 KB     (33_151 B under TD-374's +150)
 *
 *   THE SIGN IS THE INTERESTING PART, AND IT IS POSITIVE. TD-420 is a DELETION
 *   brief — it removes quoted counts from prose — so the plan predicted a
 *   NEGATIVE own share, and this ledger still has no negative row. It came out
 *   **+1_281 B**, and the reason is structural rather than an error: deleting the
 *   word "SIXTEEN" buys a handful of bytes, while replacing it with the citation
 *   that keeps the sentence meaningful ("derive it from `server.ts`'s arms")
 *   costs an order of magnitude more. A DERIVATION IS LONGER THAN THE NUMBER IT
 *   REPLACES; budget for that rather than for the deletion.
 *
 *   WHERE THE 1_281 B WENT. Almost all of it is `cli/src/lib/**` — `routes.ts`,
 *   `params.ts` and `brain-write-bridge.ts`, whose comments `tsc` preserves into
 *   `dist/` and pays for TWICE (`.js` + `.js.map`). Everything else the brief
 *   touched is free: `MAINTAINING.md` and `docs/**` are outside `files`; the new
 *   gate and the two edited suites are under test globs `tsconfig` excludes; the
 *   one `cli/dashboard/**` edit was a comment and Vite minified it to nothing —
 *   PROVEN rather than assumed, by the bundle figures coming out byte-identical
 *   in BOTH arms (INITIAL 286_070 / TOTAL 580_979 each time).
 *   `brain-mcp-server/**` was not touched at all.
 *
 *   EVERY SUBTRACTION IS RE-DERIVED FROM THE TWO OPERANDS BESIDE IT:
 *   1_983_869 - 1_982_588 = 1_281; 1_983_869 - 1_863_420 = 120_449;
 *   150*1024 - 120_449 = 33_151; 809 - 809 = 0.
 *
 *   THE UNPACKED DELTA RECONCILES EXACTLY, which is the check worth doing when
 *   the packed figure is small enough to be argued with. +3_076 B unpacked,
 *   accounted for by SIX dist files and nothing else — `routes.js` +1_317 and
 *   its map +148, `params.js` +464 and its map +7, `brain-write-bridge.js`
 *   +1_123 and its map +17. Residual ZERO. Both arms were packed three times
 *   in one session and neither moved.
 *
 *   RE-MEASURED AFTER EACH REVIEW ROUND, AND THE MOVE IS THE 'MEASURE LAST'
 *   RULE BITING RATHER THAN AN ERROR. Readings were 1_983_284, then 1_983_726,
 *   then this one — a review round is a code-touching step for this figure even
 *   when it changes no code.
 *
 *   THE WARDEN ROUND EDITED A SHIPPING FILE AND MOVED THIS FIGURE BY ZERO, AND
 *   THE REASON IS WORTH KNOWING BEFORE YOU BUDGET A DOC BRIEF. It rewrote a
 *   docblock in `cli/src/lib/brain-write-bridge.ts` — a file that certainly
 *   ships — and `dist/lib/brain-write-bridge.js` did not move one byte. That
 *   block documents `export type TriageExtraKey` / `export interface BriefRef`,
 *   and `tsc` ERASES a type-only declaration together with its JSDoc: neither
 *   the old sentence nor the new one appears in `dist` at all. So the rule is
 *   sharper than "comments in `cli/src/lib/**` cost bytes twice" — a comment on
 *   a FUNCTION or a CONST costs ONCE, a comment on a TYPE costs nothing.
 *   (TD-443 CORRECTED THE "twice" HALF OF THAT SENTENCE, and the refutation was
 *   already in this same row: see its THE UNPACKED DELTA RECONCILES EXACTLY
 *   paragraph, where `routes.js` moved +1_317 B against its map's +148. The
 *   sharpening was right about WHICH comments cost and wrong about HOW MUCH.
 *   Grep `CHARGED ONCE PLUS A MAPPINGS SHIFT` in this file for the mechanism and
 *   the whole-tree census of the sentences that still say twice.)
 *   VERIFIED rather than inferred: `touch` + rebuild, then grep `dist` for both
 *   the old and the new wording; both absent, size byte-identical. Closing
 *   sentinel's F1/F2/F3 added a fourth scan arm and a second part-1 pin (both
 *   tsc-excluded, both free) but ALSO rewrote three `cli/src/lib/**` comment
 *   blocks — the shared-read-preamble enumeration in `routes.ts`, the
 *   `parseFilters` sentence in `params.ts`, and two relocated `count:record`
 *   markers in `brain-write-bridge.ts` — for +442 B on prose alone. Entry count
 *   did not move.
 *
 *   `tarball.test.ts` is under a test glob `tsconfig` excludes from `dist`, so
 *   writing THIS row cannot move the number it records — verified by re-packing
 *   after the edit.
 *
 * TD-333 MEASURED LAST, after its final code-touching step:
 *   packed              1_811_683    unpacked 7_138_039, 804 entries (UNCHANGED
 *                                    — TD-333's two new source files are a bash
 *                                    validator and a bats suite, neither of
 *                                    which is packed, and its one new TS file
 *                                    is `src/__tests__/db-migration-v25.test.ts`,
 *                                    which `tsconfig` excludes from `dist`)
 *   TD-333's own share  +17_915 B    (17.50 KB) against HEAD's 1_793_768,
 *                                    MEASURED by stashing the working tree,
 *                                    rebuilding, packing, and restoring —
 *                                    NOT by subtracting from the previous
 *                                    ledger entry, which is four briefs stale
 *   cumulative delta    +497.9 KB    (509_832 B over PACK_BASELINE_PACKED)
 *   headroom remaining  ~52.1 KB     (53_368 B under TD-329's +550)
 *   built app chunk     559_384 B    (BYTE-IDENTICAL — the only `cli/dashboard/**`
 *                                    edit was a docstring, and Vite minifies
 *                                    comments away)
 *
 *   THE SHARE IS ALMOST ENTIRELY COMMENT PROSE IN `brain-mcp-server/**`, and
 *   that is the ledger's oldest lesson rather than a surprise: TD-333 modified
 *   NO `cli/src/**` runtime file except the GENERATED normalizer mirror, yet
 *   still spent 17.5 KB, because `cli` packs the compiled brain server at
 *   `dist/brain-mcp-server/dist/**` and `tsc` PRESERVES comments into it and
 *   pays for them TWICE (`.js` and `.js.map`). The unpacked figure moved
 *   +109_557 B for +17_915 B packed — a ~6.1x compression ratio, which is what
 *   prose looks like in this budget.
 *
 *   WHY THE PREVIOUS ENTRY IS NOT THE BASELINE HERE. FR-250, TD-338 and TD-340
 *   all shipped after FR-247 WITHOUT recording an entry, so the gap between
 *   FR-247's 1_757_652 and this reading is 54_031 B of which only 17_915 B is
 *   TD-333's. Subtracting from the last recorded line would have over-attributed
 *   this brief by 3x. **Measure against HEAD, not against the ledger's tail** —
 *   the ledger is a record of readings, not a continuous series.
 *
 * FR-247 MEASURED LAST, after its final code-touching step:
 *   packed              1_757_652    unpacked 6_831_457, 797 entries (UNCHANGED
 *                                    — FR-247's one new file, `auto-push-fence.ts`,
 *                                    lives in `src/__tests__` and `tsconfig`
 *                                    excludes it from `dist`)
 *   cumulative delta    +445.1 KB    (455_801 B over PACK_BASELINE_PACKED)
 *   FR-247's own share  +11_132 B    against FR-246's 1_745_049  (10.84 KB)
 *   headroom remaining  ~104.9 KB    (107_399 B under TD-329's +550)
 *   built app chunk     559_384 B    (+5_899 B over FR-246's 553_485)
 *   chunk slack         616 B        (560_000 B limit; Vite kB = 1000 B)
 *
 *   EVERY SUBTRACTION ABOVE IS RE-DERIVED FROM THE TWO OPERANDS BESIDE IT, not
 *   carried forward: 1_757_652 - 1_745_049 = 11_132; 1_757_652 - 1_301_851 =
 *   455_801; 550*1024 - 455_801 = 107_399; 559_384 - 553_485 = 5_899;
 *   560_000 - 559_384 = 616. That discipline is the FR-246 bracket below —
 *   a delta carries no copy of either operand, so a class-grep for the packed
 *   value walks straight past a stale one.
 *
 *   BOTH SURFACES WERE ESTIMATED BEFORE THE WORK, which is the FR-246 lesson
 *   applied. The plan said 2.5-4.6 KB of chunk and 17-32 KB of packed. Actual:
 *   **5_899 B of chunk (over the estimate) and 11_132 B of packed (under it)**.
 *   The chunk over-run is the honest one to explain: the estimate costed a
 *   picker, a goal control, an affordance parameter and a confirm copy, and did
 *   not cost the SELECTION BAR that hosts them — a component with two labelled
 *   selects, two buttons, a failure banner and a dialog. The packed under-run
 *   has the same cause as FR-244's: the bulky work is a browser gate
 *   (`cli/scripts/`, not packed), four suites (excluded from `dist`), `docs/`
 *   and MAINTAINING. What DID cost is `dist/lib/**` — `brain-write-bridge.ts`
 *   grew a Phase-0 probe block, the TD-311 boundary paragraph and two map rows,
 *   and `tsc` PRESERVES comments into `dist/` and pays for them TWICE — plus
 *   `cli/CHANGELOG.md`, which ships. **`brain-mcp-server/**` was not touched at
 *   all**, and that zero is the single largest reason this row is small.
 *
 *   **SUPERSEDED BY TD-347 — DO NOT ACT ON THE PARAGRAPH BELOW.** It correctly
 *   told the next planner to split the chunk as their first step; TD-347 DID
 *   THAT, so the instruction is discharged, not pending. The current numbers are
 *   in the TD-347 block further down (initial set 285_390 B against a 309_390 B
 *   ceiling). Kept as the provenance of the 616 B figure, not as advice.
 *
 *   THE CHUNK IS NOW THE BINDING CEILING BY A WIDE MARGIN, and the next
 *   dashboard brief has to plan around it rather than budget against it:
 *   **616 B**, against this gate's 104.9 KB. That is not headroom. A brief that
 *   adds any UI to this bundle should expect to SPLIT the chunk (a route-level
 *   dynamic import for the layers or the graph) as its first step, not as a
 *   cut-ladder rung. **Raise NEITHER limit** — the packed one has been moved
 *   TWICE (TD-329 2026-08-02, TD-374 2026-08-10), each time before the work,
 *   on a measurement, as a recorded operator decision. Two decisions is not a
 *   precedent. *(The "raise neither" rule is the one line here that is NOT
 *   superseded — TD-347 inherits it verbatim for both of its ceilings.)*
 *
 *   THE CUT LADDER WAS DECLARED BEFORE THE WORK AND WAS NOT INVOKED. Rung by
 *   rung, with what each was measured to be worth:
 *     1. drop the brief-flavoured confirm copy for `confirmCopy`'s generic
 *        tier-1 path — **NOT AVAILABLE.** That path says "there is no
 *        un-set_priority tool -- reversing this means hand-editing the brain",
 *        which is FALSE for a reversible column write, in the register reserved
 *        for permanent deletion. The nearest available variant is dropping the
 *        confirm DIALOG entirely, MEASURED at 711 B (559_384 -> 558_673) — not
 *        taken, because a confirm is what makes a 200-brief bulk safe and 711 B
 *        does not buy that.
 *     2/3. move either write to the DETAIL view only — these rungs assume a
 *        detail-view control already exists as the cheap alternative. It does
 *        not; building one costs MORE than the list control it would replace.
 *     4. drop goal attach from v1 — would gut AC-2, and the operator's D1 is
 *        explicit that attach-to-existing is the half that ships.
 *     5. no per-row selection — weakens `confineToKeys`' stated safety property.
 *   Two savings WERE taken, and neither is a ladder rung because neither costs a
 *   property: an unmotivated `write.actions` membership check in `Briefs.tsx`
 *   (a state a single-package install cannot reach) and three over-long UI
 *   strings. Together **461 B** (559_845 -> 559_384).
 *
 * FR-246 MEASURED LAST, after its final code-touching step:
 *   packed              1_745_049    unpacked 6_783_829, 797 entries (+4: the
 *                                    compiled `briefs-read` and
 *                                    `utils/substring-search` pairs, each with
 *                                    a `.d.ts`/`.js` and their maps)
 *   cumulative delta    +432.8 KB    (443_198 B over PACK_BASELINE_PACKED)
 *   FR-246's own share  +27_055 B    against FR-245's 1_717_994  (26.42 KB)
 *   headroom remaining  ~117.2 KB    (120_002 B under TD-329's +550)
 *   built app chunk     553_485 B    (+3_654 B over FR-245's 549_831)
 *
 *   RE-MEASURED after EACH review round, and the packed total MOVED TWICE —
 *   recorded as a CHAIN (TD-326's shape) so a re-measure does not read as a
 *   drift, and so neither reading is overwritten by the next:
 *     1_744_020 -> 1_744_965  (+945 B, r1: ~10 lines in
 *        `routes.ts#briefsSearch` — drop-and-report for the four brief filters
 *        that path allow-lists but cannot bind — plus its rationale comment)
 *     1_744_965 -> 1_745_049  (+84 B, r2: three claim corrections, TWO of them
 *        comments in `cli/src/lib/**`)
 *   +1_029 B across both rounds.
 *
 *   [The r1 arrow above read `1_744_020 -> 1_745_049, +945 B` for one round.
 *   The endpoint had been class-grep-swapped to the r2 value while the DELTA
 *   computed from the r1 value was left standing, so the subtraction was
 *   false. Worth naming because of the carrier: **a delta carries no copy of
 *   EITHER operand**, so a grep for the packed value and a grep for the KB
 *   class both walk straight past it. That is the same blind spot the
 *   comparative clause had — and it survived the very round that deleted the
 *   comparative one. When you re-measure, re-derive every SUBTRACTION, not
 *   just every figure.]
 *
 *   `cli/src/lib/**` is the expensive surface precisely because `tsc` PRESERVES
 *   comments into `dist/` and pays for them TWICE (`.js` and `.js.map`). The
 *   chunk did NOT move (553_485 B, byte-identical): nothing in the round
 *   touched `cli/dashboard/src/**`. Contrast FR-245's review round, which moved
 *   neither number, and FR-244's, which moved its own share twelvefold on one
 *   changelog entry. The rule is the same in all three cases — run the
 *   measurement, then write the number; a structural argument that a review
 *   round is byte-free is only as good as its enumeration of `files`.
 *
 *   THE TWO NUMBERS MOVED IN OPPOSITE PROPORTIONS, and the reason is this
 *   ledger's own recurring lesson rather than a surprise. FR-246 wrote far more
 *   CLIENT code than FR-245's predecessor rows did — a shared readout
 *   component, a filter hook, a search mode on the briefs list, `q` wiring on
 *   four pages — and all of it cost **3.6 KB**, because Vite MINIFIES
 *   `cli/dashboard/src/**` and this brief is comment-dense. What cost 25 KB is
 *   everything else, and none of it is client code:
 *     - `dist/brain-mcp-server/**` — the v23 migration block with its measured
 *       storage note, the six triggers, and `briefs-read.js` growing from two
 *       readers to four (22_377 B packed, plus a 12_264 B source map and a
 *       10_788 B `.d.ts`). Learning 1132's premise, paying out again: a brief
 *       that touches only the brain STILL spends packed bytes here.
 *     - `dist/lib/**` — `routes.ts` (`briefsSearch` plus the `q` forwarding),
 *       `brain-bridge.ts` (the type facade) and `types.ts`. `tsc` PRESERVES
 *       COMMENTS into `dist/`, so a rationale-dense comment in `cli/src/lib/**`
 *       costs its full length twice — once in `.js` and again in `.js.map`.
 *     - `CHANGELOG.md`, which `files` carries and which therefore SHIPS
 *       (41_579 B total after this entry). The FR-244 row below records the
 *       same line item moving that brief's share TWELVEFOLD.
 *   Estimated at ~5.2 KB against the CHUNK budget and spent 3.6 KB there — the
 *   estimate was right about the surface it was made against, and silent about
 *   the one that actually moved (26.42 KB, a 7x ratio). **Estimate BOTH
 *   ceilings, or say which one the estimate is about.**
 *
 *   ONE READING FOR THE NEXT PLANNER (SUPERSEDED BY FR-247's ROW ABOVE — the
 *   chunk is now 559_384 B with 616 B of slack. Kept as the provenance of the
 *   6_515 B figure, not as the current one), because it is still closer to its
 *   own limit than this gate is: the single minified app chunk then measured
 *   **553.49 kB** (553_485 B on disk) against `dashboard/vite.config.ts`'s
 *   `chunkSizeWarningLimit` of 560 kB — **6_515 B of slack**. Note the UNITS
 *   differ from this gate's: Vite reports kB as 1000 bytes, the ceiling here is
 *   KiB. That is a build-time WARNING about one chunk, NOT this gate — the two
 *   must not be confused — but 6.5 KB of slack against the packed ceiling's
 *   117.2 KB means the next dashboard brief WILL hit the warning first, and now
 *   by a wider margin than FR-245 faced. FR-246 declared a cut ladder before
 *   writing anything and did not need it (3_654 B against 10_169 B); the next
 *   brief has 6_515 B and should declare one too. **Raise NEITHER limit.**
 *   *(SUPERSEDED BY TD-347 — DO NOT ACT ON THE CUT-LADDER INSTRUCTION ABOVE.
 *   The split shipped; there is no single app chunk to declare a ladder
 *   against. Bracketed DIRECTLY here rather than left to a two-hop chain via
 *   FR-247's row, and note this paragraph sits ABOVE the TD-347 block's
 *   'everything below is HISTORY' marker, so the marker does not cover it.
 *   'Raise NEITHER limit' is the one clause that survives verbatim.)*
 *
 * FR-244 IS THE CHEAPEST ROW IN THIS LEDGER, and it is the CONVERSE of TD-328's
 * lesson rather than a contradiction of it. TD-328 spent 24.3 KB writing only
 * `brain-mcp-server/`; FR-244 spent 176 B while adding a whole browser gate, a
 * canvas separability instrument, a sixth sandbox world, four suites' worth of
 * new assertions and ~200 lines of `docs/`. The rule both obey is the same one:
 * **what costs is what `package.json` `files` carries into `dist/`.**
 *   - `cli/scripts/browser-gate.mjs` is NOT packed — `files` names
 *     `scripts/postinstall.mjs` INDIVIDUALLY, not `scripts/`. Check that before
 *     assuming a sibling script is free; it is free because of one entry in a
 *     FIVE-element list — `dist`, `!dist/brain-mcp-server/node_modules`,
 *     `scripts/postinstall.mjs`, `README.md`, `CHANGELOG.md`. (Counted from
 *     `package.json` rather than from memory: an earlier revision of this
 *     sentence said four, having skipped the negation entry. The load-bearing
 *     premise — that `browser-gate.mjs` is not packed — was right either way,
 *     but a miscounted enumeration is how the NEXT reader concludes something
 *     is free when it is not.)
 *   - `src/__tests__/**` is excluded from `dist` by `tsconfig`, so suites and
 *     fixtures cost zero however long they get.
 *   - `docs/` and repo-root `MAINTAINING.md` are outside the package.
 *   - What FR-244 DID change inside the package is `cli/dashboard/src/**`,
 *     which Vite MINIFIES — so its comment-dense size law, its several hundred
 *     lines of rationale in `shapes.ts`/`useGraph.ts`/`Graph.tsx` and the new
 *     CSS block together came to under 200 bytes of chunk.
 * The generalisation for the next planner: estimate against WHICH PACKAGE and
 * WHICH PIPELINE a change lands in, not against how much was written. A
 * comment in `cli/src/lib/**` costs more than a page of client code. **FR-246
 * is the sharpest instance so far**: it wrote MORE client code than any row
 * above and spent 3_654 chunk bytes on it, while the same brief's brain
 * migration, its `cli/src/lib/**` comments and one changelog entry came to
 * 26_026 packed bytes — a 7x ratio, in the direction the intuition does not
 * point.
 *
 * TD-328 IS THE ROW THAT BREAKS THE "IT'S ONLY THE DASHBOARD" READING OF THIS
 * LEDGER, and it is here because a WRONG STRUCTURAL CLAIM was inherited from a
 * plan and passed to the builder as a technical anchor: "`brain-mcp-server/` is
 * not in the npm package and has no ceiling pressure". That is FALSE. The `cli`
 * package BUNDLES the compiled brain server at `dist/brain-mcp-server/dist/**`
 * — `db.js` alone is ~72 KB packed, `index.js` ~71 KB, `tools/sync.js` ~68 KB.
 * A brief that touches ONLY `brain-mcp-server/` still spends packed bytes here.
 * Every prior entry in this ledger is a `cli/`-side brief, which is precisely
 * how the misreading survived: the evidence was consistent with it by accident.
 * (Banked as learning 1132.)
 *
 * Where TD-328's 24.3 KB went, since it wrote no view and no endpoint:
 *   - a NEW packed entry, `dist/brain-mcp-server/scripts/normalize_brief_types.ts`
 *     (~15.9 KB) — the +1 on the entry count. `dist/brain-mcp-server/scripts/`
 *     ALREADY ships eight comparable maintenance scripts (`backfill_brief_edges.ts`,
 *     `td286_renormalize_backfill.ts`, …), so this follows an existing precedent
 *     rather than opening a new class. DO NOT delete it on sight as stray weight.
 *   - growth in the bundled `db.js`, `tools/brief-normalize.js`, `tools/briefs.js`
 *     and `engine/components/briefs/index.js` plus their `.map`s — `tsc`
 *     preserves comments into `dist/`, and this brief is comment-dense by design
 *     (a migration whose rationale is not written down gets "corrected" later).
 *   - `cli/CHANGELOG.md`, which SHIPS (see the TD-326 note below).
 * The BR-082/FR-241 lesson therefore generalises: budget for comments in ANY
 * `tsc`-compiled package that ends up under `dist/`, not just `cli/src/lib/**`.
 *
 * That figure moved TWICE during TD-326's review — 1_686_781 -> 1_686_903 ->
 * 1_687_005 -> 1_687_293 — the first three because a warden round edited a
 * comment in `cli/src/lib/**`, which `tsc` carries into `dist/` verbatim, and
 * the FOURTH for a different reason worth writing down: adding a CHANGELOG
 * entry. `cli/package.json`'s `files` is `dist`, `scripts/postinstall.mjs`,
 * `README.md` and **`CHANGELOG.md`** — so `cli/CHANGELOG.md` SHIPS. The rule
 * "docs cost zero packed bytes" holds for `docs/` and for repo-root
 * `MAINTAINING.md`, both of which are outside the package, and does NOT hold
 * for the CLI's own changelog. A structural argument that a round is byte-free
 * is only as good as its enumeration of `files`. This is the
 * measure-LAST rule earning its keep for the third brief running: the number is
 * stale the moment another review round touches a server-side comment, and the
 * only safe time to write it down is after the FINAL code-touching edit.
 *
 * TD-326 touched NINE shipping files, enumerated with `git diff --name-only`
 * rather than counted from memory (an earlier revision of this paragraph said
 * SEVEN and "two client files"; warden caught it, and the recount is why the
 * argument below got STRONGER):
 *   SERVER (5) — `suggestions-read.ts` (vendored), `brain-bridge.ts`,
 *                `types.ts`, `params.ts`, `routes.ts`
 *   CLIENT (4) — `ProjectScope.tsx`, `api.ts`, `useProjectScope.ts`,
 *                `Triage.tsx`
 * and still spent +2_837 B (2.77 KB), because the FOUR client files carry most of its
 * prose and Vite minifies those to nothing. The spend is almost entirely the
 * comment blocks in `cli/src/lib/**` plus the vendored reader — the BR-082
 * lesson holding for a third brief running: budget for SERVER comments, not for
 * client ones. Four minified files rather than two makes that case stronger.
 *
 * A STALE FIGURE CORRECTED WHILE PASSING (TD-326). `MAINTAINING.md` row 108
 * carried BR-082 at 1_683_163 packed / +1_854 B own share / 28_288 B headroom,
 * while this ledger carried 1_684_456 / +3_147 B / 26_995 B — a 1_293 B
 * disagreement, because BR-082 re-measured after a later edit and updated one
 * of the two places. THIS file is the authoritative one (it is the only copy an
 * assertion runs beside), and row 108 is now re-pointed at it. That is the
 * same failure the +550 KB paragraph above describes: a number nothing executes
 * has no way to be caught when it goes stale, so keep the two in sync in the
 * same commit or do not write the second one.
 *
 * READ THIS BEFORE PLANNING THE NEXT BRIEF: **SUPERSEDED BY TD-374 — see the
 * directive further down, which is the ONE copy — this sentence deliberately
 * carries no number, because a second copy is exactly how the last three went
 * stale.** This paragraph is kept as FR-247-era
 * history, and it is the second copy of this directive: TD-373's changelog
 * claimed to have re-pointed "the ledger's head directive" and hit only one of
 * the two. ~104.9 KB was what was left (the
 * FR-247 reading above; ~117.2 KB was FR-246's, ~143.6 KB FR-245's,
 * ~147.2 KB FR-244's, ~149.3 KB TD-328's and ~173.6 KB TD-326's, all
 * superseded).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TD-347 (2026-08-06) — THE SINGLE-CHUNK ERA IS OVER. READ THIS FIRST.
 * ─────────────────────────────────────────────────────────────────────────
 * Everything below about "the app chunk" and its `chunkSizeWarningLimit` slack
 * is HISTORY. There is no longer one chunk, and the binding budget is no longer
 * a Vite warning — it is two EXECUTABLE ceilings in
 * `cli/src/__tests__/dashboard-chunks.test.ts`, which is now authoritative for
 * every browser-bundle number. Read the constants from there, never from here.
 *
 * THE NEW COMPOSITION, measured via `bash cli/scripts/build-dashboard.sh`:
 *
 *   INITIAL SET   285_390 B  over 1 file   (ceiling 309_390 B, 24_000 B slack)
 *   TOTAL JS      562_923 B  over 7 chunks (ceiling 586_923 B, 24_000 B slack)
 *   DEFERRED      277_533 B  over 6 chunks, off the critical path
 *
 *     Graph       206_455 B   <- the vendored force-graph family lives here
 *     Layers       45_539 B
 *     Triage       12_675 B
 *     useQFilter   11_448 B
 *     neighbours    1_036 B
 *     Button          380 B
 *
 * The initial set fell 559_516 -> 285_390 B, a **274_126 B (49.0%) reduction**.
 * Re-derived from the two operands beside it: 559_516 - 285_390 = 274_126;
 * 274_126 / 559_516 = 49.0%. TOTAL JS went 559_516 -> 562_923 = **+3_407 B**,
 * which is the chunking overhead and is the honest cost of the split.
 *
 * WHICH CEILING YOUR CHANGE IS CHARGED AGAINST — this is the AC #6 answer, and
 * the reason the table above is spelled out rather than summarised:
 *   * EAGER, charged to INITIAL_JS_CEILING: `App.tsx`, `router.tsx`,
 *     `layers/model.ts`, `components/chrome/**`, most of `components/ui/**`,
 *     `lib/**`, and `pages/Overview.tsx` (eager because `router.tsx#parse` falls
 *     back to it for `#/` and every unknown hash, AND because its exclusive
 *     weight is 8_005 B — every import it has is already shared EXCEPT
 *     `ui/Card.tsx` (~1 KB), so lazying it would buy little and cost a round
 *     trip on the commonest first paint).
 *     NOT wholesale `components/ui/**`: `ui/Button.tsx` is used by three LAZY
 *     routes and no eager one, so it is hoisted into its own DEFERRED
 *     `Button-<hash>` chunk and charged to TOTAL_JS_CEILING only.
 *   * DEFERRED, charged to TOTAL_JS_CEILING only: `pages/Graph.tsx` + `graph/**`,
 *     `pages/Layers.tsx` + `pages/layers/**` + `components/record/**` +
 *     `markdown/**`, and `pages/Triage.tsx` + `triage/**`.
 *   * `gsap` stays EAGER regardless of the split — `components/chrome/Cursor.tsx`
 *     anchors it. It is the largest non-React eager item and the next planner's
 *     candidate; removing it is a behaviour change and was out of TD-347's scope.
 *
 * BOTH CEILINGS ARE `measured + 24_000 B`. The 24_000 B is four briefs at
 * FR-247's 5_899 B, the largest single-brief chunk spend in this ledger
 * (FR-246 spent 3_654 B; BR-085 spent 132 B). Re-derive it; do not round it.
 * **Neither is ever raised to make room** — TD-329's discipline applies to both.
 *
 * SCOPE THE SUPERLATIVE. This ledger only starts recording CHUNK deltas at
 * FR-246, and there is a bigger out-of-ledger case: `vite.config.ts`'s comment
 * history puts the chunk at ~477 KB after FR-239 and 524.69 KB after FR-240,
 * i.e. **~+47_700 B in one brief, ~8x FR-247's figure**. One FR-240-shaped brief
 * busts either ceiling outright. That is NOT a reason to widen the headroom: the
 * error runs the safe way (a red test and a forced conversation), and a headroom
 * sized for the worst brief on record would absorb that brief silently. Stated
 * so the next planner meets the number with the counterexample already in hand.
 *
 * WHY THERE ARE TWO AND NOT ONE, demonstrated rather than argued. Three plants,
 * each built and run:
 *   * PLANT A — 40 KB imported eagerly from `App.tsx`: INITIAL **RED** by
 *     16_023 B (325_413 vs 309_390), TOTAL **RED** by the same.
 *   * PLANT B — the same 40 KB imported ONLY from the lazy `pages/Graph.tsx`:
 *     INITIAL **GREEN**, unchanged at 285_390; TOTAL **RED** by 16_017 B
 *     (602_940 vs 586_923). **This is the whole reason the total ceiling
 *     exists**: without it, `React.lazy` is an unbounded way to spend bytes
 *     behind a boundary the initial ceiling cannot see — the "it moved
 *     elsewhere" defect class this repo keeps filing.
 *   * PLANT C — no bulk; a temporary vendor `manualChunks` pulling React out:
 *     the entry FILE fell 285_390 -> 95_394 B (−189_996 B) while the INITIAL SET
 *     moved only 285_390 -> 285_047 B (−343 B, now over two files) and the gate
 *     stayed green — correctly. This is why `initialSet()` reads the entry
 *     `<script>` PLUS its `<link rel="modulepreload">` closure: the metric is
 *     the initial LOAD, not the initial FILE, and a vendor split cannot game it.
 *
 * A PLANT-CONSTRUCTION TRAP, recorded because it cost a false reading. The first
 * draft referenced the bulk as `window.__bulk = BULK.length`. `BULK.length`
 * constant-folds to a number, `BULK` becomes unused, and the 40 KB literal is
 * tree-shaken — the build came back +18 B and the gate went green, which reads
 * exactly like "the ceiling does not catch this". Verified by grepping the built
 * chunks for the literal: absent. A plant must reference the WHOLE value
 * (`window.__bulk = BULK`). **A demonstration that silently plants nothing is
 * worse than no demonstration**, because it produces a confident green.
 * (An earlier draft was worse still: `"x".repeat(40000)` is 20 characters of
 * source, so it added 43 B. Use a real literal.)
 *
 * `chunkSizeWarningLimit` SURVIVES BUT IS DEMOTED, 560 -> 300. At 560 the
 * largest chunk (285.39 kB) sat 274.61 kB below it, so it would effectively
 * never fire again and would measure nothing — the exact defect scope item 4
 * named. At 300 it is capable of firing, and deliberately TIGHTER than this
 * gate's 309_390 B so the build warns before the test reddens. It is re-aimed just above the largest chunk and is
 * now a build-time surprise detector, NOT the gate. The gate is the vitest file.
 *
 * HISTORY BELOW THIS LINE, kept as provenance:
 *
 * BR-085 measured 2026-08-04: **559_384 -> 559_516 B, +132 B**, spending 21% of
 * the 616 B FR-247 left. Superseded by TD-347 — that 484 B of slack no longer
 * exists as a concept.
 *
 * CHUNK figure is SOLID; the PACKED figure below is a FLOOR, not a reading.
 * `npm pack` packs `dist/`, and on this machine `npm run build` in `cli/` is a
 * live deploy (it rewrites the vendored brain server the operator's MCP runs
 * from), so `dist/` was NOT rebuilt after this brief's review-round comment
 * edits. The dashboard bundle WAS rebuilt (`build-dashboard.sh` touches only
 * the gitignored `dist/dashboard`), which is why the chunk number is real. The
 * packed total below therefore reflects the pre-review build: **1_812_952 B
 * over 804 entries**, and the review round added roughly 400 B of comment to
 * `src/lib/dashboard/routes.ts` that tsc will preserve on the next real build.
 * Do not read a `+0 B` delta here as "free" — it means the artifact did not
 * move because it was not rebuilt. Re-take this reading after the next build.
 *
 * The 132 B
 * are the client-side review-scope plumbing (the `review_status` field on the
 * search row type, the banner's scope source, and the search-params render) —
 * a genuinely small UI change, which was the point: at 484 B, "small" was no
 * longer automatically affordable. **RESOLVED BY TD-347** — the split shipped
 * separately (the operator's choice over folding it into whichever UI brief ran
 * first), so FR-248 and FR-249 are both unblocked and neither owns it. They now
 * plan against `INITIAL_JS_CEILING`, with 24_000 B of initial slack and the
 * composition table above naming which chunk each change is charged to.
 *
 * TD-347's OWN PACKED READING, in BR-085's own terms: **unchanged-because-not-
 * rebuilt, NOT free.** Nothing TD-347 touched is a packed surface —
 * `dashboard-chunks.test.ts` is under `src/__tests__` (excluded from `dist`),
 * `browser-gate.mjs` is not packed, and `MAINTAINING.md` / `docs/` are outside
 * the package. The exception is `cli/CHANGELOG.md`, which IS in `package.json`
 * `files` and ships, so the next real build moves the packed figure by roughly
 * that entry's length. Do not record a `+0 B` delta here as a measurement.
 *
 * The "five GL-006 briefs remain" this sentence used to carry was not
 * re-derivable, so it is read off the goal's own edges instead. Re-derived
 * READ-ONLY at FR-247 (`serves_goal` edges into GL-006, deleted-flag excluded,
 * project-qualified to `igris-ai` — the join in `getGoal` is NOT
 * project-qualified, which is BR-078 and is why this reading adds the
 * predicate itself): BR-082, FR-244, FR-245, FR-246, TD-326, TD-328 and TD-329
 * are `Done`, and **FR-247 is the brief writing this line**. The goal's
 * `serves_goal` set is therefore EXHAUSTED — there is no next brief on GL-006
 * whose estimate this paragraph could carry, and the deferred FR-249 (goal
 * creation from the dashboard) is not yet attached to it.
 *
 * THE RATIOS ARE GONE, DELIBERATELY, AT THE FOURTH FAILURE. This sentence used
 * to translate the headroom into "N FR-240s of slack" and to name which past
 * briefs would still fit. It went stale FOUR times. The headroom above is the
 * number; the per-brief own-share table in this same file is the divisor; a
 * reader who wants the ratio can divide, and their division cannot rot. Nothing
 * gated the comparison — `PACK_HARD_CEILING_DELTA` gates the BYTE figure and
 * there is no assertion anywhere behind a ratio — so it was a claim with no
 * gradient, which is precisely the failure TD-328 diagnosed about tolerance
 * without observation, in a different costume. **If you find yourself re-adding
 * a ratio here, that is the fifth time: don't.** [Kept below: the record of the
 * four failures, because it is why this paragraph is shaped the way it is.]
 *
 * [Corrected AGAIN at FR-246 review — the THIRD time this exact
 * sentence has gone stale while every copy of the NUMBER six lines up was
 * updated correctly. At FR-245 it read "roughly ONE FR-240 of slack" (true at
 * 48.4 KB, false at 143.6); at FR-246 it read "roughly THREE" (true at 143.6,
 * false at 118.2), and the brief-count clause had gone wrong in a second way —
 * it named FR-246 as unshipped while FR-246 WAS the brief updating the number
 * beside it, and the figure moved a THIRD time inside the review round itself
 * (118.2 -> 117.3 -> 117.2 KB across the two rounds). Three strikes on one sentence is no longer drift, it is a
 * structural property of the sentence: a claim ABOUT a value carries no copy of
 * that value, so a class-grep for `1\d\d\.\d KB` finds the figure and walks
 * straight past the comparison. **Grep the COMPARISON — "FR-240s of slack",
 * "would fit", "unshipped" — not just the figure**, and if you are editing this
 * paragraph for a fourth time, consider whether it should carry ratios at
 * all." At the fourth time, they WERE removed — see above. Past-tensed because
 * a live imperative inside a preserved history block is the shape that gets
 * obeyed by someone who did not read twenty lines up.] The answer when it binds is still to cut or to vendor less,
 * never to raise `PACK_HARD_CEILING_DELTA` — it has moved TWICE (TD-329
 * 2026-08-02, TD-374 2026-08-10 which also RE-BASED it), each time before the
 * work, on a measurement, as a recorded operator decision. Two decisions taken
 * that way are not a sliding number; FR-239 is the proof, having proposed a
 * raise, measured, not needed it, and RESTORED the old value.
 *
 * (An earlier revision of this sentence said the headroom was "smaller than
 * what any single brief has spent except TD-326 and BR-082". That was true at
 * ~23.6 KB and became FALSE at 173.6 KB — the number was swapped and the claim
 * built on it was left standing. Caught in review. It is the learning-1131
 * failure in its subtlest form: a class-grep finds the VALUE, but a claim
 * ABOUT the value carries no copy of it.)
 *
 * THE CEILING DID NOT MOVE FOR FR-241, and none of its three pre-declared cut
 * levers was needed. It planned against ~68 KB and spent ~39 KB. The reason the
 * figure is that small is worth recording, because it is the same reason
 * FR-240's was: the expensive things this brief added are NOT packed. `docs/`
 * and `MAINTAINING.md` sit outside `package.json` `files` (which is `dist` plus
 * three named files), and the test glob under `src` is excluded by
 * `tsconfig.json`, so no compiled `__tests__` directory exists under `dist` —
 * two new endpoint suites, a two-process parity differ, a fixture and this
 * provenance note cost exactly zero packed bytes. What DOES cost is `dist` and
 * the Vite chunk.
 *
 * (That glob is spelled out in prose rather than written literally on purpose:
 * the exclude pattern contains a star-slash pair, which terminates a block
 * comment. A provenance note that breaks the build is not a provenance note —
 * the same trap the FR-241 Phase-0 probe record dodged with its cron fields.)
 *
 * Phase 7's own delta is +1_004 B over the phase-6b reading of 1_680_305 —
 * entirely the expanded `handlePerceptionDashboard` comment block, which `tsc`
 * preserves into the vendored bundle. Small, but not zero, which is exactly why
 * the rule is measure LAST rather than reuse the last figure you saw.
 *
 * (TWO earlier readings are recorded so the git history is not read as a drift.
 * +329.6 KB was taken BEFORE the `--smoke` probe list landed in
 * `verbs/dashboard.ts`. +330.6 KB / 1_640_403 was taken at the end of phase 5,
 * before the warden pass added the `params.ts` empty-value rule and
 * `context-docs-read.ts#cutToBytes` — the only two warden-pass edits that SHIP,
 * worth +1 196 B between them; everything else that pass touched is tests,
 * `scripts/` and docs, none of which `package.json` `files` includes. The rule
 * this keeps re-teaching: measure LAST, or the figure you write down is one
 * commit stale on arrival.)
 *
 * TD-373 MEASURED ON A CLEAN TREE — the first reading in this ledger that is
 * one, and the reason the numbers above all shifted:
 *   packed              1_863_420    796 entries (a CLEAN build: `rm -rf` on
 *                                    BOTH `brain-mcp-server/dist` and
 *                                    `cli/dist`, then rebuild)
 *   cumulative delta    +548.4 KB    (561_569 B over PACK_BASELINE_PACKED)
 *   headroom remaining  ~1.6 KB      (1_631 B under TD-329's +550)
 *                                    SUPERSEDED BY TD-374 — this reading is
 *                                    what triggered the re-base and the +150 KB
 *                                    grant, and is kept as its evidence.
 *                                    This row SAID `the baseline is ~24 KB
 *                                    high and correcting it goes ~19.9 KB
 *                                    NEGATIVE`. TD-374 measured it: the clean
 *                                    figure went **+189 KB the OTHER way**, and
 *                                    the baseline was replaced rather than
 *                                    corrected.
 *   orphans deleted     -9_624 B     24 files with no source, shipping since
 *                                    `c6777bc`. Their presence is what put the
 *                                    working tree 3 B PAST the ceiling.
 *   TD-373's own share  NOT ISOLATED, deliberately. A clean build of `HEAD`
 *                                    (873d012) in a scratch worktree read
 *                                    1_855_430 / +9_621 B headroom. The 5_541 B
 *                                    between that and the figure above is
 *                                    uncommitted work that SHIPS — TD-373's own
 *                                    `cli/CHANGELOG.md` entry AND a concurrent
 *                                    session's TD-367 changes, in the same
 *                                    file. Separating them would mean stashing
 *                                    another agent's live work, so the ledger
 *                                    says "both" rather than guessing a split.
 *                                    (This is the TD-333 lesson applied to
 *                                    itself: an earlier draft of this row
 *                                    attributed the whole 5_541 B to the other
 *                                    session and forgot its own changelog
 *                                    entry, which is exactly the over-
 *                                    attribution TD-333 warns about.)
 *
 *   MEASURED LAST, twice, and the second pass corrected the first. An
 *   intermediate reading of 1_860_971 / +4_080 B was written here; the review
 *   round that followed spent **+2_449 B** and the row was re-measured. A draft
 *   of this paragraph blamed "this very docblock and two CHANGELOG entries",
 *   which is wrong in the flattering direction: `tsconfig` excludes
 *   `src/__tests__` from `dist`, so **every byte of prose in THIS file is
 *   packed-free**, and so is `scripts/copy-templates.sh` (outside
 *   `package.json` `files`). Re-measuring after the edit confirmed it —
 *   1_863_420 both before and after, unchanged to the byte. The 2_449 B is
 *   `cli/CHANGELOG.md`, which `files` ships verbatim, plus a four-line comment
 *   in `src/lib/sync/code.ts`, which `tsc` compiles into `dist` and charges for
 *   TWICE (`.js` and `.js.map`). Which prose costs is not intuition; it is a
 *   property of `files` and `tsconfig`, and it is cheap to check.
 *
 *   HOW IT WAS TAKEN, so the next brief does not re-derive it: `git worktree
 *   add` a detached checkout, symlink `node_modules` at the repo root AND in
 *   `cli/` AND in `brain-mcp-server/` (the last is required or `tsc` cannot
 *   resolve `@types/express`), `npm run build`, `npm pack --dry-run --json`.
 *   The live deploy is never touched because the worktree's `cli/dist` is a
 *   different path. Four minutes. BR-085 and TD-347 both logged a FLOOR instead
 *   of doing this, and FR-248's plan then bounded the slack at 52_099 B — 13x
 *   the truth, against a tree that was already over.
 *
 * TD-374 IS THE NEW ORIGIN, and its own row is the first one measured against
 * itself:
 *   baseline set        1_863_420    796 entries — the clean measurement of
 *                                    TD-373's tree, taken on `bd49525`
 *   packed after        1_865_128    796 entries
 *   TD-374's own share  +1_708 B     `cli/CHANGELOG.md` ONLY — the root
 *                                    CHANGELOG is not in `cli`'s `files`, so
 *                                    an earlier draft saying "its two CHANGELOG
 *                                    entries" over-attributed by one. The constants,
 *                                    this docblock and the whole provenance
 *                                    rewrite cost ZERO, because `tsconfig`
 *                                    excludes `src/__tests__` from `dist`
 *   delta after         +1_708 B     headroom +151_892 B under the +150 KB grant
 *
 *   MEASURED LAST. The `MAINTAINING.md` row also cost nothing — it is outside
 *   `package.json` `files`. Which prose costs is a property of `files` and
 *   `tsconfig`, not intuition, and it is cheap to check before writing.
 *
 * FR-248 MEASURED LAST — the first brief to spend against TD-374's origin:
 *   packed              1_889_030    800 entries
 *   cumulative delta    +25.0 KB     (25_610 B over PACK_BASELINE_PACKED)
 *   FR-248's own share  +23_902 B    against its plan's ~26 KB estimate, which
 *                                    HELD — worth saying, since five other
 *                                    numbers quoted into this brief did not
 *   headroom remaining  ~125.0 KB    (127_990 B under TD-374's +150)
 *   browser surfaces    INITIAL +299 B (estimate said ~300, also held)
 *                       TOTAL   +8_695 B over 9 chunks (was 8 — Rollup
 *                       re-partitioned when `SearchReadout` gained a third
 *                       async importer). NEITHER chunk ceiling re-based:
 *                       `HEADROOM` is deliberately ~four briefs of CUMULATIVE
 *                       budget, so moving `MEASURED_TOTAL` would turn it into a
 *                       per-brief reset.
 *
 * FR-249 MEASURED LAST:
 *   packed              1_896_135    800 entries
 *   cumulative delta    +31.9 KB     (32_715 B over PACK_BASELINE_PACKED)
 *   FR-249's own share  +7_105 B     against its plan's +8-18 KB estimate, which
 *                                    OVER-shot. The charge is `cli/CHANGELOG.md`
 *                                    verbatim plus the bridge's runtime prose;
 *                                    the guard rewrite, the five new gates, the
 *                                    browser gate, `docs/**` and `MAINTAINING.md`
 *                                    are all packed-free by the rule below
 *   headroom remaining  ~118.1 KB    (120_885 B under TD-374's +150)
 *   browser surfaces    INITIAL +0 B — the `lib/api.ts` widening is TYPE-ONLY
 *                       and the rule below predicted zero. PREDICTED, THEN
 *                       MEASURED: 285_689 before and after, to the byte
 *                       TOTAL   +1_704 B over the same 9 chunks — `Layers`
 *                       45_577 -> 46_789 (the form) and `useQFilter` 6_215 ->
 *                       6_707 (the create builder and the third `useTriage`
 *                       wrapper, which live in `triage/**` and are therefore
 *                       charged to the SHARED chunk rather than to the page
 *                       that renders them). NEITHER chunk ceiling re-based
 *
 *   MEASURE IT THE WAY THE BASELINE WAS TAKEN, OR THE COMPARISON IS OFF BY A
 *   FILE. `DASH_BUNDLE_REPORT=1 bash scripts/build-dashboard.sh` writes
 *   `dist/dashboard/.bundle-report.json`, which `files` SHIPS — so an in-place
 *   pack taken after a report-enabled build reads 801 entries and 1_898_453,
 *   +3_395 B against an otherwise identical tree. `npm run build` does not set
 *   that variable, so no clean-worktree baseline in this ledger contains the
 *   file. Both numbers were taken here; the 800-entry one is the comparable.
 *   **The ENTRY COUNT is what exposes it** — 801 vs 800 — which is the argument
 *   for this ledger's convention of recording entries beside every byte figure.
 *   A 3_395 B phantom looks exactly like code growth if you only read bytes.
 *   NOW GUARDED: see the assertion "no build DIAGNOSTIC reaches the tarball",
 *   proven red-first by rebuilding WITH the flag and watching it fire. The
 *   measuring instrument could inflate the thing it measures; it no longer can.
 *
 *   AND THE TOTAL_JS CEILING IS NOW THE TIGHT ONE — 13_601 B after this brief,
 *   against packed's 121_962. The next brief with a UI hits the browser ceiling
 *   first, and this row is where it should learn that rather than reading
 *   packed's comfortable figure and planning against the wrong constraint.
 *
 *   WHICH PROSE COSTS IS A PROPERTY OF WHAT IT IS ATTACHED TO, not of which
 *   file it lives in — and this session made three different claims about it
 *   before measuring. The rule, verified in both directions:
 *     - `src/__tests__/**`            FREE. `tsconfig` `exclude`s it from `dist`.
 *     - `scripts/**`                  FREE. Outside `package.json` `files`.
 *     - `docs/**`, `MAINTAINING.md`   FREE. Same reason.
 *     - `cli/CHANGELOG.md`            CHARGED, verbatim — `files` ships it.
 *     - a comment on RUNTIME code     CHARGED ONCE in the `.js`, plus a small
 *                                     `mappings` shift in the `.js.map`.
 *                                     Verified: TD-373's note on `RSYNC_EXCLUDES`
 *                                     (a `const`) appears in `dist/lib/sync/code.js`.
 *                                     (READ TWICE UNTIL TD-443 — grep
 *                                     `CHARGED ONCE PLUS A MAPPINGS SHIFT`.)
 *     - a comment on a TYPE-ONLY      **FREE.** TypeScript ERASES `type` and
 *       declaration                   `interface` entirely, and the docblock
 *                                     above them goes with it. Verified: FR-248
 *                                     added ~500 B of prose above
 *                                     `TriageExtraKey`/`BriefRef` in
 *                                     `brain-write-bridge.ts` and
 *                                     `dist/lib/brain-write-bridge.js` came back
 *                                     BYTE-IDENTICAL (same shasum after `touch`
 *                                     + `tsc --listEmittedFiles` confirmed the
 *                                     file WAS re-emitted).
 *   So "it is in `cli/src`, therefore it ships" is too coarse, and so is "it is
 *   a comment, therefore it is free". Check what the comment sits on.
 *
 *   CHARGED ONCE PLUS A MAPPINGS SHIFT — TD-443's correction to the RUNTIME row
 *   of the `WHICH PROSE COSTS IS A PROPERTY OF WHAT IT IS ATTACHED TO` table
 *   (grep it; it is in FR-249's row), and it is a CLASS, not a line. Nothing
 *   here depends on the two staying adjacent. "Charged twice (`.js` + `.js.map`)"
 *   was never true in either package, and two independent measurements refute
 *   it. (a) A `.js.map` carries NO `sourcesContent` — the keys are version,
 *   file, sourceRoot, sources, names, mappings — so the prose is in the map
 *   nowhere and only the VLQ `mappings` move:
 *     python3 -c "import json;print(sorted(json.load(open('cli/dist/lib/slug.js.map'))))"
 *   (b) The shift was measured directly, and it is in TD-420's own row in this
 *   file — grep `THE UNPACKED DELTA RECONCILES EXACTLY`: `routes.js` +1_317 B
 *   against its map's +148, `params.js` +464 against +7, `brain-write-bridge.js`
 *   +1_123 against +17. A few percent, not a second copy. The brain side is
 *   identical: all 138 vendored `.d.ts.map` carry that same six-key set and no
 *   `sourcesContent`, so the 138 TD-443 dropped from `files` were pointer files
 *   rather than a second copy of the prose.
 *
 *   THE CENSUS, KEYED TO HEAD SO IT CANNOT COUNT ITSELF. This correction block
 *   adds occurrences of the phrase it is about, so every figure in THIS BLOCK is
 *   taken against `1e48af5`, where it is frozen. Strip the leading " * " and run:
 *
 *   rm -rf /tmp/h && mkdir /tmp/h && git archive HEAD | tar -x -C /tmp/h && (cd /tmp/h && find . -type f ! -name '*.png' ! -name '*.jpg' -print0 | xargs -0 perl -0777 -ne 's/\s+/ /g; while (/(.{0,170}(?:twice|second time|doubl[ey]).{0,170})/gi) { my $h=$1; print "$ARGV\n  $h\n\n" if $h =~ /tsc|dist\/|comment|docblock|prose|\.js\.map|\.d\.ts\.map/i && $h =~ /charg|cost|pay|paid|spend|spent|byte|packed|tarball/i }')
 *
 *   The subshell is load-bearing — a bare `cd` leaves the caller in /tmp/h. Pipe
 *   the output through `grep -c '^  '` for the window count; it prints 21.
 *
 *   MEASURED 2026-09-02: 21 windows over 7 files, adjudicated to 17 MEMBERS and
 *   4 non-members. COLLAPSE FIRST — the same predicate run line-oriented misses
 *   every wrap-crossing member, including the rule sentence in TD-420's row,
 *   whose "cost bytes twice" and its verdict sit on opposite sides of a comment
 *   wrap. The four non-members are named so nobody re-opens them: FR-245's row
 *   "at twice the size" (a size comparison), MAINTAINING row 110's "moved the
 *   packed total TWICE, recorded as a chain" (a count of readings),
 *   `browser-gate.mjs`'s "the payload is paid for twice" (a network fetch), and
 *   `npm-publish.yml`'s "double-booking a second build" (a CI job).
 *
 *   THE 17, WITH DISPOSITIONS:
 *     - 3 LIVE RULE SITES, all in this file, all CORRECTED by TD-443: the
 *       RUNTIME row of the `WHICH PROSE COSTS` table in FR-249's row, the rule
 *       sharpening in TD-420's row, and TD-374's ceiling derivation under
 *       `THE CEILING — +150 KB`. Every one is grep-addressable on purpose.
 *       Two MORE live sites sit
 *       OUTSIDE THE REPO and were corrected in the same pass: §13's table row
 *       and its `.d.ts` clause in
 *       `~/.igris/projects/igris-ai/context/coding_guidelines.md`. `git
 *       ls-files` CANNOT SEE that file. Run the same perl over `~/.igris` as a
 *       second pass, or the sweep reports the class clean while the doc every
 *       brief consults before budgeting prose still states it.
 *     - 9 HISTORICAL PER-BRIEF NARRATIVES IN THIS FILE, LEFT AS WRITTEN AND
 *       COVERED BY THIS ENTRY — the rows of FR-266, TD-420, TD-333, FR-247,
 *       FR-246 (twice), TD-373, BR-089 and BR-083 — plus MAINTAINING row 110
 *       twice and the root `CHANGELOG.md` TD-374 entry. Each records what its
 *       brief BELIEVED while measuring, and no FIGURE in any of them depends on
 *       the belief: every one is a measured packed delta, never an estimate
 *       arrived at by doubling. Rewriting frozen narrative would put new prose
 *       into records whose numbers are right; correcting the RULE and
 *       enumerating the copies is the proportionate half.
 *     - 2 DECLINED BECAUSE THEY ARE PACKED SURFACES, and the decline is the
 *       answer rather than an oversight: `cli/CHANGELOG.md`'s TD-374 entry, and
 *       the `openBrainReadonly` docblock in `cli/src/lib/brain-db.ts`. Both
 *       ship — the changelog verbatim, the docblock through
 *       `dist/lib/brain-db.js` — so editing either moves the very total this
 *       ledger records, and TD-443's round-3 scope forbids the re-pack that
 *       would be needed to state the new one. The changelog copy has a second
 *       reason that outlives the scope: it is the verbatim twin of the root
 *       `CHANGELOG.md` entry, so correcting the free copy alone would DIVERGE
 *       two changelogs meant to match. Whoever next re-packs for another reason
 *       should take both in one pass, and re-measure after.
 *   EIGHT MORE COPIES live in closed briefs and plans under
 *   `~/.igris/projects/igris-ai/` — the FR-247, FR-248, FR-249, FR-260 and
 *   FR-268 plans, TD-420's plan, and the TD-373 and TD-374 briefs. They record
 *   what those briefs planned against and are left for the same reason as the
 *   ledger rows.
 *
 *   THE LAST TWO DIGITS CHASE THEMSELVES, and this row is where that is stated.
 *   `cli/CHANGELOG.md` SHIPS, so writing the exact byte count into the entry
 *   changes the byte count. Three iterations converged to within 1 B and then
 *   oscillated on the digit itself. Resolved by rounding in the changelog
 *   (`~23.8 KB`) and putting the exact figure HERE — `src/__tests__` is excluded
 *   from `dist` by `tsconfig`, so this file is packed-free and can carry a
 *   number the changelog cannot. TD-374's row established that property; this
 *   row is the first to need it.
 *
 * BR-089 MEASURED LAST — a DEPENDENCY bump, so the shape of the spend differs:
 *   packed              1_899_945    800 entries
 *   cumulative delta    +35.7 KB     (36_525 B over PACK_BASELINE_PACKED)
 *   BR-089's own share  +10_915 B    and almost NONE of it is this brief's
 *                                    prose. `better-sqlite3` 11 -> 12 changes
 *                                    the vendored `dist/brain-mcp-server`
 *                                    payload, and the two `trusted_schema`
 *                                    fixes are comments on RUNTIME code, so
 *                                    they are charged twice (.js + .js.map) per
 *                                    the rule below. A dependency bump is the
 *                                    one change whose packed cost is mostly not
 *                                    yours to control.
 *   headroom remaining  ~114.3 KB    (117_075 B under TD-374's +150)
 *   browser surfaces    UNCHANGED — no `cli/dashboard/**` file was touched.
 *                       INITIAL 285_689, TOTAL 573_322, slack 13_601 B.
 *
 * BR-083 MEASURED LAST — the biggest single spend since the ledger was re-based:
 *   packed              1_931_485    801 entries (800 + the new backfill script,
 *                                    which SHIPS on purpose: `copy-templates.sh`
 *                                    stages `scripts/` into the bundle so the
 *                                    VPS can run the same backfill this brief
 *                                    ran locally — see the deploy hazard below)
 *   cumulative delta    +66.5 KB     (68_065 B over PACK_BASELINE_PACKED)
 *   BR-083's own share  +31_540 B    the largest of the session, and almost all
 *                                    of it is the VENDORED BRAIN: a new schema
 *                                    version, the qualification ladder, the
 *                                    backfill, and the prose on runtime code
 *                                    that `tsc` charges TWICE (.js + .js.map)
 *                                    per the rule below
 *   headroom remaining  ~83.5 KB     (85_535 B under TD-374's +150)
 *   browser surfaces    UNCHANGED — INITIAL 285_689, TOTAL 573_322, slack
 *                       13_601 B. Brain-side brief; the prediction that it
 *                       would not touch the browser was CHECKED, not assumed.
 *
 *   THE DEPLOY HAZARD IS A PACKED FACT, not only a runtime one. `entity_edges`
 *   is in `SYNC_TABLES` and the new qualifiers join the `syncKey`, so a push to
 *   a VPS still on `edges@3` fails on every INSERT. The backfill script ships in
 *   the tarball precisely so the remote can be brought forward with the same
 *   instrument rather than a hand-written UPDATE -> TD-378.
 *
 * TD-378 — a DEPLOY brief, so the packed spend is prose only:
 *   packed              1_932_758    801 entries (+1_273 B over BR-083, all of
 *                                    it `cli/CHANGELOG.md`)
 *   headroom remaining  ~82.3 KB     (84_262 B under TD-374's +150)
 *
 *   AND THE PACK ITSELF CROSSED A TEST BUDGET, which is a packed-size
 *   consequence nobody had costed. `npm pack --dry-run` now takes **16.5-19.9 s
 *   on an IDLE machine** (timed three times), against TD-336's 9464/7256 ms for
 *   the same operation under EIGHT-WAY LOAD. The tarball roughly doubled the
 *   pack's wall clock as it grew this session. Two TD-168 tests carried a
 *   hand-written `15_000` rather than `PACK_TIMEOUT_MS` and went from
 *   intermittent to RELIABLY RED. Fixed here, both halves of the contract at
 *   once as the paragraph at the top of this file demands. **A growing tarball
 *   costs seconds as well as bytes** — worth knowing before the next brief
 *   plans a spend.
 *
 * FR-267 (2026-08-26) shipped WITHOUT a row, so its share is recovered here
 * from a clean worktree build of its commit (`edf4497`, the TD-373 method:
 * `git worktree add … HEAD`, node_modules symlinked, `rm -rf dist` + build,
 * `npm pack --dry-run --json`):
 *   packed              1_979_281    801 entries (+46_523 B over TD-378, all
 *                                    of it `brain-mcp-server` prose + the
 *                                    hunt-cost handler; the entry count did
 *                                    not move)
 *   headroom remaining  ~37.7 KB     (37_739 B under TD-374's +150 —
 *                                    153_600 − 115_861)
 *
 * TD-426 MEASURED LAST (2026-08-27 14:02 UTC), the same build sequence and the
 * same node_modules as BR-097's reading:
 *   packed              2_001_634    807 entries (no new entry — the change is
 *                                    three vendored files: `db.js` (the
 *                                    four-tier `resolveDbPath` and its
 *                                    docblock, the deleted `DB_PATH` const),
 *                                    `index.js` (`_engineDbPath`, the
 *                                    `[brain] db:` line, two re-pointed sites)
 *                                    and `stdio-lifecycle.js` (the `pidsDir`
 *                                    middle tier), plus their maps; two comment
 *                                    fixes in the staged `scripts/`; and the
 *                                    `cli/CHANGELOG.md` entry, which SHIPS.
 *                                    `scripts/smoke-bundled-mcp.sh` and the
 *                                    bats twin are outside `files`, and this
 *                                    file is packed-free — the two largest
 *                                    diffs of the brief cost 0 B)
 *   cumulative delta    +135.0 KB    (138_214 B over PACK_BASELINE_PACKED)
 *   TD-426's own share  +1_702 B     (2_001_634 − 1_999_932)
 *   headroom remaining  ~15.0 KB     (15_386 B under TD-374's +150 —
 *                                    153_600 − 138_214)
 *   browser surfaces    +0 B — no dashboard file changed
 *
 * BR-097 MEASURED LAST (2026-08-27 10:48 UTC), `cd brain-mcp-server && npm run
 * build && cd ../cli && npm run build` then `npm pack --dry-run --json`, same
 * node_modules as FR-268's reading:
 *   packed              1_999_932    807 entries (re-measured after warden r1:
 *                                    +93 B over the 1_999_839 first reading —
 *                                    one comment in the vendored sync
 *                                    component and the scoped B3 sentence in
 *                                    `cli/CHANGELOG.md`, which SHIPS; no new
 *                                    entry — the change is two vendored files:
 *                                    `sync.js` (the `skipped[]` field, the
 *                                    acknowledgement stamp rule and the
 *                                    held-table text in `handleBrainPush`) and
 *                                    the vendored sync component's `index.js`
 *                                    (the same rule in `pushTables`), plus one
 *                                    line in the route)
 *   cumulative delta    +133.3 KB    (136_512 B over PACK_BASELINE_PACKED)
 *   BR-097's own share  +2_774 B     (1_999_932 − 1_997_158) against its plan's
 *                                    <= 3_072 B budget, which HELD
 *   headroom remaining  ~16.7 KB     (17_088 B under TD-374's +150 —
 *                                    153_600 − 136_512)
 *   browser surfaces    +0 B — no dashboard file changed
 *
 * FR-268 MEASURED LAST (2026-08-27), both trees built the same way with the
 * same node_modules, so the two readings are comparable to the byte:
 *   packed              1_997_158    807 entries (re-measured after warden r1:
 *                                    +146 B over the 1_997_012 first reading —
 *                                    the `throughputSql` export, the `||` slug
 *                                    fallback and two comments)
 *   cumulative delta    +130.6 KB    (133_738 B over PACK_BASELINE_PACKED)
 *   FR-268's own share  +17_877 B    (1_997_158 − 1_979_281) against its plan's
 *                                    <= 20 KB budget, which
 *                                    HELD. The six new entries are
 *                                    `dist/lib/kpi-read.js` (21_546 B
 *                                    unpacked — the seven SQL derivations and
 *                                    their doc comments, which `tsc` keeps)
 *                                    + its map, `dist/verbs/{ceremony,kpi}.js`
 *                                    + maps; the changed ones are
 *                                    `brain-db.js` (+4_941, the two doors),
 *                                    `index.js` (+2_688, two registrations),
 *                                    the vendored instances component
 *                                    (+2_068, migration v4) and `sync.js`
 *                                    (+697, one SYNC_TABLES entry).
 *   headroom remaining  ~19.4 KB     (19_862 B under TD-374's +150 —
 *                                    153_600 − 133_738)
 *   browser surfaces    +0 B — no dashboard file changed (INITIAL 286_070,
 *                       TOTAL 580_979 over 12 chunks, identical before/after)
 *
 *   **~19.4 KB IS WHAT IS LEFT.** The next brief that touches `cli/src` or
 *   `brain-mcp-server/src` must measure before it plans, and a brief of
 *   FR-267's shape (+46.5 KB) no longer fits. The answer is still to cut or
 *   to vendor less, not to raise `PACK_HARD_CEILING_DELTA` — but the
 *   operator conversation that TD-374 had is now one brief away.
 *
 * TD-423 MEASURED LAST, after its final code-touching step. Both trees rebuilt
 * from the same node_modules on both arms, so the readings are comparable:
 *   packed              2_015_140    unpacked 7_739_090, 807 entries (UNCHANGED
 *                                    — every new source file is a test or a
 *                                    fixture under a glob `tsconfig` excludes
 *                                    from `dist`)
 *   TD-423's own share  +13_487 B    (13.17 KB) against HEAD's 2_001_653,
 *                                    MEASURED by stashing the working tree
 *                                    (`git stash push -u`), rebuilding BOTH
 *                                    artifacts, packing, restoring, and
 *                                    verifying every restored file `cmp`-equal
 *                                    to a pre-stash copy — NOT by subtracting
 *                                    from the previous ledger row. The HEAD arm
 *                                    reproduced the recorded bundle figures
 *                                    EXACTLY (INITIAL 286_070 / TOTAL 580_979),
 *                                    which is what says the stash was clean.
 *   cumulative delta    +148.2 KB    (151_720 B over PACK_BASELINE_PACKED)
 *   headroom remaining  ~1.8 KB      (1_880 B under TD-374's +150 —
 *                                    153_600 − 151_720)
 *   browser surfaces    +0 B — no `cli/dashboard/**` file changed
 *
 *   **IT DID NOT FIT ON THE FIRST READING, AND THE CEILING DID NOT MOVE.** The
 *   first measurement was 2_017_493 — 473 B OVER. Per this file's own
 *   instruction the answer was to cut, not to re-base: 2_567 B was recovered
 *   by RELOCATING comment prose, not deleting it, to surfaces that are free
 *   (2_017_493 → 2_014_926), and a later correctness fix in the same brief —
 *   a channel warning that named the wrong reason — spent 214 B of it back.
 *   Where the recovery came from is the reusable part.
 *
 *   THE RULE "A COMMENT ON A TYPE COSTS NOTHING" IS TRUE FOR `cli/src` AND
 *   FALSE FOR `brain-mcp-server/src`, and that had not been recorded here. It
 *   is true in `cli/src` because that build sets `declaration: false`, so a
 *   type-only declaration and its JSDoc are erased entirely — verified: the new
 *   `CognitionYieldDigest` family is ~9 KB of source and `dist/types.js` is 95 B.
 *   It is FALSE across the package boundary: `brain-mcp-server` EMITS `.d.ts`,
 *   `copy-templates.sh` vendors `dist/brain-mcp-server/dist/**` wholesale, and
 *   `npm pack` carries 138 `.d.ts` entries totalling 693_914 B. A docblock on an
 *   INTERFACE FIELD in the brain therefore ships. Trimming the `produced`
 *   docblock in `cognition/types.ts` from 2_267 B to 1_421 B moved the packed
 *   total on its own. Budget brain-side type prose; cli-side type prose is free.
 *
 *   WHERE THE 13_487 B WENT, and none of it is decoration. The two new reader
 *   modules dominate: `dist/verbs/cognition.js` +17_114 B and
 *   `dist/lib/brain-db.js` +16_272 B unpacked, plus +11_181 and +10_983 in
 *   their maps — 55.5 KB of the 59.2 KB unpacked delta, for ~600 lines of new
 *   TypeScript. `brain-mcp-server/**` contributed ~2.7 KB across the migration,
 *   the roster projection and seven one-line extractor declarations. `docs/`,
 *   `MAINTAINING.md` and `core/skills/**` are outside `files` and cost nothing,
 *   which is exactly why the long-form account of the yield surface lives in
 *   `docs/COGNITION.md` and the shipped docblocks point at it.
 *
 *   **~1.8 KB IS WHAT IS LEFT, AND THAT IS THE HEADLINE.** HEAD already had
 *   only 15_367 B before this brief spent 13_487 of it. The next brief that
 *   touches `cli/src` or `brain-mcp-server/src` cannot fit a feature at all —
 *   even a pure comment round in a shipped file has moved this number by
 *   +442 B before now. This is the state TD-374's own text anticipated: "the
 *   operator conversation that TD-374 had is now one brief away." It has
 *   arrived. Raising `PACK_HARD_CEILING_DELTA` is an OPERATOR decision with a
 *   named date, taken BEFORE the work that needs it and with an estimate on the
 *   record — not something a failing assertion licenses.
 *
 *   `tarball.test.ts` is under a test glob `tsconfig` excludes from `dist`, so
 *   writing THIS row cannot move the number it records — verified by re-packing
 *   after the edit.
 *
 * TD-414 MEASURED LAST (2026-09-04), after its final SHIPPED code-touching
 * step (the runtime context docs that closed the hunt ship no bytes).
 * MEASURED BY STAGING INTO A COPY, NOT BY BUILDING — TD-447's method, taken
 * twice: once before and once after the shipped-comment trim (the first
 * reading, +1_759 packed, is void; only the second is the row). Both packages
 * compiled inertly with `npx tsc --outDir <scratch>` and NO other flag; the
 * staged set was DERIVED by `cmp` of every inert-compile artifact against its
 * vendored twin (brain: 409 unchanged, 136 of them `.js.map` whose `sources`
 * rewrite came out `cmp`-identical BEFORE any changed map was staged; cli:
 * 216 unchanged, 0 changed — this brief edits no `cli/src` runtime file).
 * `cli/dist` and `brain-mcp-server/dist` were never written; no file under
 * either dist is newer than the edited sources. The three brain sources newer
 * than the vendored `index.js` are exactly this brief's `cache/handlers.ts`,
 * `cache/index.ts` and `tools/briefs.ts` (plus its two test files, excluded
 * from dist).
 *   packed              2_010_385    unpacked 7_663_285, 672 entries (UNCHANGED —
 *                                    no new module; the classifier lives in
 *                                    cache/handlers.ts)
 *   TD-414's own share  +1_334 B     (1.3 KB) against HEAD `a3d8a4a`'s 2_009_051
 *                                    (+5_219 unpacked, reconciling EXACTLY to the
 *                                    eight staged files' size deltas — all eight
 *                                    non-zero; the SHA control on the untouched
 *                                    copy reproduced 2_009_051 / 7_658_066 / 672 /
 *                                    shasum `0494960fd0874ac5a17a8321e78f874a4c408b2a`
 *                                    twice, before each staging)
 *   cumulative delta    +146_965 B   (143.5 KB over PACK_BASELINE_PACKED,
 *                                    95.7% of TD-374's grant)
 *   headroom remaining  ~6.5 KB      (6_635 B — 153_600 − 146_965)
 *   built app chunk     NOT REMEASURED (no dashboard change)
 *
 *   WHERE THE 1_334 B WENT. Brain side only, charged three ways:
 *   `cache/handlers.ts` +3_324 unpacked (.js +1_409 — `cacheRoot`, `dbTimeMs`,
 *   `briefCachePath`, `diskEditState`, `projectBriefFile`, the `force` and
 *   `briefs_skipped` plumbing; .js.map +1_367; .d.ts +548 — three new exports
 *   and two exported string unions), `cache/index.ts` +963 (.js +656 — the
 *   warn branch, the `force` schema entry and two reworded listen
 *   descriptions; .js.map +259; .d.ts +48), `tools/briefs.ts` +932 (.js +628 —
 *   the widened SELECT and the decline note; .js.map +304; .d.ts +0 — the
 *   signature did not change). 0.26 packed bytes per unpacked byte on this
 *   mix. New shipped comment prose across the three files: +290 B (measured
 *   against `git show HEAD:`; the first draft was +996 and was trimmed to the
 *   plan's ≤ 400 B budget — the reasoning moved to the unshipped test docblock
 *   and to `docs/architecture/brief-state-source-of-truth.md`).
 *
 *   `tarball.test.ts` is under a test glob `tsconfig` excludes from `dist`, so
 *   writing THIS row cannot move the number it records.
 *
 * TD-390 MEASURED LAST (2026-09-04), after its final code-touching step.
 * +0 B PACKED, BY CONSTRUCTION AND BY MEASUREMENT. This brief edits no
 * `cli/src` runtime file and no brain source: the fix is a bash guard in
 * `core/scripts/cli-adapters/compile_harnesses.sh` plus a comment in
 * `check_harness_drift.sh`, and the bash adapters are NOT in the tarball
 * (`cli/package.json` `files` = `dist` + `scripts/postinstall.mjs` + README +
 * CHANGELOG; `copy-templates.sh` stages `harness-manifest.json` and the brain
 * bundle, never `cli-adapters/` — grep: 0 hits; `cli/dist/**\/compile_harnesses.sh`
 * does not exist). They ARE TD-096 runtime-mirrored, which is a different
 * surface. No build ran (L-1165: `npm run build` is `rm -rf dist && tsc …` and
 * `cli/dist` is the live brain bundle path); the bats suite drove the existing
 * `cli/dist/index.js` read-only. `cli/package.json` declares no `prepack` or
 * `prepare` hook, so the in-place `npm pack --dry-run` below built nothing.
 *   packed              2_009_051    unpacked 7_658_066, 672 entries, shasum
 *                                    `0494960fd0874ac5a17a8321e78f874a4c408b2a`
 *                                    — the on-disk dist packs at EXACTLY the
 *                                    TD-414 row's CONTROL reading (identical
 *                                    shasum), because TD-414 staged its brain
 *                                    edits into a copy and never built; the
 *                                    row's live figure 2_010_385 is that staged
 *                                    reading and is unchanged by this brief.
 *   TD-390's own share  +0 B         (nothing packed was touched; the only
 *                                    `cli/` edit is this comment, excluded
 *                                    from dist)
 *   cumulative delta    +146_965 B   (unchanged from TD-414)
 *   headroom remaining  ~6.5 KB      (6_635 B — unchanged)
 *   built app chunk     NOT REMEASURED (no dashboard change)
 *
 * TD-447 MEASURED LAST (2026-09-03), after its final code-touching step.
 * MEASURED BY STAGING INTO A COPY, NOT BY BUILDING — TD-440 round 4's method,
 * adopted as that row instructs: both packages compiled inertly with
 * `npx tsc --outDir <scratch>`, exactly the changed artifacts staged into a
 * scratch copy of the packed surface, and the pack taken there. `cli/dist` and
 * `brain-mcp-server/dist` were never written: an in-place `npm pack --dry-run`
 * AFTER staging differed from the control at exactly ONE entry, `CHANGELOG.md`
 * (171_658 → 172_048 — the working-tree bullet), so every `dist` entry the real
 * package would ship is the control's; and the brain sources newer than the
 * vendored `index.js` are exactly this brief's eleven edited files, no more.
 * No file under either dist is newer than the edited sources.
 * Round 2 (the warden's L-1246 finding: perception `runner.ts`'s `LlmStatus`
 * still printed `failed:unknown` for the new classes) re-took the whole
 * measurement from the same control; the staged set was DERIVED by `cmp` of
 * every inert-compile artifact against its vendored twin, not hand-listed.
 *   packed              2_009_051    unpacked 7_658_066, 672 entries (UNCHANGED —
 *                                    no new module; the detector lives in
 *                                    parse-output.ts)
 *   TD-447's own share  +2_523 B     (2.5 KB) against HEAD `6d077a1`'s 2_006_528
 *                                    (+9_723 unpacked, reconciling EXACTLY to the
 *                                    twenty-one staged files' size deltas: eighteen
 *                                    non-zero, three content-changed at +0 —
 *                                    monitoring/index.js's `:110` → `:112`
 *                                    pointer, events.js.map, brain-write-bridge.js.
 *                                    Round 1 read +2_482 / +9_472; round 2 added
 *                                    runner.{js,js.map,d.ts} = +41 packed,
 *                                    +251 unpacked, and nothing else moved)
 *   cumulative delta    +145_631 B   (142.2 KB over PACK_BASELINE_PACKED,
 *                                    94.8% of TD-374's grant)
 *   headroom remaining  ~7.8 KB      (7_969 B — 153_600 − 145_631)
 *   built app chunk     NOT REMEASURED (no dashboard change)
 *
 *   THE CONTROL CORRECTS THE BASE. The scratch copy packed 2_006_528 /
 *   7_648_343 / 672 / shasum `30eab099c3128b5ac88675dd73fbaa01d89f177b`
 *   BEFORE staging, and the in-place pack of `cli/dist` gave the identical
 *   four figures — so HEAD's live reading is 2_006_528 (cumulative 143_108,
 *   headroom 10_492 B), 371 B ABOVE the 2_006_157 / 10_863 B the TD-440 row
 *   records. Whether those 371 B are a post-row edit or a staging-vs-build
 *   difference was not established here; the SHA control is what this row's
 *   delta is taken against. TD-447's brief quoted "10,492 B" and attributed it
 *   to a `TD-444`, which matches no file in the tree — the number was right,
 *   the attribution was not.
 *
 *   WHERE THE 2_523 B WENT. Brain side, charged three ways: `parse-output.ts`
 *   +4_129 unpacked (.js +1_883, .js.map +1_199, .d.ts +1_047 — the detector,
 *   its exported interface and the auth regex), `backend/index.ts` +857, the
 *   perception `switch` +363, the perception runner's `LlmStatus` union and
 *   two `case` lines +251 (.js +132, .js.map +76, .d.ts +43), two `.d.ts`
 *   comment lines +58. CLI side, charged
 *   once: `brain-db.ts` +1_543 (.js + map), `verbs/cognition.ts` +2_132
 *   (.js + map: the `firstSentence` helper, the classifier prefix and its
 *   WHY comment). `CHANGELOG.md` +390 verbatim. 0.26 packed bytes per unpacked
 *   byte on this mix. Source maps were staged with their `sources` path
 *   rewritten from the scratch-relative form to the vendored form
 *   (`../../../../../src/…`); the rewrite was validated on two UNCHANGED files
 *   (`exec.js.map`, `kpi-read.js.map`) coming out `cmp`-identical to their
 *   vendored copies before any changed map was staged.
 *
 *   `tarball.test.ts` is under a test glob `tsconfig` excludes from `dist`, so
 *   writing THIS row cannot move the number it records.
 *
 * TD-440 MEASURED LAST (2026-09-03, re-measured after round 4), after its
 * final code-touching step.
 * MEASURED BY STAGING, NOT BY BUILDING, and that distinction is the method:
 * `npm run build` in `cli/` re-vendors the brain bundle and replaces the binary
 * the live MCP runs, so it is a DEPLOY and this brief was forbidden one. Both
 * packages were compiled INERTLY with `npx tsc --outDir <scratch>` and the
 * artifacts for exactly the changed sources were staged before packing.
 *   packed              2_006_157    unpacked 7_647_047, 672 entries (+3 — the
 *                                    one new module's .js, .js.map and .d.ts;
 *                                    its .d.ts.map is excluded by TD-443)
 *   TD-440's own share  +22_243 B    (21.7 KB) against HEAD `9bbda40`'s
 *                                    1_983_914
 *   round 4's own share +470 B       (2_006_157 − round 3's 2_005_687;
 *                                    +1_314 unpacked, entries UNCHANGED)
 *   cumulative delta    +142_737 B   (139.4 KB over PACK_BASELINE_PACKED,
 *                                    92.9% of TD-374's grant)
 *   headroom remaining  ~10.6 KB     (10_863 B — 153_600 − 142_737)
 *   built app chunk     NOT REMEASURED — see the caveat below
 *
 *   ROUND 4 STAGED INTO A COPY INSTEAD OF INTO `cli/dist`, and that is the
 *   better method — adopt it. The whole packed surface is small (`package.json`
 *   `files` is `dist` minus `dist/brain-mcp-server/node_modules` minus every
 *   `.d.ts.map`, plus `scripts/postinstall.mjs`, `README.md`, `CHANGELOG.md`),
 *   so it copies to a scratch directory in seconds and packs there. `cli/dist`
 *   is never written, so there is no restore to get wrong and no window in
 *   which the live MCP bundle is a staged hybrid. THE CONTROL IS THE SAME AND
 *   IT IS THE SHA, taken on the COPY before staging anything: it reproduced
 *   HEAD's 1_983_914 / 7_581_990 unpacked / 669 entries / shasum
 *   `fc4d8d20303b2e1306562a27515754ce9b2c2a1d` byte-exactly, which is what
 *   licenses reading the post-staging number as a delta. It was taken TWICE —
 *   once before the first staging and again on a fresh copy after a later edit
 *   — and reproduced both times. An in-place pack of `cli/dist` confirmed the
 *   real bundle was never written.
 *
 *   ROUND 3 STAGED IN PLACE AND RESTORED, and the failure modes are kept here
 *   because they are the reason the copy method is better. It took four
 *   attempts, and both failures LOOKED like a clean restore at a glance: a
 *   restore loop that fell back to a second destination root wrote four files
 *   into `dist/brain-mcp-server/dist/` that had never existed there, and
 *   `cli/dist/types.js.map` came back byte-different because the map embeds
 *   line mappings and `cli/src/types.ts` grew. Size alone said "off by 51 B";
 *   only the SHA said which file.
 *
 *   WHERE ROUND 4's 474 B WENT, AND WHAT IT DID NOT PAY FOR. Round 4 added a
 *   value-level assertion per `suggestions` writer site to
 *   `source-instance.test.ts` — and that cost **ZERO packed bytes**, because
 *   `brain-mcp-server/tsconfig.json` excludes the `__tests__` glob from the
 *   emit and the packlist carries no test artifact at all (verified: the
 *   scratch compile emits no `source-instance` output, and the packed file
 *   list matches `test` zero times). Every one of the 470 B is PROSE — **+879
 *   source bytes**, being dated counts, a re-framed threshold and nine stale
 *   `file.ts:NNN` pointers converted to `file.ts#symbol` anchors. It splits
 *   +819 across five brain modules (`finding-key.ts` +211, `types.ts` +354,
 *   `suggestions-read.ts` +159, `runner.ts` +57, `handlers.ts` +38) and +60
 *   across two cli ones (`brain-bridge.ts` +64, `types.ts` −4) — which `tsc`
 *   preserves into both the `.js` and the `.js.map` and, for the brain's
 *   exported declarations, the `.d.ts` as well. That is **0.53 packed bytes per
 *   source byte** on this round's mix (470 / 879), the low end of the
 *   0.54-0.73 band above because most of it landed in `.js`/`.js.map` rather
 *   than in exported-declaration prose. A test is free.
 *
 *   WHERE THE 21.7 KB WENT. Almost all of it is `brain-mcp-server/**`, which is
 *   this ledger's oldest lesson rather than a surprise: `tsc` PRESERVES comments
 *   into the vendored bundle and pays for them TWICE (`.js` and `.js.map`), and
 *   the emitted `.d.ts` carries interface prose a third time. The single new
 *   module `subconscious/finding-key.ts` is 13_432 source B and cost **+9_730 B
 *   packed on its own** — measured separately, with its own restore control —
 *   i.e. ~0.72 packed bytes per brain source byte, at the top of the 0.54-0.73
 *   band this ledger has recorded before. The remaining ~12 KB is spread over
 *   15 modified brain modules and 4 `cli/src` ones. The four `cli/src` files are
 *   nearly free where they are type-only: `cli` compiles with
 *   `declaration: false`, so `types.ts`'s ~40 new lines of interface prose
 *   erase to nothing in `types.js` — but NOT in `types.js.map`, which is the
 *   detail that broke the restore control above.
 *
 *   WHAT THIS ROW DOES NOT COVER — the browser bundle. `cli/dashboard/src`
 *   changed (one filter chip in `Triage.tsx`, type-only additions in
 *   `api.ts`), and rebuilding the dashboard is a separate script this brief also
 *   did not run, so the built chunk was NOT re-measured and the figure above
 *   excludes it. The changed JSX is one array entry, one `const` and one `||`
 *   in a predicate; the type additions erase. Expect a low-hundreds-of-bytes
 *   move on TOTAL_JS and verify it at the first build rather than trusting this
 *   sentence — the chunk gate is the binding one and an estimate is not a
 *   reading.
 *
 *   HEADROOM IS NOW ~10.7 KB AND THAT IS THE HEADLINE. TD-443 recovered
 *   31_426 B by dropping the `.d.ts.map` population from the packlist and this
 *   brief spent 71% of it. A brief that adds another brain module of this
 *   size does not fit. The remedy this ledger already names is still the right
 *   one and is still unspent, and round 4 REPLACED ITS ESTIMATE WITH A
 *   MEASUREMENT (delete the files from a scratch copy of the packed surface and
 *   re-pack). The count in the round-3 wording was wrong — "246 vendored" was
 *   the count of EVERY `.js.map` in the packed `dist`, not the vendored subset:
 *   *   139 vendored maps (`dist/brain-mcp-server/**`)  −158_296 B (154.6 KB)
 *   *   247 maps, the whole packed `dist`                −320_240 B (312.7 KB)
 *   (both measured against a 2_006_098 staging taken mid-round; the later
 *   +59 B does not move either figure at this resolution)
 *   The size the round-3 row quoted (~154 KB) was right for the vendored arm;
 *   only the cardinal was wrong. Both arms are dangling pointers for a
 *   consumer — a vendored map's `sources` is `["../src/index.ts"]` and there is
 *   no `sourcesContent`, so it resolves into a tree the tarball does not ship.
 *   Either arm is a packlist change, not a compiler-flag change, and it needs
 *   its own brief; the 247-file arm alone would return the whole surface to
 *   below `PACK_BASELINE_PACKED`.
 *
 * TD-443 MEASURED LAST (2026-09-02), after its final code-touching step. The
 * FIRST ROW IN THIS LEDGER WHOSE OWN SHARE IS NEGATIVE — it is a RECOVERY, not
 * a typo and not a re-base. No build was run: `npm pack` reads whatever is in
 * `cli/dist`, and this brief never changed `cli/dist`.
 *   packed              1_983_914    unpacked 7_581_990, 669 entries (807 → 669,
 *                                    −138: the whole `.d.ts.map` population)
 *   TD-443's own share  −31_226 B    (−30.5 KB) against HEAD `1e48af5`'s
 *                                    2_015_140. Composition, measured in two
 *                                    steps rather than derived: the packlist
 *                                    change is −31_426 B (which already pays
 *                                    the +27 raw B of the new `files` line),
 *                                    and `cli/CHANGELOG.md`'s 587 raw B of new
 *                                    prose adds +200 B back. −31_426 + 200 =
 *                                    −31_226.
 *   cumulative delta    +117.7 KB    (120_494 B over PACK_BASELINE_PACKED,
 *                                    78.4% of TD-374's grant — the gate is
 *                                    still live, not slack)
 *   headroom remaining  ~32.3 KB     (33_106 B under TD-374's +150 —
 *                                    153_600 − 120_494). TD-440's worst case
 *                                    is +20_275 B, which leaves 12_831 B.
 *   browser surfaces    +0 B — no `cli/dashboard/**` file changed
 *
 *   THE CHANGE IS ONE LINE, and it is a PACKLIST change, not a compiler-flag
 *   change. `cli/package.json` `files` gains a negation matching `.d.ts.map` at
 *   any depth under `dist`. The literal glob is in that file and in the failure
 *   message of the TD-443 pin in this file; it is not reproduced in this
 *   comment because it contains the two-character block-comment terminator.
 *   `brain-mcp-server/tsconfig.json:15` keeps `declarationMap: true`, nothing
 *   was deleted from the working tree, and `files` only selects tar members.
 *   Round 2 turned that from an ASSERTION into a GATE: the third test in the
 *   TD-443 describe reads the brain tsconfig and pins `declarationMap` and
 *   `declaration` to true. Both packlist pins are OUTCOME pins and neither can
 *   see the flag — flip it, rebuild, drop the negation, and every one of them
 *   stays green while the shipped sentence goes false. Cost: 0 packed B, the
 *   same reason this row is free.
 *
 *   METHOD, and the control that makes these numbers a measurement.
 *   `npm pack --dry-run --json --ignore-scripts` from `cli/`, four readings.
 *   NAME THE ALGORITHM: the checksum column is npm's own `shasum` field, which
 *   is **SHA-1** (40 hex, verified by length on this tree); the `integrity`
 *   field beside it is `sha512-`. It is NOT a `shasum -a 256` of the tarball,
 *   and a verifier who assumes otherwise chases a phantom divergence — one
 *   did.
 *     A  untouched HEAD          2_015_140 / 807   sha1 6b122d90…
 *     B  after the `files` line  1_983_714 / 669   sha1 f9a7bb5e…
 *     C  after reverting it      2_015_140 / 807   sha1 6b122d90…  ← the control
 *     D  MEASURED LAST           1_983_914 / 669   sha1 fc4d8d20…
 *   D was taken twice in a row, byte- and sha-identical, after the last edit to
 *   `cli/CHANGELOG.md` — the only shipped surface this brief touched.
 *   C reproduced A on size, entry count, unpacked size AND tarball sha — a
 *   measurement whose control does not restore is not a measurement, and the
 *   sha is a stricter identity than size + count. Reading B was reproduced
 *   twice more, byte- and sha-identical each time, after each of the two option
 *   probes in this row's OPTION NOT TAKEN paragraph — that is what says the
 *   probes left no residue. `--ignore-scripts` is belt-and-braces:
 *   `cli/package.json` has no
 *   `prepack` and no `prepare`, so nothing fires (this is also why `packReport()`
 *   in this file is safe without it — do not "fix" that).
 *
 *   THE DEFECT, since a recovery row has to say what was recovered FROM. Every
 *   `.d.ts.map` under `dist/brain-mcp-server/dist/` carries a `sources` entry
 *   like `["../../src/engine/bus.ts"]` and NO `sourcesContent`, while `files`
 *   ships `dist` only — `dist/brain-mcp-server/src` does not exist in the
 *   tarball. All 138 were pointers a consumer could not follow. Sharper than
 *   the brief expected, and worth recording because it removes the last doubt:
 *   the VENDORED copies are dangling IN THE REPO TOO. `copy-templates.sh`
 *   stages `dist/**` only. The staging block is `copy-templates.sh:172-173` —
 *   `mkdir -p "$MCP_DEST/dist"` then `cp -R "$MCP_SRC/dist/."` — and no `cp`
 *   IN THAT BLOCK has a `src` counterpart: its four are `dist/.`,
 *   `package.json`, `package-lock.json` and `scripts`. SCOPE THE CARDINAL —
 *   the script holds SIX `cp` in total (`grep -n 'cp -' copy-templates.sh` →
 *   `:26`, `:44`, `:173`, `:174`, `:176`, `:178`); the two outside the block
 *   are `cli`'s own `src/lib/templates` → `dist/lib/templates` walk and the
 *   harness-manifest copy, neither of which can create
 *   `dist/brain-mcp-server/src`. What carries the claim is not the count but
 *   the reference set: the only two `$MCP_SRC/src` references in the file are
 *   a staleness check and an orphan check, both READS
 *   (`grep -n 'MCP_SRC/src' copy-templates.sh` → 2 hits). Grep
 *   `MCP_DEST/dist` if those line numbers move. So
 *   `cli/dist/brain-mcp-server/src` never exists either — walked and checked,
 *   0 of 138 vendored maps resolve locally, while
 *   138 of 138 under `brain-mcp-server/dist/` do. The maps that serve IDE
 *   go-to-definition are a DIFFERENT SET OF FILES, in the authoring package,
 *   and a `cli` packlist entry cannot reach them.
 *
 *   AC-3 — WHICH OPTION SHIPPED, AND THE ARGUMENT FOR THE ONE NOT TAKEN. The
 *   narrow one shipped: declaration maps only, not every map. The reason is the
 *   ASSERTION it makes available, not the bytes it leaves behind.
 *   `cli/tsconfig.json:14` sets `declaration: false`, so `cli` emits no
 *   declarations of its own and the staged `dist/brain-mcp-server/scripts/`
 *   holds `.ts` sources rather than compiled output (12 entries, zero maps).
 *   THE 12 IS A PRUNED 19, and the pruning is what makes it re-derivable —
 *   `copy-templates.sh:178` copies `scripts/` WHOLESALE, so the count is not
 *   the copy, it is the two `rm` that follow it:
 *     find brain-mcp-server/scripts -maxdepth 1 -type f | wc -l   # 19
 *     :183  rm -rf .../scripts/__tests__ .../scripts/fixtures     # TD-298,
 *           the only two subdirectories, so they move no top-level file
 *     :199  a `for dev_script in` list of SEVEN named files        # TD-299
 *           (recall_bench.ts, dedup_corpus_eval.ts, td087_check_pair.ts,
 *            td087_e2e_deterministic.ts, td087_label_pairs.py,
 *            td087_corpus_pairs_labeled.csv, td285_dedup_recall_audit.ts)
 *   19 − 7 = 12, confirmed on the staged tree with
 *   `find cli/dist/brain-mcp-server/scripts -type f | wc -l`. "Zero maps"
 *   needs no count and does not depend on any of this: nothing in that
 *   directory is compiled, so nothing there can emit one.
 *   The tarball's ENTIRE `.d.ts.map` population was therefore the brain's 138,
 *   and the pin can be stated unscoped — "no packed entry ends in `.d.ts.map`",
 *   true of the whole tarball with zero exceptions. A `.js.map` pin could not
 *   be written that way: MEASURED on the same manifest, 246 `.js.map` ship and
 *   only 138 are the brain's, because `cli/tsconfig.json:15` sets
 *   `sourceMap: true` and the 108 cli-own maps carry the identical defect
 *   (`dist/lib/slug.js.map` reads `"sources":["../../src/lib/slug.ts"]`, and
 *   `src` is not in `files`). Such a pin would have to be path-scoped, and a
 *   later reader would take it for a whole-tarball guarantee it is not. The
 *   NARROWER change buys the STRONGER invariant; that inversion is the reason.
 *
 *   THE OPTION NOT TAKEN WAS PRICED, IN BOTH OF ITS SHAPES, rather than quoted
 *   — and the brief's single figure turned out to name only one of them:
 *     brain-scoped map exclusion   1_829_779 / 531   cumulative −33_641 B
 *     unscoped map exclusion       1_668_956 / 423   cumulative −194_464 B
 *   The unscoped shape also takes the 108 cli-own maps, which is why it drops
 *   384 entries rather than 276. Either puts the tree BELOW
 *   PACK_BASELINE_PACKED, so the ceiling assertion in this file would pass on a
 *   NEGATIVE number and stay green through 182.9 KB (187_241 B) or 339.9 KB
 *   (348_064 B) of unmeasured growth — the headroom each option would leave
 *   under the same +150 KB grant, which is the measure of how far the gate
 *   would stop reporting. It would not break; it would go QUIET, which is
 *   worse, and quiet is the harder failure to notice. The shipped
 *   option leaves the delta at 78% of the grant, so the gate keeps biting and
 *   the "cut or vendor less" instruction keeps its teeth.
 *
 *   AC-4 — PACK_BASELINE_PACKED AND PACK_HARD_CEILING_DELTA ARE UNCHANGED, and
 *   that is a decision, not an omission. This brief recovers headroom; it does
 *   not re-base. Note the shape of it: the option that WOULD have forced a
 *   re-base conversation is precisely the one not taken, because a ceiling that
 *   has gone slack is the state in which re-basing becomes the honest
 *   bookkeeping. If the operator later wants that runway, the re-base is
 *   THEIRS to decide, before the work, on the record. This row carries the
 *   numbers that decision needs, and every one of them is re-derivable from the
 *   four readings and the two option probes it records.
 *
 *   THE TRAILERS STAY, AND THAT WAS ESTABLISHED BY MEASUREMENT WITH A PAIRED
 *   CONTROL rather than assumed. The shipped `.d.ts` keep their
 *   `sourceMappingURL` trailer (`tools/sync.d.ts` and every sibling) pointing
 *   at a map that is now absent from the tarball. Extracted the real tarball,
 *   pointed a consumer project at it through `node_modules` and deep-imported
 *   `dist/brain-mcp-server/dist/engine/bus.js`: `tsc --noEmit` exit 0, ZERO
 *   BYTES of diagnostic output. The identical run against a tarball packed WITH
 *   the maps produced byte-identical (empty) output, so this brief adds no
 *   diagnostic. Three tool classes answer this question differently and only
 *   one of them is a consumer, which is why one reading would not have settled
 *   it: `tsc`/tsserver fall back silently to the `.d.ts` position; `node` is
 *   silent too (verified — this row's EVIDENCE FOR THE FOLLOW-ON paragraph has
 *   the reading); vite's SSR loader is NOISY — one ENOENT
 *   per unresolvable map, recorded at `brain-bridge.test.ts:228-229`, which is
 *   why that fixture strips the trailer before copying. The `files` route never
 *   creates that condition anywhere, because every map stays ON DISK.
 *
 *   EVIDENCE FOR THE FOLLOW-ON, RECORDED AND NOT ACTED ON. For the `.js.map`
 *   class this brief did NOT touch, `node --enable-source-maps` importing a
 *   `.js` whose map is absent while the trailer remains: exit 0, stdout 0 B,
 *   stderr 0 B. So the cost of dropping them is not noise; it is a thin
 *   FORENSIC path, and here it is, measured on `utils/fts5.js` by calling it
 *   with `null` to force a TypeError from inside the module:
 *     map PRESENT  at Module.sanitizeFts5Query (…/src/utils/fts5.ts:33:25)
 *     map ABSENT   at Module.sanitizeFts5Query (…/dist/utils/fts5.js:32:27)
 *   Node reports the ORIGINAL name and line even though it cannot read the
 *   source — and note the first path does not exist on a consumer machine
 *   either, though it IS resolvable against the GitHub tag. That is the whole
 *   of the value, stated at its real size.
 *
 *   THE PIN IS A RELATION, NOT A COUNT, which is a deliberate choice against
 *   `test_standards` rule 4's shape (a hard-coded count pinned with a dated
 *   reason). `brain-artifact.test.ts` argues the general case and it applies
 *   here: a count goes green on a delete-plus-add and needs re-blessing every
 *   time the brain gains a module. The second assertion is a PRESENCE relation
 *   for the same reason — it exists because a glob typo would also drop the
 *   138 `.d.ts`, and those are 693_030 B unpacked at THIS tree — re-derivable
 *   without a pack or a build, because the vendored copies ARE the packed
 *   copies:
 *     find cli/dist/brain-mcp-server/dist -name '*.d.ts' -type f | wc -l
 *     find cli/dist/brain-mcp-server/dist -name '*.d.ts' -type f -exec cat {} + | wc -c
 *   → 138 and 693030 exactly, run 2026-09-02.
 *
 *   TD-423 READ 693_914 FOR THE SAME 138 ENTRIES, AND THE 884 B IS
 *   UNEXPLAINED. An earlier draft of this paragraph said "the brain has moved
 *   884 B since", which rejected an alternative nobody had tested — and it is
 *   refuted by the interval being EMPTY. TD-423's closing commit IS `1e48af5`
 *   (`git log --oneline --all --grep=TD-423`), and `1e48af5` is the same HEAD
 *   readings A and C in this row's four-reading table were taken against, so
 *   `git log 1e48af5..1e48af5 -- brain-mcp-server/src` names no commit at all.
 *   No COMMIT moved brain source between the two readings; two tarballs of
 *   identical size and entry count could not have contained 138 shared
 *   `.d.ts` differing by 884 B anyway. What differs is not the commit but the
 *   WORKING TREE: both are TD-423's, and only the later one still exists. The
 *   leading candidate is TD-423's own mid-brief `produced` trim in
 *   `cognition/types.ts` (2_267 B → 1_421 B, 846 B), which `1e48af5` records
 *   only as a net +26 lines because both of its states collapse into one
 *   commit. That is NAMED, NOT ASSERTED: it leaves 38 B unaccounted, and the
 *   pre-trim `.d.ts` cannot be re-emitted without a build, which this round's
 *   scope forbids. Re-read the figure rather than carrying it — that lesson
 *   holds under either explanation, and it is the whole reason this ledger
 *   records a date beside every figure.
 *
 *   SWEEP OF THE CLAIM THIS FALSIFIES, AND THE CENSUS IS A COMMAND RATHER
 *   THAN AN ARITHMETIC. "The ONE exclusion is
 *   `dist/brain-mcp-server/node_modules`" became false the moment a second
 *   exclusion existed. The plan named ONE line; the class has SEVEN members,
 *   and a line-oriented grep under-reads it by more than half — collapse
 *   whitespace first. Strip the leading " * " from the next line and run it
 *   from the repo root:
 *
 *   git ls-files -z ':!cli/src/__tests__/tarball.test.ts' | xargs -0 perl -0777 -ne 's/\s+/ /g; while (/(.{0,60}the one[ *]*(?:exclusion|(?:excluded[ *]+)?direc)[a-z*]{0,12}.{0,90})/gi) { my $h=$1; print "$ARGV\n  $h\n" if $h =~ /`files`|package\.json|tarball/i }'
 *
 *   MEASURED 2026-09-02: 7 hits against HEAD `1e48af5`, 6 against this tree,
 *   ZERO false positives in either run. The co-occurrence filter is what earns
 *   that, and it is not decoration: drop it and the anchor alone returns 9 at
 *   HEAD and 8 here. The two extra are instructive — MAINTAINING row 93's
 *   "antigravity is the ONE exclusion" (harness projection, a different sense
 *   of the word) and `verbs/cognition.ts`'s "in the one direction no stated
 *   bound explains", where `direc` matched DIRECTION. A third near-miss never
 *   reaches the anchor at all: `igris doctor`'s "the ONE documented exclusion"
 *   puts a word between "one" and "exclusion". Widen either half and you
 *   inherit all three.
 *   THE COLLAPSE IS LOAD-BEARING, and here is its price: the IDENTICAL regex
 *   run line-oriented (`perl -ne` instead of `perl -0777 -ne`) finds 3 of the
 *   7 — row 109 twice and `paths.ts` — and misses `docs/dashboard.md` twice,
 *   `brain-bridge.ts` and `Learnings.tsx`. The command LOCATES the class; it
 *   does not adjudicate it, and a member that has been TIGHTENED still
 *   matches. The seven, with dispositions:
 *     [1] MAINTAINING row 109, CONSUMERS column: "the ONE exclusion is
 *         `dist/…/node_modules`". FALSE. Rewritten to name both exclusions and
 *         their different kinds. This is the one member that LEAVES the class,
 *         which is the whole of the 7 → 6.
 *     [2] MAINTAINING row 109, CHANGE-PROCEDURE column: "live in the ONE
 *         excluded directory". TRUE on a technicality — there is still exactly
 *         one excluded DIRECTORY. Tightened so "directory" is load-bearing.
 *         Round 1 rewrote [1] and missed [2]: ONE ROW, TWO COLUMNS, and a
 *         census that trusted its own reading of the row it had just edited.
 *         A line-oriented grep DOES find this one — it was a reading miss,
 *         not a notation miss, and that is the more embarrassing kind.
 *     [3] and [4] `docs/dashboard.md`, twice. TRUE on the same technicality;
 *         tightened the same way. 0 packed B — `docs/` is outside `files`.
 *     [5] `paths.ts#bundledBrainNodeModulesDir` and
 *     [6] `brain-bridge.ts#loadSqliteVecModule`. TRUE as written, in docblocks
 *         that SHIP: `tsc` keeps comments, so both sentences are in
 *         `dist/lib/paths.js` and `dist/lib/brain-bridge.js` right now
 *         (grepped, 1 each). Correcting an earlier draft of this row, which
 *         said editing them would charge the tarball "twice over via `.js` and
 *         `.js.map`": their maps carry NO `sourcesContent` — the keys are
 *         version, file, sourceRoot, sources, names, mappings — so the prose
 *         is charged ONCE, in the `.js`, and only the VLQ `mappings` would
 *         shift. Left alone anyway, and this is the binding reason: a
 *         `cli/src` edit cannot reach `cli/dist` without a build, so it would
 *         leave the source and the artifact this row measures out of sync.
 *     [7] `cli/dashboard/src/pages/layers/Learnings.tsx`. TRUE as written.
 *         NEW in round 2, named by neither the plan nor round 1 nor the round
 *         1 review; the line break falls INSIDE the phrase ("the one" /
 *         "directory"), which is why only a collapsed sweep reaches it. Its
 *         cost is DIFFERENT from [5] and [6] and the difference was measured:
 *         the dashboard bundler strips block comments, so this docblock is in
 *         no shipped asset (zero occurrences of "the one" across all 12
 *         `dist/dashboard/assets/*.js`, and zero block-comment openers in the
 *         `Layers-<hash>.js` chunk — `Layers-BIDq1jxt.js` at this tree, and
 *         the hash moves on every build — which DOES carry the component: its
 *         `LEARNINGS DEGRADED` string is in there). It would be free even
 *         after a build; it is left alone for the build reason alone.
 *
 *   `tarball.test.ts` is under a test glob `tsconfig` excludes from `dist`, so
 *   writing THIS row cannot move the number it records — verified by re-packing
 *   after the edit, the same way TD-423 verified it. Verified a SECOND way in
 *   round-1 review, and by a different hand: reverting this file alone and
 *   re-packing reproduced D byte-identically, which is what establishes that
 *   the whole of B → D is `cli/CHANGELOG.md` and none of it is this row or the
 *   pin below.
 *
 * READ THAT BEFORE PLANNING THE NEXT ONE. **~82.3 KB (84_262 B) is what is
 * left on PACKED** — FR-249's row below is the live reading. *(SUPERSEDED —
 * AND NOT BY POSITION. `f8ea15b` re-pointed this parenthetical at "the FR-268
 * row directly above"; TD-423 then appended its own row between the two, which
 * falsified the direction and the figure in one edit and left the sentence that
 * OPENS WITH AN INSTRUCTION TO THE NEXT PLANNER overstating headroom by more
 * than 10x. A direction word cannot survive an append, so this copy carries a
 * BRIEF, a DATE and no direction: **as of TD-390, measured 2026-09-04,
 * ~6.5 KB (6_635 B) is what is left on PACKED.** Grep `TD-390 MEASURED LAST` in this
 * file for that reading (a +0 B row that reproduces TD-414's control) and the
 * method behind it, and treat the 84_262 B above
 * as TD-378's historical figure, not a budget. THE ONE "above" IN THIS
 * PARENTHETICAL IS THE STATED EXCEPTION, and it is safe for a reason the ban
 * does not cover: it is INTRA-PARAGRAPH — it names the 84_262 B in this same
 * paragraph's own opening sentence, so separating the pointer from its referent
 * would take an insertion INSIDE the paragraph, not an append after it. That is
 * the whole test. A direction word is safe exactly when nothing can be placed
 * between it and what it names; "the FR-268 row directly above" failed that test
 * because a row could be, and was. Whoever appends the next row
 * re-points THIS sentence at their own brief id, date and figure. TD-443 was
 * the reason the figure last went UP rather than down — it is a recovery row,
 * so do not read that jump from TD-423's 1_880 B as a ceiling change. TD-440
 * then spent 22_243 B of what TD-443 recovered; both constants are still
 * untouched, and the direction of travel is back down.)* **But packed is
 * NOT the binding ceiling any more:** `dashboard-chunks.test.ts`'s TOTAL_JS has
 * **13_601 B**, and any brief with a UI will hit that first. Read both — the
 * packed GRANT is +150 KB and the headroom is what remains under it, and
 * the figure changed MEANING as well as value: TD-374 re-based the constant to
 * a clean measurement of TD-373's tree, and the operator granted +150 KB over
 * it, so this now reads growth-since-clean rather than growth-since-FR-238.
 * TD-373's row below is the first CLEAN reading this ledger ever carried; it
 * read ~1.6 KB against the OLD ceiling, which is precisely why the grant
 * happened. (~104.9 KB
 * was FR-247's, ~117.2 KB FR-246's, ~143.6 KB FR-245's, ~147.2 KB FR-244's,
 * ~149.3 KB TD-328's and ~173.6 KB TD-326's, all superseded. Every one of
 * those was measured on a tree carrying orphan artifacts, so every one was
 * generous by roughly the 9.6 KB TD-373 deleted — and the last two were
 * explicitly logged as FLOORS, not readings.) **And the OTHER ceiling is not merely binding now, it is
 * effectively spent**: **616 B** of chunk slack against this gate's 104.9 KB.
 * *(THAT CHUNK CLAUSE IS SUPERSEDED BY TD-347 — there is no single chunk any
 * more, and the browser-bundle budget is now two executable ceilings in
 * `dashboard-chunks.test.ts`. The PACKED half of this paragraph still stands.
 * This copy sits below the HISTORY marker but opens with an instruction, so it
 * is labelled in place rather than left to be read as current.)*
 * FR-246 estimated against the chunk alone and was right about it (+3_654 B)
 * while spending +27_055 B here; FR-247 estimated BOTH and inverted the error —
 * +5_899 B of chunk against a 2.5-4.6 KB estimate, +11_132 B packed against a
 * 17-32 KB one. Two briefs, two directions, one rule: **estimate BOTH, measure
 * BOTH, and name which surface any single number is about.** And note TD-328's correction to the SCOPE of this budget: a
 * brief that touches only
 * `brain-mcp-server/` spends from it too, because that package is bundled. If the next
 * brief needs more, the answer is to cut or to vendor less — NOT to raise
 * `PACK_HARD_CEILING_DELTA`, for the reason the paragraphs above spend thirty
 * lines on. (FR-241 was told the same thing about its ~68 KB and did not need
 * the exemption either; the pattern so far is that the estimate before
 * measuring is the pessimistic one.)
 *
 * The budget is CUMULATIVE across the family, not per-brief: a per-brief
 * reading lets three views bust the ceiling with every individual brief
 * passing. Subtract the shipped delta before claiming headroom, and measure
 * rather than estimate. (`PACK_BASELINE_PACKED` was UNCHANGED for the whole
 * FR-238..TD-373 run; TD-374 re-based it — see the provenance block below.)
 *
 * PROVENANCE OF THE BASELINE CONSTANT — RE-BASED TO A MEASURED NUMBER
 * (TD-374, operator grant 2026-08-10)
 * ─────────────────────────────────────────────────────────────────────────
 * The baseline is now **today, measured on a clean tree**, not an archaeological
 * figure from FR-238. That is a change of MEANING, not just of value:
 * `delta` used to read "cumulative growth since the dashboard family began" and
 * now reads "growth since the tree was known clean."
 *
 * WHY THE OLD BASELINE WAS ABANDONED RATHER THAN CORRECTED. The previous note
 * asserted `1_301_851` was ~24 KB HIGH versus a clean build, and instructed a
 * re-measure once dist-cleaning landed. TD-373 landed it, so TD-374 took the
 * measurement — and the instruction turned out to rest on an estimate that does
 * not survive contact:
 *
 *   FR-238's commit (`71abaa0`), built CLEAN with today's node_modules:
 *     packed 1_467_162  /  740 files  /  5_854_678 unpacked
 *   what this note predicted:
 *     packed ~1_277_864 /  715 files  /  5_394_552 unpacked
 *
 * **+189 KB in the opposite direction from the prediction.** The confound is
 * dependencies, not sources: `package-lock.json` has drifted since 2026-07-29
 * (different digest), and the dashboard bundle is built from whatever `vite`,
 * `react` and `force-graph` are installed. So a "clean FR-238 baseline" is not
 * one number — it is a number per dependency tree, and recovering the July one
 * would need a period-accurate `npm ci` to describe a July fact that no longer
 * governs anything. The old constant is retired rather than corrected because
 * the question it answers is unanswerable and, once answered, useless.
 *
 * HOW THE NEW BASELINE WAS TAKEN, so it can be re-derived:
 *   `rm -rf cli/dist brain-mcp-server/dist && (cd cli && npm run build)` then
 *   `npm pack --dry-run --json`, on `bd49525` (TD-373).
 *     packed 1_863_420  /  796 files
 *   Never `npm run build` in `cli/` on the operator's machine casually — it is
 *   a live deploy. TD-373 records the scratch-worktree method for that case.
 *
 * READING THE LEDGER'S OLDER ROWS. Every "cumulative delta" above is stated
 * against the OLD baseline. Convert with a single offset:
 *   new_delta = old_delta - 561_569        (1_863_420 - 1_301_851)
 * They are also all measured on trees carrying the orphan artifacts TD-373
 * deleted, so treat them as historical narrative, not as comparable figures.
 *
 * THE CEILING — +150 KB, operator grant, 2026-08-10
 * ─────────────────────────────────────────────────
 * Raised from +550 KB over the old baseline. In absolute terms the cap moves
 * 1_865_051 -> 2_017_020, i.e. **+148 KB of real room**, because the old
 * ceiling had 1_631 B left and GL-006 could not finish inside it.
 *
 * DERIVED, not chosen round — though only two of the five inputs are SOURCED
 * (FR-248's from its own plan, the overhead from this session's measurements);
 * the other three are labelled estimates rather than presented as readings.
 * The remaining GL-006 work and its overhead:
 *   FR-248 cross-layer search      ~26 KB (its own plan's upper estimate)
 *   FR-249 create-a-goal            ~20 KB  ESTIMATE, by analogy to FR-247
 *   BR-083 entity_edges project     ~10 KB  ESTIMATE, brain-side migration
 *   TD-369/370/371/372 follow-ups    ~5 KB  ESTIMATE, all S-Small
 *   changelog + docstring overhead  ~24 KB (this session measured 2.5-4.4 KB
 *                                    per brief, and prose in shipped files is
 *                                    charged ONCE via .js plus a small
 *                                    .js.map mappings shift — TD-443
 *                                    corrected "twice" here. THE GRANT DOES
 *                                    NOT MOVE WITH THE CORRECTION: the
 *                                    2.5-4.4 KB was MEASURED per brief, not
 *                                    derived by doubling anything, so the
 *                                    ~24 KB input stands as taken.)
 *                                   ───────
 *                                    ~85 KB, so +150 KB is ~76% margin.
 *
 * WHAT THE GRANT DOES NOT LICENSE. The instruction still inverts rather than
 * disappears: a brief that runs out cuts scope or vendors less. The ceiling was
 * raised because a MEASUREMENT showed real work did not fit, taken before the
 * work rather than after a failing assertion — the same standard TD-329 set.
 * It was NOT raised to accommodate cruft: TD-373 deleted 9_624 B of artifacts
 * for sources that no longer existed, and that deletion happened FIRST,
 * deliberately, so this grant is spent on features rather than on leftovers.
 */
const PACK_BASELINE_PACKED = 1_863_420; // TD-374, measured clean on bd49525
const PACK_HARD_CEILING_DELTA = 150 * 1024; // TD-374, operator, 2026-08-10

/**
 * TD-336: how long a pack-dependent test is allowed to take.
 *
 * This is a MEASUREMENT, not a round number chosen to be safely large.
 * `npm pack --dry-run` on this package, measured 2026-08-04:
 *
 * TWO SURFACES, NAMED — per this file's own rule 40 lines up: estimate both,
 * measure both, and say which surface any single number is about. The `npm
 * pack --dry-run` CALL and the enclosing TEST are not the same duration, and
 * an earlier draft of this block quoted one of each as if they were one series.
 *
 *   the CALL, idle                1357 / 1427 / 1579 ms
 *   the CALL, 8-way contention    2460 - 2950 ms
 *   the TEST, full suite in flight 4438 - 6654 ms over fifteen measured runs
 *   the TEST, sustained 8-way load  up to 9157 ms
 *
 * vitest's default `testTimeout` is 5000 ms, so the TEST straddles it under the
 * suite's own parallel load — which is why this file failed intermittently, on
 * whichever pack-dependent test happened to run first, reporting as an
 * assertion about `index.html` when the actual event was a 6 s subprocess.
 * The fastest PASSING run of that test was 4438 ms: still 89% of the old
 * budget. It was never "sometimes slow"; it was always near the line, and the
 * default reporter shows you nothing about proximity — only about crossing.
 *
 * 30 s is ~4.5x the worst full-suite test duration (6654 ms) and ~3.3x the
 * worst under sustained load (9157 ms). The margin is deliberately generous
 * because the load that causes this is the CI/dev machine's, not ours.
 *
 * TWO HALVES, AND THEY BOUND DIFFERENT THINGS. This constant is used twice:
 * as each pack-dependent test's `testTimeout`, and as `options.timeout` on the
 * `execFileSync` itself. The test timeout is POST-HOC DETECTION — it cannot
 * preempt a synchronous body, so against a genuinely hung npm the worker's
 * event loop blocks and the timer never fires. Only `options.timeout` SIGTERMs
 * the child. Keep both: the first attributes the failure to a test, the second
 * is what actually stops a hang.
 *
 * That reasoning holds BECAUSE every pack-dependent body here is synchronous.
 * If a future edit makes one of them `async`, vitest can preempt it and this
 * framing silently stops applying to that test — re-derive it rather than
 * assuming the comment still covers you.
 *
 * Measured both ways against a real 20 s hang: WITH `options.timeout` the call
 * dies at 2008 ms (`spawnSync ETIMEDOUT`); WITHOUT it, the per-test timeout
 * alone let it run the full 20040 ms and then reported `SyntaxError:
 * Unexpected end of JSON input` — a misleading error, because the synchronous
 * body threw before the timeout could be reported. That is the same
 * "reports as a different bug" failure this brief exists to kill.
 *
 * NOT `beforeAll`. Warming the cache in a hook would pay the cost in a place
 * that is *about* paying it, which is tempting, but a hook failure is far less
 * legible than a test failure — it fails the whole describe with no assertion
 * to read. Per-test timeouts keep the failure attached to the thing that failed.
 */
const PACK_TIMEOUT_MS = 30_000;

/**
 * Memoised. `npm pack --dry-run` walks the whole package and takes a couple of
 * seconds; running it once per file rather than once per assertion keeps the
 * suite fast, and computing it LAZILY (not in the describe body) keeps it out
 * of collection for a filtered run of any other test in this file.
 *
 * The laziness is load-bearing and TD-336 deliberately preserved it: only the
 * FIRST pack-dependent test to run pays the subprocess cost, and a filtered run
 * of any other test in this file never spawns npm at all. Every test that can
 * reach here carries PACK_TIMEOUT_MS, because any of them may be the first.
 */
let packReportCache: PackReport | null = null;
function packReport(): PackReport {
  if (packReportCache !== null) return packReportCache;
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const cliRoot = require("node:path").join(__dirname, "..", "..") as string;
  const raw = childProcess.execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: cliRoot,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    // This is what makes the per-test PACK_TIMEOUT_MS mean what its docblock
    // says. A vitest test timeout is POST-HOC detection: it cannot preempt a
    // synchronous body, so if npm truly hangs, the worker's event loop blocks
    // and the timer never fires. `options.timeout` SIGTERMs the child, which
    // is the half that actually bounds a hang.
    timeout: PACK_TIMEOUT_MS,
  });
  packReportCache = (JSON.parse(raw) as PackReport[])[0];
  return packReportCache;
}

function packedPaths(): Set<string> {
  return new Set(packReport().files.map((f) => f.path));
}

describe("FR-238 — dist/dashboard ships in the npm tarball", () => {

  it("includes dist/dashboard/index.html", () => {
    expect(packedPaths().has("dist/dashboard/index.html")).toBe(true);
  }, PACK_TIMEOUT_MS);

  it("includes the three vendored woff2 fonts", () => {
    const paths = packedPaths();
    for (const f of [
      "dist/dashboard/fonts/anton-latin-400-normal.woff2",
      "dist/dashboard/fonts/space-grotesk-latin-wght-normal.woff2",
      "dist/dashboard/fonts/jetbrains-mono-latin-400-normal.woff2",
    ]) {
      expect(paths.has(f), `missing from tarball: ${f}`).toBe(true);
    }
  }, PACK_TIMEOUT_MS);

  it("includes the hashed JS and CSS assets", () => {
    const assets = [...packedPaths()].filter((p) => p.startsWith("dist/dashboard/assets/"));
    expect(assets.some((p) => p.endsWith(".js"))).toBe(true);
    expect(assets.some((p) => p.endsWith(".css"))).toBe(true);
  }, PACK_TIMEOUT_MS);

  it("still ships the vendored brain engine the FR-238 bridge imports", () => {
    // The bridge is a path-literal dependency on this artifact (R2). If the
    // `files` exclusion list ever widens to drop it, the dashboard's graph
    // readout degrades silently — so assert it here, loudly.
    expect(
      packedPaths().has(
        "dist/brain-mcp-server/dist/engine/components/edges/whole-graph.js",
      ),
    ).toBe(true);
  }, PACK_TIMEOUT_MS);

  it("ships FR-241's suggestion reader AND the engine module the WRITE door boots", () => {
    // MAINTAINING row 107, extended again by FR-241. The two entries are
    // different in kind and the failure modes are not the same:
    //
    //   - `suggestions-read.js` is a READ artifact. Losing it degrades
    //     `/api/suggestions` to an empty queue that looks like a cleared
    //     backlog — the same silent shape as the three readers below.
    //   - `engine/index.js` exports `bootEngine` and is the WRITE door. Losing
    //     it takes the MUTATION surface down, not a readout, and the signal
    //     that goes false is `/api/health`'s `write.available`. A dashboard
    //     that cannot triage is a different bug report from one that shows an
    //     empty list, so it gets its own named assertion rather than joining
    //     the reader loop.
    //
    // Both are reached by path literal from `brain-bridge.ts#MODULE_RELS`, so
    // they resolve in this repo whether or not they are in the pack. Only a
    // packaging assertion can catch the consumer-machine case.
    const packed = packedPaths();
    for (const rel of [
      "dist/brain-mcp-server/dist/tools/suggestions-read.js",
      "dist/brain-mcp-server/dist/engine/index.js",
    ]) {
      expect(packed.has(rel), `${rel} is missing from the published tarball`).toBe(
        true,
      );
    }
  }, PACK_TIMEOUT_MS);

  it("ships the three FR-240 pure READ modules the layer endpoints import", () => {
    // MAINTAINING row 107, extended by FR-240. Same failure mode as the builder
    // above and the same reason it needs a packaging assertion rather than a
    // runtime one: `loadLayerReaders()` DEGRADES when a module is missing, so a
    // dropped artifact serves four empty layer views that look exactly like an
    // empty brain. Nothing at runtime would say "the tarball is incomplete".
    //
    // Note two of these are under `dist/tools/`, OUTSIDE `dist/engine/` — the
    // trap that forced the bridge resolver to anchor on the bundle ROOT.
    const packed = packedPaths();
    for (const rel of [
      "dist/brain-mcp-server/dist/tools/briefs-read.js",
      "dist/brain-mcp-server/dist/tools/memory-read.js",
      "dist/brain-mcp-server/dist/engine/components/goals/read.js",
    ]) {
      expect(packed.has(rel), `${rel} is missing from the published tarball`).toBe(
        true,
      );
    }
  }, PACK_TIMEOUT_MS);

  it("ships the MCP wrappers whose SQL those readers now hold", () => {
    // The wrappers import the readers. Shipping a reader without its wrapper (or
    // vice versa) would break the MCP surface `/hunt` and `/awaken` depend on,
    // and the failure would appear as a module-resolution error at brain boot —
    // far from its cause.
    const packed = packedPaths();
    for (const rel of [
      "dist/brain-mcp-server/dist/tools/briefs.js",
      "dist/brain-mcp-server/dist/tools/memory.js",
      "dist/brain-mcp-server/dist/engine/components/goals/handlers.js",
    ]) {
      expect(packed.has(rel), `${rel} is missing from the published tarball`).toBe(
        true,
      );
    }
  }, PACK_TIMEOUT_MS);

  /**
   * FR-249 — a DIAGNOSTIC must not be able to ship, or to corrupt the reading.
   *
   * `DASH_BUNDLE_REPORT=1 bash cli/scripts/build-dashboard.sh` writes
   * `dist/dashboard/.bundle-report.json` — the file every recent brief has used
   * to prove which chunk its code landed in. `package.json` `files` ships
   * `dist`, wholesale, so that diagnostic SHIPS.
   *
   * It bit FR-249 immediately and in the worst way: a pack taken right after a
   * report-enabled build read **801 entries / 1_898_453 B** against the
   * comparable **800 / 1_895_058** — a 3,395 B phantom delta that looks exactly
   * like code growth. The ENTRY COUNT is the tell, which is why this ledger
   * records entries beside every byte figure and why that convention is worth
   * keeping.
   *
   * So the instrument used to measure the budget could silently inflate the
   * budget. This assertion closes that: it does not care whether the file is
   * present in the working tree (it legitimately is, mid-diagnosis) — only that
   * it never reaches the tarball.
   */
  it("no build DIAGNOSTIC reaches the tarball (FR-249)", () => {
    const report = packReport();
    const leaked = report.files
      .map((f) => f.path)
      .filter((p) => /\.bundle-report\.json$|\.tsbuildinfo$|\.vite[/\\]/.test(p));
    expect(
      leaked,
      "a diagnostic artifact is in the published tarball. It inflates the " +
        "packed delta and every brief downstream reads a phantom number. " +
        "Rebuild without DASH_BUNDLE_REPORT=1, or exclude it in package.json files.",
    ).toEqual([]);
  }, PACK_TIMEOUT_MS);

  it("stays under the hard packed-size ceiling (+150 KB over baseline)", () => {
    const report = packReport();
    const delta = report.size - PACK_BASELINE_PACKED;
    expect(
      delta,
      `packed delta ${(delta / 1024).toFixed(1)} KB exceeds the ` +
        `+${PACK_HARD_CEILING_DELTA / 1024} KB ceiling ` +
        `(packed ${report.size}, baseline ${PACK_BASELINE_PACKED})`,
    ).toBeLessThan(PACK_HARD_CEILING_DELTA);
  }, PACK_TIMEOUT_MS);

  it("ships the vendored graph library — bundled, never fetched (AC #4)", () => {
    // `force-graph` is a devDependency BUNDLED BY VITE into the dashboard's
    // hashed JS chunk. It must never appear as a runtime dependency, and it
    // must never be reached over the network. The absence of a
    // `dist/node_modules/force-graph` entry is the first half of that; the
    // artifact test's off-origin scan is the second.
    const paths = packedPaths();
    expect(
      [...paths].some((p) => p.includes("node_modules/force-graph")),
      "force-graph must be bundled by Vite, not shipped as a runtime dep",
    ).toBe(false);
    expect(
      [...paths].some(
        (p) => p.startsWith("dist/dashboard/assets/") && p.endsWith(".js"),
      ),
      "the hashed dashboard chunk that carries it is missing",
    ).toBe(true);
  }, PACK_TIMEOUT_MS);
});

/**
 * TD-443 — no declaration map ships, and the pin is UNSCOPED because it can be.
 *
 * Every `.d.ts.map` under `dist/brain-mcp-server/dist/` carries a `sources`
 * array like `["../../src/engine/bus.ts"]` with no `sourcesContent`, while
 * `files` ships `dist` only — `dist/brain-mcp-server/src` does not exist in the
 * tarball. Each one is therefore a dangling pointer on a consumer machine: the
 * path resolves to nothing and there is no inlined fallback. 138 entries,
 * 31_426 packed B, measured 2026-09-02. They are NOT dead in the repo, where
 * `dist/` and `src/` are siblings and the maps drive go-to-definition — which
 * is why the fix is `package.json` `files` and NOT `declarationMap: false`.
 * `brain-mcp-server/tsconfig.json:15` is untouched, no file left the tree, and
 * the third test below PINS that flag so this stays true by gate rather than
 * by claim.
 *
 * WHY THIS PIN CARRIES NO PATH SCOPE, and why the `.js.map` class cannot have
 * one. `cli/tsconfig.json:14` sets `declaration: false`, so `cli` emits no
 * declarations of its own, and the staged `dist/brain-mcp-server/scripts/`
 * holds `.ts` sources rather than compiled output (12 entries, zero maps). The
 * tarball's ENTIRE `.d.ts.map` population was the brain's 138 — measured
 * directly off the pack manifest, and corroborated by 807 − 138 = 669 entries
 * after the exclusion. So "no packed entry ends in `.d.ts.map`" is true of the
 * whole tarball with zero exceptions. A `.js.map` pin could not be written that
 * way: 246 `.js.map` ship and only 138 are the brain's, because
 * `cli/tsconfig.json:15` sets `sourceMap: true` and the 108 cli-own maps carry
 * the identical defect (`dist/lib/slug.js.map` reads
 * `"sources":["../../src/lib/slug.ts"]`, and `src` is not in `files`). Such a
 * pin would have to be path-scoped, and a later reader would take a scoped pin
 * for a whole-tarball guarantee it is not. The narrower exclusion buys the
 * stronger invariant, and that inversion is the reason it is the one taken.
 * The full argument, including the option NOT taken, is in this file's pack
 * ledger — grep `TD-443 MEASURED LAST`.
 *
 * RELATION, NOT COUNT. `brain-artifact.test.ts` states the rule this follows:
 * "It does not assert a file COUNT … The orphan scan asserts the RELATION."
 * A count goes green on a delete-plus-add and needs re-blessing every time the
 * brain gains a module. `toEqual([])` rather than a length check, so a
 * regression PRINTS the offending paths instead of a bare number.
 */
describe("TD-443 — no dangling declaration maps ship", () => {
  it("packs no .d.ts.map at all — whole tarball, no path scope", () => {
    const stray = [...packedPaths()].filter((p) => p.endsWith(".d.ts.map"));
    expect(
      stray,
      "declaration maps are back in the published tarball (TD-443). Their " +
        "`sources` point at `brain-mcp-server/src`, which `files` does not " +
        "ship, and there is no `sourcesContent` — so every one is weight no " +
        "consumer can resolve. The 138 of them cost 31_426 packed B. Restore " +
        'the `"!dist/**/*.d.ts.map"` negation in cli/package.json `files`.',
    ).toEqual([]);
  }, PACK_TIMEOUT_MS);

  it("still ships the vendored .d.ts those maps described", () => {
    // The inverse guard, and the reason it is a PRESENCE relation rather than a
    // count: a glob typo — `!dist/**/*.d.ts*` — would also drop the 138 `.d.ts`
    // (693_030 B unpacked, measured 2026-09-02) and the assertion above would
    // stay green on a far LARGER regression. A count would additionally need
    // re-blessing whenever the brain gains or loses a module.
    const declarations = [...packedPaths()].filter(
      (p) => p.startsWith("dist/brain-mcp-server/dist/") && p.endsWith(".d.ts"),
    );
    expect(
      declarations.length,
      "the vendored brain declarations are gone from the tarball. TD-443 " +
        "excluded declaration MAPS only; if this is red, the exclusion glob " +
        "widened past the maps and took the declarations with it.",
    ).toBeGreaterThan(0);
  }, PACK_TIMEOUT_MS);

  it("keeps `declarationMap` ON in the brain's tsconfig — AC-2's mechanism", () => {
    // BOTH assertions above are OUTCOME pins on the packlist, and neither can
    // see the mechanism AC-2 actually requires. Flip `declarationMap` to
    // false, rebuild, and delete the `files` negation: no `.d.ts.map` is
    // emitted, so none can pack and the first assertion stays green; the
    // `.d.ts` keep shipping, so the inverse guard stays green too. The tarball
    // would still be CORRECT — this is not a defect in the fix — but the
    // shipped sentence in cli/CHANGELOG.md, "`declarationMap` stays on and
    // every map stays on disk", would be FALSE with the whole suite passing.
    // This pin is the gate for that sentence. It reads SOURCE, so it fires
    // without a build, which is the only way it could run in this brief at
    // all.
    //
    // The on-disk half of the claim is deliberately NOT pinned here:
    // `brain-mcp-server/dist` is gitignored (.gitignore:41), so a clean
    // checkout has no maps to count and the assertion would be measuring
    // whether someone had built the brain. The flag is the durable half.
    //
    // `declaration` is asserted alongside it because `declarationMap` emits
    // nothing when declarations are off — the flag would read true and the
    // claim would still be false.
    const tsconfigPath = join(
      __dirname,
      "..",
      "..",
      "..",
      "brain-mcp-server",
      "tsconfig.json",
    );
    const raw = readFileSync(tsconfigPath, "utf8");
    let opts: Record<string, unknown>;
    try {
      opts = (JSON.parse(raw) as { compilerOptions: Record<string, unknown> })
        .compilerOptions;
    } catch {
      throw new Error(
        "brain-mcp-server/tsconfig.json is no longer plain JSON (a comment or " +
          "a trailing comma would do it) and this pin parses it with " +
          "JSON.parse. Teach it a tolerant parser — do not delete it.",
      );
    }
    expect(
      opts.declarationMap,
      "brain-mcp-server/tsconfig.json no longer sets `declarationMap: true`. " +
        "TD-443 excluded declaration maps from the PACKLIST and left the " +
        "compiler alone on purpose, so that in-repo go-to-definition keeps " +
        "working; turning the flag off is a DIFFERENT change with a different " +
        "blast radius, and on its own it would leave every packlist assertion " +
        "in this file green while making the shipped TD-443 CHANGELOG entry " +
        "false.",
    ).toBe(true);
    expect(
      opts.declaration,
      "brain-mcp-server/tsconfig.json no longer sets `declaration: true`, so " +
        "no `.d.ts` is emitted and `declarationMap` has nothing to describe.",
    ).toBe(true);
  });
});
