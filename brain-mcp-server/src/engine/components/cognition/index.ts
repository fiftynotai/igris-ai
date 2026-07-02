/**
 * Brain Engine v7.1 — Cognition component factory (FR-118 M4a).
 *
 * THE COLLAPSE. Perception and subconscious were two separate `BrainComponent`s
 * (`createPerceptionComponent`, `createSubconsciousComponent`). FR-118 unified
 * them onto one agnostic LLM-extraction host (the engine + backend + registry);
 * M4a finishes the unification by collapsing the TWO component factories into
 * ONE `createCognitionComponent()`. The cognition subsystem is now a single
 * engine component that owns BOTH instances' surfaces:
 *
 *   - schema   : perception watermarks + suggestions v3 + dismissed_patterns,
 *                run UNDER THEIR ORIGINAL component keys ('perception' /
 *                'subconscious') so a live brain that already applied them does
 *                NOT re-run (migration-identity preservation — see init()).
 *   - tools    : the 8 perception tools + the 5 suggestion/subconscious tools.
 *                The registered tool SET is UNCHANGED by the collapse (same
 *                tools, one factory) → the gateway tool count is unchanged.
 *   - events   : the perception bus emits + the subconscious bootstrap_failed
 *                emit; listens engine.ready (the schedule bootstrap).
 *   - init     : resolves both instances' config, sets both handler contexts,
 *                and wires the `subconscious_engine` schedule bootstrap verbatim.
 *
 * The two inner factories (`createPerceptionComponent` /
 * `createSubconsciousComponent`) are COMPOSED here — the merged component
 * delegates lifecycle (init/destroy) + surface (tools/events) to them. This
 * keeps the perception/subconscious internals (handlers, runner, instance) as
 * the single source of truth while presenting ONE component to the engine.
 *
 * @module engine/components/cognition
 * @author fifty.dev
 */

import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { createPerceptionComponent } from '../perception/index.js';
import { createSubconsciousComponent } from '../subconscious/index.js';
import { createSynapseComponent } from '../synapse/index.js';

/**
 * Build the unified cognition component. Composes the perception + subconscious
 * inner factories: one engine component, two instances' surfaces.
 *
 * `depends: ['memory']` carries forward perception's dependency (the perception
 * channel reads `learnings.review_status` from db.ts v15; the suggestions schema
 * has no cross-component dependency). Booting after memory keeps the migration
 * ordering correct.
 */
export function createCognitionComponent(): BrainComponent {
  const perception = createPerceptionComponent();
  const subconscious = createSubconsciousComponent();
  const synapse = createSynapseComponent();

  return {
    name: 'cognition',
    version: '1.0.0',
    // Perception depends on memory (learnings.review_status, db.ts v15). The
    // merged component inherits that dependency so boot order stays correct.
    depends: ['memory'],

    /**
     * MIGRATION-IDENTITY PRESERVATION: the merged component's `schema()` returns
     * `[]` so the registry does NOT run any migration under the NEW 'cognition'
     * component key. The perception + subconscious migrations are instead run in
     * `init()` UNDER THEIR ORIGINAL KEYS ('perception' / 'subconscious'), so a
     * live brain that already applied them (tracked in `engine_migrations` keyed
     * by `(component, version)`) sees `currentVersion=3` for each and skips —
     * NO re-run of the perception v2 ALTER (which would throw "duplicate column")
     * or the suggestions v3 table-rebuild.
     */
    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      // The full registered surface = perception's 8 tools + subconscious's 5
      // tools + synapse's 1 tool (FR-211: igris_synapse_run). Synapse is composed
      // here the same way subconscious is — the engine host is untouched (AC #1).
      return [...perception.tools(), ...subconscious.tools(), ...synapse.tools()];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      // EVENT DECLARATIONS STAY WITH THE INNER FACTORIES (FR-118 M4a). The
      // event-bus-integrity test scans each component DIR's
      // {index.ts,handlers.ts,daemon.ts} and asserts (Group 1) every literal
      // emit call is declared in that dir's events().emits, and (Group 2) every
      // declared emit has a literal emit call in that dir. The perception +
      // subconscious emit LITERALS live in those dirs' source
      // (perception/handlers.ts, subconscious/index.ts), NOT in this file — the
      // merged factory only DELEGATES (no emit calls of its own). So the merged
      // component declares NO emits here (returning the inner declarations would
      // fail Group 2: this file carries no matching emit literals). The
      // perception/ + subconscious/ dirs remain scanned components that carry
      // their own declaration-to-literal contract; the merged factory composes
      // their runtime wiring via init() without re-declaring their events.
      return { emits: [], listens: [] };
    },

    init(ctx: ComponentContext): void {
      // 1. Run the perception + subconscious migrations UNDER THEIR ORIGINAL
      //    component keys (migration-identity preservation — see schema()).
      const perceptionMigrations = perception.schema();
      if (perceptionMigrations.length > 0) {
        ctx.storage.runMigrations('perception', perceptionMigrations);
      }
      const subconsciousMigrations = subconscious.schema();
      if (subconsciousMigrations.length > 0) {
        ctx.storage.runMigrations('subconscious', subconsciousMigrations);
      }
      // Synapse reuses `suggestions` + `entity_edges` — it declares NO schema of
      // its own (schema() === []), so there is no migration to run under a
      // synapse key. (Guarded for symmetry in case a future knob adds one.)
      const synapseMigrations = synapse.schema();
      if (synapseMigrations.length > 0) {
        ctx.storage.runMigrations('synapse', synapseMigrations);
      }

      // 2. Delegate init to the inner factories: each resolves its instance
      //    config, sets its handler context, and (subconscious/synapse) wires its
      //    schedule bootstrap on engine.ready.
      perception.init(ctx);
      subconscious.init(ctx);
      synapse.init(ctx);

      ctx.log.info(
        'Cognition component initialized (perception + subconscious + synapse instances)',
      );
    },

    destroy(): void {
      // Tear down all inner factories (subconscious + synapse unhook their
      // engine.ready listeners; perception is stateless).
      perception.destroy();
      subconscious.destroy();
      synapse.destroy();
    },
  };
}
