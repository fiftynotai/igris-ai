// FR-273 D1/D10 — the relation write core (db-param): the ONE path every edge
// write funnels through. Tombstone removal, never a DELETE. Contract: MAINTAINING
// row "project relations store".

import type Database from 'better-sqlite3';

import { findPathHolder } from '../../../../tools/projects.js';
import { resolveKind, unknownKindRefusal, type CoreOutcome, type RelationRefusal } from './kinds.js';
import { canonicalDetail, maxProvenance, parseDetail, type Provenance } from './read.js';

// Detail limits (D1).
export const DETAIL_MAX_KEYS = 8;
export const DETAIL_MAX_VALUE_CHARS = 200;
const DETAIL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

// One stored relation row, detail parsed.
export interface RelationRecord {
  from: string;
  kind: string;
  to: string;
  detail: Record<string, string>;
  provenance: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

// What a declare or remove did.
export interface RelationWriteData {
  outcome: 'created' | 'revived' | 'updated' | 'unchanged' | 'removed';
  changed: boolean;
  relation: RelationRecord;
  // Present when the input kind was an alias or a merged name.
  resolved_kind?: { input: string; canonical: string; via: 'alias' | 'merged' };
}

// The endpoint triple.
export interface RelationKey {
  from: string;
  kind: string;
  to: string;
}

interface Row {
  from_slug: string;
  kind: string;
  to_slug: string;
  detail: string;
  provenance: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

function refuse(code: string, message: string, extra: Partial<RelationRefusal> = {}): { ok: false; refused: RelationRefusal } {
  return { ok: false, refused: { code, message, ...extra } };
}

function readRow(db: Database.Database, from: string, kind: string, to: string): Row | undefined {
  return db.prepare(
    'SELECT from_slug, kind, to_slug, detail, provenance, removed_at, created_at, updated_at FROM project_relations WHERE from_slug = ? AND kind = ? AND to_slug = ?',
  ).get(from, kind, to) as Row | undefined;
}

function toRecord(r: Row): RelationRecord {
  return {
    from: r.from_slug,
    kind: r.kind,
    to: r.to_slug,
    detail: parseDetail(r.detail),
    provenance: r.provenance,
    removed_at: r.removed_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Validate a `detail` map; the refusal message, or null when valid.
export function validateDetail(detail: unknown): string | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    return '`detail` must be a flat object of string values.';
  }
  const entries = Object.entries(detail as Record<string, unknown>);
  if (entries.length > DETAIL_MAX_KEYS) return `\`detail\` holds at most ${DETAIL_MAX_KEYS} keys (got ${entries.length}).`;
  for (const [k, v] of entries) {
    if (!DETAIL_KEY_RE.test(k)) return `\`detail\` key '${k}' must be lower snake case (at most 32 characters).`;
    if (typeof v !== 'string') return `\`detail.${k}\` must be a string.`;
    if (v.length > DETAIL_MAX_VALUE_CHARS) return `\`detail.${k}\` is over ${DETAIL_MAX_VALUE_CHARS} characters.`;
    if (/[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(v)) return `\`detail.${k}\` holds a URL with credentials (user@); relations replicate, so store it without them.`;
    if (/^(?:[/~]|file:|[a-z]:[\\/]|\\\\)/i.test(v)) {
      return `\`detail.${k}\` looks like a local path ('${v.slice(0, 40)}'); relations replicate, so a detail value must not be an absolute, ~, file:, drive or UNC path — store a relative or descriptive value.`;
    }
  }
  return null;
}

// Endpoint validity (D10): registered, and not a duplicate-path slug.
function endpointRefusal(db: Database.Database, slug: string): { ok: false; refused: RelationRefusal } | null {
  const row = db.prepare('SELECT slug, path FROM projects WHERE slug = ?').get(slug) as { slug: string; path: string } | undefined;
  if (row === undefined) {
    return refuse('unregistered_endpoint', `'${slug}' is not a registered project slug. Register it first (igris_project_register), or check the slug.`, { existing: slug });
  }
  const holder = findPathHolder(db, row.slug, row.path);
  if (holder !== undefined) {
    return refuse(
      'duplicate_path',
      `'${slug}' shares its directory with '${holder.slug}' (doctor's duplicate-path class; resolve the duplicate first).`,
      { existing: holder.slug },
    );
  }
  return null;
}

function resolved(input: string, canonical: string, via: 'name' | 'alias' | 'merged'): RelationWriteData['resolved_kind'] {
  return via === 'name' ? undefined : { input, canonical, via };
}

// Declare (or re-declare) one relation.
export function declareRelation(
  db: Database.Database,
  input: RelationKey & { detail?: Record<string, string> },
  opts: { provenance?: Provenance } = {},
): CoreOutcome<RelationWriteData> {
  const from = input.from.trim();
  const to = input.to.trim();
  if (from === '' || to === '') return refuse('invalid_argument', '`from` and `to` must be non-empty project slugs.');
  if (from === to) return refuse('self_loop', `A project cannot relate to itself ('${from}').`);
  if (input.detail !== undefined) {
    const bad = validateDetail(input.detail);
    if (bad !== null) return refuse('invalid_detail', bad);
  }
  // One IMMEDIATE transaction: the read-then-write cannot race another writer (M10).
  return db.transaction((): CoreOutcome<RelationWriteData> => {
    const res = resolveKind(db, input.kind);
    if (!res.ok) return { ok: false, refused: unknownKindRefusal(input.kind, res.closest) };
    const kind = res.kind.name;
    for (const slug of [from, to]) {
      const r = endpointRefusal(db, slug);
      if (r !== null) return r;
    }

    const provenance = opts.provenance ?? 'declared';
    const existing = readRow(db, from, kind, to);
    let outcome: RelationWriteData['outcome'];
    if (existing === undefined) {
      db.prepare('INSERT INTO project_relations (from_slug, kind, to_slug, detail, provenance) VALUES (?, ?, ?, ?, ?)')
        .run(from, kind, to, canonicalDetail(input.detail ?? {}), provenance);
      outcome = 'created';
    } else {
      const detail = input.detail !== undefined ? canonicalDetail(input.detail) : canonicalDetail(parseDetail(existing.detail));
      const prov = maxProvenance(existing.provenance, provenance);
      if (existing.removed_at !== null) {
        db.prepare("UPDATE project_relations SET detail = ?, provenance = ?, removed_at = NULL, updated_at = datetime('now') WHERE from_slug = ? AND kind = ? AND to_slug = ?")
          .run(detail, prov, from, kind, to);
        outcome = 'revived';
      } else if (detail !== canonicalDetail(parseDetail(existing.detail)) || prov !== existing.provenance) {
        db.prepare("UPDATE project_relations SET detail = ?, provenance = ?, updated_at = datetime('now') WHERE from_slug = ? AND kind = ? AND to_slug = ?")
          .run(detail, prov, from, kind, to);
        outcome = 'updated';
      } else {
        outcome = 'unchanged';
      }
    }
    const data: RelationWriteData = {
      outcome,
      changed: outcome !== 'unchanged',
      relation: toRecord(readRow(db, from, kind, to)!),
    };
    const rk = resolved(input.kind, kind, res.via);
    if (rk !== undefined) data.resolved_kind = rk;
    return { ok: true, data };
  }).immediate();
}

// Remove one relation: a TOMBSTONE, never a DELETE. Removing a tombstone is a no-op.
export function removeRelation(db: Database.Database, input: RelationKey): CoreOutcome<RelationWriteData> {
  const from = input.from.trim();
  const to = input.to.trim();
  return db.transaction((): CoreOutcome<RelationWriteData> => {
    const res = resolveKind(db, input.kind);
    if (!res.ok) return { ok: false, refused: unknownKindRefusal(input.kind, res.closest) };
    const kind = res.kind.name;
    const existing = readRow(db, from, kind, to);
    if (existing === undefined) {
      return refuse('unknown_edge', `No relation '${from} ${kind} ${to}' exists.`);
    }
    let outcome: RelationWriteData['outcome'] = 'unchanged';
    if (existing.removed_at === null) {
      db.prepare("UPDATE project_relations SET removed_at = datetime('now'), updated_at = datetime('now') WHERE from_slug = ? AND kind = ? AND to_slug = ?")
        .run(from, kind, to);
      outcome = 'removed';
    }
    const data: RelationWriteData = { outcome, changed: outcome === 'removed', relation: toRecord(readRow(db, from, kind, to)!) };
    const rk = resolved(input.kind, kind, res.via);
    if (rk !== undefined) data.resolved_kind = rk;
    return { ok: true, data };
  }).immediate();
}
