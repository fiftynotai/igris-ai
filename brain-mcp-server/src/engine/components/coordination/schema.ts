/**
 * Brain Engine v7.0 — Coordination Component Schema
 *
 * Seeds default agent capabilities and coordination configuration
 * into the tables created by the tasks v2 migration. The coordination
 * component depends on the tasks component, so these tables are
 * guaranteed to exist by the time this runs.
 *
 * @module engine/components/coordination/schema
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';

/**
 * Initialize coordination schema by seeding default data.
 *
 * Called during the coordination component's init() phase.
 * Uses INSERT OR IGNORE to be idempotent — safe to call on every boot.
 */
export function initCoordinationSchema(): void {
  const db = getDb();

  // Seed default agent capabilities
  const seedCapabilities = db.prepare(`
    INSERT OR IGNORE INTO agent_capabilities (agent, capability)
    VALUES (?, ?)
  `);

  const defaultCapabilities: [string, string][] = [
    ['architect', 'plan'],
    ['architect', 'analyze'],
    ['architect', 'review'],
    ['forger', 'code'],
    ['forger', 'refactor'],
    ['forger', 'document'],
    ['sentinel', 'test'],
    ['sentinel', 'verify'],
    ['sentinel', 'coverage'],
    ['warden', 'review'],
    ['warden', 'audit'],
    ['warden', 'quality'],
    ['mender', 'debug'],
    ['mender', 'diagnose'],
    ['mender', 'fix'],
    ['seeker', 'research'],
    ['seeker', 'investigate'],
    ['seeker', 'explore'],
    ['sage', 'code'],
    ['sage', 'flutter'],
    ['sage', 'mvvm'],
  ];

  db.transaction(() => {
    for (const [agent, capability] of defaultCapabilities) {
      seedCapabilities.run(agent, capability);
    }
  })();

  // Seed default coordination config
  const seedConfig = db.prepare(`
    INSERT OR IGNORE INTO coordination_config (key, value)
    VALUES (?, ?)
  `);

  const defaultConfig: [string, string][] = [
    ['autonomous_enabled', 'false'],
    ['auto_route_enabled', 'false'],
    ['max_retries_default', '3'],
    ['priority_ceiling', '1'],
    ['priority_floor', '5'],
    ['self_healing_enabled', 'true'],
  ];

  db.transaction(() => {
    for (const [key, value] of defaultConfig) {
      seedConfig.run(key, value);
    }
  })();
}
