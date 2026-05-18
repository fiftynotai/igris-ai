/**
 * Brain Engine v7.0 — Sessions Component Schema
 *
 * Database migrations for the sessions component's `session_files` table.
 *
 * Version 1 creates the `session_files` table (idempotent with the legacy
 * v7 inline DDL — every existing brain DB already records `sessions@1`, so
 * v1 never re-runs there; it survives only so a fresh DB still builds the
 * table). It is byte-equivalent to the literal previously inlined in
 * `index.ts`'s `schema()`.
 *
 * Version 2 (FR-130) gives `session_files` per-instance keying
 * (`instance_id`) and a 3-state lifecycle column (`state`). It is part of
 * the FR-126 multi-harness session re-architecture (Child A).
 *
 * Design note (L-142): the owning component owns its ALTERs. The engine
 * migration runner (`engine/storage/sqlite.ts`) tracks per-component
 * versions in `engine_migrations` and applies only migrations with
 * `version > currentVersion`, each wrapped in its own transaction. This
 * matches the `goals/schema.ts` and `tasks/schema.ts` pattern.
 *
 * @module engine/components/sessions/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/**
 * Sessions schema migrations.
 *
 * Version 1: session_files table + project index (idempotent with legacy v7).
 * Version 2: instance_id + state columns + 2 lookup indexes (FR-130).
 */
export const sessionMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create session_files table (idempotent with legacy v7)',
    sql: `
            CREATE TABLE IF NOT EXISTS session_files (
              id TEXT PRIMARY KEY,
              project TEXT NOT NULL,
              filename TEXT NOT NULL,
              content TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(project, filename)
            );
            CREATE INDEX IF NOT EXISTS idx_session_files_project ON session_files(project);
          `,
  },
  {
    version: 2,
    description: 'Add instance_id + state columns to session_files (per-instance keying + lifecycle)',
    sql: `
      -- FR-130: session_files gains per-instance keying + 3-state lifecycle.
      -- Plain ALTER ADD COLUMN — no table rebuild. Adding columns + a CHECK on a
      -- NEW column is permitted by ALTER ADD COLUMN; mutating an existing column's
      -- constraint would not be (that needs a rebuild — not the case here).
      ALTER TABLE session_files ADD COLUMN instance_id TEXT;
      ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live'
        CHECK (state IN ('live','rested','archived'));
      CREATE INDEX IF NOT EXISTS idx_session_files_instance ON session_files(instance_id);
      CREATE INDEX IF NOT EXISTS idx_session_files_state ON session_files(state);
    `,
  },
];
