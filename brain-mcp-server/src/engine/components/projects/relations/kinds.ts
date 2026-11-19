// FR-273 D2/D3 — the kind registry core (db-param). resolve / add (lexical gate
// first, semantic fail-open) / alias / merge (one transaction, tombstones).
// Contract: MAINTAINING row "project relations store".

import type Database from 'better-sqlite3';

import {
  closestKinds,
  cosine,
  foldName,
  lexicalScore,
  SEMANTIC_THRESHOLD,
} from './near-dup.js';
import {
  canonicalDetail,
  maxProvenance,
  parseDetail,
  readKinds,
  type RelationKind,
} from './read.js';

// An embedder: text → vector. Throws when the backend is unavailable.
export type EmbedFn = (text: string) => Promise<ArrayLike<number>>;

// The semantic-gate seams `addKind` takes.
export interface SemanticDeps {
  // `null` = no embedder (disabled or unavailable); the gate reports why.
  embed: EmbedFn | null;
  // Why `embed` is null (rendered as `unavailable: <reason>`).
  unavailableReason?: string;
  // Override {@link SEMANTIC_THRESHOLD} for this call (`null` = advisory).
  semanticThreshold?: number | null;
}

// Why a registry operation was refused. `message` is the operator-facing text.
export interface RelationRefusal {
  code: string;
  message: string;
  // The closest registered kinds (unknown-kind refusals).
  closest?: string[];
  // The existing kind or holder a refusal is about.
  existing?: string;
  // The near-duplicate score.
  score?: number;
  // Which gate refused: `lexical-name`, `lexical-meaning` or `semantic`.
  gate?: string;
}

// The outcome of a core operation.
export type CoreOutcome<T> =
  | { ok: true; data: T; semantic_check?: string }
  | { ok: false; refused: RelationRefusal; semantic_check?: string };

// Resolution of a kind name.
export type KindResolution =
  | { ok: true; kind: RelationKind; via: 'name' | 'alias' | 'merged' }
  | { ok: false; input: string; closest: string[] };

// A kind or alias name: lower snake case, 2–48 characters.
export const KIND_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;

// Every kind row in registry order (active and merged).
export function listKinds(db: Database.Database): RelationKind[] {
  return readKinds(db);
}

// The ACTIVE kinds, in registry order.
export function activeKinds(db: Database.Database): RelationKind[] {
  return readKinds(db).filter((k) => k.status === 'active');
}

// The refusal for a name no kind answers to.
export function unknownKindRefusal(input: string, closest: string[]): RelationRefusal {
  return {
    code: 'unknown_kind',
    message: `Unknown relation kind '${input}'. Closest registered: ${closest.join(', ') || '(none)'}. ` +
      'Use a registered kind (or one of its aliases), or add a kind deliberately with igris_project_relation_kinds action:"add".',
    closest,
  };
}

// Resolve a kind (notation folded): canonical name, active alias, or merged name → survivor.
export function resolveKind(db: Database.Database, input: string): KindResolution {
  const name = foldName(input);
  const all = readKinds(db);
  const byName = new Map(all.map((k) => [k.name, k]));
  let k = byName.get(name);
  if (k !== undefined) {
    let via: 'name' | 'merged' = 'name';
    const seen = new Set<string>();
    while (k.status === 'merged' && k.merged_into !== null && !seen.has(k.name)) {
      seen.add(k.name);
      const next = byName.get(k.merged_into);
      if (next === undefined) break;
      k = next;
      via = 'merged';
    }
    if (k.status === 'active') return { ok: true, kind: k, via };
  }
  const active = all.filter((x) => x.status === 'active');
  const aliased = active.find((x) => x.aliases.includes(name));
  if (aliased !== undefined) return { ok: true, kind: aliased, via: 'alias' };
  return { ok: false, input, closest: closestKinds(name, active) };
}

// The kind (any status) that already holds `name` as a name or an alias.
function holderOf(all: readonly RelationKind[], name: string, except?: string): { kind: string; as: 'name' | 'alias' } | null {
  for (const k of all) {
    if (k.name === except) continue;
    if (k.name === name) return { kind: k.name, as: 'name' };
    if (k.aliases.includes(name)) return { kind: k.name, as: 'alias' };
  }
  return null;
}

// The input `addKind` takes (already presence/type-checked by the action layer).
export interface AddKindInput {
  name: string;
  meaning: string;
  direction: string;
  forward_label: string;
  inverse_label: string;
  example: string;
  aliases?: string[];
}

// Name/alias collisions, then the lexical gate, against the CURRENT registry.
function addRefusal(all: readonly RelationKind[], name: string, aliases: string[], meaning: string): RelationRefusal | null {
  const nameHolder = holderOf(all, name);
  if (nameHolder !== null) {
    return {
      code: 'name_collision',
      message: `'${name}' is already ${nameHolder.as === 'name' ? 'a registered kind' : `an alias of '${nameHolder.kind}'`}. Use '${nameHolder.kind}'.`,
      existing: nameHolder.kind,
    };
  }
  for (const a of aliases) {
    const h = holderOf(all, a);
    if (h !== null) {
      return {
        code: 'alias_collision',
        message: `Alias '${a}' is already ${h.as === 'name' ? 'a registered kind' : `an alias of '${h.kind}'`}; every alias must be unique across the registry.`,
        existing: h.kind,
      };
    }
  }
  const lexical = lexicalScore({ name, meaning, aliases }, all.filter((k) => k.status === 'active'));
  return lexical === null ? null : nearDupRefusal(name, lexical.kind, lexical.score, lexical.gate);
}

// `addKind`'s success payload.
export interface AddKindData {
  kind: RelationKind;
  changed: true;
  // The nearest active kind by meaning, when the semantic gate ran.
  semantic?: { nearest: string; score: number };
}

const TEXT_MAX = 300;

// Add a relation kind.
export async function addKind(db: Database.Database, input: AddKindInput, deps: SemanticDeps): Promise<CoreOutcome<AddKindData>> {
  const name = foldName(input.name);
  if (!KIND_NAME_RE.test(name)) {
    return { ok: false, refused: { code: 'invalid_argument', message: `Kind name '${input.name}' must be lower snake case, 2–48 characters (e.g. deploys_to).` } };
  }
  for (const f of ['meaning', 'direction', 'forward_label', 'inverse_label', 'example'] as const) {
    const v = input[f].trim();
    if (v === '' || v.length > TEXT_MAX) {
      return { ok: false, refused: { code: 'invalid_argument', message: `'${f}' must be a non-empty string of at most ${TEXT_MAX} characters.` } };
    }
  }
  const aliases = [...new Set((input.aliases ?? []).map(foldName))].filter((a) => a !== name);
  for (const a of aliases) {
    if (!KIND_NAME_RE.test(a)) {
      return { ok: false, refused: { code: 'invalid_argument', message: `Alias '${a}' must be lower snake case, 2–48 characters.` } };
    }
  }

  const all = readKinds(db);
  const early = addRefusal(all, name, aliases, input.meaning);
  if (early !== null) return { ok: false, refused: early };
  const active = all.filter((k) => k.status === 'active');

  let semantic_check: string;
  let semantic: { nearest: string; score: number } | undefined;
  const threshold = deps.semanticThreshold !== undefined ? deps.semanticThreshold : SEMANTIC_THRESHOLD;
  if (deps.embed === null) {
    semantic_check = `unavailable: ${deps.unavailableReason ?? 'no embedder'}`;
  } else {
    try {
      const mine = await deps.embed(input.meaning);
      for (const k of active) {
        const score = cosine(mine, await deps.embed(k.meaning));
        if (semantic === undefined || score > semantic.score) semantic = { nearest: k.name, score };
      }
      if (semantic !== undefined && threshold !== null && semantic.score >= threshold) {
        return { ok: false, semantic_check: 'refused', refused: nearDupRefusal(name, semantic.nearest, semantic.score, 'semantic') };
      }
      semantic_check = threshold === null ? 'advisory' : 'passed';
    } catch (err) {
      semantic = undefined;
      semantic_check = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // The embed awaited: re-check against the registry NOW, in the same IMMEDIATE
  // transaction as the INSERT, so a concurrent add is refused, not thrown (M10).
  return db.transaction((): CoreOutcome<AddKindData> => {
    const late = addRefusal(readKinds(db), name, aliases, input.meaning);
    if (late !== null) return { ok: false, refused: late, semantic_check };
    db.prepare(
      'INSERT INTO project_relation_kinds (name, meaning, direction, forward_label, inverse_label, example, aliases) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      name, input.meaning.trim(), input.direction.trim(), input.forward_label.trim(),
      input.inverse_label.trim(), input.example.trim(), [...aliases].sort().join(','),
    );
    const kind = readKinds(db).find((k) => k.name === name)!;
    const data: AddKindData = { kind, changed: true };
    if (semantic !== undefined) data.semantic = semantic;
    return { ok: true, data, semantic_check };
  }).immediate();
}

function nearDupRefusal(name: string, existing: string, score: number, gate: string): RelationRefusal {
  return {
    code: 'near_duplicate',
    message: `Kind '${name}' near-duplicates '${existing}' (${gate} gate, score ${score.toFixed(2)}). ` +
      `Use '${existing}', or alias your name onto it (igris_project_relation_kinds action:"alias", name:"${existing}", alias:"${name}").`,
    existing,
    score,
    gate,
  };
}

// `aliasKind`'s success payload.
export interface AliasKindData {
  kind: RelationKind;
  alias: string;
  changed: boolean;
}

// Append one alias to a kind (resolved by name or alias). Idempotent.
export function aliasKind(db: Database.Database, input: { name: string; alias: string }): CoreOutcome<AliasKindData> {
  const res = resolveKind(db, input.name);
  if (!res.ok) return { ok: false, refused: unknownKindRefusal(input.name, res.closest) };
  const alias = foldName(input.alias);
  if (!KIND_NAME_RE.test(alias)) {
    return { ok: false, refused: { code: 'invalid_argument', message: `Alias '${input.alias}' must be lower snake case, 2–48 characters.` } };
  }
  const kind = res.kind;
  if (kind.aliases.includes(alias)) return { ok: true, data: { kind, alias, changed: false } };
  const holder = holderOf(readKinds(db), alias);
  if (holder !== null) {
    return {
      ok: false,
      refused: {
        code: 'alias_collision',
        message: `'${alias}' is already ${holder.as === 'name' ? 'a registered kind' : `an alias of '${holder.kind}'`}; every alias must be unique across the registry.`,
        existing: holder.kind,
      },
    };
  }
  const merged = [...new Set([...kind.aliases, alias])].sort().join(',');
  db.prepare("UPDATE project_relation_kinds SET aliases = ?, updated_at = datetime('now') WHERE name = ?").run(merged, kind.name);
  return { ok: true, data: { kind: readKinds(db).find((k) => k.name === kind.name)!, alias, changed: true } };
}

// `mergeKinds`'s success payload.
export interface MergeKindsData {
  retired: string;
  survivor: string;
  // Live retired edges moved onto the survivor kind.
  rewritten: number;
  // Of those, survivor rows that were tombstoned and are now revived.
  revived: number;
  // Retired rows tombstoned by this merge.
  tombstoned: number;
  changed: boolean;
}

interface RelRow {
  from_slug: string;
  kind: string;
  to_slug: string;
  detail: string;
  provenance: string;
  removed_at: string | null;
}

// Merge `retired` into `survivor` in ONE transaction; every touched row bumps updated_at.
export function mergeKinds(db: Database.Database, input: { retired: string; survivor: string }): CoreOutcome<MergeKindsData> {
  const retiredName = foldName(input.retired);
  const all = readKinds(db);
  const retired = all.find((k) => k.name === retiredName);
  if (retired === undefined) {
    return { ok: false, refused: unknownKindRefusal(input.retired, closestKinds(retiredName, all.filter((k) => k.status === 'active'))) };
  }
  const sres = resolveKind(db, input.survivor);
  if (!sres.ok) return { ok: false, refused: unknownKindRefusal(input.survivor, sres.closest) };
  const survivor = sres.kind;

  if (retired.status === 'merged') {
    const target = resolveKind(db, retired.name);
    if (target.ok && target.kind.name === survivor.name) {
      return { ok: true, data: { retired: retired.name, survivor: survivor.name, rewritten: 0, revived: 0, tombstoned: 0, changed: false } };
    }
    return {
      ok: false,
      refused: {
        code: 'already_merged',
        message: `'${retired.name}' is already merged into '${retired.merged_into}'.`,
        existing: retired.merged_into ?? undefined,
      },
    };
  }
  if (survivor.name === retired.name) {
    return { ok: false, refused: { code: 'self_merge', message: `Cannot merge '${retired.name}' into itself.`, existing: retired.name } };
  }

  let rewritten = 0;
  let revived = 0;
  let tombstoned = 0;
  db.transaction(() => {
    const live = db.prepare(
      'SELECT from_slug, kind, to_slug, detail, provenance, removed_at FROM project_relations WHERE kind = ? AND removed_at IS NULL',
    ).all(retired.name) as RelRow[];
    const findSurvivor = db.prepare('SELECT from_slug, kind, to_slug, detail, provenance, removed_at FROM project_relations WHERE from_slug = ? AND kind = ? AND to_slug = ?');
    const updateSurvivor = db.prepare(
      "UPDATE project_relations SET detail = ?, provenance = ?, removed_at = NULL, updated_at = datetime('now') WHERE from_slug = ? AND kind = ? AND to_slug = ?",
    );
    const insertSurvivor = db.prepare('INSERT INTO project_relations (from_slug, kind, to_slug, detail, provenance) VALUES (?, ?, ?, ?, ?)');
    const tombstone = db.prepare(
      "UPDATE project_relations SET removed_at = datetime('now'), updated_at = datetime('now') WHERE from_slug = ? AND kind = ? AND to_slug = ?",
    );
    for (const r of live) {
      const existing = findSurvivor.get(r.from_slug, survivor.name, r.to_slug) as RelRow | undefined;
      if (existing !== undefined) {
        const detail = { ...parseDetail(r.detail), ...parseDetail(existing.detail) };
        if (existing.removed_at !== null) revived++;
        updateSurvivor.run(canonicalDetail(detail), maxProvenance(existing.provenance, r.provenance), r.from_slug, survivor.name, r.to_slug);
      } else {
        insertSurvivor.run(r.from_slug, survivor.name, r.to_slug, canonicalDetail(parseDetail(r.detail)), maxProvenance(r.provenance, null));
      }
      rewritten++;
      tombstone.run(r.from_slug, retired.name, r.to_slug);
      tombstoned++;
    }
    db.prepare("UPDATE project_relation_kinds SET status = 'merged', merged_into = ?, updated_at = datetime('now') WHERE name = ?")
      .run(survivor.name, retired.name);
    const aliases = [...new Set([...survivor.aliases, retired.name, ...retired.aliases])].sort().join(',');
    db.prepare("UPDATE project_relation_kinds SET aliases = ?, updated_at = datetime('now') WHERE name = ?").run(aliases, survivor.name);
  })();
  return { ok: true, data: { retired: retired.name, survivor: survivor.name, rewritten, revived, tombstoned, changed: true } };
}
