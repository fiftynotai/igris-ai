/** FR-276: machine-local execution ledger; deliberately excluded from sync/export. */
import type { Migration } from '../../types.js';
export const attentionMigrations: Migration[] = [{ version: 1, description: 'FR-276 local attention sessions, evidence and published-tool inventory', sql: `
CREATE TABLE IF NOT EXISTS attention_sessions (
 id TEXT PRIMARY KEY, project TEXT, instance_id TEXT, harness TEXT, harness_session_id TEXT,
 machine_id TEXT, parent_session_id TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','interrupted')),
 current_epoch INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
 coverage TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_sessions_project ON attention_sessions(project, started_at, id);
CREATE TABLE IF NOT EXISTS attention_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES attention_sessions(id),
 sequence INTEGER NOT NULL, context_epoch INTEGER NOT NULL, actor_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('delivery','invocation','availability','epoch','end')),
 node_type TEXT, node_project TEXT, node_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('started','succeeded','failed','unknown')),
 extent TEXT CHECK(extent IN ('preview','full','unknown')), origin TEXT NOT NULL CHECK(origin IN ('loader','tool_boundary','harness','self_report')),
 source_revision TEXT, bytes INTEGER, reason TEXT, observed_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(session_id, sequence), UNIQUE(session_id, operation_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_attention_events_epoch ON attention_events(session_id, context_epoch, sequence);
CREATE TABLE IF NOT EXISTS attention_tool_inventory (
 provider TEXT NOT NULL, name TEXT NOT NULL, observed_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(provider, name)
);
` }, { version: 2, description: 'FR-276 nullable selection provenance for session focus', sql: `
ALTER TABLE attention_events ADD COLUMN selection TEXT;
` }];
