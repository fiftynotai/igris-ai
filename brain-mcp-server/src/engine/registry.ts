/**
 * Brain Engine v5.0 — Component Registry
 *
 * Loads components, resolves dependencies via topological sort,
 * and orchestrates the boot sequence: migrations -> init -> tools -> events.
 * Shutdown runs in reverse order.
 *
 * @module engine/registry
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentConfig,
  ComponentContext,
  ComponentLogger,
  StorageAdapter,
  EventBus,
  ToolDefinition,
} from './types.js';

/** Internal tracking of a registered component */
interface RegisteredComponent {
  component: BrainComponent;
  config: ComponentConfig;
  initialized: boolean;
}

/**
 * Create a component registry.
 *
 * The registry manages the lifecycle of all domain components:
 * registration, dependency resolution, boot, and shutdown.
 */
export function createRegistry(storage: StorageAdapter, bus: EventBus) {
  const components = new Map<string, RegisteredComponent>();
  const bootOrder: string[] = [];
  const allTools: ToolDefinition[] = [];

  /**
   * Register a component with the registry.
   * Does NOT initialize it — call boot() after all components are registered.
   */
  function register(component: BrainComponent, config: ComponentConfig): void {
    if (components.has(component.name)) {
      throw new Error(`Component "${component.name}" is already registered`);
    }
    components.set(component.name, {
      component,
      config,
      initialized: false,
    });
  }

  /**
   * Resolve dependencies via topological sort (Kahn's algorithm).
   * Returns component names in a valid initialization order.
   */
  function resolveDependencies(): string[] {
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(name: string): void {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }

      const entry = components.get(name);
      if (!entry) {
        throw new Error(`Missing dependency: "${name}"`);
      }

      visiting.add(name);

      for (const dep of entry.component.depends) {
        // Only resolve dependencies that are registered and enabled
        const depEntry = components.get(dep);
        if (!depEntry) {
          throw new Error(
            `Component "${name}" depends on "${dep}" which is not registered`
          );
        }
        if (!depEntry.config.enabled) {
          throw new Error(
            `Component "${name}" depends on "${dep}" which is disabled`
          );
        }
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    }

    // Visit only enabled components
    for (const [name, entry] of components) {
      if (entry.config.enabled) {
        visit(name);
      }
    }

    return sorted;
  }

  /**
   * Create a scoped logger for a component.
   */
  function createLogger(componentName: string): ComponentLogger {
    return {
      info(message: string) {
        console.error(`[${componentName}] ${message}`);
      },
      warn(message: string) {
        console.error(`[${componentName}] WARN: ${message}`);
      },
      error(message: string) {
        console.error(`[${componentName}] ERROR: ${message}`);
      },
    };
  }

  /**
   * Boot all registered and enabled components in dependency order.
   *
   * For each component:
   * 1. Run schema migrations
   * 2. Call init(ctx)
   * 3. Collect tool definitions
   * 4. Wire event listeners
   * 5. Emit component.loaded event
   */
  function boot(): ToolDefinition[] {
    const order = resolveDependencies();
    bootOrder.length = 0;
    bootOrder.push(...order);
    allTools.length = 0;

    for (const name of order) {
      const entry = components.get(name)!;
      const { component, config } = entry;
      const log = createLogger(name);

      try {
        // 1. Run migrations
        const migrations = component.schema();
        if (migrations.length > 0) {
          storage.runMigrations(name, migrations);
        }

        // 2. Init with context
        const ctx: ComponentContext = {
          storage,
          bus,
          log,
          config: { ...config },
        };
        component.init(ctx);
        entry.initialized = true;

        // 3. Collect tools
        const tools = component.tools();
        allTools.push(...tools);

        // 4. Wire event listeners (component sets them up in init())
        // Events are self-wired by components during init() via ctx.bus.on()

        // 5. Emit lifecycle event
        bus.emit('component.loaded', {
          component: name,
          version: component.version,
          toolCount: tools.length,
        });

        log.info(
          `Loaded v${component.version} (${tools.length} tools, ${migrations.length} migrations)`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to load: ${message}`);
        bus.emit('component.error', { component: name, error: message });
        throw new Error(`Failed to boot component "${name}": ${message}`);
      }
    }

    return allTools;
  }

  /**
   * Shut down all initialized components in reverse boot order.
   */
  function shutdown(): void {
    const reversed = [...bootOrder].reverse();
    for (const name of reversed) {
      const entry = components.get(name);
      if (entry?.initialized) {
        try {
          entry.component.destroy();
          entry.initialized = false;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[registry] Error shutting down "${name}": ${message}`);
        }
      }
    }
  }

  /**
   * Get the names of all registered components.
   */
  function listComponents(): string[] {
    return Array.from(components.keys());
  }

  /**
   * Get the boot order (after boot() has been called).
   */
  function getBootOrder(): string[] {
    return [...bootOrder];
  }

  return {
    register,
    boot,
    shutdown,
    listComponents,
    getBootOrder,
  };
}

/** Type of the registry returned by createRegistry */
export type ComponentRegistry = ReturnType<typeof createRegistry>;
