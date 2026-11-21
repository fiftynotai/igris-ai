/**
 * `igris lessons digest|ingest|audit` (TD-496, hidden). Exit codes: digest 0
 * (2 usage); ingest 0, 1 a row failed, 2 bad input, 3 no brain; audit 0, 1
 * problems, 2, 3. `--json` prints one object.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readLessonsAudit, readRoleDigest } from "../lib/brain-db.js";
import { dryRunIngest, parseIngestJsonl, writeIngest } from "../lib/lessons-ingest.js";
import {
  ROLE_DIGEST_DEFAULT_BYTES,
  ROLE_DIGEST_MAX_BYTES,
  ROLE_DIGEST_MIN_BYTES,
  ROLE_TAG_RE,
  parseLedger,
} from "../lib/lessons.js";
import { brainDbPath } from "../lib/paths.js";
import { defaultProjectSlug } from "../lib/project-identity.js";
import type { IngestResult } from "../types.js";

export interface LessonsOptions {
  role?: string;
  project?: string;
  context?: string;
  maxBytes?: string;
  in?: string;
  ledger?: string;
  dryRun?: boolean;
  json?: boolean;
}

function toStdout(s: string): void {
  process.stdout.write(s);
}

function toStderr(s: string): void {
  process.stderr.write(s);
}

function usage(m: string): number {
  toStderr(`lessons: ${m}\n`);
  return 2;
}

function readInput(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function lessonsDigest(o: LessonsOptions): number {
  const role = o.role ?? "";
  if (!ROLE_TAG_RE.test(`role:${role}`)) return usage("digest needs --role <agent> (lowercase, e.g. warden)");
  let maxBytes = ROLE_DIGEST_DEFAULT_BYTES;
  if (o.maxBytes !== undefined) {
    maxBytes = /^\d+$/.test(o.maxBytes) ? Number(o.maxBytes) : NaN;
    if (!(maxBytes >= ROLE_DIGEST_MIN_BYTES && maxBytes <= ROLE_DIGEST_MAX_BYTES)) {
      return usage(`--max-bytes must be an integer in ${ROLE_DIGEST_MIN_BYTES}..${ROLE_DIGEST_MAX_BYTES}`);
    }
  }
  const project = o.project ?? defaultProjectSlug();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(project)) return usage(`bad --project '${project}'`);
  const d = readRoleDigest({ role, project, context: o.context ?? "", maxBytes });
  toStdout(o.json ? JSON.stringify(d) + "\n" : d.markdown);
  return 0;
}

const DRY: IngestResult["status"][] = ["would-store", "would-tag", "already-present", "title-collision", "error"];
const WRITE: IngestResult["status"][] = ["stored", "tagged", "already-present", "title-collision", "error"];

async function lessonsIngest(o: LessonsOptions): Promise<number> {
  if (o.in === undefined) return usage("ingest needs --in <file.jsonl|->");
  if (o.dryRun !== true && o.ledger === undefined) return usage("ingest needs --ledger <path> (or --dry-run)");
  let text: string;
  try {
    text = readInput(o.in);
  } catch (e) {
    return usage(`cannot read --in: ${e instanceof Error ? e.message : String(e)}`);
  }
  const dry = o.dryRun === true;
  const fail = (exit: 2 | 3, reason: string): number => {
    toStderr(`lessons ingest: ${reason}${exit === 3 ? "; nothing written" : ""}\n`);
    if (o.json === true) toStdout(JSON.stringify({ ok: false, dry_run: dry, exit, reason, results: [] }) + "\n");
    return exit;
  };
  const parsed = parseIngestJsonl(text);
  if (!parsed.ok) return fail(2, `--in ${parsed.error}`);
  if (!dry && !existsSync(dirname(resolve(o.ledger as string)))) {
    return fail(2, `ledger directory does not exist: ${dirname(resolve(o.ledger as string))}`);
  }
  const run = dry
    ? await dryRunIngest(parsed.rows)
    : await writeIngest(parsed.rows, { ledgerPath: resolve(o.ledger as string) });
  if (!run.ok) return fail(run.exit, run.reason);
  const shown = (dry ? DRY : WRITE).map((s) => `${s} ${run.results.filter((r) => r.status === s).length}`);
  const v = run.results[0];
  const vec = dry ? `; vector dedup ${v.vector_available ? "on" : `off (${v.vector_reason})`}` : "";
  const summary = `lessons ingest${dry ? " --dry-run" : ""}: ${run.results.length} rows — ${shown.join(", ")}${vec}\n`;
  if (o.json === true) {
    toStdout(JSON.stringify({ ok: true, dry_run: dry, results: run.results }) + "\n");
    toStderr(summary);
  } else {
    toStdout(summary);
    for (const r of run.results) {
      const near = r.nearest ? ` — nearest L-${r.nearest.id} ${r.nearest.similarity.toFixed(2)}${r.nearest.advisory ? " (advisory)" : ""}` : "";
      toStdout(`  line ${r.line} ${r.key} ${r.status}${r.id !== null ? ` L-${r.id}` : ""}${r.error ? ` — ${r.error}` : ""}${near}\n`);
    }
  }
  if (dry) return 0;
  return run.results.some((r) => r.status === "error" || r.status === "title-collision") ? 1 : 0;
}

function lessonsAudit(o: LessonsOptions): number {
  if (o.ledger === undefined) return usage("audit needs --ledger <path>");
  let text: string;
  try {
    text = readInput(o.ledger);
  } catch (e) {
    return usage(`cannot read --ledger: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ledger = parseLedger(text);
  if (!ledger.ok) return usage(ledger.error);
  let a;
  try {
    a = existsSync(brainDbPath()) ? readLessonsAudit(ledger.rows) : null;
  } catch (e) {
    toStderr(`lessons audit: brain read failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
  if (a === null) {
    toStderr(`lessons audit: no readable brain database at ${brainDbPath()}\n`);
    return 3;
  }
  if (o.json === true) {
    toStdout(JSON.stringify(a) + "\n");
  } else {
    toStdout(`lessons audit: ${a.verified} of ${a.keys} ledger keys verified (${a.ledger_rows} rows); ${a.problems.length} problem(s)\n`);
    for (const p of a.problems) toStdout(`  ${p.kind} ${p.key ?? "-"} L-${p.id}: ${p.detail}\n`);
  }
  return a.ok ? 0 : 1;
}

export async function runLessons(action: string, o: LessonsOptions): Promise<number> {
  if (action === "digest") return lessonsDigest(o);
  if (action === "ingest") return lessonsIngest(o);
  if (action === "audit") return lessonsAudit(o);
  return usage(`unknown action '${action}' (digest | ingest | audit)`);
}
