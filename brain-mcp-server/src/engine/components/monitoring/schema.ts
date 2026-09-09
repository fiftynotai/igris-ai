/**
 * Brain Engine v7.0 -- Monitoring Component Schema
 *
 * Defines the event_log table for storing engine event history.
 * Events are logged by the monitoring component which listens to
 * all orphan engine events (schedules, cache, coordination).
 *
 * @module engine/components/monitoring/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

export const monitoringMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create event_log table with indexes',
    sql: `
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        component TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        machine_hostname TEXT,
        project_slug TEXT,
        instance_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_event_log_name ON event_log(event_name);
      CREATE INDEX IF NOT EXISTS idx_event_log_component ON event_log(component);
      CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
    `,
  },
  {
    version: 2,
    // BR-100 (docs/COGNITION.md): NOT in SYNC_TABLES — L-849 inverted, non-replication is the contract.
    description: 'BR-100: event_log.machine_id (not replicated)',
    sql: 'ALTER TABLE event_log ADD COLUMN machine_id TEXT;',
  },
];
