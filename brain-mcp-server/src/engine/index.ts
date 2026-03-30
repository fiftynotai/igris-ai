/**
 * Brain Engine v5.0 — Engine Bootstrap
 *
 * Orchestrates the full engine lifecycle:
 * 1. Create storage adapter (SQLite)
 * 2. Create event bus
 * 3. Create component registry
 * 4. Register all domain components
 * 5. Boot (migrations + init + tools + events)
 * 6. Create API gateway
 * 7. Bridge db.ts via setAdapter()
 *
 * @module engine/index
 * @author Fifty.ai
 */

import type { EngineConfig, ComponentConfig } from './types.js';
import { createSqliteAdapter } from './storage/sqlite.js';
import { createEventBus } from './bus.js';
import { createRegistry } from './registry.js';
import { createGateway } from './gateway.js';
import type { ApiGateway } from './gateway.js';
import type { ComponentRegistry } from './registry.js';
import type { StorageAdapter, EventBus } from './types.js';

// Domain components
import { createMemoryComponent } from './components/memory/index.js';
import { createErrorsComponent } from './components/errors/index.js';
import { createProjectsComponent } from './components/projects/index.js';
import { createMetricsComponent } from './components/metrics/index.js';
import { createSessionsComponent } from './components/sessions/index.js';
import { createBriefsComponent } from './components/briefs/index.js';
import { createTasksComponent } from './components/tasks/index.js';
import { createInstancesComponent } from './components/instances/index.js';
import { createSyncComponent } from './components/sync/index.js';
import { createCacheComponent } from './components/cache/index.js';
import { createSchedulesComponent } from './components/schedules/index.js';
import { createCoordinationComponent } from './components/coordination/index.js';
import { createMonitoringComponent } from './components/monitoring/index.js';
import { createContextComponent } from './components/context/index.js';
import { createRegistryComponent } from './components/registry/index.js';

// db.ts bridge
import { setAdapter, migrateSchema } from '../db.js';

/** Result of engine bootstrap */
export interface Engine {
  gateway: ApiGateway;
  registry: ComponentRegistry;
  storage: StorageAdapter;
  bus: EventBus;
  shutdown(): void;
}

/** Default component config — all enabled */
const DEFAULT_COMPONENT_CONFIG: ComponentConfig = { enabled: true };

/**
 * Boot the Brain Engine.
 *
 * Creates all infrastructure, registers domain components, runs migrations,
 * initializes components, and returns a ready-to-use gateway.
 *
 * @param config - Engine configuration (db path, component settings)
 * @returns The booted engine with gateway, registry, and shutdown handle
 */
export function bootEngine(config: EngineConfig): Engine {
  console.error('[engine] Booting Brain Engine v5.0...');

  // 1. Create storage adapter
  const storage = createSqliteAdapter(config.dbPath);

  // 2. Run legacy migrations on the engine's connection BEFORE bridging.
  //    This ensures v1-v9 tables (including sync_queue, brief_files,
  //    session_files, definition_files, agent_events) exist on fresh DBs.
  migrateSchema(storage.rawConnection);

  // 3. Bridge db.ts — all tool modules that call getDb() now use this connection
  setAdapter(storage);

  // 4. Create event bus
  const bus = createEventBus();

  // 5. Create registry
  const registry = createRegistry(storage, bus);

  // 6. Register domain components (all 15)
  const componentFactories = [
    createMemoryComponent,
    createErrorsComponent,
    createProjectsComponent,
    createContextComponent,
    createMetricsComponent,
    createSessionsComponent,
    createBriefsComponent,
    createTasksComponent,
    createInstancesComponent,
    createSyncComponent,
    createCacheComponent,
    createSchedulesComponent,
    createCoordinationComponent,
    createMonitoringComponent,
    createRegistryComponent,
  ];

  for (const factory of componentFactories) {
    const component = factory();
    const componentConfig = config.components[component.name] ?? DEFAULT_COMPONENT_CONFIG;
    registry.register(component, componentConfig);
  }

  // 7. Boot — runs migrations, init, collects tools
  const allTools = registry.boot();

  // 8. Create gateway and register tools
  const gateway = createGateway();
  gateway.register(allTools);

  // 9. Emit engine.ready — components that need dispatchTool can capture it
  bus.emit('engine.ready', { dispatch: gateway.dispatch.bind(gateway) });

  console.error(
    `[engine] Brain Engine v5.0 ready — ${gateway.toolCount()} tools, ${registry.getBootOrder().length} components`
  );

  // Shutdown function
  function shutdown(): void {
    console.error('[engine] Shutting down Brain Engine...');
    registry.shutdown();
    storage.close();
  }

  return { gateway, registry, storage, bus, shutdown };
}

export type { EngineConfig, ApiGateway, ComponentRegistry };
