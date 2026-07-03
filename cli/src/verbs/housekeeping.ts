/**
 * `igris housekeeping` — the crash-robust, idempotent archive sweep (FR-195 M2).
 *
 * Faithfully reproduces SKILL.md §3.8 (H0–H3): a once-per-`/awaken` sweep, NOT
 * a daemon. Running it twice is harmless; a crash mid-sweep leaves a consistent
 * state (Lock 4 — `session_protocol.md` §5). Each step is a separate function.
 *
 * Channel: LOCAL — better-sqlite3 (`session_files` state flips) + the on-disk
 * `session/archive/` directory. The cost guard (SKILL.md §3.8) is structural:
 * the sweep touches ONLY `session/archive/` + the RESTED set + the one legacy
 * row — NEVER LIVE files, NEVER the brief DB, NEVER the VPS.
 *
 * Why CODE not recipe (the FR-195 thesis): the H2/H3 header-presence guard
 * (idempotency) and the per-file append-then-delete (crash-robustness) are the
 * exact class of atomicity contract that "cannot be enforced from a skill
 * recipe" — the same reasoning that put the sync-queue drain in
 * `cli/src/lib/sync/queue.ts` (FR-128, cited in `data.ts`). The Lock-2
 * "read-before-archive" invariant becomes a TESTABLE property: H1 only archives
 * a file that a newer rested file from a different instance provably superseded.
 *
 * Cross-process ordering (the awaken skill's responsibility, NOT enforced here):
 * the skill calls gather → register → housekeeping in that fixed order, exactly
 * as the inline steps did. H0's "gather provably read the legacy row earlier in
 * this same /awaken" holds because the skill ran gather first; the verbs are
 * individually idempotent so a re-run in the right order is always safe.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { detectCapabilities } from "../lib/detect.js";
import {
  listSessionFiles,
  sessionFileUpsert,
  getSessionFileContent,
} from "../lib/brain-db.js";
import {
  projectSessionDir,
  projectSessionInstancesDir,
  projectSessionArchiveDir,
} from "../lib/paths.js";
import { basenameOfCwd } from "../lib/sync/util.js";
import type { SessionFileRow, HousekeepingDigest } from "../types.js";

export interface HousekeepingOptions {
  /** Project slug override; default basename(cwd) per the sync convention. */
  project?: string;
  /** 30-day digest-roll window (SKILL.md "tunable knob"); default 30. */
  rollDays?: number;
  /** Individual-file ceiling before the H3 burst valve fires; default 150. */
  ceiling?: number;
  /** Emit JSON to stdout (default ON for the awaken path). */
  json?: boolean;
}

const LEGACY_FILENAME = "CURRENT_SESSION.md";
const DEFAULT_ROLL_DAYS = 30;
const DEFAULT_CEILING = 150;

/**
 * Move a file on disk, creating the destination dir. The archive moves are
 * rename (same filesystem under `~/.igris/`); a pre-existing destination is
 * overwritten (idempotent — a re-run that finds the move half-done completes
 * it). renameSync replaces an existing dest atomically on POSIX.
 */
function moveFile(from: string, to: string): void {
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
}

/**
 * H0 — Legacy `CURRENT_SESSION.md` retirement (FR-133, one-time per project).
 *
 * SKILL.md §3.8 H0. Find the legacy row: `filename='CURRENT_SESSION.md'` AND
 * `instance_id IS NULL`. If it exists with `state IN ('live','rested')`, it was
 * provably read as the GENUINE HANDOFF by THIS /awaken's gather (§2 G3) and
 * superseded by §3.7's fresh LIVE file — so retire it:
 *   - flip its DB state to 'archived' carrying `content` through UNCHANGED (a
 *     state flip, not a content edit) and leaving `instance_id` untouched
 *     (omitted → the sessionFileUpsert COALESCE preserves the existing NULL);
 *   - move `session/CURRENT_SESSION.md` → `session/archive/CURRENT_SESSION-<updated_at>.md`.
 *
 * Lock-2 holds: gather read the row earlier in this same /awaken (the skill's
 * ordering guarantee). Idempotent: a re-run finds the row already 'archived'
 * (or the disk file already moved) and no-ops. An ABANDONED-LIVE per-instance
 * file is NEVER touched here — H0 acts ONLY on the legacy NULL-instance row.
 */
function runH0(slug: string, rows: SessionFileRow[]): boolean {
  const legacy = rows.find(
    (r) => r.filename === LEGACY_FILENAME && r.instance_id === null,
  );

  // No legacy row, or already retired → no-op (idempotent).
  if (!legacy || legacy.state === "archived") {
    return false;
  }
  // Only retire a legacy row that is still live/rested (a forward-compat
  // unknown state is left alone — never destructive on the unknown).
  if (legacy.state !== "live" && legacy.state !== "rested") {
    return false;
  }

  // Carry the EXISTING content through unchanged (state flip, not content edit).
  // Read it from the DB (the authoritative copy) so the archive is faithful even
  // if the on-disk file already moved in a prior crashed run.
  const content =
    getSessionFileContent(slug, LEGACY_FILENAME) ??
    readOnDiskLegacy(slug) ??
    "";

  // Flip DB state → archived. instance_id OMITTED → COALESCE preserves the
  // existing NULL (the legacy row stays instance-less); state set explicitly.
  sessionFileUpsert({
    project: slug,
    filename: LEGACY_FILENAME,
    content,
    // instance_id intentionally omitted — do NOT set/clear it (Lock 1 + §3.8 H0).
    state: "archived",
  });

  // Move the on-disk file if it is still at the live location. Idempotent: if
  // it already moved (prior crash), existsSync is false → skip.
  const livePath = join(projectSessionDir(slug), LEGACY_FILENAME);
  if (existsSync(livePath)) {
    const dest = join(
      projectSessionArchiveDir(slug),
      `${LEGACY_FILENAME.replace(/\.md$/, "")}-${tsSuffix(legacy.updated_at)}.md`,
    );
    moveFile(livePath, dest);
  }

  return true;
}

/** Read the on-disk legacy CURRENT_SESSION.md if present (fallback for H0 content). */
function readOnDiskLegacy(slug: string): string | null {
  const p = join(projectSessionDir(slug), LEGACY_FILENAME);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/**
 * H1 — RESTED → ARCHIVED supersession (the ONLY steady-state archiving).
 *
 * SKILL.md §3.8 H1. For each `state='rested'` file R, archive R ONLY if a NEWER
 * `state='rested'` file from a DIFFERENT `instance_id` exists — that newer
 * rested file is proof R was consumed (some instance awoke, read R, then
 * rested). This is the Lock-2 "a file is ALWAYS read before it is archived"
 * invariant made a TESTABLE property.
 *
 * For each superseded R: flip DB state → 'archived' (carry R's content +
 * instance_id through) and move `session/instances/<instance_id>.md` →
 * `session/archive/<instance_id>-<rested_at>.md`.
 *
 * An ABANDONED LIVE file is NEVER archived here — it has no superseding rested
 * file (it is `state='live'`, not rested). It is compacted only by H2's 30-day
 * roll. Idempotent: an already-archived R is no longer `state='rested'` so it
 * is not re-selected.
 */
function runH1(slug: string, rows: SessionFileRow[]): string[] {
  const rested = rows.filter((r) => r.state === "rested");
  const archived: string[] = [];

  for (const r of rested) {
    // Find a NEWER rested file from a DIFFERENT instance (proof of consumption).
    const superseded = rested.some(
      (other) =>
        other.instance_id !== r.instance_id &&
        other.updated_at > r.updated_at,
    );
    if (!superseded) {
      // Non-superseded rested → untouched (could still be the live handoff).
      continue;
    }

    const content =
      getSessionFileContent(slug, r.filename) ?? "";

    // Flip DB state → archived, carrying instance_id + content through.
    sessionFileUpsert({
      project: slug,
      filename: r.filename,
      content,
      instance_id: r.instance_id,
      state: "archived",
    });

    // Move the on-disk per-instance file. The filename in the DB is
    // `instances/<id>.md`; the live path mirrors that under session/.
    const basename = `${r.instance_id ?? "unknown"}-${tsSuffix(r.updated_at)}.md`;
    const livePath = join(
      projectSessionInstancesDir(slug),
      `${r.instance_id ?? "unknown"}.md`,
    );
    const dest = join(projectSessionArchiveDir(slug), basename);
    if (existsSync(livePath)) {
      moveFile(livePath, dest);
    }
    archived.push(basename);
  }

  return archived;
}

/**
 * Parse a timestamp suffix for an archive filename from a DB `updated_at`.
 * Normalises `2026-06-01 12:00:00` → `2026-06-01T120000` (filesystem-safe,
 * mirroring H1's `<rested_at>` convention). A bare date passes through.
 */
function tsSuffix(updatedAt: string): string {
  return updatedAt.trim().replace(" ", "T").replace(/:/g, "");
}

/** Month bucket (`YYYY-MM`) for an individual archive file's timestamp. */
function monthOf(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Derive an individual archive file's timestamp — used ONLY for month-digest
 * BUCKETING (which `<YYYY-MM>.md` a rolled file lands in), NOT for the retention
 * age gate. Per session_protocol.md §1 the `<rested_at>` filename suffix exists
 * to prevent collision when one instance rests repeatedly AND to bucket a rolled
 * file under its calendar month — so bucketing prefers the suffix. Age/retention
 * is a SEPARATE clock (see {@link archiveEntryMtimeMs}).
 *
 * Prefer the `<rested_at>` suffix embedded in the filename (`<id>-<ts>.md` or
 * `CURRENT_SESSION-<ts>.md`), else fall back to the file's mtime. The suffix is
 * the `YYYY-MM-DDTHHMMSS` shape tsSuffix writes; parse it back to a Date.
 */
function fileTimestamp(archiveDir: string, filename: string): Date {
  // Try the `-YYYY-MM-DDThhmmss.md` suffix first.
  const m = filename.match(/-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})\.md$/);
  if (m) {
    const [, day, hh, mm, ss] = m;
    const iso = `${day}T${hh}:${mm}:${ss}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  // Try a bare `-YYYY-MM-DD.md` suffix.
  const md = filename.match(/-(\d{4}-\d{2}-\d{2})\.md$/);
  if (md) {
    const d = new Date(`${md[1]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  // Fall back to the on-disk mtime.
  return statSync(join(archiveDir, filename)).mtime;
}

/**
 * The RETENTION age key for an individual archive file: its on-disk mtime —
 * the file's last-write time. H0/H1 move a file in via renameSync (same
 * filesystem — both under `session/` — so the mtime is preserved), meaning
 * mtime tracks the session's rest/write time, NOT a fresh archival stamp.
 * Retention ("the last 30 days of archived files are kept individually",
 * session_protocol.md §5) keys on this mtime; the `<rested_at>` filename SUFFIX
 * is used ONLY for month-digest bucketing (fileTimestamp), never the age gate.
 *
 * Why this matters (the TD-299 bug): keying H2's age gate on the SUFFIX folded a
 * just-written archive file into its month digest in the SAME sweep whenever the
 * suffix was >30 days old — even though the file itself had only just been
 * written (a recently-active scratchpad archived under an old rest-timestamp).
 * Keying on mtime keeps such a recently-written file for its retention window.
 * (A genuinely dormant session — old mtime AND old suffix — can still roll in
 * the same sweep; that is harmless: it lands in its correct rest-month digest,
 * no data loss. Retention measured strictly from ARCHIVAL would need an explicit
 * utimesSync stamp on the moved file — deferred.) H3 oldest-first ordering keys
 * off mtime too.
 */
function archiveEntryMtimeMs(archiveDir: string, filename: string): number {
  return statSync(join(archiveDir, filename)).mtimeMs;
}

/** Is `name` an individual archive file (NOT a YYYY-MM.md month digest)? */
function isIndividualArchiveFile(name: string): boolean {
  if (!name.endsWith(".md")) return false;
  // A month digest is exactly `YYYY-MM.md` — exclude it (never re-rolled).
  if (/^\d{4}-\d{2}\.md$/.test(name)) return false;
  return true;
}

/**
 * Roll a single individual archive file into its month digest, crash-robustly.
 *
 * SKILL.md §3.8 H2 per-file mechanism:
 *   1. Header-presence GUARD (idempotency): if `<YYYY-MM>.md` already contains a
 *      `## <filename>` header line, the file was rolled by an earlier crashed
 *      sweep — SKIP the append (do NOT duplicate), then still delete the
 *      individual file so a re-run converges.
 *   2. Otherwise append `\n\n## <filename>\n<content>` to `<YYYY-MM>.md`.
 *   3. After a SUCCESSFUL append, delete the now-rolled individual file
 *      (append-then-delete = crash-robust: a crash between two files leaves
 *      earlier files rolled, later files untouched; a crash before THIS delete
 *      leaves the header present → next run's guard skips re-append).
 *
 * Returns true when the individual file was folded (append or guard-skip both
 * count — both end with the file gone and the digest carrying it exactly once).
 */
function rollFileIntoDigest(archiveDir: string, filename: string): void {
  const ts = fileTimestamp(archiveDir, filename);
  const digestName = `${monthOf(ts)}.md`;
  const digestPath = join(archiveDir, digestName);
  const individualPath = join(archiveDir, filename);
  const header = `## ${filename}`;

  // Header-presence guard — idempotency. A digest already carrying this header
  // means a prior (crashed) sweep appended it but may not have deleted the
  // individual file. Skip the append; fall through to the delete to converge.
  let headerPresent = false;
  if (existsSync(digestPath)) {
    const digest = readFileSync(digestPath, "utf-8");
    // Match the header as a whole line to avoid a substring false-positive.
    headerPresent = digest
      .split("\n")
      .some((line) => line === header);
  }

  if (!headerPresent) {
    const content = readFileSync(individualPath, "utf-8");
    const block = `\n\n${header}\n${content}`;
    if (existsSync(digestPath)) {
      appendFileSync(digestPath, block, "utf-8");
    } else {
      // First file for this month — seed the digest (no leading blank lines).
      writeFileSync(digestPath, `${header}\n${content}`, "utf-8");
    }
  }

  // Delete the individual file (append succeeded OR guard found it already
  // present). Concatenation, never content deletion of the digest.
  rmSync(individualPath, { force: true });
}

/**
 * H2 — 30-day digest roll. SKILL.md §3.8 H2.
 *
 * Enumerate the INDIVIDUAL files in `session/archive/*.md` (NOT the `YYYY-MM.md`
 * digests). Roll any that have SAT IN THE ARCHIVE longer than `rollDays` (its
 * mtime = archival time, see {@link archiveEntryMtimeMs}) into its month digest
 * via {@link rollFileIntoDigest}. The digest a file lands in is still bucketed by
 * its `<rested_at>` SUFFIX (fileTimestamp) — only the age GATE keys off mtime, so
 * a session archived today survives its retention window even if its rest event
 * was long ago (TD-299). Returns the count rolled.
 */
function runH2(archiveDir: string, rollDays: number): number {
  if (!existsSync(archiveDir)) return 0;
  const now = Date.now();
  const cutoffMs = rollDays * 24 * 60 * 60 * 1000;

  const individual = readdirSync(archiveDir).filter(isIndividualArchiveFile);
  let rolled = 0;
  for (const name of individual) {
    if (now - archiveEntryMtimeMs(archiveDir, name) > cutoffMs) {
      rollFileIntoDigest(archiveDir, name);
      rolled += 1;
    }
  }
  return rolled;
}

/**
 * H3 — 150-file ceiling (burst safety valve). SKILL.md §3.8 H3.
 *
 * After H2, if `session/archive/` still holds more than `ceiling` INDIVIDUAL
 * files (a burst that out-paced the 30-day window), roll the OLDEST individual
 * files into their month digests — same header-guard mechanism as H2 — until
 * the individual-file count is at or below `ceiling`. Returns the count rolled.
 */
function runH3(archiveDir: string, ceiling: number): number {
  if (!existsSync(archiveDir)) return 0;

  let individual = readdirSync(archiveDir).filter(isIndividualArchiveFile);
  if (individual.length <= ceiling) return 0;

  // Sort oldest-first (by ARCHIVAL mtime, the same retention clock H2 uses) so
  // we roll the files that have sat longest until we are at/under the ceiling.
  const withTs = individual.map((name) => ({
    name,
    ts: archiveEntryMtimeMs(archiveDir, name),
  }));
  withTs.sort((a, b) => a.ts - b.ts);

  let rolled = 0;
  let remaining = individual.length;
  for (const { name } of withTs) {
    if (remaining <= ceiling) break;
    rollFileIntoDigest(archiveDir, name);
    rolled += 1;
    remaining -= 1;
  }
  return rolled;
}

/**
 * Run the housekeeping sweep. Degrades (exit 0) when the brain DB is absent —
 * a fresh start has no session files to sweep (SKILL.md §3.8 "skip silently;
 * do NOT block session start").
 */
export function runHousekeeping(opts: HousekeepingOptions): number {
  const slug = opts.project ?? basenameOfCwd();
  const rollDays = opts.rollDays ?? DEFAULT_ROLL_DAYS;
  const ceiling = opts.ceiling ?? DEFAULT_CEILING;
  const json = opts.json !== false;

  const caps = detectCapabilities();
  if (!caps.brain_db) {
    const digest: HousekeepingDigest = {
      degraded: true,
      h0_legacy_retired: false,
      h1_archived: [],
      h2_rolled: 0,
      h3_ceiling_rolled: 0,
      noop: true,
    };
    if (json) process.stdout.write(JSON.stringify(digest) + "\n");
    return 0;
  }

  // One list call feeds H0 + H1 (the rows already gathered in §2; we re-list
  // here because housekeeping is a separate process — the cost is one query).
  const rows: SessionFileRow[] = listSessionFiles(slug);
  const archiveDir = projectSessionArchiveDir(slug);

  const h0 = runH0(slug, rows);
  // Re-list is NOT needed between H0 and H1: H0 only touches the legacy
  // NULL-instance row (never a rested per-instance file), so the rested set
  // H1 scans is unaffected by H0's flip.
  const h1 = runH1(slug, rows);
  const h2 = runH2(archiveDir, rollDays);
  const h3 = runH3(archiveDir, ceiling);

  const noop = !h0 && h1.length === 0 && h2 === 0 && h3 === 0;

  const digest: HousekeepingDigest = {
    degraded: false,
    h0_legacy_retired: h0,
    h1_archived: h1,
    h2_rolled: h2,
    h3_ceiling_rolled: h3,
    noop,
  };
  if (json) process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}
