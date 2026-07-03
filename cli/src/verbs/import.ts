/**
 * `igris import <bundle>` — the project-handoff CONSUMER (FR-230).
 *
 * The hard half of the handoff pair: it writes to the brain DB from an
 * UNTRUSTED bundle, and the whole point of the brief is that the existing sync
 * merge path (silent timestamp LWW, no conflict detection, no provenance) is
 * UNSAFE for cross-owner data. So this verb:
 *
 *   unpack → checksum-verify → reject executable-surface/unknown stores →
 *   idempotency short-circuit → ancestor-based classify (NOT timestamp LWW) →
 *   preview → (dry-run stop | confirm | explicit policy) → apply in ONE txn →
 *   deserialize context docs → write the CLI-local ledger → print the digest.
 *
 * A corrupt / tampered / checksum-mismatch bundle, or a missing brain DB, is a
 * HARD failure (typed error + non-zero exit) with ZERO DB writes. Verification
 * runs BEFORE anything touches the DB.
 *
 * Channel: LOCAL — better-sqlite3 writes via `brain-db.ts` + raw context-doc
 * file writes to `projectContextDir(slug)`. No network. The ancestor / idempotency
 * / provenance ledger is CLI-local under `projectImportsDir(slug)` (D1 — the
 * brain schema can't hold provenance and in-row stamping corrupts round-trip
 * hashes).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { detectCapabilities } from "../lib/detect.js";
import {
  classifyImport,
  applyImport,
  importStoreConfig,
  importDecisionKey,
  lookupLocalRow,
  IMPORTABLE_STORES,
  ImportUnsupportedStoreError,
  type ImportStoreInput,
} from "../lib/brain-db.js";
import {
  readAncestorIndex,
  ancestorHash,
  bundleAlreadyApplied,
  recordImport,
  backupContextDoc,
} from "../lib/import-ledger.js";
import { unpackBundle, TarballError } from "../lib/tarball.js";
import { projectContextDir } from "../lib/paths.js";
import { error as logError } from "../lib/log.js";
import type {
  ExportManifest,
  ImportAncestorUpdate,
  ImportClassification,
  ImportContextDocPlan,
  ImportDigest,
  ImportLedgerRecord,
  ImportOptions,
  ImportPlan,
  OnConflictPolicy,
} from "../types.js";

/** Raised when the import cannot proceed (hard failures; the verb exits non-zero). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

const POLICIES: OnConflictPolicy[] = ["ask", "theirs", "mine", "newer"];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Recursively collect file paths under `dir`, relative + posix, sorted. */
function walkFilesRelative(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) visit(childAbs);
      else if (entry.isFile()) out.push(relative(dir, childAbs).split(sep).join("/"));
    }
  };
  visit(dir);
  return out.sort();
}

/**
 * Recompute the payload checksum over the extracted files EXCLUDING
 * `manifest.json`, reproducing `export.ts` `payloadChecksum` EXACTLY: sha256
 * over the sorted `(path, \0, content, \0)` pairs. Integrity only, NOT
 * authenticity — the bundle stays untrusted data throughout.
 */
function computePayloadChecksum(destDir: string): string {
  const hash = createHash("sha256");
  for (const rel of walkFilesRelative(destDir)) {
    if (rel === "manifest.json") continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(destDir, rel), "utf-8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Rewrite a row's scope column to the TARGET slug in place (`--as`, Phase 4). */
function rewriteScope(
  store: string,
  rows: Record<string, unknown>[],
  targetSlug: string,
): void {
  for (const row of rows) {
    if (
      store === "brief_status" ||
      store === "brief_files" ||
      store === "learnings" ||
      store === "errors"
    ) {
      row.project = targetSlug;
    } else if (store === "goals") {
      row.project_slug = targetSlug;
    }
    // entity_edges / concept_edges / graph_nodes key on brief_id / concept ids,
    // not slugs — left as-is (documented `--as` edge case, plan Phase 4).
  }
}

/** Classify one context doc via the same ancestor-based truth table as rows (D5). */
function classifyContextDocs(
  destDir: string,
  targetSlug: string,
  hashes: Record<string, string>,
  ancestor: (store: string, key: string) => string | undefined,
): ImportContextDocPlan[] {
  const plans: ImportContextDocPlan[] = [];
  for (const filename of Object.keys(hashes).sort()) {
    const bundlePath = join(destDir, "context", filename);
    if (!existsSync(bundlePath)) continue;
    const content = readFileSync(bundlePath, "utf-8");
    const H_b = sha256(content);
    const localPath = join(projectContextDir(targetSlug), filename);
    const H_l = existsSync(localPath)
      ? sha256(readFileSync(localPath, "utf-8"))
      : undefined;
    const A = ancestor("context_docs", filename);

    let classification: ImportContextDocPlan["classification"];
    if (H_l === undefined) classification = "NEW";
    else if (H_l === H_b) classification = "UNCHANGED";
    else if (A !== undefined && H_l === A && H_b !== A) classification = "INCOMING";
    else if (A !== undefined && H_b === A && H_l !== A) classification = "LOCAL_ONLY";
    else classification = "CONFLICT";

    plans.push({ filename, classification, bundleHash: H_b, localHash: H_l, ancestorHash: A, content });
  }
  return plans;
}

/** Resolve a CONFLICT row deterministically (theirs/mine/newer). */
function resolveRowConflict(
  policy: OnConflictPolicy,
  store: string,
  row: Record<string, unknown>,
): "theirs" | "mine" {
  if (policy === "theirs") return "theirs";
  if (policy === "mine") return "mine";
  // newer: opt-in LWW by the store's timestampCol, for CONFLICT rows ONLY.
  const config = importStoreConfig(store);
  const timestampCol = config.timestampCol ?? "updated_at";
  const bundleTs = String(row[timestampCol] ?? "");
  const local = lookupLocalRow(config, config.syncKey.map((k) => row[k]));
  const localTs = String(local?.[timestampCol] ?? "");
  return bundleTs > localTs ? "theirs" : "mine";
}

/** TTY confirm — reads from stdin, writes the prompt to stderr (stdout stays JSON). */
async function confirmPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** TTY per-conflict prompt (default keep-mine). */
async function conflictPrompt(label: string): Promise<"theirs" | "mine"> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (
      await rl.question(`${label} — [t]heirs / [m]ine (keep local)? [m] `)
    )
      .trim()
      .toLowerCase();
    return answer === "t" || answer === "theirs" ? "theirs" : "mine";
  } finally {
    rl.close();
  }
}

function emptyClassCounts(): Record<ImportClassification, number> {
  return { NEW: 0, UNCHANGED: 0, INCOMING: 0, LOCAL_ONLY: 0, CONFLICT: 0 };
}

function perStoreCounts(
  plan: ImportPlan,
): Record<string, Record<ImportClassification, number>> {
  const out: Record<string, Record<ImportClassification, number>> = {};
  for (const sp of plan.stores) out[sp.store] = sp.counts;
  return out;
}

const REEMBED_HINT =
  "imported learnings/briefs carry NULL embeddings (embeddings are never " +
  "exported) — the next brain interaction re-derives them via the FR-220 " +
  "post-merge NULL-scan / igris_memory_backfill_embeddings.";

const SCOPE_NOTE =
  "v1 scope: point-in-time snapshot hand-off/hand-back. Continuous " +
  "co-management = 'both point at one VPS brain', not this feature.";

/** Print a compact human preview to stderr (stdout is reserved for the JSON digest). */
function printPreview(
  bundle: string,
  targetSlug: string,
  plan: ImportPlan,
  ctxPlans: ImportContextDocPlan[],
): void {
  const t = plan.totals;
  process.stderr.write(
    `import: ${bundle} → slug '${targetSlug}'\n` +
      `  rows: ${t.NEW} new, ${t.UNCHANGED} unchanged, ${t.INCOMING} incoming, ` +
      `${t.LOCAL_ONLY} local-only, ${t.CONFLICT} conflict\n`,
  );
  for (const sp of plan.stores) {
    const c = sp.counts;
    process.stderr.write(
      `    ${sp.store}: ${c.NEW}N ${c.UNCHANGED}U ${c.INCOMING}I ${c.LOCAL_ONLY}L ${c.CONFLICT}C\n`,
    );
  }
  if (ctxPlans.length > 0) {
    const cn = ctxPlans.filter((d) => d.classification === "NEW").length;
    const cu = ctxPlans.filter((d) => d.classification === "UNCHANGED" || d.classification === "LOCAL_ONLY").length;
    const cc = ctxPlans.filter((d) => d.classification === "CONFLICT").length;
    const ci = ctxPlans.filter((d) => d.classification === "INCOMING").length;
    process.stderr.write(`  context docs: ${cn} new, ${cu} unchanged, ${ci} incoming, ${cc} conflict\n`);
  }
}

/**
 * Run the import verb. Returns the process exit code (0 success/dry-run/no-op,
 * 1 hard failure, 2 usage error). The JSON digest prints to stdout on success;
 * progress/preview/warnings go to stderr so stdout stays a clean digest.
 */
export async function runImport(opts: ImportOptions): Promise<number> {
  const bundle = opts.bundle;
  if (!bundle || bundle.length === 0) {
    logError("import: a <bundle> path is required");
    return 2;
  }

  const policy = opts.onConflict ?? "ask";
  if (!POLICIES.includes(policy)) {
    logError(`import: --on-conflict value '${policy}' is not one of ${POLICIES.join(" | ")}`);
    return 2;
  }

  // HARD failure on a missing brain DB (like export): nothing to import into.
  const caps = detectCapabilities();
  if (!caps.brain_db) {
    logError(
      `import: brain DB not found at ${caps.brain_root}/memory/knowledge.db — ` +
        "nothing to import into (run 'igris init' first).",
    );
    return 1;
  }

  let staged: string | null = null;
  try {
    // 1. Unpack the bundle to a temp dir (zip-slip-safe, no strip, no allowlist).
    staged = mkdtempSync(join(tmpdir(), "igris-import-"));
    await unpackBundle(bundle, staged);

    // 2. Parse + validate the manifest.
    const manifestPath = join(staged, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new ImportError("bundle has no manifest.json (not an .igris-pack)");
    }
    let manifest: ExportManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExportManifest;
    } catch (err) {
      throw new ImportError(
        `bundle manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (manifest.format !== "igris-pack") {
      throw new ImportError(`unknown bundle format '${String(manifest.format)}' (expected 'igris-pack')`);
    }
    if (manifest.format_version !== 1) {
      throw new ImportError(
        `unsupported bundle format_version ${String(manifest.format_version)} (this CLI reads version 1)`,
      );
    }
    if (typeof manifest.checksum !== "string" || manifest.checksum.length === 0) {
      throw new ImportError("bundle manifest is missing a checksum");
    }
    if (manifest.project === undefined || typeof manifest.project.slug !== "string") {
      throw new ImportError("bundle manifest is missing project.slug");
    }
    const stores = manifest.stores ?? {};

    // 3. Verify the payload checksum (integrity) — BEFORE any DB read/write.
    const actualChecksum = computePayloadChecksum(staged);
    if (actualChecksum !== manifest.checksum) {
      throw new ImportError(
        `bundle checksum mismatch: manifest says ${manifest.checksum.slice(0, 12)}…, ` +
          `recomputed ${actualChecksum.slice(0, 12)}… — the bundle is corrupt or tampered ` +
          "(zero DB writes).",
      );
    }

    // 4. Reject unknown / executable-surface stores (AC9) — BEFORE any DB write.
    for (const storeName of Object.keys(stores)) {
      if (!IMPORTABLE_STORES.has(storeName)) {
        throw new ImportError(
          `bundle declares a non-importable store '${storeName}' ` +
            "(unknown or executable-surface: skills/agents/hooks/…) — refusing to import (zero DB writes).",
        );
      }
    }

    const targetSlug = opts.as ?? manifest.project.slug;
    const sourceFingerprint = `${manifest.project.slug}@${manifest.created_at}#${manifest.checksum.slice(0, 12)}`;

    // 5. Idempotency short-circuit (AC5): an already-applied bundle is a no-op.
    if (!opts.dryRun && bundleAlreadyApplied(targetSlug, manifest.checksum)) {
      const digest = makeDigest({
        bundle,
        targetSlug,
        policy,
        dryRun: false,
        alreadyImported: true,
        applied: "none",
        totals: emptyClassCounts(),
        perStore: {},
        conflicts: [],
        contextDocs: { new: 0, unchanged: 0, conflict: 0, written: [], backed_up: [] },
        sourceFingerprint,
      });
      process.stderr.write(`import: bundle already applied to '${targetSlug}' — no-op.\n`);
      emitDigest(opts, digest);
      return 0;
    }

    // 6. Read the row stores, rewrite scope, build classify inputs.
    const ledgerIndex = readAncestorIndex(targetSlug);
    const ancestor = (store: string, key: string): string | undefined =>
      ancestorHash(ledgerIndex, store, key);

    const storeInputs: ImportStoreInput[] = [];
    for (const [storeName, descriptor] of Object.entries(stores)) {
      if (storeName === "context_docs") continue;
      const file = descriptor.file ?? `data/${storeName}.json`;
      const dataPath = join(staged, file);
      let rows: Record<string, unknown>[] = [];
      if (existsSync(dataPath)) {
        try {
          const parsed = JSON.parse(readFileSync(dataPath, "utf-8"));
          rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
        } catch (err) {
          throw new ImportError(
            `bundle data file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      rewriteScope(storeName, rows, targetSlug);
      storeInputs.push({ store: storeName, rows, contentHashes: descriptor.content_hashes });
    }

    // 7. Classify rows (NO writes) + context docs (D5).
    const plan = classifyImport(storeInputs, { ancestor });
    const ctxDescriptor = stores.context_docs;
    const ctxPlans = classifyContextDocs(
      staged,
      targetSlug,
      ctxDescriptor?.hashes ?? {},
      ancestor,
    );

    // 8. Dry-run: print the preview, write NOTHING, exit 0 (AC1).
    if (opts.dryRun) {
      printPreview(bundle, targetSlug, plan, ctxPlans);
      const digest = makeDigest({
        bundle,
        targetSlug,
        policy,
        dryRun: true,
        alreadyImported: false,
        applied: "none",
        totals: plan.totals,
        perStore: perStoreCounts(plan),
        conflicts: [],
        contextDocs: ctxDocDigest(ctxPlans, [], []),
        sourceFingerprint,
      });
      emitDigest(opts, digest);
      return 0;
    }

    // 9. Gate the apply on the conflict policy.
    const conflictRows = plan.stores.flatMap((sp) =>
      sp.rows.filter((r) => r.classification === "CONFLICT").map((r) => ({ store: sp.store, row: r })),
    );
    const conflictDocs = ctxPlans.filter((d) => d.classification === "CONFLICT");
    const conflictDecisions = new Map<string, "theirs" | "mine">();
    const docDecisions = new Map<string, "theirs" | "mine">();

    if (policy === "ask") {
      const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
      if (!interactive) {
        // Non-TTY: cannot confirm → print the preview, apply NOTHING, exit 0.
        printPreview(bundle, targetSlug, plan, ctxPlans);
        process.stderr.write(
          "import: --on-conflict 'ask' needs a TTY to confirm; nothing applied. " +
            "Re-run with --dry-run to inspect, or pass --on-conflict theirs|mine|newer.\n",
        );
        const digest = makeDigest({
          bundle,
          targetSlug,
          policy,
          dryRun: false,
          alreadyImported: false,
          applied: "none",
          totals: plan.totals,
          perStore: perStoreCounts(plan),
          conflicts: [],
          contextDocs: ctxDocDigest(ctxPlans, [], []),
          sourceFingerprint,
        });
        emitDigest(opts, digest);
        return 0;
      }
      // TTY: global confirm, then per-conflict prompts.
      printPreview(bundle, targetSlug, plan, ctxPlans);
      const proceed = await confirmPrompt(
        `Apply ${plan.totals.NEW} inserts / ${plan.totals.INCOMING} updates` +
          (conflictRows.length + conflictDocs.length > 0
            ? ` and resolve ${conflictRows.length + conflictDocs.length} conflict(s)`
            : "") +
          "? [y/N] ",
      );
      if (!proceed) {
        process.stderr.write("import: aborted — nothing applied.\n");
        const digest = makeDigest({
          bundle,
          targetSlug,
          policy,
          dryRun: false,
          alreadyImported: false,
          applied: "none",
          totals: plan.totals,
          perStore: perStoreCounts(plan),
          conflicts: [],
          contextDocs: ctxDocDigest(ctxPlans, [], []),
          sourceFingerprint,
        });
        emitDigest(opts, digest);
        return 0;
      }
      for (const c of conflictRows) {
        conflictDecisions.set(
          importDecisionKey(c.store, c.row.key),
          await conflictPrompt(`conflict: ${c.store} ${c.row.key}`),
        );
      }
      for (const d of conflictDocs) {
        docDecisions.set(d.filename, await conflictPrompt(`conflict: context/${d.filename}`));
      }
    } else {
      // Deterministic policy — resolve conflicts without prompting.
      for (const c of conflictRows) {
        conflictDecisions.set(
          importDecisionKey(c.store, c.row.key),
          resolveRowConflict(policy, c.store, c.row.row),
        );
      }
      for (const d of conflictDocs) {
        // Context docs have no reliable timestamp: theirs wins for 'theirs',
        // everything else keeps mine (conservative, never clobbers a local edit).
        docDecisions.set(d.filename, policy === "theirs" ? "theirs" : "mine");
      }
    }

    // 10. Apply the row plan in ONE transaction (all-or-nothing). The project is
    //     auto-registered inside the same txn so the brief_status FK is satisfied
    //     on a fresh-machine import (C2).
    const projectPath = resolve(opts.projectPath ?? process.cwd());
    const result = applyImport(plan, {
      conflictDecisions,
      targetSlug,
      projectPath,
    });
    if (result.projectRegistered) {
      process.stderr.write(`import: registered project '${targetSlug}' at ${projectPath}\n`);
    }

    // 11. Deserialize context docs (backup before overwrite; D5).
    const written: string[] = [];
    const backedUp: string[] = [];
    const ctxAncestorUpdates: ImportAncestorUpdate[] = [];
    for (const d of ctxPlans) {
      const writeIt =
        d.classification === "NEW" ||
        d.classification === "INCOMING" ||
        (d.classification === "CONFLICT" && docDecisions.get(d.filename) === "theirs");
      if (writeIt) {
        const dir = projectContextDir(targetSlug);
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, d.filename);
        if (existsSync(dest)) {
          backupContextDoc(targetSlug, manifest.checksum, d.filename, readFileSync(dest, "utf-8"));
          backedUp.push(d.filename);
        }
        writeFileSync(dest, d.content);
        written.push(d.filename);
        ctxAncestorUpdates.push({ store: "context_docs", key: d.filename, hash: d.bundleHash });
      } else if (d.classification === "UNCHANGED") {
        ctxAncestorUpdates.push({ store: "context_docs", key: d.filename, hash: d.bundleHash });
      }
    }

    // 12. Inspect per-row failures (C1). A partial apply is NEVER exit 0.
    const totalFailed = Object.values(result.perStore).reduce(
      (sum, r) => sum + r.failed,
      0,
    );
    const clean = totalFailed === 0;

    // 13. Record the import in the CLI-local ledger. Provenance/ancestor for the
    //     rows that LANDED is always recorded; the `clean` flag gates the
    //     applied-bundle idempotency marker so a partial apply can be retried (C3).
    const record: ImportLedgerRecord = {
      checksum: manifest.checksum,
      source_fingerprint: sourceFingerprint,
      imported_at: new Date().toISOString(),
      as_slug: targetSlug,
      rows: [...result.ancestorUpdates, ...ctxAncestorUpdates].map((a) => ({
        store: a.store,
        key: a.key,
        hash: a.hash,
      })),
      clean,
    };
    recordImport(targetSlug, record);

    // 14. Surface failures LOUDLY (capped sample) + digest.
    if (!clean) {
      const sample: string[] = [];
      for (const [store, r] of Object.entries(result.perStore)) {
        for (const fail of r.failures ?? []) {
          sample.push(`  ${store}:${fail.key} → ${fail.error}`);
        }
      }
      const shown = sample.slice(0, 10);
      const extra = sample.length - shown.length;
      process.stderr.write(
        `import: PARTIAL APPLY — ${totalFailed} row(s) failed (NOT marked applied; ` +
          `re-import after fixing the cause to retry):\n${shown.join("\n")}\n` +
          (extra > 0 ? `  +${extra} more\n` : ""),
      );
    }

    const digest = makeDigest({
      bundle,
      targetSlug,
      policy,
      dryRun: false,
      alreadyImported: false,
      applied: clean ? "full" : "partial",
      failed: totalFailed,
      registeredProject: result.projectRegistered ? targetSlug : null,
      totals: plan.totals,
      perStore: perStoreCounts(plan),
      conflicts: result.conflicts,
      contextDocs: ctxDocDigest(ctxPlans, written, backedUp),
      sourceFingerprint,
      result: result.perStore,
    });
    if (clean) {
      process.stderr.write(`import: applied to '${targetSlug}'. ${REEMBED_HINT}\n${SCOPE_NOTE}\n`);
    }
    emitDigest(opts, digest);
    // Distinct non-zero "partial" code (3) — never exit 0 on a partial apply (C1).
    return clean ? 0 : 3;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      err instanceof ImportError ||
      err instanceof TarballError ||
      err instanceof ImportUnsupportedStoreError
    ) {
      logError(`import: ${msg}`);
    } else {
      logError(`import failed: ${msg}`);
    }
    return 1;
  } finally {
    if (staged !== null && existsSync(staged)) {
      try {
        rmSync(staged, { recursive: true, force: true });
      } catch {
        process.stderr.write(`warn: import could not clean staging dir ${staged}\n`);
      }
    }
  }
}

// --- digest assembly -------------------------------------------------------

interface MakeDigestArgs {
  bundle: string;
  targetSlug: string;
  policy: OnConflictPolicy;
  dryRun: boolean;
  alreadyImported: boolean;
  applied: "full" | "partial" | "none";
  failed?: number;
  registeredProject?: string | null;
  totals: Record<ImportClassification, number>;
  perStore: Record<string, Record<ImportClassification, number>>;
  conflicts: ImportDigest["conflicts"];
  contextDocs: ImportDigest["context_docs"];
  sourceFingerprint: string;
  result?: ImportDigest["result"];
}

function ctxDocDigest(
  ctxPlans: ImportContextDocPlan[],
  written: string[],
  backedUp: string[],
): ImportDigest["context_docs"] {
  return {
    new: ctxPlans.filter((d) => d.classification === "NEW").length,
    unchanged: ctxPlans.filter(
      (d) => d.classification === "UNCHANGED" || d.classification === "LOCAL_ONLY",
    ).length,
    conflict: ctxPlans.filter((d) => d.classification === "CONFLICT").length,
    written,
    backed_up: backedUp,
  };
}

function makeDigest(args: MakeDigestArgs): ImportDigest {
  return {
    bundle: args.bundle,
    target_slug: args.targetSlug,
    policy: args.policy,
    dry_run: args.dryRun,
    already_imported: args.alreadyImported,
    applied: args.applied,
    failed: args.failed ?? 0,
    registered_project: args.registeredProject ?? null,
    totals: args.totals,
    per_store: args.perStore,
    result: args.result,
    conflicts: args.conflicts,
    context_docs: args.contextDocs,
    source_fingerprint: args.sourceFingerprint,
    reembed_hint: REEMBED_HINT,
    scope_note: SCOPE_NOTE,
  };
}

function emitDigest(opts: ImportOptions, digest: ImportDigest): void {
  if (opts.json !== false) {
    process.stdout.write(JSON.stringify(digest) + "\n");
  }
}
