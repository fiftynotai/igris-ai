/**
 * Brain Engine v7.1 — Synapse Component (FR-211).
 *
 * The edge-inference cognition instance's engine-component wrapper. Mirrors the
 * subconscious component: it owns the `igris_synapse_run` LLM-run tool, resolves
 * the instance config (`resolveSynapseConfig`, `cognition.synapse` NESTED-ONLY),
 * and self-bootstraps the `synapse_engine` cron schedule (daily 03:00) on
 * engine.ready. It is COMPOSED into `createCognitionComponent` (cognition/
 * index.ts) exactly the way subconscious is — the engine host is UNTOUCHED
 * (AC #1).
 *
 * Component contract:
 *   - schema()   : []  — synapse reuses the `suggestions` table (owned by the
 *                  subconscious component) and `entity_edges` (owned by the edges
 *                  component). No new table, no `entity_edges` ALTER; the
 *                  `provenance='inferred'` value already exists (D1 / option (a)).
 *   - tools()    : 1 MCP tool — igris_synapse_run.
 *   - events()   : emits synapse.bootstrap_failed; listens engine.ready. The run
 *                  lifecycle is written by the cognition engine under
 *                  `cognition.synapse.*` (event_log directly, NOT the bus).
 *   - init()     : resolves the instance config; on engine.ready, dispatches
 *                  `igris_schedule_create` if the schedule isn't already present.
 *
 * @module engine/components/synapse
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  EventPayload,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { errMsg, successResult } from '../../helpers.js';
import { DEFAULT_SYNAPSE_CONFIG, type SynapseConfig } from './types.js';
import { runSynapse } from './runner.js';
import { resolveLlmExtractorGlobalConfig } from '../subconscious/index.js';

/** The well-known name used to detect an existing schedule on init. */
const SCHEDULE_NAME = 'synapse_engine';
/** Daily at 03:00 — back-catalog edge inference is not urgent (cheaper than every-6h). */
const SCHEDULE_CRON_EXPR = '0 3 * * *';

// ---------------------------------------------------------------------------
// Config resolution (FR-211)
// ---------------------------------------------------------------------------

/** Read + parse `~/.igris/config.json`, or `{}` on any error. */
function readIgrisConfig(): Record<string, unknown> {
  try {
    const configPath = path.join(os.homedir(), '.igris', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* absent / malformed — defaults apply */
  }
  return {};
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve the synapse instance config (FR-211). Reads the `cognition.synapse`
 * path NESTED-ONLY (mirrors `resolveSubconsciousConfig`). Absent keys fall back
 * to `DEFAULT_SYNAPSE_CONFIG` (OFF). There is NO legacy top-level fallback — the
 * nested namespace is canonical (the feature never shipped to consumers).
 */
export function resolveSynapseConfig(
  config: Record<string, unknown> = readIgrisConfig(),
): SynapseConfig {
  const cognition = asObject(config.cognition);
  const nested = (cognition && asObject(cognition.synapse)) ?? {};
  const pick = <T>(key: string, fallback: T): T => {
    if (nested[key] !== undefined) return nested[key] as T;
    return fallback;
  };
  return {
    enabled: pick('enabled', DEFAULT_SYNAPSE_CONFIG.enabled),
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_SYNAPSE_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_SYNAPSE_CONFIG.llm_daily_budget),
    min_input_bytes: pick('min_input_bytes', DEFAULT_SYNAPSE_CONFIG.min_input_bytes),
    harness: pick('harness', DEFAULT_SYNAPSE_CONFIG.harness),
    cosine_floor: pick('cosine_floor', DEFAULT_SYNAPSE_CONFIG.cosine_floor),
    top_k: pick('top_k', DEFAULT_SYNAPSE_CONFIG.top_k),
    max_pairs: pick('max_pairs', DEFAULT_SYNAPSE_CONFIG.max_pairs),
    auto_approve: pick('auto_approve', DEFAULT_SYNAPSE_CONFIG.auto_approve),
  };
}

export function createSynapseComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _dispatchTool:
    | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
    | null = null;

  /**
   * Capture the gateway dispatcher off `engine.ready`. Once we have it, register
   * the cron schedule (idempotently) so the daemon picks it up on its next tick.
   */
  function onEngineReady(payload: EventPayload): void {
    const dispatch = payload.data.dispatch as
      | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!dispatch) return;
    _dispatchTool = dispatch;
    void ensureScheduleExists();
  }

  /**
   * Idempotent schedule bootstrap. Reads the `schedules` table directly and
   * dispatches `igris_schedule_create` only if no row matches `name =
   * synapse_engine`. Re-running init is a no-op. Uses the gateway dispatch (not
   * the raw schedules handler) so the schedules component's own events fire.
   */
  async function ensureScheduleExists(): Promise<void> {
    if (!_ctx || !_dispatchTool) return;
    try {
      const db = getDb();
      const existing = db
        .prepare(`SELECT id FROM schedules WHERE name = ? LIMIT 1`)
        .get(SCHEDULE_NAME) as { id: number } | undefined;
      if (existing !== undefined) {
        _ctx.log.info(`Schedule "${SCHEDULE_NAME}" already exists; skipping bootstrap`);
        return;
      }
    } catch (err) {
      _ctx.log.warn(`Could not query schedules table: ${errMsg(err)}`);
      return;
    }

    try {
      await _dispatchTool('igris_schedule_create', {
        name: SCHEDULE_NAME,
        description: 'FR-211 synapse engine: edge-inference pipeline (daily 03:00)',
        cron_expr: SCHEDULE_CRON_EXPR,
        handler_type: 'mcp-tool',
        handler_config: { tool: 'igris_synapse_run', args: {} },
        enabled: true,
        tags: ['synapse', 'fr-211'],
      });
      _ctx.log.info(`Bootstrapped schedule: ${SCHEDULE_NAME} (${SCHEDULE_CRON_EXPR})`);
    } catch (err) {
      const message = errMsg(err);
      _ctx.log.warn(`Failed to bootstrap schedule "${SCHEDULE_NAME}": ${message}`);
      // Emit synapse.bootstrap_failed so the monitoring component captures the
      // failure in event_log. The warn-log alone is not a downstream signal.
      _ctx.bus.emit('synapse.bootstrap_failed', {
        error_message: message,
      });
    }
  }

  return {
    name: 'synapse',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      // No schema of its own — synapse reuses `suggestions` + `entity_edges`.
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_synapse_run',
          description:
            'Run the synapse edge-inference LLM extractor once (FR-211). Builds a cheap deterministic set of candidate learning pairs (embedding-cosine neighbours plus shared-brief siblings, minus pairs already edged or pending), runs an isolated LLM call on the resolved harness to judge the relationship type plus confidence, and QUEUES each proposed edge for operator review as an edge_inference suggestion (approved later via igris_suggestion_apply_action). Invoked by the cron schedule "synapse_engine" daily at 03:00; also fireable manually. Returns the run outcome (succeeded/skipped/failed), the persisted count, and the skip/fail reason. Scope with project; force bypasses the cold-start plus candidate-size gate.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to scope candidate generation to (default: whole brain).',
              },
              force: {
                type: 'boolean',
                description:
                  'Bypass the cold-start plus minimum-candidate-size gate for an immediate sweep (does NOT bypass the daily budget or the disabled switch).',
              },
            },
          },
          handler: async (args) => {
            const db = getDb();
            const config = resolveSynapseConfig();
            const globalConfig = resolveLlmExtractorGlobalConfig();
            const project = typeof args.project === 'string' ? args.project : 'all';
            const force = args.force === true;
            const result = await runSynapse(db, project, {
              config,
              globalConfig,
              force,
              trigger: 'manual',
            });
            return successResult(JSON.stringify(result, null, 2));
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      // The run-lifecycle events are written by the cognition engine directly to
      // event_log under `cognition.synapse.{run_started,run_succeeded,run_failed,
      // run_skipped}` (NOT via bus.emit). So the only surviving bus emit is the
      // schedule-bootstrap failure. Every declared emit below still has a literal
      // `bus.emit` in this file (the event-bus integrity invariant).
      return {
        emits: [
          {
            name: 'synapse.bootstrap_failed',
            description:
              'The synapse_engine schedule failed to bootstrap on engine.ready (FR-211)',
          },
        ],
        listens: [
          {
            name: 'engine.ready',
            description: 'Capture gateway dispatch and bootstrap the cron schedule',
          },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.bus.on('engine.ready', onEngineReady);

      const synapseConfig = resolveSynapseConfig();
      const globalConfig = resolveLlmExtractorGlobalConfig();
      ctx.log.info(
        `Synapse component initialized (LLM edge-inference: enabled=${synapseConfig.enabled}, ` +
          `harness=${synapseConfig.harness ?? globalConfig.harness ?? 'claude'}, ` +
          `budget=${synapseConfig.llm_daily_budget}/day, cosine_floor=${synapseConfig.cosine_floor}, ` +
          `max_pairs=${synapseConfig.max_pairs}, auto_approve=${synapseConfig.auto_approve})`,
      );
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('engine.ready', onEngineReady);
      }
      _ctx = null;
      _dispatchTool = null;
    },
  };
}
