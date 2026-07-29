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
  }, 15_000);

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
  it("bundled entry spawns clean — no ERR_MODULE_NOT_FOUND (BR-068)", async () => {
    if (!bundleBuilt()) return;
    const cp = await import("node:child_process");
    const os = await import("node:os");

    const brainDir = mkdtempSync(join(tmpdir(), "igris-mcp-spawn-test-"));
    try {
      let stderr = "";
      let timedOut = false;
      try {
        cp.execFileSync("node", [bundledEntry], {
          timeout: 4000,
          encoding: "utf-8",
          env: { ...process.env, IGRIS_BRAIN_DIR: brainDir },
        });
      } catch (err) {
        const e = err as {
          signal?: string;
          killed?: boolean;
          stderr?: string;
        };
        // A timeout-kill means the server booted and idled — that is the
        // expected healthy outcome for a stdio server with no stdin.
        timedOut = e.killed === true || e.signal === "SIGTERM";
        stderr = e.stderr ?? "";
      }
      expect(stderr).not.toMatch(
        /ERR_MODULE_NOT_FOUND|Cannot find package/,
      );
      // It either idled until the timeout kill, or exited cleanly — both
      // are acceptable; what is NOT acceptable is a resolution failure.
      void timedOut;
      void os;
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 15_000);

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
  }, 15_000);
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
 * The dashboard budget (plan D2) is +250 KB packed with a hard ceiling of
 * +400 KB. The CEILING is asserted here rather than the budget, so an ordinary
 * CLI change does not fail the suite — but a bundle that doubles does.
 *
 * PROVENANCE OF THE CONSTANT, stated because it is softer than it looks:
 * 1_301_851 was measured on the FR-238 authoring checkout (739 files /
 * 5_475_927 unpacked). A CLEAN worktree measures ~1_277_864 (715 files /
 * 5_394_552) — `cli/dist` is never cleaned by the build, so a long-lived
 * checkout accumulates orphan artifacts from deleted sources (~91 KB of
 * `subconscious/` leftovers at the time of writing) that a fresh clone does
 * not have.
 *
 * Direction of the error, stated plainly: the constant is ~24 KB HIGHER than a
 * clean baseline, so on a clean tree (where CI runs) the computed delta
 * UNDER-reports the true one by ~24 KB and the ceiling is that much more
 * permissive. It does not invalidate the assertion — this is a one-sided
 * tripwire with ~200 KB of headroom either way — but do not read the number as
 * a precise per-commit delta. If dist-cleaning ever lands, re-measure on a
 * clean worktree and update this constant together with this provenance note.
 */
const PACK_BASELINE_PACKED = 1_301_851;
const PACK_HARD_CEILING_DELTA = 400 * 1024;

/**
 * Memoised. `npm pack --dry-run` walks the whole package and takes a couple of
 * seconds; running it once per file rather than once per assertion keeps the
 * suite fast, and computing it LAZILY (not in the describe body) keeps it out
 * of collection for a filtered run of any other test in this file.
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
  });

  it("includes the three vendored woff2 fonts", () => {
    const paths = packedPaths();
    for (const f of [
      "dist/dashboard/fonts/anton-latin-400-normal.woff2",
      "dist/dashboard/fonts/space-grotesk-latin-wght-normal.woff2",
      "dist/dashboard/fonts/jetbrains-mono-latin-400-normal.woff2",
    ]) {
      expect(paths.has(f), `missing from tarball: ${f}`).toBe(true);
    }
  });

  it("includes the hashed JS and CSS assets", () => {
    const assets = [...packedPaths()].filter((p) => p.startsWith("dist/dashboard/assets/"));
    expect(assets.some((p) => p.endsWith(".js"))).toBe(true);
    expect(assets.some((p) => p.endsWith(".css"))).toBe(true);
  });

  it("still ships the vendored brain engine the FR-238 bridge imports", () => {
    // The bridge is a path-literal dependency on this artifact (R2). If the
    // `files` exclusion list ever widens to drop it, the dashboard's graph
    // readout degrades silently — so assert it here, loudly.
    expect(
      packedPaths().has(
        "dist/brain-mcp-server/dist/engine/components/edges/whole-graph.js",
      ),
    ).toBe(true);
  });

  it("stays under the FR-238 hard packed-size ceiling (+400 KB over baseline)", () => {
    const report = packReport();
    const delta = report.size - PACK_BASELINE_PACKED;
    expect(
      delta,
      `packed delta ${(delta / 1024).toFixed(1)} KB exceeds the +400 KB ceiling ` +
        `(packed ${report.size}, baseline ${PACK_BASELINE_PACKED})`,
    ).toBeLessThan(PACK_HARD_CEILING_DELTA);
  });
});
