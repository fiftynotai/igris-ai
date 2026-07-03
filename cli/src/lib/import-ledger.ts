/**
 * FR-230 — the CLI-LOCAL import ledger (provenance + ancestor + idempotency).
 *
 * The brief wanted imported rows to carry the source fingerprint "in their
 * metadata/JSON blob," but the real brain schema kills that as a uniform
 * mechanism (D1): three of five row stores have NO JSON column, `learnings.
 * provenance` is a CHECK-constrained enum, and stamping provenance INTO a JSON
 * blob mutates content that participates in the content hash — a re-export would
 * then show a FALSE conflict on hand-back. And create-never forbids the CLI
 * adding a brain-owned provenance table.
 *
 * So provenance + the ancestor hash + the applied-bundle set live ENTIRELY in a
 * CLI-local ledger under `~/.igris/projects/{slug}/imports/` (same class of local
 * state as `context/`, `session/`, `plans/`). Pure filesystem, no DB, no
 * brain-schema change. It powers all three AC needs at once:
 *   - AC3 ancestor-based conflict detection (`ancestorHash`),
 *   - AC4 "rows imported from bundle X" (`<checksum>.json` per-bundle record),
 *   - AC5 idempotency (`bundleAlreadyApplied`).
 *
 * Layout under `projectImportsDir(slug)`:
 *   index.json          — `"<store> <key>" → { hash, bundle, fingerprint, imported_at }`
 *                         (the ancestor + provenance index)
 *   <checksum>.json     — the per-bundle record (applied-bundle marker + row list)
 *   <checksum>/backup/  — pre-overwrite context-doc copies (clean undo, learning #208)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { projectImportsDir } from "./paths.js";
import type { ImportLedgerRecord } from "../types.js";

/** One (store,key) ancestor + provenance entry in `index.json`. */
export interface AncestorEntry {
  /** The content hash recorded at the LAST import of this lineage (the ancestor). */
  hash: string;
  /** The bundle checksum that produced this ancestor. */
  bundle: string;
  /** The source-snapshot fingerprint (D2). */
  fingerprint: string;
  imported_at: string;
}

/** The full `(store\0key) → AncestorEntry` ancestor/provenance index. */
export type AncestorIndex = Record<string, AncestorEntry>;

function indexPath(slug: string): string {
  return join(projectImportsDir(slug), "index.json");
}

function bundleRecordPath(slug: string, checksum: string): string {
  return join(projectImportsDir(slug), `${checksum}.json`);
}

/** The composite ledger key for a (store, syncKey-string) pair. */
function ancestorKey(store: string, key: string): string {
  return `${store} ${key}`;
}

/** Read the ancestor/provenance index for a slug ({} when absent or corrupt). */
export function readAncestorIndex(slug: string): AncestorIndex {
  const p = indexPath(slug);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AncestorIndex;
  } catch {
    // A corrupt ledger degrades to "no ancestors" — every differing row then
    // classifies CONFLICT (the conservative, never-silent-clobber direction).
    return {};
  }
}

/** The recorded ancestor hash for (store, key), or undefined on first-ever import. */
export function ancestorHash(
  index: AncestorIndex,
  store: string,
  key: string,
): string | undefined {
  return index[ancestorKey(store, key)]?.hash;
}

/**
 * True when this exact bundle checksum was already applied to this slug CLEANLY
 * (the AC5 idempotency short-circuit). A PARTIAL apply writes the record with
 * `clean:false` (so provenance is kept) but does NOT count as applied (C3) — the
 * corrective re-import must re-classify and land the previously-failed rows. A
 * second, row-level guard (every landed row classifies UNCHANGED on a true
 * re-import) means idempotency still holds even if this ledger file is lost.
 */
export function bundleAlreadyApplied(slug: string, checksum: string): boolean {
  const p = bundleRecordPath(slug, checksum);
  if (!existsSync(p)) return false;
  try {
    const record = JSON.parse(readFileSync(p, "utf-8")) as Partial<ImportLedgerRecord>;
    return record.clean === true;
  } catch {
    // A corrupt record → treat as NOT-applied so the re-import can re-attempt.
    return false;
  }
}

/**
 * Record an import: advance the `(store,key)→hash` ancestor index to each LANDED
 * row's NEW content hash (the ancestor for the NEXT import) and write the
 * per-bundle record (the "rows from bundle X" provenance listing). The record's
 * `clean` flag gates {@link bundleAlreadyApplied}: a partial apply records
 * provenance but is NOT a no-op-on-re-import (C3). Filesystem only.
 */
export function recordImport(slug: string, record: ImportLedgerRecord): void {
  const dir = projectImportsDir(slug);
  mkdirSync(dir, { recursive: true });

  const index = readAncestorIndex(slug);
  for (const r of record.rows) {
    index[ancestorKey(r.store, r.key)] = {
      hash: r.hash,
      bundle: record.checksum,
      fingerprint: record.source_fingerprint,
      imported_at: record.imported_at,
    };
  }
  writeFileSync(indexPath(slug), JSON.stringify(index, null, 2) + "\n");
  writeFileSync(
    bundleRecordPath(slug, record.checksum),
    JSON.stringify(record, null, 2) + "\n",
  );
}

/** The per-bundle context-doc backup dir (`<checksum>/backup/`). */
export function contextDocBackupDir(slug: string, checksum: string): string {
  return join(projectImportsDir(slug), checksum, "backup");
}

/**
 * Back up a context doc's PRIOR content before an overwrite (learning #208:
 * provenance-tag for a clean undo). Returns the backup file path.
 */
export function backupContextDoc(
  slug: string,
  checksum: string,
  filename: string,
  priorContent: string,
): string {
  const dir = contextDocBackupDir(slug, checksum);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, filename);
  writeFileSync(dest, priorContent);
  return dest;
}
