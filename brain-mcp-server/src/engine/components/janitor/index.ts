/**
 * Brain Engine v7.1 — Janitor Component (FR-119).
 *
 * The memory-hygiene cognition instance's engine-component wrapper. Mirrors the
 * synapse component: it owns the `igris_janitor_run_now` run tool, resolves the
 * instance config (`resolveJanitorConfig`, `cognition.janitor` NESTED-ONLY), and
 * self-bootstraps the `janitor_engine` cron schedule (daily 04:00, offset from
 * synapse's 03:00) on engine.ready. It is COMPOSED into
 * `createCognitionComponent` (cognition/index.ts) exactly the way synapse is —
 * the engine host is UNTOUCHED (AC #1).
 *
 * UNLIKE synapse, the janitor OWNS schema: `brain_maintenance_runs` + the
 * `learnings.deleted_at`/`merged_into` audit columns (see `schema.ts`). The
 * migration runs under the `'janitor'` component key in
 * `createCognitionComponent.init()` (mirroring the guarded synapse block).
 *
 * Component contract:
 *   - schema()   : `janitorMigrations` — the maintenance table + learnings ALTER.
 *   - tools()    : 1 MCP tool — igris_janitor_run_now.
 *   - events()   : emits janitor.bootstrap_failed; listens engine.ready. The run
 *                  lifecycle is written by the cognition engine under
 *                  `cognition.janitor.*` (event_log directly, NOT the bus).
 *   - init()     : resolves the instance config; on engine.ready, dispatches
 *                  `igris_schedule_create` if the schedule isn't already present.
 *
 * @module engine/components/janitor
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
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from './types.js';
import { janitorMigrations } from './schema.js';
import { runJanitor } from './runner.js';
import { resolveArbiterConfig } from '../arbiter/types.js';
import { resolveLlmExtractorGlobalConfig } from '../subconscious/index.js';

/** The well-known name used to detect an existing schedule on init. */
const SCHEDULE_NAME = 'janitor_engine';
/** Daily at 04:00 — offset from synapse's 03:00 so the two extractors do not collide. */
const SCHEDULE_CRON_EXPR = '0 4 * * *';

// ---------------------------------------------------------------------------
// Config resolution (FR-119)
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
 * Resolve the janitor instance config (FR-119). Reads the `cognition.janitor`
 * path NESTED-ONLY (mirrors `resolveSynapseConfig`). Absent keys fall back to
 * `DEFAULT_JANITOR_CONFIG` (OFF). There is NO legacy top-level fallback — the
 * nested namespace is canonical (the feature never shipped to consumers).
 */
export function resolveJanitorConfig(
  config: Record<string, unknown> = readIgrisConfig(),
): JanitorConfig {
  const cognition = asObject(config.cognition);
  const nested = (cognition && asObject(cognition.janitor)) ?? {};
  const pick = <T>(key: string, fallback: T): T => {
    if (nested[key] !== undefined) return nested[key] as T;
    return fallback;
  };
  return {
    enabled: pick('enabled', DEFAULT_JANITOR_CONFIG.enabled),
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_JANITOR_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_JANITOR_CONFIG.llm_daily_budget),
    min_input_bytes: pick('min_input_bytes', DEFAULT_JANITOR_CONFIG.min_input_bytes),
    harness: pick('harness', DEFAULT_JANITOR_CONFIG.harness),
    dupe_cosine_floor: pick('dupe_cosine_floor', DEFAULT_JANITOR_CONFIG.dupe_cosine_floor),
    dupe_min_overlap: pick('dupe_min_overlap', DEFAULT_JANITOR_CONFIG.dupe_min_overlap),
    top_k: pick('top_k', DEFAULT_JANITOR_CONFIG.top_k),
    max_pairs: pick('max_pairs', DEFAULT_JANITOR_CONFIG.max_pairs),
    auto_merge: pick('auto_merge', DEFAULT_JANITOR_CONFIG.auto_merge),
    auto_merge_threshold: pick('auto_merge_threshold', DEFAULT_JANITOR_CONFIG.auto_merge_threshold),
    rediscovery_bump_n: pick('rediscovery_bump_n', DEFAULT_JANITOR_CONFIG.rediscovery_bump_n),
    reject_recur_n: pick('reject_recur_n', DEFAULT_JANITOR_CONFIG.reject_recur_n),
    stale_days: pick('stale_days', DEFAULT_JANITOR_CONFIG.stale_days),
  };
}

export function createJanitorComponent(): BrainComponent {
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
   * janitor_engine`. Re-running init is a no-op.
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
        description: 'FR-119 janitor engine: memory-hygiene pipeline (daily 04:00)',
        cron_expr: SCHEDULE_CRON_EXPR,
        handler_type: 'mcp-tool',
        handler_config: { tool: 'igris_janitor_run_now', args: {} },
        enabled: true,
        tags: ['janitor', 'fr-119'],
      });
      _ctx.log.info(`Bootstrapped schedule: ${SCHEDULE_NAME} (${SCHEDULE_CRON_EXPR})`);
    } catch (err) {
      const message = errMsg(err);
      _ctx.log.warn(`Failed to bootstrap schedule "${SCHEDULE_NAME}": ${message}`);
      // Emit janitor.bootstrap_failed so the monitoring component captures the
      // failure in event_log. The warn-log alone is not a downstream signal.
      _ctx.bus.emit('janitor.bootstrap_failed', {
        error_message: message,
      });
    }
  }

  return {
    name: 'janitor',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      // The janitor OWNS brain_maintenance_runs + the learnings audit columns.
      return janitorMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_janitor_run_now',
          description:
            'Run the janitor memory-hygiene pipeline once (FR-119/FR-116 M2). Performs the deterministic sweep (TD-086 confidence bumps for re-discovered learnings, stale pending_review rejection, dormant re-evaluation surfacing), then the near-duplicate MERGE LLM extractor (builds a cheap deterministic set of near-dupe learning pairs, judges keep/merge/false-positive, QUEUES each proposed merge as a janitor suggestion), and then the co-scheduled CONTRADICTION-RESOLUTION extractor (arbiter): builds a set of same-topic opposition pairs (high-cosine + a deterministic negation/antonym cue), judges newer-wins/both-valid-scope/evolved-merge/not-a-contradiction, and QUEUES each proposed resolution as an arbiter suggestion (applied later via igris_suggestion_apply_action). Both extractors ride the single cognition.janitor.enabled flag. Writes one brain_maintenance_runs audit row aggregating all counters. Invoked by the cron schedule "janitor_engine" daily at 04:00; also fireable manually. Returns the run outcome plus the aggregated counters. Scope with project; force bypasses the cold-start plus candidate-size gate.',
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
            const igrisConfig = readIgrisConfig();
            const config = resolveJanitorConfig(igrisConfig);
            // FR-116 M2: the arbiter rides the SAME `cognition.janitor.enabled`
            // flag (Decision #4A) — resolved from the same config object so its
            // `enabled` gate stays in lockstep with the janitor's.
            const arbiterConfig = resolveArbiterConfig(igrisConfig);
            const globalConfig = resolveLlmExtractorGlobalConfig();
            const project = typeof args.project === 'string' ? args.project : 'all';
            const force = args.force === true;
            const result = await runJanitor(db, project, {
              config,
              arbiterConfig,
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
      // event_log under `cognition.janitor.{run_started,run_succeeded,run_failed,
      // run_skipped}` (NOT via bus.emit). So the only surviving bus emit is the
      // schedule-bootstrap failure. Every declared emit below still has a literal
      // `bus.emit` in this file (the event-bus integrity invariant).
      return {
        emits: [
          {
            name: 'janitor.bootstrap_failed',
            description:
              'The janitor_engine schedule failed to bootstrap on engine.ready (FR-119)',
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

      const janitorConfig = resolveJanitorConfig();
      const globalConfig = resolveLlmExtractorGlobalConfig();
      ctx.log.info(
        `Janitor component initialized (memory hygiene: enabled=${janitorConfig.enabled}, ` +
          `harness=${janitorConfig.harness ?? globalConfig.harness ?? 'claude'}, ` +
          `budget=${janitorConfig.llm_daily_budget}/day, dupe_cosine_floor=${janitorConfig.dupe_cosine_floor}, ` +
          `dupe_min_overlap=${janitorConfig.dupe_min_overlap}, ` +
          `auto_merge=${janitorConfig.auto_merge}, stale_days=${janitorConfig.stale_days})`,
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
