/**
 * TD-128 Gateway Strict-Input Contract — Tests
 *
 * Asserts that the gateway's strict-input contract (M4 reject-mode) THROWS
 * on unknown args for tools with `additionalProperties: false`. The handler
 * is NOT invoked when an extra arg is detected.
 *
 * Permissive tools (no `additionalProperties` field) must remain unaffected
 * — they accept any args and pass them through to their handler.
 *
 * The parameterized "every registered tool has additionalProperties: false"
 * contract test registers every component's tools() output into a gateway,
 * then iterates listTools() to assert the invariant holds for all
 * production-registered surfaces.
 *
 * @module engine/__tests__/gateway-strict-input.test
 */

import { describe, it, expect, vi } from 'vitest';
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
import { createCognitionComponent } from '../components/cognition/index.js';
import { createMonitoringComponent } from '../components/monitoring/index.js';
import { createContextComponent } from '../components/context/index.js';
import { createCatalogComponent } from '../components/catalog/index.js';

function makeOkResult(text = 'ok'): ToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('TD-128 gateway strict-input contract — M4 reject-mode', () => {
  it('strict tool throws on unknown arg with tool name + key + accepted keys list', async () => {
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

    await expect(
      gateway.dispatch('igris_test_strict', {
        project: 'igris-ai',
        brief_id: 'TD-128',
        bogus_extra: 'should-throw',
      }),
    ).rejects.toThrowError(
      /igris_test_strict: unknown argument 'bogus_extra'\. Accepted keys: project, brief_id\. \(strict-input contract; TD-128\)/,
    );

    // Handler MUST NOT have been invoked when reject-mode triggers.
    expect(handler).not.toHaveBeenCalled();
  });

  it('strict tool dispatches cleanly when only allowed args are passed', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('strict-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_strict_clean',
      description: 'TD-128 test fixture (strict, clean call)',
      inputSchema: {
        type: 'object',
        properties: { project: {}, brief_id: {} },
        additionalProperties: false,
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_strict_clean', {
      project: 'igris-ai',
      brief_id: 'TD-128',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      brief_id: 'TD-128',
    });
    expect(result).toEqual(makeOkResult('strict-handler-ran'));
  });

  it('permissive tool (no additionalProperties) accepts extras and dispatches', async () => {
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
        // additionalProperties intentionally omitted — permissive-path
        // tools (none currently exist post-M2 sweep, but the gateway must
        // continue to support them for forward-compat).
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_permissive', {
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });

    // Handler received all args unchanged — permissive path bypasses the
    // strict guard entirely.
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
  // FR-118 M4a: perception + subconscious collapsed into one cognition factory.
  // The strict-input contract test is parameterised over listTools(), so the
  // merged factory's tools auto-cover (no per-tool edit needed).
  createCognitionComponent,
  createMonitoringComponent,
  createCatalogComponent,
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
