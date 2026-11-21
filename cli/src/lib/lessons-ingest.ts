/**
 * TD-496 `igris lessons ingest`: rows go through the brain gateway (the `sync
 * push` door); lookups use a read-only handle. Idempotent by `amx:` key.
 */

import type Database from "better-sqlite3";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  lastNearestMatchFailure,
  loadNearestMatch,
  loadVendoredEmbeddings,
  openBrainReadonly,
  openBrainReadonlyWithVec,
} from "./brain-bridge.js";
import { bootWriteEngine, shutdownWriteEngine } from "./brain-write-bridge.js";
import { brainDbPath } from "./paths.js";
import {
  AMX_KEY_RE,
  findKeyRow,
  findTitleCollision,
  learningById,
  parseLedger,
  projectRegistered,
  sha256Hex,
  tagTokens,
  type LearningLite,
} from "./lessons.js";
import type { IngestResult, IngestRow } from "../types.js";

/** memory/index.ts:75-157 minus review_status and edges. */
export const INGEST_STORE_KEYS: readonly string[] = Object.freeze([
  "project", "category", "title", "content", "tags", "tech_stack", "source_brief", "scope", "provenance", "source_extractor",
]);
export const INGEST_TOOLS = Object.freeze(["igris_memory_store", "igris_memory_update"] as const);
const REQUIRED = ["project", "category", "title", "content"];

export interface NearestMatcher {
  available: boolean;
  reason: string | null;
  match(title: string, content: string): Promise<{ id: number; similarity: number } | null>;
  close?(): void | Promise<void>;
}

export type IngestRun = { ok: true; results: IngestResult[] } | { ok: false; exit: 2 | 3; reason: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkRow(o: Record<string, unknown>, line: number): IngestRow {
  const key = typeof o.key === "string" ? o.key : "";
  const op = o.op as IngestRow["op"];
  const row: IngestRow = { line, key, op, args: null, id: null, tags: null, invalid: null };
  const fields = op === "store" ? ["key", "op", "args"] : ["key", "op", "id", "tags"];
  const extra = Object.keys(o).filter((k) => !fields.includes(k));
  const fail = (why: string): IngestRow => ({ ...row, invalid: why });
  if (!AMX_KEY_RE.test(key)) return fail(`key must be amx:<12 hex>, got '${key}'`);
  if (extra.length > 0) return fail(`unexpected field(s): ${extra.join(", ")}`);
  if (op === "add_tags") {
    if (!Number.isInteger(o.id) || (o.id as number) <= 0) return fail("id must be a positive integer");
    if (typeof o.tags !== "string" || !tagTokens(o.tags).includes(key)) return fail(`key ${key} not in tags`);
    return { ...row, id: o.id as number, tags: o.tags };
  }
  if (!isObj(o.args)) return fail("args must be an object");
  const args = o.args;
  const outside = Object.keys(args).filter((k) => !INGEST_STORE_KEYS.includes(k));
  if (outside.length > 0) return fail(`args key(s) outside the allowlist: ${outside.join(", ")}`);
  const notString = Object.keys(args).filter((k) => typeof args[k] !== "string");
  if (notString.length > 0) return fail(`args must be strings: ${notString.join(", ")}`);
  const missing = REQUIRED.filter((k) => !args[k]);
  if (missing.length > 0) return fail(`missing required argument(s): ${missing.join(", ")}`);
  if (!tagTokens(args.tags as string | undefined).includes(key)) return fail(`key ${key} not in args.tags`);
  return { ...row, args };
}

/** Bad JSON, unknown op, duplicate key or no rows fail the file; the rest fail per row. */
export function parseIngestJsonl(text: string): { ok: true; rows: IngestRow[] } | { ok: false; error: string } {
  const rows: IngestRow[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      return { ok: false, error: `line ${i + 1}: not JSON` };
    }
    if (!isObj(o)) return { ok: false, error: `line ${i + 1}: not an object` };
    if (o.op !== "store" && o.op !== "add_tags") return { ok: false, error: `line ${i + 1}: unknown op '${String(o.op)}'` };
    if (typeof o.key === "string" && o.key !== "") {
      if (seen.has(o.key)) return { ok: false, error: `line ${i + 1}: duplicate key ${o.key}` };
      seen.add(o.key);
    }
    rows.push(checkRow(o, i + 1));
  }
  return rows.length === 0 ? { ok: false, error: "no rows" } : { ok: true, rows };
}

function blank(row: IngestRow): IngestResult {
  return {
    line: row.line, key: row.key, op: row.op, status: "error", id: null, error: row.invalid, key_present: false,
    collision: null, project_registered: null, vector_available: null, vector_reason: null, nearest: null,
  };
}

/** Fills `res`; "go" = write it, a row = already present (heal the ledger), null = refused. */
function plan(db: Database.Database, row: IngestRow, res: IngestResult, inFile: Map<string, string>): LearningLite | null | "go" {
  const refuse = (why: string): null => {
    res.error = why;
    return null;
  };
  if (row.invalid !== null) return null;
  const holder = findKeyRow(db, row.key);
  res.key_present = holder !== null;
  if (row.op === "add_tags") {
    const target = learningById(db, row.id as number);
    if (target === null) return refuse(`unknown-id:${row.id}`);
    if (target.deleted_at) return refuse(`deleted-id:${row.id}`);
    if (holder !== null && holder.id !== target.id) return refuse(`key-present:${holder.id}`);
    res.id = target.id;
    const have = tagTokens(target.tags);
    if (!tagTokens(row.tags).every((t) => have.includes(t))) return "go";
    res.status = "already-present";
    return target;
  }
  if (holder !== null) {
    res.status = "already-present";
    res.id = holder.id;
    return holder;
  }
  const a = row.args as Record<string, string>;
  res.project_registered = projectRegistered(db, a.project);
  if (res.project_registered === false) return refuse(`unregistered-project:${a.project}`);
  const triple = JSON.stringify([a.project, a.category, a.title]);
  const hit = findTitleCollision(db, a.project, a.category, a.title);
  const first = inFile.get(triple);
  if (hit !== null || first !== undefined) {
    res.status = "title-collision";
    res.collision = { id: hit, key: hit === null ? (first as string) : null };
    res.error = `title-collision:${hit ?? first}`;
    return null;
  }
  inFile.set(triple, row.key);
  return "go";
}

const off = (reason: string, close?: () => Promise<void>): NearestMatcher => ({
  available: false, reason, match: async () => null, close,
});

/** Vector dedup, or a named reason it is off. */
async function defaultMatcher(): Promise<{ db: Database.Database | null; matcher: NearestMatcher }> {
  const vh = await openBrainReadonlyWithVec();
  if (vh === null) return { db: null, matcher: off("no brain") };
  const db = vh.db;
  if (!vh.vector_available) return { db, matcher: off(vh.vector_reason ?? "sqlite-vec unavailable") };
  const find = await loadNearestMatch();
  if (find === null) return { db, matcher: off(lastNearestMatchFailure() ?? "dedup module unavailable") };
  try {
    db.prepare("SELECT 1 FROM learnings_vec LIMIT 1").get();
  } catch (e) {
    return { db, matcher: off(`learnings_vec unreadable: ${msg(e)}`) };
  }
  const emb = await loadVendoredEmbeddings();
  if (emb?.generateEmbedding === undefined) return { db, matcher: off("embeddings module unavailable") };
  const close = (): Promise<void> => emb.disposeEmbeddingPipeline();
  try {
    await emb.generateEmbedding("igris lessons dedup probe");
  } catch (e) {
    return { db, matcher: off(`embeddings unavailable: ${short(msg(e))}`, close) };
  }
  const match = async (title: string, content: string): Promise<{ id: number; similarity: number } | null> => {
    const m = await find(db, { title, content });
    return m === null ? null : { id: m.matched_id, similarity: m.similarity };
  };
  return { db, matcher: { available: true, reason: null, match, close } };
}

const noBrain = (): string => `brain database not found at ${brainDbPath()}`;

export async function dryRunIngest(rows: IngestRow[], opts: { matcher?: NearestMatcher } = {}): Promise<IngestRun> {
  if (!existsSync(brainDbPath())) return { ok: false, exit: 3, reason: noBrain() };
  const opened = opts.matcher
    ? { db: openBrainReadonly(), matcher: opts.matcher }
    : await defaultMatcher();
  const { db, matcher } = opened;
  if (db === null) {
    await matcher.close?.();
    return { ok: false, exit: 3, reason: "brain database could not be opened read-only" };
  }
  try {
    const inFile = new Map<string, string>();
    const results: IngestResult[] = [];
    for (const row of rows) {
      const res = blank(row);
      res.vector_available = matcher.available;
      res.vector_reason = matcher.reason;
      if (plan(db, row, res, inFile) === "go") {
        res.status = row.op === "store" ? "would-store" : "would-tag";
        if (row.op === "store" && matcher.available) {
          const a = row.args as Record<string, string>;
          const m = await matcher.match(a.title, a.content);
          const r = m === null ? null : learningById(db, m.id);
          if (m !== null && r !== null) {
            const counts = (r.project === a.project || r.scope === "global") && r.review_status === "approved" && !r.deleted_at;
            res.nearest = { id: r.id, project: r.project, title: r.title, tags: r.tags, scope: r.scope, similarity: m.similarity, advisory: !counts };
          }
        }
      }
      results.push(res);
    }
    return { ok: true, results };
  } finally {
    try {
      await matcher.close?.();
    } finally {
      db.close();
    }
  }
}

export async function writeIngest(rows: IngestRow[], opts: { ledgerPath: string }): Promise<IngestRun> {
  let ledgerText = "";
  try {
    if (existsSync(opts.ledgerPath)) ledgerText = readFileSync(opts.ledgerPath, "utf8");
  } catch (e) {
    return { ok: false, exit: 2, reason: `cannot read ledger: ${msg(e)}` };
  }
  const ledger = parseLedger(ledgerText);
  if (!ledger.ok) return { ok: false, exit: 2, reason: ledger.error };
  const ledgered = new Map(ledger.rows.map((r) => [r.key, r.id]));
  if (!existsSync(brainDbPath())) return { ok: false, exit: 3, reason: noBrain() };
  const booted = await bootWriteEngine();
  if (!booted.ok) return { ok: false, exit: 3, reason: booted.reason };
  const db = openBrainReadonly();
  if (db === null) {
    shutdownWriteEngine();
    return { ok: false, exit: 3, reason: "brain database could not be opened read-only" };
  }
  const record = (key: string, id: number, content: string, op: IngestRow["op"]): void => {
    if (ledgered.get(key) === id) return;
    appendFileSync(opts.ledgerPath, JSON.stringify({ key, id, sha256: sha256Hex(content), op }) + "\n");
    ledgered.set(key, id);
  };
  const dispatch = booted.engine.gateway.dispatch;
  try {
    const inFile = new Map<string, string>();
    const results: IngestResult[] = [];
    for (const row of rows) {
      const res = blank(row);
      results.push(res);
      const p = plan(db, row, res, inFile);
      if (p !== "go") {
        if (p !== null) record(row.key, p.id, p.content, row.op);
        continue;
      }
      try {
        let id: number | null = null;
        let text: string;
        if (row.op === "store") {
          const out = await dispatch(INGEST_TOOLS[0], row.args as Record<string, unknown>);
          text = out.content?.[0]?.text ?? "";
          const m = /^ID: (\d+)$/m.exec(text);
          if (out.isError !== true && !/^(Validation error:|Invalid )/.test(text) && m !== null) id = Number(m[1]);
        } else {
          const target = learningById(db, row.id as number) as LearningLite;
          const tags = [...new Set([...tagTokens(target.tags), ...tagTokens(row.tags)])].join(",");
          const out = await dispatch(INGEST_TOOLS[1], { id: target.id, tags });
          text = out.content?.[0]?.text ?? "";
          let parsed: { id?: unknown } = {};
          try {
            parsed = JSON.parse(text) as { id?: unknown };
          } catch {
            /* refusals are plain text */
          }
          if (out.isError !== true && parsed.id === target.id) id = target.id;
        }
        const landed = id === null ? null : learningById(db, id);
        if (landed === null) {
          res.error = short(text) || "the brain returned no id";
          continue;
        }
        record(row.key, landed.id, landed.content, row.op);
        res.status = row.op === "store" ? "stored" : "tagged";
        res.id = landed.id;
      } catch (e) {
        res.error = short(msg(e));
      }
    }
    return { ok: true, results };
  } finally {
    try {
      await (await loadVendoredEmbeddings())?.disposeEmbeddingPipeline();
    } finally {
      db.close();
      shutdownWriteEngine();
    }
  }
}
