/**
 * TD-496 role lessons. PURE (db-param, SELECT-only). Tags are matched as exact
 * trimmed tokens: `role:<agent>`, `agent-memory`, `amx:<cid12>`.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { LedgerRow, LessonsAudit, LessonsAuditProblem, RoleDigest, RoleLessonRow } from "../types.js";

export const ROLE_DIGEST_DEFAULT_BYTES = 4096;
export const ROLE_DIGEST_MIN_BYTES = 512;
export const ROLE_DIGEST_MAX_BYTES = 8192;
export const ROLE_DIGEST_MAX_LESSONS = 12;
export const ROLE_TAG_RE = /^role:[a-z][a-z0-9_-]{0,31}$/;
export const AMX_KEY_RE = /^amx:[0-9a-f]{12}$/;
export const LESSON_MARKER = "agent-memory";

export function tagTokens(tags: string | null | undefined): string[] {
  return (tags ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function clipChars(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n - 1).join("") + "…";
}

function clipBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const cp of s) {
    const b = bytes(cp);
    if (used + b + 3 > max) break;
    out += cp;
    used += b;
  }
  return out + "…";
}

export function selectRoleLessons(db: Database.Database, opts: { role: string; project: string }): RoleLessonRow[] {
  const cols = columns(db, "learnings");
  if (cols.size === 0) throw new Error("no learnings table");
  const promoted = cols.has("promoted_to_doc") ? "promoted_to_doc" : "NULL AS promoted_to_doc";
  const live = cols.has("deleted_at") ? "AND deleted_at IS NULL" : "";
  const token = `role:${opts.role}`;
  const rows = db
    .prepare(
      `SELECT id, project, title, content, tags, scope, confidence, created_at, ${promoted}
         FROM learnings
        WHERE review_status = 'approved' ${live}
          AND (project = ? OR scope = 'global') AND instr(tags, ?) > 0`,
    )
    .all(opts.project, token) as RoleLessonRow[];
  return rows.filter((r) => tagTokens(r.tags).includes(token));
}

const FOOTER = "Source: agent-memory";
const STOP = new Set("the and for with this that from into are was were has have not but you your its our".split(" "));
const words = (s: string): Set<string> =>
  new Set([...s.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]).filter((w) => w.length >= 3 && !STOP.has(w)));
const body = (r: RoleLessonRow): string => r.content.split("\n").filter((l) => !l.trimStart().startsWith(FOOTER)).join("\n");

function gist(r: RoleLessonRow): string {
  for (const raw of r.content.split("\n")) {
    const l = oneLine(raw.replace(/^\s*(#+\s*|[-*>]\s+)/, ""));
    if (l === "" || l.toLowerCase() === r.title.toLowerCase().trim() || l.startsWith(FOOTER)) continue;
    return clipChars(l, 200);
  }
  return "";
}

function lessonLine(r: RoleLessonRow): string {
  const g = gist(r);
  const tail = r.promoted_to_doc ? ` → ${clipChars(oneLine(r.promoted_to_doc), 120)}` : g ? ` — ${g}` : "";
  return `- L-${r.id} ${clipChars(oneLine(r.title), 120)}${tail}`;
}

export interface RoleDigestOptions {
  role: string;
  project: string;
  context?: string;
  maxBytes?: number;
  maxLessons?: number;
}

export function unavailableDigest(o: RoleDigestOptions, reason: string): RoleDigest {
  const max = o.maxBytes ?? ROLE_DIGEST_DEFAULT_BYTES;
  const line = (r: string): string => `Role lessons (${o.role}): unavailable — ${r}; proceeding without them.\n`;
  const r = clipBytes(oneLine(reason), max - bytes(line("")));
  const markdown = line(r);
  return {
    role: o.role, project: o.project, max_bytes: max, bytes: bytes(markdown), included: 0, available: 0,
    truncated: false, degraded: true, reason: r, markdown, lessons: [],
  };
}

/** Rank, then fill under a true UTF-8 byte cap (worst-case header/footer reserved first). */
export function renderRoleDigest(rows: RoleLessonRow[], o: RoleDigestOptions): RoleDigest {
  const max = o.maxBytes ?? ROLE_DIGEST_DEFAULT_BYTES;
  const maxLessons = o.maxLessons ?? ROLE_DIGEST_MAX_LESSONS;
  const base = { role: o.role, project: o.project, max_bytes: max, degraded: false, reason: null };
  if (rows.length === 0) {
    const markdown = `Role lessons (${o.role}): none stored.\n`;
    return { ...base, bytes: bytes(markdown), included: 0, available: 0, truncated: false, markdown, lessons: [] };
  }
  const ctx = words(o.context ?? "");
  const scored = rows.map((r) => {
    const w = words(`${r.title} ${body(r)}`);
    let overlap = 0;
    for (const c of ctx) if (w.has(c)) overlap++;
    return { r, overlap, local: r.project === o.project ? 1 : 0 };
  });
  scored.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      b.local - a.local ||
      (b.r.confidence ?? 0) - (a.r.confidence ?? 0) ||
      (a.r.created_at === b.r.created_at ? 0 : a.r.created_at > b.r.created_at ? -1 : 1) ||
      b.r.id - a.r.id,
  );
  const n = rows.length;
  const header = (k: number): string => `Role lessons (${clipChars(o.role, 32)}): ${k} of ${n} for ${clipChars(oneLine(o.project), 64)}.`;
  const more = (k: number): string => `+${k} more not shown (cap ${max} B, ${maxLessons} lessons). Full text: igris_memory_get id=<n>.`;
  let budget = max - bytes(header(n)) - bytes(more(n)) - 2;
  const lines: string[] = [];
  const picked: RoleLessonRow[] = [];
  for (const { r } of scored) {
    if (picked.length >= maxLessons) break;
    let line = lessonLine(r);
    if (bytes(line) + 1 > budget) {
      if (budget - 1 < 40) break;
      line = clipBytes(line, budget - 1);
    }
    lines.push(line);
    picked.push(r);
    budget -= bytes(line) + 1;
  }
  const truncated = picked.length < n;
  const foot = truncated ? more(n - picked.length) : "Full text: igris_memory_get id=<n>.";
  let markdown = [header(picked.length), ...lines, foot].join("\n") + "\n";
  if (bytes(markdown) > max) markdown = clipBytes(markdown, max - 1) + "\n";
  return {
    ...base, bytes: bytes(markdown), included: picked.length, available: n, truncated, markdown,
    lessons: picked.map((r) => ({ id: r.id, title: r.title })),
  };
}

export function buildRoleDigest(db: Database.Database, o: RoleDigestOptions): RoleDigest {
  try {
    return renderRoleDigest(selectRoleLessons(db, o), o);
  } catch (err) {
    return unavailableDigest(o, `brain read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseLedger(text: string): { ok: true; rows: LedgerRow[] } | { ok: false; error: string } {
  const rows: LedgerRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let o: Partial<LedgerRow>;
    try {
      o = JSON.parse(lines[i]) as Partial<LedgerRow>;
    } catch {
      return { ok: false, error: `ledger line ${i + 1}: not JSON` };
    }
    if (
      typeof o?.key !== "string" || !AMX_KEY_RE.test(o.key) || !Number.isInteger(o.id) || (o.id as number) <= 0 ||
      typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256) || (o.op !== "store" && o.op !== "add_tags")
    ) {
      return { ok: false, error: `ledger line ${i + 1}: want {key: amx:<12 hex>, id, sha256, op: store|add_tags}` };
    }
    rows.push({ key: o.key, id: o.id as number, sha256: o.sha256, op: o.op });
  }
  return { ok: true, rows };
}

export interface LearningLite {
  id: number; project: string; category: string; title: string; content: string; tags: string;
  scope: string; review_status: string; deleted_at: string | null;
}

function liteSelect(db: Database.Database): string {
  const del = columns(db, "learnings").has("deleted_at") ? "deleted_at" : "NULL AS deleted_at";
  return `SELECT id, project, category, title, content, tags, scope, review_status, ${del} FROM learnings`;
}

export function learningById(db: Database.Database, id: number): LearningLite | null {
  return (db.prepare(`${liteSelect(db)} WHERE id = ?`).get(id) as LearningLite | undefined) ?? null;
}

export function findKeyRow(db: Database.Database, key: string): LearningLite | null {
  const rows = db.prepare(`${liteSelect(db)} WHERE instr(tags, ?) > 0 ORDER BY id`).all(key) as LearningLite[];
  return rows.find((r) => tagTokens(r.tags).includes(key)) ?? null;
}

/** sync.ts:126-130 keys `learnings` on (project, category, title). */
export function findTitleCollision(db: Database.Database, project: string, category: string, title: string): number | null {
  const row = db
    .prepare("SELECT id FROM learnings WHERE project = ? AND category = ? AND title = ? ORDER BY id LIMIT 1")
    .get(project, category, title) as { id: number } | undefined;
  return row?.id ?? null;
}

export function projectRegistered(db: Database.Database, slug: string): boolean | null {
  if (columns(db, "projects").size === 0) return null;
  return db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug) !== undefined;
}

/** Last ledger row per key wins; orphans carry `marker` + an `amx:` key not in the ledger. */
export function auditLedger(db: Database.Database, ledger: LedgerRow[], o: { marker?: string }): LessonsAudit {
  const marker = o.marker ?? LESSON_MARKER;
  const last = new Map<string, LedgerRow>();
  for (const r of ledger) last.set(r.key, r);
  const problems: LessonsAuditProblem[] = [];
  let verified = 0;
  for (const [key, r] of last) {
    const row = learningById(db, r.id);
    const bad = (kind: LessonsAuditProblem["kind"], detail: string): void => void problems.push({ kind, key, id: r.id, detail });
    if (row === null) bad("missing-id", "not in the brain");
    else if (sha256Hex(row.content) !== r.sha256) bad("sha-mismatch", "content changed since ingest");
    else if (!tagTokens(row.tags).includes(key) || !tagTokens(row.tags).some((t) => ROLE_TAG_RE.test(t))) {
      bad("missing-token", `tags lack ${key} or a role: token`);
    } else if (row.deleted_at) bad("deleted", `soft-deleted at ${row.deleted_at}`);
    else verified++;
  }
  const tagged = db.prepare("SELECT id, tags FROM learnings WHERE instr(tags, ?) > 0 ORDER BY id").all(marker) as { id: number; tags: string }[];
  for (const row of tagged) {
    const toks = tagTokens(row.tags);
    if (!toks.includes(marker)) continue;
    for (const t of toks) {
      if (AMX_KEY_RE.test(t) && !last.has(t)) problems.push({ kind: "orphan", key: t, id: row.id, detail: "key not in the ledger" });
    }
  }
  return { ok: problems.length === 0, ledger_rows: ledger.length, keys: last.size, verified, problems };
}
