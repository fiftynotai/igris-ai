/**
 * Brain Engine v5.0 — Event Bus
 *
 * Simple synchronous event bus with typed events and wildcard support.
 * Handler errors are caught and logged — they never crash the server.
 *
 * Wildcard patterns:
 *   "memory.*"  matches "memory.stored", "memory.promoted", etc.
 *   "*"         matches everything
 *
 * @module engine/bus
 * @author Fifty.ai
 */

import type { EventBus, EventHandler, EventPayload } from './types.js';

/**
 * Create a new event bus instance.
 *
 * @returns An EventBus with on/off/emit methods
 */
export function createEventBus(): EventBus {
  /** Map of exact event names to their handler sets */
  const handlers = new Map<string, Set<EventHandler>>();
  /** Map of wildcard patterns (stored as prefix before the .*) to their handler sets */
  const wildcardHandlers = new Map<string, Set<EventHandler>>();

  function on(event: string, handler: EventHandler): void {
    if (event.endsWith('.*')) {
      const prefix = event.slice(0, -2);
      if (!wildcardHandlers.has(prefix)) {
        wildcardHandlers.set(prefix, new Set());
      }
      wildcardHandlers.get(prefix)!.add(handler);
    } else if (event === '*') {
      // Global wildcard — match everything
      if (!wildcardHandlers.has('')) {
        wildcardHandlers.set('', new Set());
      }
      wildcardHandlers.get('')!.add(handler);
    } else {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
    }
  }

  function off(event: string, handler: EventHandler): void {
    if (event.endsWith('.*')) {
      const prefix = event.slice(0, -2);
      wildcardHandlers.get(prefix)?.delete(handler);
    } else if (event === '*') {
      wildcardHandlers.get('')?.delete(handler);
    } else {
      handlers.get(event)?.delete(handler);
    }
  }

  function emit(event: string, data: Record<string, unknown>): void {
    const payload: EventPayload = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };

    // Exact match handlers
    const exactHandlers = handlers.get(event);
    if (exactHandlers) {
      for (const handler of exactHandlers) {
        try {
          handler(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[bus] Handler error for "${event}": ${message}`);
        }
      }
    }

    // Wildcard handlers — match "memory.*" against "memory.stored"
    for (const [prefix, wildcardSet] of wildcardHandlers) {
      // Empty prefix = global wildcard "*"
      if (prefix === '' || event.startsWith(prefix + '.')) {
        for (const handler of wildcardSet) {
          try {
            handler(payload);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[bus] Wildcard handler error for "${event}" (pattern: "${prefix}.*"): ${message}`);
          }
        }
      }
    }
  }

  return { on, off, emit };
}
