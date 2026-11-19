// FR-273 projects:3 — the relation tables + 5 seed kinds. Rules (tombstones,
// no FK, no vocabulary CHECK, fixed seed timestamps, never declines): MAINTAINING
// row "project relations store".

import type { Migration } from '../../../types.js';

// Fixed on every machine, so LWW never churns a seed (D2).
export const SEED_KINDS_TIMESTAMP = '2026-09-29 00:00:00';

export interface SeedRelationKind {
  name: string;
  meaning: string;
  direction: string;
  forward_label: string;
  inverse_label: string;
  example: string;
  aliases: readonly string[];
}

// REGISTRY ORDER (lookup + /boot sort by it); meanings are the brief's.
export const SEED_RELATION_KINDS: readonly SeedRelationKind[] = [
  {
    name: 'uses_package',
    meaning: "A imports B's code (compile-time)",
    direction: 'A → B: from = the consumer, to = the package it imports',
    forward_label: 'uses',
    inverse_label: 'used by',
    example: 'moca-agent-web uses_package moca-agent-flutter-client',
    aliases: ['depends_on_package', 'imports_package', 'uses'],
  },
  {
    name: 'calls_service',
    meaning: 'A calls B at runtime (API, SSE, RPC)',
    direction: 'A → B: from = the caller, to = the service it calls',
    forward_label: 'calls',
    inverse_label: 'called by',
    example: 'moca-agent-flutter-client calls_service moca-ai-agent',
    aliases: ['calls', 'client_of', 'consumes_api'],
  },
  {
    name: 'white_label_of',
    meaning: 'A is a client-branded build of base B',
    direction: 'A → B: from = the branded build, to = its base',
    forward_label: 'is a white-label of',
    inverse_label: 'white-labelled as',
    example: 'moca-hadir-app white_label_of hadir',
    aliases: ['branded_build_of', 'white_label'],
  },
  {
    name: 'variant_of',
    meaning: 'A is a narrower build of B for another audience of the same client',
    direction: 'A → B: from = the narrower build, to = the build it narrows',
    forward_label: 'is a variant of',
    inverse_label: 'has variant',
    example: 'moca-hadir-app variant_of moca-app',
    aliases: ['subset_of', 'variant'],
  },
  {
    name: 'supersedes',
    meaning: 'A replaces B',
    direction: 'A → B: from = the replacement, to = the project it replaces',
    forward_label: 'supersedes',
    inverse_label: 'superseded by',
    example: 'hadir supersedes attendance_app',
    aliases: ['replaces', 'successor_of'],
  },
];

export const RELATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS project_relation_kinds (
  name TEXT PRIMARY KEY,
  meaning TEXT NOT NULL,
  direction TEXT NOT NULL,
  forward_label TEXT NOT NULL,
  inverse_label TEXT NOT NULL,
  example TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT 'declared',
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_slug, kind, to_slug)
);
CREATE INDEX IF NOT EXISTS idx_project_relations_to ON project_relations(to_slug);
`;

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function seedKindsSql(): string {
  return SEED_RELATION_KINDS.map((k) =>
    'INSERT OR IGNORE INTO project_relation_kinds ' +
    '(name, meaning, direction, forward_label, inverse_label, example, aliases, status, merged_into, created_at, updated_at) VALUES (' +
    [
      lit(k.name), lit(k.meaning), lit(k.direction), lit(k.forward_label),
      lit(k.inverse_label), lit(k.example), lit([...k.aliases].sort().join(',')),
      "'active'", 'NULL', lit(SEED_KINDS_TIMESTAMP), lit(SEED_KINDS_TIMESTAMP),
    ].join(', ') +
    ');',
  ).join('\n');
}

export const relationsMigrationV3: Migration = {
  version: 3,
  description: 'project_relation_kinds + project_relations (FR-273) — synced, tombstone removal, 5 seed kinds',
  sql: `${RELATION_TABLES_SQL}\n${seedKindsSql()}`,
};
