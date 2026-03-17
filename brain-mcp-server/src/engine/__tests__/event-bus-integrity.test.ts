/**
 * Event Bus Integrity Integration Tests
 *
 * Uses static source analysis to verify that:
 * 1. Every emitted event is declared in the component's events().emits
 * 2. Every declared emit has a matching bus.emit() call in source
 * 3. Every declared listen has a matching bus.on() in init()
 * 4. Every bus.on() has a matching bus.off() in destroy()
 *
 * These tests read source files directly and regex-match patterns,
 * comparing against the component event declarations. No database
 * or runtime mocking needed.
 *
 * @module engine/__tests__/event-bus-integrity.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ENGINE_DIR = resolve(import.meta.dirname, '..');
const COMPONENTS_DIR = join(ENGINE_DIR, 'components');
const REGISTRY_PATH = join(ENGINE_DIR, 'registry.ts');
const ENGINE_INDEX_PATH = join(ENGINE_DIR, 'index.ts');

// ---------------------------------------------------------------------------
// Infrastructure events (emitted by engine, not by components)
// ---------------------------------------------------------------------------

/** Events emitted by engine infrastructure, not by individual components */
const INFRASTRUCTURE_EVENTS = new Set([
  'engine.ready',
  'component.loaded',
  'component.error',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all component directories */
function getComponentDirs(): string[] {
  return readdirSync(COMPONENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Get all source files for a component (index.ts, handlers.ts, daemon.ts) */
function getComponentSourceFiles(componentName: string): string[] {
  const dir = join(COMPONENTS_DIR, componentName);
  const sourceFiles = ['index.ts', 'handlers.ts', 'daemon.ts'];
  return sourceFiles
    .map((f) => join(dir, f))
    .filter((f) => existsSync(f));
}

/** Read file content as string */
function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

/** Extract declared emits from a component's events() method */
function extractDeclaredEmits(source: string): string[] {
  // Match: { name: 'event.name', description: '...' }
  const emitsSection = source.match(/emits:\s*\[([\s\S]*?)\]/);
  if (!emitsSection) return [];

  const names: string[] = [];
  const nameRegex = /name:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(emitsSection[1])) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** Extract declared listens from a component's events() method */
function extractDeclaredListens(source: string): string[] {
  const listensSection = source.match(/listens:\s*\[([\s\S]*?)\]/);
  if (!listensSection) return [];

  const names: string[] = [];
  const nameRegex = /name:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(listensSection[1])) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** Extract all bus.emit('event.name', ...) calls from source */
function extractBusEmits(source: string): string[] {
  const names: string[] = [];
  // Match bus.emit('event.name' or _handlerCtx.bus.emit('event.name' or ctx.bus.emit('event.name'
  const emitRegex = /(?:bus|_handlerCtx\.bus|ctx\.bus|_ctx\?\.bus|_ctx\.bus)\.emit\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = emitRegex.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** Extract all bus.on('event.name', ...) calls from source */
function extractBusOn(source: string): string[] {
  const names: string[] = [];
  const onRegex = /(?:bus|ctx\.bus|_ctx\.bus)\.on\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = onRegex.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** Extract all bus.off('event.name', ...) calls from source */
function extractBusOff(source: string): string[] {
  const names: string[] = [];
  const offRegex = /(?:bus|ctx\.bus|_ctx\.bus)\.off\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = offRegex.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Test Group 1: Every emitted event is declared
// ---------------------------------------------------------------------------

describe('Event Bus Integrity', () => {
  const componentNames = getComponentDirs();

  describe('every emitted event is declared in events().emits', () => {
    for (const name of componentNames) {
      it(`${name}: all bus.emit() calls match declared emits`, () => {
        const sourceFiles = getComponentSourceFiles(name);
        const indexSource = readSource(join(COMPONENTS_DIR, name, 'index.ts'));
        const declaredEmits = new Set(extractDeclaredEmits(indexSource));

        // Collect all emits across all source files for this component
        const allEmits: string[] = [];
        for (const filePath of sourceFiles) {
          const source = readSource(filePath);
          allEmits.push(...extractBusEmits(source));
        }

        // Filter out infrastructure events (emitted by engine, not by components)
        const componentEmits = allEmits.filter((e) => !INFRASTRUCTURE_EVENTS.has(e));

        // Deduplicate
        const uniqueEmits = [...new Set(componentEmits)];

        for (const emittedEvent of uniqueEmits) {
          expect(
            declaredEmits.has(emittedEvent),
            `Component "${name}" emits "${emittedEvent}" but does not declare it in events().emits`
          ).toBe(true);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Test Group 2: Every declared emit has a matching bus.emit() call
  // -------------------------------------------------------------------------

  describe('every declared emit has a matching bus.emit() call', () => {
    for (const name of componentNames) {
      it(`${name}: all declared emits have bus.emit() calls`, () => {
        const sourceFiles = getComponentSourceFiles(name);
        const indexSource = readSource(join(COMPONENTS_DIR, name, 'index.ts'));
        const declaredEmits = extractDeclaredEmits(indexSource);

        if (declaredEmits.length === 0) return; // Skip components with no emits

        // Collect all emits across all source files
        const allEmits = new Set<string>();
        for (const filePath of sourceFiles) {
          const source = readSource(filePath);
          for (const emit of extractBusEmits(source)) {
            allEmits.add(emit);
          }
        }

        for (const declared of declaredEmits) {
          expect(
            allEmits.has(declared),
            `Component "${name}" declares emit "${declared}" but no bus.emit('${declared}') found in source files`
          ).toBe(true);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Test Group 3: Every declared listen has a matching bus.on() in init()
  // -------------------------------------------------------------------------

  describe('every declared listen has a matching bus.on() in init()', () => {
    for (const name of componentNames) {
      it(`${name}: all declared listens have bus.on() calls`, () => {
        const indexSource = readSource(join(COMPONENTS_DIR, name, 'index.ts'));
        const declaredListens = extractDeclaredListens(indexSource);

        if (declaredListens.length === 0) return; // Skip components with no listens

        const busOnCalls = new Set(extractBusOn(indexSource));

        for (const listen of declaredListens) {
          expect(
            busOnCalls.has(listen),
            `Component "${name}" declares listen for "${listen}" but no bus.on('${listen}') found`
          ).toBe(true);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Test Group 4: Every bus.on() has matching bus.off() in destroy()
  // -------------------------------------------------------------------------

  describe('every bus.on() has matching bus.off() in destroy()', () => {
    for (const name of componentNames) {
      it(`${name}: all bus.on() calls have matching bus.off() calls`, () => {
        const indexSource = readSource(join(COMPONENTS_DIR, name, 'index.ts'));
        const onCalls = extractBusOn(indexSource);

        if (onCalls.length === 0) return; // Skip components with no listeners

        const offCalls = new Set(extractBusOff(indexSource));

        for (const eventName of onCalls) {
          expect(
            offCalls.has(eventName),
            `Component "${name}" has bus.on('${eventName}') but no matching bus.off('${eventName}') in destroy()`
          ).toBe(true);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Additional: Infrastructure event verification
  // -------------------------------------------------------------------------

  describe('infrastructure events', () => {
    it('registry emits component.loaded and component.error', () => {
      const registrySource = readSource(REGISTRY_PATH);
      const emits = extractBusEmits(registrySource);

      expect(emits).toContain('component.loaded');
      expect(emits).toContain('component.error');
    });

    it('engine index emits engine.ready', () => {
      const engineSource = readSource(ENGINE_INDEX_PATH);
      const emits = extractBusEmits(engineSource);

      expect(emits).toContain('engine.ready');
    });
  });
});
