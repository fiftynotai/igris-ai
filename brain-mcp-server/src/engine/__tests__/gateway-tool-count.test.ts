/**
 * TD-171 M4 — Pinned tool-count contract test.
 *
 * Asserts the registered surface on the gateway is exactly the 124 tools
 * targeted by TD-171 closeout (107 baseline + 14 net-new across M0-M4)
 * plus 1 net-new from FR-130 (igris_session_file_list)
 * plus 2 net-new from FR-127 (igris_brief_claim / igris_brief_release).
 *
 * Why a literal-count test:
 *   - The tool-name drift validator (`scripts/validate_brain_stewardship_enums.sh`,
 *     extended in TD-171 M4 §10) catches doc <-> gateway drift but does NOT
 *     police the absolute total. A future tool added without an accompanying
 *     brief / count-bump would still pass the drift validator.
 *   - This test fails loudly the moment the count moves either way, forcing
 *     a deliberate bump (and therefore a new brief) for any addition or
 *     removal. Mirrors TD-171's success criteria — the tool count is a
 *     load-bearing number now, not an emergent one.
 *
 * If a legitimate change moves the count, update the literal here in the
 * same commit that moves it. Do NOT loosen the assertion.
 *
 * Pattern note:
 *   We mirror `gateway-strict-input.test.ts`'s component-factory list rather
 *   than calling `bootEngine()` because the count contract is a property of
 *   the registered factories — no DB / migrations / event bus is needed.
 *
 * @module engine/__tests__/gateway-tool-count.test
 */

import { describe, it, expect } from 'vitest';
import { createGateway } from '../gateway.js';
import type { ToolDefinition } from '../types.js';

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

describe('gateway tool count (TD-171 closeout)', () => {
  const gateway = createGateway();
  gateway.register(collectAllTools());
  const tools = gateway.listTools();

  it('exposes exactly 125 tools (TD-171 closeout: 107 baseline + 14 net-new + 1 FR-130 igris_session_file_list + 2 FR-127 igris_brief_claim/release + 1 FR-200 igris_memory_mark_promoted)', () => {
    // If this assertion fires, the registered surface drifted. Either a tool
    // was added/removed without bumping the count here, or the closeout
    // baseline shifted intentionally. In either case: open a brief, decide,
    // and update this literal in the same commit that moves the surface.
    expect(tools.length).toBe(125);
  });

  it('every component factory contributes at least one tool', () => {
    // Sanity guard: a factory that silently stopped registering tools would
    // pass the strict-input contract (no permissive schemas) but quietly
    // shrink the surface. The total-count assertion above catches this too,
    // but a per-factory probe localizes the diagnosis when it does fire.
    for (const factory of COMPONENT_FACTORIES) {
      const component = factory();
      expect(
        component.tools().length,
        `component '${component.name}' contributed zero tools`,
      ).toBeGreaterThan(0);
    }
  });
});
