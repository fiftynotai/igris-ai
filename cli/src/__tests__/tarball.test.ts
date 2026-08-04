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
 * The dashboard packed-size gate is **one number: a hard ceiling of +550 KB**
 * over `PACK_BASELINE_PACKED`, asserted below. An ordinary CLI change does not
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
 *   THE CHUNK IS NOW THE BINDING CEILING BY A WIDE MARGIN, and the next
 *   dashboard brief has to plan around it rather than budget against it:
 *   **616 B**, against this gate's 104.9 KB. That is not headroom. A brief that
 *   adds any UI to this bundle should expect to SPLIT the chunk (a route-level
 *   dynamic import for the layers or the graph) as its first step, not as a
 *   cut-ladder rung. **Raise NEITHER limit** — TD-329 raised the packed one
 *   ONCE, before the work, as a recorded operator decision, and that is not a
 *   precedent.
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
 * READ THIS BEFORE PLANNING THE NEXT BRIEF: ~104.9 KB is what is left (the
 * FR-247 reading above; ~117.2 KB was FR-246's, ~143.6 KB FR-245's,
 * ~147.2 KB FR-244's, ~149.3 KB TD-328's and ~173.6 KB TD-326's, all
 * superseded). **BUT THE PACKED FIGURE IS NO LONGER THE ONE THAT BINDS.** The
 * app chunk has **484 B** of slack against `vite.config.ts`'s
 * `chunkSizeWarningLimit` (559_516 B of 560_000). A brief adding ANY UI to this
 * bundle should plan a route-level code split as its FIRST step, not as a
 * cut-ladder rung — there is no longer a budget to cut from.
 *
 * BR-085 measured 2026-08-04: **559_384 -> 559_516 B, +132 B**, spending 21% of
 * the 616 B FR-247 left.
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
 * a genuinely small UI change, which is the point: **at 484 B, "small" is no
 * longer automatically affordable.** FR-248 and FR-249 both add UI and cannot
 * both fit; whichever runs first owns the route-level split.
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
 * never to raise `PACK_HARD_CEILING_DELTA` — TD-329 raised it ONCE, before the
 * work, as a recorded operator decision, and that is not a precedent.
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
 * READ THAT BEFORE PLANNING THE NEXT ONE. **~104.9 KB is what is left** (the
 * FR-247 reading above; ~117.2 KB was FR-246's, ~143.6 KB FR-245's,
 * ~147.2 KB FR-244's, ~149.3 KB TD-328's and ~173.6 KB TD-326's, all
 * superseded). **And the OTHER ceiling is not merely binding now, it is
 * effectively spent**: **616 B** of chunk slack against this gate's 104.9 KB.
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
 * rather than estimate. `PACK_BASELINE_PACKED` is UNCHANGED.
 *
 * PROVENANCE OF THE BASELINE CONSTANT, stated because it is softer than it looks:
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
const PACK_HARD_CEILING_DELTA = 550 * 1024; // TD-329, operator, 2026-08-02

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

  it("stays under the hard packed-size ceiling (+550 KB over baseline)", () => {
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
