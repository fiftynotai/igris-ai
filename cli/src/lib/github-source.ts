/**
 * FR-148 GitHub-origin source module for `igris registry`.
 *
 * Provides the parser, fetch abstraction, manifest read+validate, surface
 * selection, and release-freshness comparison used by the `github` origin
 * type. Builds on FR-142's copy-vendor + typed-origin foundation in
 * `verbs/registry.ts`.
 *
 * THE TESTABILITY SEAM (L-159 / L-173): the network/tooling boundary is two
 * injectable functions — `FetchRepoFn` and `ListReleasesFn` — mirroring
 * FR-142's `overlayPath`/`vendorDir` seams. Unit tests inject fakes that
 * return a staged fixture repo dir + a fake SHA + a fixture release list.
 * NEVER `vi.mock` the SUT (`runRegistry`); stub the FETCH instead.
 *
 * EXTRACTION NOTE (high-impact, plan §2 risk): we do NOT reuse
 * `tarball.ts`'s `fetchAndExtract` — its `isEntrySafe` hard-codes a `core/`-only
 * allow-list and would silently vendor nothing from an arbitrary repo. This
 * module ships a SEPARATE `extractRepoTarball` that keeps the zip-slip /
 * path-traversal guard but drops the `core/` filter.
 *
 * The repo manifest is validated against the EXISTING exported
 * `validateOverlayShape` from `verbs/registry.ts` (the FR-141 TS port of
 * `manifest.schema.json`, parity-tested against the real bash
 * `validate_manifest`). Reuse — no fork, no new schema.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve as pathResolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Transform, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { x as tarExtract } from "tar";
import { httpsGet } from "./tarball.js";
import { httpsGetJson } from "./http.js";
import { validateOverlayShape } from "../verbs/registry.js";

const pipeline = promisify(streamPipeline);

// ---------------------------------------------------------------------------
// Spec parser: github:owner/repo@ref[#subdir]
// ---------------------------------------------------------------------------

/** A parsed `github:owner/repo@ref[#subdir]` source spec. */
export interface GithubSpec {
  owner: string;
  repo: string;
  ref: string;
  subdir?: string;
}

/** The literal `--from` scheme discriminant for a github source. */
export const GITHUB_SCHEME = "github:";

/** True when a `--from` value names a github source (vs a filesystem path). */
export function isGithubSpec(from: string): boolean {
  return from.startsWith(GITHUB_SCHEME);
}

// GitHub login rules: alphanumerics + single internal hyphens, no leading/
// trailing hyphen. We accept `_` and `.` defensively (repo charset overlaps).
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a `github:owner/repo@ref[#subdir]` spec into a typed GithubSpec.
 * Returns a typed error message string on failure (same idiom as
 * `parseTarget`/`resolveSource`). Leading/trailing whitespace is trimmed;
 * internal whitespace is rejected.
 */
export function parseGithubSpec(spec: string): GithubSpec | string {
  const trimmed = spec.trim();
  if (!trimmed.startsWith(GITHUB_SCHEME)) {
    return `github source must start with '${GITHUB_SCHEME}'`;
  }
  let rest = trimmed.slice(GITHUB_SCHEME.length);

  // Split off the optional `#subdir` first (a `#` cannot appear in a ref).
  let subdir: string | undefined;
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    subdir = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  // Require `@ref`.
  const atIdx = rest.indexOf("@");
  if (atIdx < 0) {
    return "github source must pin a ref: github:owner/repo@<tag-or-sha>";
  }
  const ownerRepo = rest.slice(0, atIdx);
  const ref = rest.slice(atIdx + 1);

  // owner/repo split.
  const slashIdx = ownerRepo.indexOf("/");
  if (slashIdx < 0) {
    return "github source must be github:owner/repo@<ref>";
  }
  const owner = ownerRepo.slice(0, slashIdx);
  const repo = ownerRepo.slice(slashIdx + 1);

  if (owner.length === 0 || repo.length === 0) {
    return "github source owner/repo cannot be empty";
  }
  if (ref.length === 0) {
    return "github source ref cannot be empty";
  }
  if (/\s/.test(owner) || /\s/.test(repo) || /\s/.test(ref)) {
    return "github source must not contain whitespace";
  }
  if (!OWNER_PATTERN.test(owner)) {
    return `github source owner '${owner}' is not a valid GitHub login`;
  }
  if (!REPO_PATTERN.test(repo)) {
    return `github source repo '${repo}' is not a valid repository name`;
  }

  if (subdir !== undefined) {
    const sd = subdir.trim();
    if (sd.length === 0) {
      return "github source subdir cannot be empty (drop the '#')";
    }
    if (/\s/.test(sd)) {
      return "github source subdir must not contain whitespace";
    }
    if (
      sd.startsWith("/") ||
      sd === ".." ||
      sd.startsWith("../") ||
      sd.includes("/../") ||
      sd.endsWith("/..")
    ) {
      return "github source subdir must be a relative path without '..'";
    }
    subdir = sd;
  }

  return subdir !== undefined
    ? { owner, repo, ref, subdir }
    : { owner, repo, ref };
}

// ---------------------------------------------------------------------------
// Semver / release-tag freshness comparison
// ---------------------------------------------------------------------------

/** A parsed semantic version (release portion + optional prerelease ids). */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers (e.g. `["rc", 1]`); empty for a release version. */
  pre: (string | number)[];
}

/**
 * Parse a semver string, tolerating a leading `v`. Returns null for any
 * non-semver value (branch names, raw SHAs, calver, etc.).
 */
export function parseSemver(input: string): ParsedSemver | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s.startsWith("v") || s.startsWith("V")) {
    s = s.slice(1);
  }
  // major.minor.patch[-prerelease][+build] — build metadata is ignored.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    s,
  );
  if (m === null) return null;
  const pre: (string | number)[] = [];
  if (m[4] !== undefined) {
    for (const id of m[4].split(".")) {
      if (/^\d+$/.test(id)) {
        pre.push(Number(id));
      } else {
        pre.push(id);
      }
    }
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

/**
 * Compare two parsed semvers. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Prerelease ordering per semver §11: a version with a prerelease has LOWER
 * precedence than the same release without one; prerelease identifiers are
 * compared field-by-field (numeric < non-numeric, numeric ascending,
 * lexical for strings, more fields wins when all prior are equal).
 */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Release (no pre) > prerelease.
  const aPre = a.pre.length > 0;
  const bPre = b.pre.length > 0;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1; // a is release, b is prerelease → a > b
  if (!bPre) return -1;

  const len = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return (x as number) - (y as number);
    } else if (xNum !== yNum) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return xNum ? -1 : 1;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return a.pre.length - b.pre.length;
}

/** The outcome of a release-freshness check. */
export interface NewerReleaseResult {
  tag: string;
  mode: "semver" | "non-semver-pin";
}

/**
 * Given the pinned `ref` and a list of candidate release tags, decide whether
 * a newer release exists and which tag to advance to. Returns null when no
 * update is warranted (no releases, or none newer than the pin).
 *
 * - Semver pin: pick the HIGHEST semver tag strictly greater than the pin.
 * - Non-semver pin (branch/SHA): comparison is undefined → coarse mode:
 *   "newest semver release tag != pinned ref" means an update is available;
 *   target = highest semver tag. If no tag parses as semver, no update.
 */
export function pickNewerReleaseTag(
  pinnedRef: string,
  tags: string[],
): NewerReleaseResult | null {
  if (tags.length === 0) return null;

  // Highest semver tag among the candidates.
  let best: { tag: string; sv: ParsedSemver } | null = null;
  for (const tag of tags) {
    const sv = parseSemver(tag);
    if (sv === null) continue;
    if (best === null || compareSemver(sv, best.sv) > 0) {
      best = { tag, sv };
    }
  }
  if (best === null) {
    // No parseable semver tags at all → nothing to advance to.
    return null;
  }

  const pinnedSv = parseSemver(pinnedRef);
  if (pinnedSv === null) {
    // Non-semver pin: coarse compare. An update is available iff the highest
    // semver tag differs from the pinned ref.
    if (best.tag === pinnedRef) return null;
    return { tag: best.tag, mode: "non-semver-pin" };
  }

  // Semver pin: only if the best is strictly newer.
  if (compareSemver(best.sv, pinnedSv) > 0) {
    return { tag: best.tag, mode: "semver" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch + release seams (the injectable boundary)
// ---------------------------------------------------------------------------

/** A fetched repo on disk, ready to read+vendor. Caller MUST call cleanup. */
export interface FetchedRepo {
  /** Absolute path to the extracted repo root. `#subdir` is applied later. */
  dir: string;
  /** The resolved immutable commit SHA the ref pointed at (provenance pin). */
  sha: string;
  /** Cleanup callback — removes the temp dir. Caller MUST invoke in finally. */
  cleanup: () => void;
}

/** The fetch seam: resolve a github spec to an on-disk repo. */
export type FetchRepoFn = (spec: GithubSpec) => Promise<FetchedRepo>;

/** The release-listing seam: return the repo's release tag names. */
export type ListReleasesFn = (owner: string, repo: string) => Promise<string[]>;

// ---------------------------------------------------------------------------
// Repo manifest read + validation
// ---------------------------------------------------------------------------

/** A repo manifest agent entry (subset of the overlay AgentEntry shape). */
export interface RepoAgentEntry {
  name: string;
  layer?: string;
  canonical: {
    dir: string;
    versioned: boolean;
    glob?: string;
    file?: string;
  };
  body_exception?: string;
  targets: { type: string; path: string }[];
}

/** A parsed + validated repo manifest. */
export interface RepoManifest {
  version: number;
  agents: RepoAgentEntry[];
  surfaces?: Record<string, unknown>;
}

/**
 * Read + validate the repo's manifest. Looks for `<repoDir>/igris.json` first,
 * then `<repoDir>/.igris/manifest.json`. Validates with the EXISTING
 * `validateOverlayShape` (reused from verbs/registry.ts). Returns the manifest
 * or an error message string.
 */
export function readRepoManifest(repoDir: string): RepoManifest | string {
  const candidates = [
    join(repoDir, "igris.json"),
    join(repoDir, ".igris", "manifest.json"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    return `repo has no manifest (looked for igris.json and .igris/manifest.json)`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, "utf-8"));
  } catch (err) {
    return `repo manifest ${found} is not valid JSON: ${(err as Error).message}`;
  }
  const shapeErr = validateOverlayShape(parsed);
  if (shapeErr !== null) {
    return `repo manifest ${found} is invalid: ${shapeErr}`;
  }
  return parsed as RepoManifest;
}

/** The selected surface's source dir + file list, resolved on disk. */
export interface SelectedSurface {
  entry: RepoAgentEntry;
  /** Absolute source dir the canonical files live in. */
  srcDir: string;
  /** Relative file names to vendor out of srcDir. */
  files: string[];
}

/** Translate a simple shell-style glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Path-traversal containment guard: verify that `candidate` resolves to a path
 * UNDER `root` (the fetched repo root). Rejects `..` escape and absolute paths.
 * Returns true when contained, false when it escapes. Mirrors the
 * resolve-and-verify-under-root check in `extractRepoTarball`.
 *
 * A malicious repo manifest can carry `canonical.dir: "../../../etc"` or
 * `file: "../../passwd"` — the schema validator only checks these are STRINGS,
 * not that they stay inside the repo. Without this guard we would vendor
 * arbitrary host files into `~/.igris/registry/`.
 */
function isContainedUnder(root: string, candidate: string): boolean {
  const resolvedRoot = pathResolve(root);
  const resolvedCandidate = pathResolve(resolvedRoot, candidate);
  const rootWithSep = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : resolvedRoot + sep;
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(rootWithSep)
  );
}

/**
 * REALPATH-aware containment guard: dereference symlinks on BOTH the root and
 * the candidate, THEN verify the candidate's real path stays under the root's
 * real path. This is what `isContainedUnder` (lexical `pathResolve`) CANNOT do:
 * a malicious repo can check in a symlink as `canonical.dir` (e.g.
 * `agents -> /etc`) that the gh/git clone tiers materialize on disk. The
 * lexical check passes (the link's own path is under the repo) but
 * `copyFileSync` would dereference it and vendor host files. Resolving symlinks
 * first closes that hole. (Precedent: `verbs/doctor.ts` uses `realpathSync`.)
 *
 * Fails CLOSED: if either path cannot be realpath'd (ENOENT, broken symlink,
 * dangling target), returns false — "missing/unsafe", never a throw.
 */
function isContainedUnderReal(root: string, candidate: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    return false;
  }
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realCandidate === realRoot || realCandidate.startsWith(rootWithSep);
}

/**
 * Select ONE surface from a repo manifest by name + resolve its canonical
 * files on disk. Selection precedence (plan §2d):
 *   1. single-entry manifest → use it.
 *   2. multi-entry → `<name>` MUST match a manifest agents[].name; select it.
 * `#subdir` scopes WHERE the canonical dir is resolved (relative to
 * `<repoDir>/<subdir>`); it does NOT select the surface. Returns the resolved
 * surface or an error message string.
 */
export function selectSurface(
  manifest: RepoManifest,
  name: string,
  repoDir: string,
  subdir: string | undefined,
): SelectedSurface | string {
  const agents = manifest.agents;
  if (agents.length === 0) {
    return "repo manifest has no agents to register";
  }
  let entry: RepoAgentEntry;
  if (agents.length === 1) {
    entry = agents[0];
  } else {
    const match = agents.find((a) => a.name === name);
    if (match === undefined) {
      const names = agents.map((a) => a.name).join(", ");
      return `repo manifest has no agent named '${name}'; available: ${names}`;
    }
    entry = match;
  }

  // The containment root is the fetched repo root scoped by #subdir. EVERYTHING
  // a (potentially malicious) repo manifest resolves to MUST stay under it.
  // The schema validator only checks these fields are strings — it does NOT
  // contain them. Fail BEFORE vendoring anything (no partial vendor).
  const baseDir = subdir !== undefined ? join(repoDir, subdir) : repoDir;

  // Guard the canonical dir itself against `..`-escape / absolute paths.
  if (!isContainedUnder(baseDir, entry.canonical.dir)) {
    return `surface '${entry.name}' canonical.dir escapes the repo root: ${entry.canonical.dir}`;
  }
  const srcDir = join(baseDir, entry.canonical.dir);
  if (!existsSync(srcDir)) {
    return `surface '${entry.name}' canonical dir does not exist in repo: ${entry.canonical.dir}`;
  }
  // REALPATH check (the load-bearing symlink-escape guard): the lexical
  // `isContainedUnder` above only rejects `..`/absolute strings — it does NOT
  // dereference symlinks. A repo that checks in `canonical.dir` as a symlink
  // pointing outside the root (materialized by the gh/git clone tiers) would
  // pass the lexical check, then `copyFileSync` would follow it and vendor host
  // files. Resolving symlinks on both repo root and srcDir before the under-
  // root check closes that hole. Fails closed on a dangling/broken link.
  if (!isContainedUnderReal(repoDir, srcDir)) {
    return `surface '${entry.name}' canonical dir resolves outside the repo (symlink escape): ${entry.canonical.dir}`;
  }

  let files: string[];
  if (entry.canonical.versioned) {
    const glob = entry.canonical.glob ?? "";
    const re = globToRegExp(glob);
    try {
      files = readdirSync(srcDir, { withFileTypes: true })
        .filter((d) => d.isFile() && re.test(d.name))
        .map((d) => d.name);
    } catch (err) {
      return `cannot read surface dir ${srcDir}: ${(err as Error).message}`;
    }
    if (files.length === 0) {
      return `no files in ${srcDir} match glob '${glob}'`;
    }
  } else {
    const file = entry.canonical.file ?? "";
    files = [file];
  }

  // Containment-check EACH resolved file BEFORE vendoring. Two layers:
  //   1. LEXICAL (`isContainedUnder`): rejects `..`/separator escapes in the
  //      attacker-controlled `file` (the `glob` is basename-only, but `file`
  //      could carry separators).
  //   2. REALPATH (`isContainedUnderReal`): dereferences symlinks so a file
  //      that IS a symlink (or lives under a symlinked dir) pointing outside
  //      the repo cannot have its target vendored by `copyFileSync`.
  for (const f of files) {
    if (!isContainedUnder(srcDir, f)) {
      return `surface '${entry.name}' file '${f}' escapes the surface dir`;
    }
    const full = join(srcDir, f);
    if (!isContainedUnder(repoDir, full)) {
      return `surface '${entry.name}' file '${f}' resolves outside the repo`;
    }
    if (!existsSync(full)) {
      return `surface '${entry.name}' canonical file does not exist: ${f}`;
    }
    if (!isContainedUnderReal(repoDir, full)) {
      return `surface '${entry.name}' file '${f}' resolves outside the repo (symlink escape)`;
    }
  }

  return { entry, srcDir, files };
}

// ---------------------------------------------------------------------------
// extractRepoTarball — general-purpose extractor (NOT tarball.ts's core/-only)
// ---------------------------------------------------------------------------

/**
 * Extract a gzipped repo tarball stream into `destDir`. Keeps the zip-slip /
 * path-traversal guard from `tarball.ts` (`..`/leading-`/` rejection +
 * absolute-resolve-under-root check) but DROPS the `core/`-only allow-list:
 * the whole tree is extracted. `strip:1` drops GitHub's `<repo>-<sha>/` prefix
 * dir. Returns the number of files extracted.
 *
 * Distinct from `tarball.ts fetchAndExtract`, which is purpose-built for the
 * Igris-repo `core/` shape and would silently vendor nothing here.
 */
export async function extractRepoTarball(
  stream: NodeJS.ReadableStream,
  destDir: string,
): Promise<number> {
  let fileCount = 0;
  let zipSlip: string | null = null;

  const gunzip = createGunzip();
  // The hash tap is unused for vendoring but keeps the pipeline shape clear.
  const passthrough = new Transform({
    transform(chunk, _enc, cb): void {
      cb(null, chunk);
    },
  });

  const extractStream = tarExtract({
    cwd: destDir,
    strict: true,
    filter: (path: string, entry): boolean => {
      if (zipSlip !== null) return false;
      // M3: refuse symlink/hardlink entries — a malicious link can point
      // outside the extraction root and let a subsequent entry escape via it.
      // We only ever vendor regular files; links are never needed. `entry` is
      // a tar ReadEntry (carries `.type`) or fs Stats; read `type` defensively.
      const entryType = (entry as { type?: unknown }).type;
      if (
        entryType === "SymbolicLink" ||
        entryType === "Link" ||
        entryType === "symlink" ||
        entryType === "link"
      ) {
        return false;
      }
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "" || normalized === ".") return false;
      if (
        normalized.startsWith("/") ||
        /(?:^|\/)\.\.(?:\/|$)/.test(normalized)
      ) {
        zipSlip = path;
        return false;
      }
      // Strip the leading GitHub prefix segment ourselves (matches strip:1).
      const slashIdx = normalized.indexOf("/");
      if (slashIdx === -1) return false; // bare prefix dir, nothing under it
      const stripped = normalized.slice(slashIdx + 1);
      if (stripped === "" || stripped === "/") return false;
      const lastSeg = stripped.split("/").pop()!;
      if (lastSeg.startsWith("._")) return false; // macOS AppleDouble noise

      const wouldBeDest = pathResolve(destDir, stripped);
      const destWithSep = destDir.endsWith(sep) ? destDir : destDir + sep;
      if (wouldBeDest !== destDir && !wouldBeDest.startsWith(destWithSep)) {
        zipSlip = path;
        return false;
      }
      fileCount += 1;
      return true;
    },
    strip: 1,
  });

  try {
    await pipeline(stream, passthrough, gunzip, extractStream);
  } catch (err) {
    if (zipSlip !== null) {
      throw new Error(`refused to extract entry '${zipSlip}': zip-slip`);
    }
    throw new Error(
      `repo tarball extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (zipSlip !== null) {
    throw new Error(`refused to extract entry '${zipSlip}': zip-slip`);
  }
  return fileCount;
}

// ---------------------------------------------------------------------------
// Production fetch + release implementations (gh → git → tarball)
// ---------------------------------------------------------------------------

/**
 * True if a binary is on PATH. M1: pass `bin` as an argv element to `command`
 * via `bash -c 'command -v "$1"' _ <bin>` rather than interpolating it into the
 * shell string — defense-in-depth even though every caller passes a hardcoded
 * literal ("gh"/"git").
 */
function commandExists(bin: string): boolean {
  try {
    execFileSync("bash", ["-c", 'command -v "$1"', "_", bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** True if `gh auth status` exits 0 (the user has ambient gh auth). */
function ghAuthOk(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resolve HEAD's commit SHA in a cloned repo dir. */
function gitHeadSha(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Production fetch chain: gh → git → unauthenticated tarball. Lands the repo in
 * an OS-tmpdir temp dir; the caller MUST invoke `cleanup()` in a finally.
 *
 * - gh: `gh repo clone owner/repo <tmp> -- --depth 1 --branch <ref>`; ambient
 *   auth carries private-repo access (no Igris credential story, L-514).
 * - git: `git clone --depth 1 --branch <ref> https://github.com/owner/repo`;
 *   honors the user's git credential helper.
 * - tarball: anon GET `https://github.com/owner/repo/archive/<ref>.tar.gz`.
 *   Public repos only; a private repo here → actionable error.
 */
export async function fetchRepoDefault(spec: GithubSpec): Promise<FetchedRepo> {
  const tmp = mkdtempSync(join(tmpdir(), "igris-gh-"));
  const cleanup = (): void => {
    rmSync(tmp, { recursive: true, force: true });
  };
  const slug = `${spec.owner}/${spec.repo}`;

  // Tier 1: gh (ambient auth → private repos work).
  if (commandExists("gh") && ghAuthOk()) {
    try {
      execFileSync(
        "gh",
        ["repo", "clone", slug, tmp, "--", "--depth", "1", "--branch", spec.ref],
        { stdio: "ignore" },
      );
      const sha = gitHeadSha(tmp);
      return { dir: tmp, sha, cleanup };
    } catch {
      // A SHA ref (not a branch/tag) fails `--branch`; fall through to git/tarball.
    }
  }

  // Tier 2: git.
  if (commandExists("git")) {
    try {
      execFileSync(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          spec.ref,
          `https://github.com/${slug}`,
          tmp,
        ],
        { stdio: "ignore" },
      );
      const sha = gitHeadSha(tmp);
      return { dir: tmp, sha, cleanup };
    } catch {
      // Fall through to anon tarball.
    }
  }

  // Tier 3: unauthenticated tarball (public repos only).
  try {
    const url = `https://github.com/${slug}/archive/${encodeURIComponent(spec.ref)}.tar.gz`;
    const stream = await httpsGet(url);
    await extractRepoTarball(stream, tmp);
    // Resolve SHA via the public commits API (best-effort; provenance only).
    // M2: when the lookup fails we record the explicit `"unknown"` sentinel
    // rather than an empty string, so a consumer reading origins.json can tell
    // "SHA was never resolved" apart from "" (a malformed/half-written field).
    let sha = "unknown";
    try {
      const body = await httpsGetJson(
        `https://api.github.com/repos/${slug}/commits/${encodeURIComponent(spec.ref)}`,
      );
      const parsed = JSON.parse(body) as { sha?: unknown };
      if (typeof parsed.sha === "string" && parsed.sha.length > 0) {
        sha = parsed.sha;
      }
    } catch {
      // SHA is provenance-only; a soft failure does not break vendoring.
    }
    return { dir: tmp, sha, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(
      `cannot fetch ${slug}@${spec.ref}: ${err instanceof Error ? err.message : String(err)}. ` +
        `If this is a private repo, install gh and run 'gh auth login', or configure git credentials.`,
    );
  }
}

/**
 * Production release-listing: gh (ambient auth) → public releases API. Returns
 * the repo's release tag names. An empty list (no releases) is valid, not an
 * error.
 */
export async function listReleasesDefault(
  owner: string,
  repo: string,
): Promise<string[]> {
  const slug = `${owner}/${repo}`;
  if (commandExists("gh") && ghAuthOk()) {
    try {
      const out = execFileSync(
        "gh",
        ["release", "list", "--repo", slug, "--json", "tagName", "--limit", "100"],
        { encoding: "utf-8" },
      );
      const parsed = JSON.parse(out) as { tagName?: unknown }[];
      const tags = parsed
        .map((r) => r.tagName)
        .filter((t): t is string => typeof t === "string");
      return tags;
    } catch {
      // Fall through to the public API.
    }
  }
  try {
    const body = await httpsGetJson(
      `https://api.github.com/repos/${slug}/releases?per_page=100`,
    );
    const parsed = JSON.parse(body) as { tag_name?: unknown }[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => r.tag_name)
      .filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

/** Stable content hash over a vendored file set (mirrors registry.ts). */
export function hashFileSet(absDir: string, fileRelPaths: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...fileRelPaths].sort()) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(absDir, rel)));
  }
  return h.digest("hex");
}

/** Guard: a temp dir must be a directory before we read a manifest from it. */
export function assertRepoDir(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`fetched repo dir is missing or not a directory: ${dir}`);
  }
}
