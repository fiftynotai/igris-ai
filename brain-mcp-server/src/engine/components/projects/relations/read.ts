// FR-273 — the PURE SELECT-only relations reader (lookup D7, /boot digest D5,
// kind registry, shared pure helpers). Transitive reach, disclosed: the FR-274
// watermark helpers in tools/projects.js import db.js, which opens nothing at
// import time. Contract: MAINTAINING row "project relations store".

import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

import {
  checkKnowledgeWatermark,
  expandHome,
  hasWatermarkColumns,
  renderKnowledgeWatermark,
  type KnowledgeWatermarkCheck,
} from '../../../../tools/projects.js';
import { SEED_RELATION_KINDS } from './schema.js';

// — Constants

// The deepest traversal a lookup performs (D7).
export const MAX_DEPTH = 5;
// Nodes a traversal or a system component visits before `truncated`.
export const MAX_NODES = 50;
// Watermark checks one lookup may run (each up to five git spawns).
export const WATERMARK_CHECK_CAP = 4;
// Wall-time budget for a lookup's watermark checks.
export const WATERMARK_BUDGET_MS = 2500;
// At most this many segments on the /boot line, then `(+N more)`.
export const BOOT_MAX_SEGMENTS = 4;
// The /boot line's hard length cap.
export const BOOT_MAX_CHARS = 240;

const BOOT_PREFIX = 'Connected: ';
const BOOT_SUFFIX = ' · more: igris project relations';

export type RelationDirection = 'out' | 'in' | 'both';
export type Provenance = 'declared' | 'derived';

// — Shared pure helpers

// Parse a stored `detail` into a flat string map; anything else reads `{}`.
export function parseDetail(text: unknown): Record<string, string> {
  if (typeof text !== 'string') return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

// The canonical stored form of a detail map: JSON with sorted keys.
export function canonicalDetail(detail: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(detail).sort()) sorted[k] = detail[k];
  return JSON.stringify(sorted);
}

// The stronger of two provenances — `derived` is never downgraded.
export function maxProvenance(a: string | null | undefined, b: string | null | undefined): Provenance {
  return a === 'derived' || b === 'derived' ? 'derived' : 'declared';
}

// Split a stored comma-joined alias list.
export function splitAliases(text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return [];
  return text.split(',').map((a) => a.trim()).filter((a) => a !== '');
}

// True when both relation tables exist (projects:3 applied).
export function relationTablesPresent(db: Database.Database): boolean {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_relations', 'project_relation_kinds')",
  ).all() as { name: string }[];
  return rows.length === 2;
}

// — The kind registry (read side)

// One `project_relation_kinds` row, aliases split.
export interface RelationKind {
  name: string;
  meaning: string;
  direction: string;
  forward_label: string;
  inverse_label: string;
  example: string;
  aliases: string[];
  status: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

const SEED_ORDER: ReadonlyMap<string, number> = new Map(SEED_RELATION_KINDS.map((k, i) => [k.name, i]));

// Every kind row in REGISTRY ORDER: seeds first, then created_at, name — the same on every replica.
export function readKinds(db: Database.Database): RelationKind[] {
  const rows = db.prepare('SELECT * FROM project_relation_kinds').all() as Record<string, unknown>[];
  const kinds = rows.map((r) => ({
    name: String(r.name),
    meaning: String(r.meaning),
    direction: String(r.direction),
    forward_label: String(r.forward_label),
    inverse_label: String(r.inverse_label),
    example: String(r.example),
    aliases: splitAliases(r.aliases),
    status: String(r.status),
    merged_into: (r.merged_into as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }));
  return kinds.sort((a, b) => {
    const sa = SEED_ORDER.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const sb = SEED_ORDER.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// — The lookup (D7)

// One live edge as the lookup reports it.
export interface RelationEdge {
  from: string;
  kind: string;
  to: string;
  detail: Record<string, string>;
  provenance: string;
}

// A neighbour's watermark (FR-274 reuse). `lines` only when the check RAN.
export interface RelationWatermark {
  sha: string;
  branch: string | null;
  recorded_at: string | null;
  // The check's state, or why it did not run.
  check: KnowledgeWatermarkCheck['state'] | 'skipped:cap' | 'skipped:budget' | 'skipped:off';
  // `renderKnowledgeWatermark`'s lines — the exact `igris_project_status` lines.
  lines?: string[];
}

// One neighbour, at its minimum depth.
export interface RelationNeighbour {
  slug: string;
  depth: number;
  // Relative to its PARENT: `out` = parent → this, `in` = this → parent.
  side: 'out' | 'in';
  kind: string;
  forward_label: string | null;
  inverse_label: string | null;
  // The label that reads correctly from the parent's side.
  label: string | null;
  detail: Record<string, string>;
  provenance: string;
  registered: boolean;
  repo_url: string | null;
  path: string | null;
  on_disk: boolean;
  watermark: RelationWatermark | null;
  // The edge through which this node was first discovered.
  via: { from: string; kind: string; to: string };
}

// The derived "system": the undirected connected component of live edges.
export interface RelationSystem {
  members: string[];
  size: number;
  truncated: boolean;
}

// The lookup result.
export interface RelationsLookup {
  project: string;
  registered: boolean;
  depth: number;
  direction: RelationDirection;
  // The canonical kind filter, or null.
  kind: string | null;
  neighbours: RelationNeighbour[];
  edges: RelationEdge[];
  truncated: boolean;
  system?: RelationSystem;
}

// Lookup options — already validated and resolved by the action layer.
export interface LookupOptions {
  slug: string;
  depth?: number;
  direction?: RelationDirection;
  // A CANONICAL kind name (the action layer resolves aliases first).
  kind?: string | null;
  check_watermarks?: boolean;
  include_system?: boolean;
}

// Injected seams (tests).
export interface LookupDeps {
  // Wall clock in ms; default `Date.now`.
  now?: () => number;
}

interface EdgeRow {
  from_slug: string;
  kind: string;
  to_slug: string;
  detail: string;
  provenance: string;
}

interface ProjectRow {
  slug: string;
  path: string;
  repo_url: string | null;
  knowledge_sha: string | null;
  knowledge_branch: string | null;
  knowledge_recorded_at: string | null;
}

function liveEdges(db: Database.Database): EdgeRow[] {
  return db.prepare(
    'SELECT from_slug, kind, to_slug, detail, provenance FROM project_relations WHERE removed_at IS NULL',
  ).all() as EdgeRow[];
}

function projectReader(db: Database.Database): (slug: string) => ProjectRow | undefined {
  const cols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[]).map((c) => c.name),
  );
  const wm = hasWatermarkColumns(db);
  const select = [
    'slug', 'path',
    cols.has('repo_url') ? 'repo_url' : 'NULL AS repo_url',
    wm ? 'knowledge_sha' : 'NULL AS knowledge_sha',
    wm ? 'knowledge_branch' : 'NULL AS knowledge_branch',
    wm ? 'knowledge_recorded_at' : 'NULL AS knowledge_recorded_at',
  ].join(', ');
  const stmt = db.prepare(`SELECT ${select} FROM projects WHERE slug = ?`);
  return (slug: string) => stmt.get(slug) as ProjectRow | undefined;
}

function kindLabels(db: Database.Database): { labels: Map<string, RelationKind>; order: Map<string, number> } {
  const kinds = readKinds(db);
  return {
    labels: new Map(kinds.map((k) => [k.name, k])),
    order: new Map(kinds.map((k, i) => [k.name, i])),
  };
}

function edgeKey(e: EdgeRow): string {
  return `${e.from_slug}\u0000${e.kind}\u0000${e.to_slug}`;
}

// Traverse the live relation graph from `slug` (BFS, visited-set on slug, so cycles are safe and each node appears ONCE at its minimum depth).
export function lookupRelations(db: Database.Database, opts: LookupOptions, deps: LookupDeps = {}): RelationsLookup {
  const now = deps.now ?? Date.now;
  const started = now();
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), MAX_DEPTH);
  const direction: RelationDirection = opts.direction ?? 'both';
  const kindFilter = opts.kind ?? null;
  const checkWatermarks = opts.check_watermarks !== false;

  const all = liveEdges(db);
  const edges = kindFilter === null ? all : all.filter((e) => e.kind === kindFilter);
  const outBy = new Map<string, EdgeRow[]>();
  const inBy = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    (outBy.get(e.from_slug) ?? outBy.set(e.from_slug, []).get(e.from_slug)!).push(e);
    (inBy.get(e.to_slug) ?? inBy.set(e.to_slug, []).get(e.to_slug)!).push(e);
  }
  const { labels, order } = kindLabels(db);
  const kindRank = (k: string): number => order.get(k) ?? Number.MAX_SAFE_INTEGER;
  const project = projectReader(db);

  interface Found { slug: string; depth: number; side: 'out' | 'in'; edge: EdgeRow }
  const visited = new Set<string>([opts.slug]);
  const found: Found[] = [];
  const traversed = new Map<string, EdgeRow>();
  let truncated = false;
  let frontier = [opts.slug];

  for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
    const candidates: Found[] = [];
    for (const node of frontier) {
      const outs = direction === 'in' ? [] : (outBy.get(node) ?? []);
      const ins = direction === 'out' ? [] : (inBy.get(node) ?? []);
      for (const e of outs) {
        traversed.set(edgeKey(e), e);
        candidates.push({ slug: e.to_slug, depth: d, side: 'out', edge: e });
      }
      for (const e of ins) {
        traversed.set(edgeKey(e), e);
        candidates.push({ slug: e.from_slug, depth: d, side: 'in', edge: e });
      }
    }
    candidates.sort((a, b) =>
      (a.side === b.side ? 0 : a.side === 'out' ? -1 : 1)
      || kindRank(a.edge.kind) - kindRank(b.edge.kind)
      || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    const next: string[] = [];
    for (const c of candidates) {
      if (visited.has(c.slug)) continue;
      if (found.length >= MAX_NODES) {
        truncated = true;
        break;
      }
      visited.add(c.slug);
      found.push(c);
      next.push(c.slug);
    }
    frontier = next;
  }

  const hasWm = hasWatermarkColumns(db);
  let checked = 0;
  const neighbours: RelationNeighbour[] = found.map((f) => {
    const k = labels.get(f.edge.kind);
    const row = project(f.slug);
    const path = row?.path ?? null;
    const onDisk = path !== null && existsSync(expandHome(path));
    let watermark: RelationWatermark | null = null;
    const sha = hasWm ? row?.knowledge_sha ?? null : null;
    if (row !== undefined && typeof sha === 'string' && sha !== '') {
      const base = { sha, branch: row.knowledge_branch ?? null, recorded_at: row.knowledge_recorded_at ?? null };
      if (!checkWatermarks) {
        watermark = { ...base, check: 'skipped:off' };
      } else if (onDisk && checked >= WATERMARK_CHECK_CAP) {
        watermark = { ...base, check: 'skipped:cap' };
      } else if (onDisk && checked > 0 && now() - started >= WATERMARK_BUDGET_MS) {
        // The first check always runs; the budget bounds the ones after it.
        watermark = { ...base, check: 'skipped:budget' };
      } else {
        // An absent path costs zero spawns and does not count against the cap.
        const check = checkKnowledgeWatermark(row.path, sha, base.branch);
        if (onDisk) checked++;
        watermark = {
          ...base,
          check: check.state,
          lines: renderKnowledgeWatermark(
            { path: row.path, knowledge_sha: sha, knowledge_branch: base.branch, knowledge_recorded_at: base.recorded_at },
            check,
          ),
        };
      }
    }
    return {
      slug: f.slug,
      depth: f.depth,
      side: f.side,
      kind: f.edge.kind,
      forward_label: k?.forward_label ?? null,
      inverse_label: k?.inverse_label ?? null,
      label: k === undefined ? null : f.side === 'out' ? k.forward_label : k.inverse_label,
      detail: parseDetail(f.edge.detail),
      provenance: f.edge.provenance,
      registered: row !== undefined,
      repo_url: row?.repo_url ?? null,
      path,
      on_disk: onDisk,
      watermark,
      via: { from: f.edge.from_slug, kind: f.edge.kind, to: f.edge.to_slug },
    };
  });

  const result: RelationsLookup = {
    project: opts.slug,
    registered: project(opts.slug) !== undefined,
    depth,
    direction,
    kind: kindFilter,
    neighbours,
    edges: [...traversed.values()].map((e) => ({
      from: e.from_slug,
      kind: e.kind,
      to: e.to_slug,
      detail: parseDetail(e.detail),
      provenance: e.provenance,
    })),
    truncated,
  };
  if (opts.include_system !== false) result.system = systemOf(all, opts.slug);
  return result;
}

// The undirected connected component of `slug` over live edges, capped.
function systemOf(edges: readonly EdgeRow[], slug: string): RelationSystem {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const e of edges) {
    link(e.from_slug, e.to_slug);
    link(e.to_slug, e.from_slug);
  }
  const seen = new Set<string>([slug]);
  const queue = [slug];
  let truncated = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of [...(adj.get(cur) ?? [])].sort()) {
      if (seen.has(n)) continue;
      if (seen.size >= MAX_NODES) {
        truncated = true;
        break;
      }
      seen.add(n);
      queue.push(n);
    }
    if (truncated) break;
  }
  const members = [...seen].sort();
  return { members, size: members.length, truncated };
}

// — The /boot digest and line (D5)

// The `igris project relations --boot` digest.
export interface RelationsBootDigest {
  degraded: boolean;
  reason: string | null;
  project: string;
  registered: boolean;
  line: string | null;
  neighbours: number;
}

// The /boot line: `Connected: ` + ≤ 4 segments + ` (+N more)` + the pointer suffix, ≤ 240 chars; null for none.
export function renderBootLine(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  const build = (shown: number): string => {
    const more = segments.length - shown;
    return BOOT_PREFIX + segments.slice(0, shown).join('; ') + (more > 0 ? ` (+${more} more)` : '') + BOOT_SUFFIX;
  };
  for (let shown = Math.min(segments.length, BOOT_MAX_SEGMENTS); shown >= 1; shown--) {
    const line = build(shown);
    if (line.length <= BOOT_MAX_CHARS) return line;
  }
  const line = build(1);
  return line.slice(0, BOOT_MAX_CHARS - BOOT_SUFFIX.length - 1) + '…' + BOOT_SUFFIX;
}

// The boot digest: never runs a watermark check, never spawns; line null when there is nothing to say.
export function relationsBootDigest(db: Database.Database, slug: string): RelationsBootDigest {
  const digest: RelationsBootDigest = { degraded: false, reason: null, project: slug, registered: false, line: null, neighbours: 0 };
  if (!relationTablesPresent(db)) {
    digest.degraded = true;
    digest.reason = 'projects:3 not applied — project_relations tables absent';
    return digest;
  }
  const lookup = lookupRelations(db, { slug, depth: 1, direction: 'both', check_watermarks: false, include_system: false });
  digest.registered = lookup.registered;
  digest.neighbours = lookup.neighbours.length;
  if (!lookup.registered || lookup.neighbours.length === 0) return digest;

  const { labels, order } = kindLabels(db);
  const kindRank = (k: string): number => order.get(k) ?? Number.MAX_SAFE_INTEGER;
  const edges = liveEdges(db);
  const byName = (a: EdgeRow, b: EdgeRow, key: 'to_slug' | 'from_slug'): number =>
    kindRank(a.kind) - kindRank(b.kind) || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

  const segments: string[] = [];
  const outgoing = edges.filter((e) => e.from_slug === slug).sort((a, b) => byName(a, b, 'to_slug'));
  for (const e of outgoing) {
    const d = parseDetail(e.detail);
    const ref = d.ref ?? d.version;
    let seg = `${labels.get(e.kind)?.forward_label ?? e.kind} ${e.to_slug}${ref !== undefined ? ` (${ref})` : ''}`;
    const hop = edges
      .filter((h) => h.from_slug === e.to_slug && h.to_slug !== slug)
      .sort((a, b) => byName(a, b, 'to_slug'))[0];
    if (hop !== undefined) seg += ` → ${labels.get(hop.kind)?.forward_label ?? hop.kind} ${hop.to_slug}`;
    segments.push(seg);
  }
  const incoming = edges.filter((e) => e.to_slug === slug);
  const kindsIn = [...new Set(incoming.map((e) => e.kind))].sort((a, b) => kindRank(a) - kindRank(b) || (a < b ? -1 : 1));
  for (const k of kindsIn) {
    const froms = incoming.filter((e) => e.kind === k).map((e) => e.from_slug).sort();
    segments.push(`${labels.get(k)?.inverse_label ?? k} ${froms.join(', ')}`);
  }
  digest.line = renderBootLine(segments);
  return digest;
}
