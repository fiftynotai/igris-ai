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
    expect(existsSync(join(dest, "core", "rules", "00-igris-universal.md"))).toBe(true);
    expect(existsSync(join(dest, "core", "hooks", "canonical-settings.json"))).toBe(true);
    expect(existsSync(join(dest, "core", "scripts", "verify_mirror.sh"))).toBe(true);
    expect(existsSync(join(dest, "core", "templates", "CLAUDE.md.tmpl"))).toBe(true);
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
