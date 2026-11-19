// FR-273 D4 — THE single relations action layer: the MCP handlers call it with
// getDb(), the CLI verbs dynamic-import this compiled module with their own
// handle, so the CLI holds zero relations SQL. Validates in-band (no gateway on
// the CLI path). Contract: MAINTAINING row "project relations store".

import type Database from 'better-sqlite3';

import { generateEmbedding } from '../../../../utils/embeddings.js';
import {
  addKind,
  aliasKind,
  listKinds,
  mergeKinds,
  resolveKind,
  unknownKindRefusal,
  type CoreOutcome,
  type EmbedFn,
  type RelationRefusal,
} from './kinds.js';
import {
  lookupRelations,
  MAX_DEPTH,
  relationTablesPresent,
  type LookupDeps,
  type RelationDirection,
} from './read.js';
import { declareRelation, removeRelation } from './write.js';
import { deriveRelationSuggestions } from './derive.js';

// The /boot digest (pure reader), re-exported so the CLI loads ONE module.
export { relationsBootDigest } from './read.js';

// The env seam (D3): `off` disables the semantic near-duplicate gate.
export const RELATIONS_SEMANTIC_ENV = 'IGRIS_RELATIONS_SEMANTIC';

// Every action's result — byte-for-byte the MCP tool's JSON text.
export interface RelationActionResult {
  ok: boolean;
  // `lookup`, `relate.declare`, `relate.remove`, `kinds.list|add|alias|merge`.
  action: string;
  refused?: RelationRefusal;
  data?: unknown;
  // `kinds add` only: `passed` | `refused` | `advisory` | `unavailable: <reason>`.
  semantic_check?: string;
}

// Injected seams. Production callers pass nothing (or a clock / an env).
export interface ActionDeps extends LookupDeps {
  // Override the default embedder (tests). The env seam still wins.
  embed?: EmbedFn | null;
  // The environment the seam is read from; default `process.env`.
  env?: NodeJS.ProcessEnv;
  // Override the semantic threshold (tests); default is the shipped one.
  semanticThreshold?: number | null;
}

// The default embedder, or null + why (the env seam).
export function resolveDefaultEmbed(env: NodeJS.ProcessEnv = process.env): { embed: EmbedFn | null; reason: string | null } {
  if ((env[RELATIONS_SEMANTIC_ENV] ?? '').trim().toLowerCase() === 'off') {
    return { embed: null, reason: `disabled (${RELATIONS_SEMANTIC_ENV}=off)` };
  }
  return { embed: generateEmbedding, reason: null };
}

type Args = Record<string, unknown>;

class ArgError extends Error {
  constructor(public readonly code: 'missing_argument' | 'invalid_argument', message: string) {
    super(message);
  }
}

function asArgs(raw: unknown): Args {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgError('invalid_argument', 'arguments must be an object.');
  }
  return raw as Args;
}

function reqString(a: Args, key: string): string {
  if (!(key in a) || a[key] === undefined) {
    throw new ArgError('missing_argument', `missing required argument '${key}' (validated in-band by the relations action layer).`);
  }
  const v = a[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ArgError('invalid_argument', `'${key}' must be a non-empty string.`);
  }
  return v;
}

function optString(a: Args, key: string): string | undefined {
  if (a[key] === undefined) return undefined;
  if (typeof a[key] !== 'string' || (a[key] as string).trim() === '') {
    throw new ArgError('invalid_argument', `'${key}' must be a non-empty string.`);
  }
  return a[key] as string;
}

function optBool(a: Args, key: string): boolean | undefined {
  if (a[key] === undefined) return undefined;
  if (typeof a[key] !== 'boolean') throw new ArgError('invalid_argument', `'${key}' must be a boolean.`);
  return a[key] as boolean;
}

function reqEnum<T extends string>(a: Args, key: string, values: readonly T[]): T {
  const v = reqString(a, key);
  if (!(values as readonly string[]).includes(v)) {
    throw new ArgError('invalid_argument', `'${key}' must be one of: ${values.join(', ')} (got '${v}').`);
  }
  return v as T;
}

function refusedResult(action: string, refused: RelationRefusal, semantic_check?: string): RelationActionResult {
  const r: RelationActionResult = { ok: false, action, refused };
  if (semantic_check !== undefined) r.semantic_check = semantic_check;
  return r;
}

function fromOutcome<T>(action: string, o: CoreOutcome<T>): RelationActionResult {
  if (!o.ok) return refusedResult(action, o.refused, o.semantic_check);
  const r: RelationActionResult = { ok: true, action, data: o.data };
  if (o.semantic_check !== undefined) r.semantic_check = o.semantic_check;
  return r;
}

const NOT_MIGRATED: RelationRefusal = {
  code: 'not_migrated',
  message: 'projects:3 not applied — the project_relations tables are absent on this brain (rebuild the CLI and respawn the brain).',
};

// Run `body`, turning an argument error into an in-band refusal.
async function guarded(action: () => string, db: Database.Database, body: () => Promise<RelationActionResult> | RelationActionResult): Promise<RelationActionResult> {
  try {
    if (!relationTablesPresent(db)) return refusedResult(action(), NOT_MIGRATED);
    return await body();
  } catch (err) {
    if (err instanceof ArgError) return refusedResult(action(), { code: err.code, message: err.message });
    throw err;
  }
}

const DIRECTIONS: readonly RelationDirection[] = ['out', 'in', 'both'];

// `igris_project_relations` / `igris project relations`: depth clamps to MAX_DEPTH; kind may be an alias.
export async function lookupAction(db: Database.Database, rawArgs: Args, deps: ActionDeps = {}): Promise<RelationActionResult> {
  return guarded(() => 'lookup', db, () => {
    const a = asArgs(rawArgs);
    const slug = reqString(a, 'slug');
    let depth = 1;
    if (a.depth !== undefined) {
      if (typeof a.depth !== 'number' || !Number.isInteger(a.depth) || a.depth < 1) {
        throw new ArgError('invalid_argument', `'depth' must be an integer from 1 to ${MAX_DEPTH}.`);
      }
      depth = Math.min(a.depth, MAX_DEPTH);
    }
    let direction: RelationDirection = 'both';
    if (a.direction !== undefined) direction = reqEnum(a, 'direction', DIRECTIONS);
    let kind: string | null = null;
    const kindArg = optString(a, 'kind');
    if (kindArg !== undefined) {
      const res = resolveKind(db, kindArg);
      if (!res.ok) return refusedResult('lookup', unknownKindRefusal(kindArg, res.closest));
      kind = res.kind.name;
    }
    const data = lookupRelations(db, {
      slug: slug.trim(),
      depth,
      direction,
      kind,
      check_watermarks: optBool(a, 'check_watermarks'),
      include_system: optBool(a, 'include_system'),
    }, { now: deps.now });
    return { ok: true, action: 'lookup', data };
  });
}

const RELATE_ACTIONS = ['declare', 'remove'] as const;

// `igris_project_relate`: `action` ∈ {declare, remove}; `detail` optional (declare).
export async function relateAction(db: Database.Database, rawArgs: Args): Promise<RelationActionResult> {
  let label = 'relate';
  return guarded(() => label, db, () => {
    const a = asArgs(rawArgs);
    const action = reqEnum(a, 'action', RELATE_ACTIONS);
    label = `relate.${action}`;
    const key = { from: reqString(a, 'from'), kind: reqString(a, 'kind'), to: reqString(a, 'to') };
    if (action === 'remove') return fromOutcome(label, removeRelation(db, key));
    const detail = a.detail === undefined ? undefined : (a.detail as Record<string, string>);
    return fromOutcome(label, declareRelation(db, { ...key, detail }));
  });
}

const KINDS_ACTIONS = ['list', 'add', 'alias', 'merge'] as const;

// `igris_project_relation_kinds`: per-action arguments are validated here (JSON Schema cannot express them).
export async function kindsAction(db: Database.Database, rawArgs: Args, deps: ActionDeps = {}): Promise<RelationActionResult> {
  let label = 'kinds';
  return guarded(() => label, db, async () => {
    const a = asArgs(rawArgs);
    const action = reqEnum(a, 'action', KINDS_ACTIONS);
    label = `kinds.${action}`;
    if (action === 'list') return { ok: true, action: label, data: { kinds: listKinds(db) } };
    if (action === 'alias') return fromOutcome(label, aliasKind(db, { name: reqString(a, 'name'), alias: reqString(a, 'alias') }));
    if (action === 'merge') return fromOutcome(label, mergeKinds(db, { retired: reqString(a, 'retired'), survivor: reqString(a, 'survivor') }));

    const input = {
      name: reqString(a, 'name'),
      meaning: reqString(a, 'meaning'),
      direction: reqString(a, 'direction'),
      forward_label: reqString(a, 'forward_label'),
      inverse_label: reqString(a, 'inverse_label'),
      example: reqString(a, 'example'),
      aliases: undefined as string[] | undefined,
    };
    if (a.aliases !== undefined) {
      if (!Array.isArray(a.aliases) || a.aliases.some((x) => typeof x !== 'string')) {
        throw new ArgError('invalid_argument', "'aliases' must be an array of strings.");
      }
      input.aliases = a.aliases as string[];
    }
    const def = resolveDefaultEmbed(deps.env ?? process.env);
    const embed = def.reason !== null ? null : deps.embed !== undefined ? deps.embed : def.embed;
    const reason = def.reason ?? (embed === null ? 'no embedder' : undefined);
    return fromOutcome(label, await addKind(db, input, {
      embed,
      unavailableReason: reason,
      ...(deps.semanticThreshold !== undefined ? { semanticThreshold: deps.semanticThreshold } : {}),
    }));
  });
}

// True when a successful write changed a row (the emit rule, D4).
export function relationChanged(r: RelationActionResult): boolean {
  return r.ok && typeof r.data === 'object' && r.data !== null && (r.data as { changed?: unknown }).changed === true;
}

// `igris_project_relations_derive`: manifest derivation → pending suggestions only.
export async function deriveAction(db: Database.Database, rawArgs: Args): Promise<RelationActionResult> {
  return guarded(() => 'relations.derive', db, () => {
    const slug = reqString(asArgs(rawArgs), 'slug').trim();
    if (db.prepare("SELECT 1 FROM pragma_table_info('suggestions') WHERE name = 'source_instance'").get() === undefined) {
      return refusedResult('relations.derive', { code: 'suggestions_unavailable', message: 'the suggestions store (subconscious v5) is absent on this brain.' });
    }
    return fromOutcome('relations.derive', deriveRelationSuggestions(db, slug));
  });
}
