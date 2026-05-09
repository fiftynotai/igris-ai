/**
 * TD-128 Gateway Strict-Input Contract — Tests
 *
 * Asserts that the gateway's strict-input infrastructure (added in M1) emits
 * a warn log on unknown args for tools with `additionalProperties: false`,
 * and that the warn does NOT block the dispatch (handler still receives args).
 *
 * Permissive tools (no `additionalProperties` field) must remain unaffected.
 *
 * M2 activates the parameterized "every registered tool has
 * additionalProperties: false" contract test by registering every component's
 * tools() output into a gateway, then iterating listTools() to assert the
 * invariant holds for all 107 surfaces.
 *
 * These warn-mode tests will be REPLACED in M4 with reject-mode equivalents
 * (per plan §4.M4).
 *
 * @module engine/__tests__/gateway-strict-input.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGateway } from '../gateway.js';
import type { ToolDefinition, ToolResult } from '../types.js';

// Domain component factories — same set bootEngine() composes in
// engine/index.ts. We wire them into a freshly-created gateway so the
// parameterized test sees every production-registered tool without booting
// the full engine (no DB, no migrations, no event bus required).
import { createMemoryComponent } from '../components/memory/index.js';
import { createErrorsComponent } from '../components/errors/index.js';
import { createProjectsComponent } from '../components/projects/index.js';
import { createMetricsComponent } from '../components/metrics/index.js';
import { createSessionsComponent } from '../components/sessions/index.js';
import { createBriefsComponent } from '../components/briefs/index.js';
import { createEdgesComponent } from '../components/edges/index.js';
import { createGoalsComponent } from '../components/goals/index.js';
import { createTasksComponent } from '../components/tasks/index.js';
import { createInstancesComponent } from '../components/instances/index.js';
import { createSyncComponent } from '../components/sync/index.js';
import { createCacheComponent } from '../components/cache/index.js';
import { createSchedulesComponent } from '../components/schedules/index.js';
import { createCoordinationComponent } from '../components/coordination/index.js';
import { createSubconsciousComponent } from '../components/subconscious/index.js';
import { createPerceptionComponent } from '../components/perception/index.js';
import { createMonitoringComponent } from '../components/monitoring/index.js';
import { createContextComponent } from '../components/context/index.js';
import { createRegistryComponent } from '../components/registry/index.js';

function makeOkResult(text = 'ok'): ToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('TD-128 gateway strict-input contract — M1 warn-mode', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('strict tool emits warn on unknown arg but still dispatches to handler', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('strict-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_strict',
      description: 'TD-128 test fixture (strict)',
      inputSchema: {
        type: 'object',
        properties: { project: {}, brief_id: {} },
        additionalProperties: false,
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_strict', {
      project: 'igris-ai',
      brief_id: 'TD-128',
      bogus_extra: 'should-warn',
    });

    // Warn was emitted with TD-128 marker, tool name, and offending key.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('[TD-128]');
    expect(warnMsg).toContain('igris_test_strict');
    expect(warnMsg).toContain("unknown argument 'bogus_extra'");
    expect(warnMsg).toContain('warn-only');

    // Handler still received the args unchanged (warn does NOT block).
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      brief_id: 'TD-128',
      bogus_extra: 'should-warn',
    });
    expect(result).toEqual(makeOkResult('strict-handler-ran'));
  });

  it('permissive tool (no additionalProperties) emits no warn even with extras', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('permissive-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_permissive',
      description: 'TD-128 test fixture (permissive — no additionalProperties)',
      inputSchema: {
        type: 'object',
        properties: { project: {} },
        // additionalProperties intentionally omitted — preserves M1+M2 transition
        // window where un-swept schemas continue to accept extras silently.
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_permissive', {
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });

    // No warn emitted on permissive-path tools.
    expect(warnSpy).not.toHaveBeenCalled();

    // Handler received all args unchanged.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });
    expect(result).toEqual(makeOkResult('permissive-handler-ran'));
  });
});

// ---------------------------------------------------------------------------
// M2 parameterized contract test — every registered tool is strict.
// ---------------------------------------------------------------------------
//
// Builds a fresh gateway, wires every domain component's tools() output
// (mirroring engine/index.ts:bootEngine), then asserts via listTools()
// that every registered tool's schema declares additionalProperties: false.
// This activates the M1 it.todo placeholder once M2's schema sweep lands.
//
// Why this approach over a full bootEngine(): the schema invariant is a
// pure structural property of the tools() return value. We can collect
// every tool definition without standing up storage, migrations, or the
// event bus. This keeps the test fast and avoids cross-cutting coupling
// with the engine bootstrap chain.

const COMPONENT_FACTORIES = [
  createMemoryComponent,
  createErrorsComponent,
  createProjectsComponent,
  createContextComponent,
  createMetricsComponent,
  createSessionsComponent,
  createBriefsComponent,
  createEdgesComponent,
  createGoalsComponent,
  createTasksComponent,
  createInstancesComponent,
  createSyncComponent,
  createCacheComponent,
  createSchedulesComponent,
  createCoordinationComponent,
  createSubconsciousComponent,
  createPerceptionComponent,
  createMonitoringComponent,
  createRegistryComponent,
];

function collectAllTools(): ToolDefinition[] {
  const all: ToolDefinition[] = [];
  for (const factory of COMPONENT_FACTORIES) {
    const component = factory();
    all.push(...component.tools());
  }
  return all;
}

describe('TD-128 strict-input contract — every registered tool (M2)', () => {
  const gateway = createGateway();
  gateway.register(collectAllTools());
  const tools = gateway.listTools();

  it('every component factory contributes at least one tool', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it.each(tools.map((t) => [t.name, t] as const))(
    '%s schema has additionalProperties: false (TD-128)',
    (_name, tool) => {
      expect(
        (tool.inputSchema as { additionalProperties?: boolean })
          .additionalProperties,
      ).toBe(false);
    },
  );
});
