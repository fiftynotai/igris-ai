/**
 * Brain Engine v7.1 — Subconscious Component
 *
 * Passive observer. The original FR-106 rule detectors (`stalled`/`gap`/
 * `conflict`/`pattern`) + the `pattern_observations` smoothing table were
 * REPLACED in FR-118 by an LLM subconscious instance on the agnostic cognition
 * engine (digest → isolated LLM call → open-typed suggestions) and then DELETED
 * in M4b. The component now owns the suggestion surface (list/dismiss/acted/
 * apply_action) + the `igris_subconscious_run` LLM-run tool + the
 * self-bootstrapping `subconscious_engine` cron schedule (every 6h).
 *
 * Component contract:
 *   - schema()   : suggestions + dismissed_patterns (v1), suggestions v3
 *                  rebuild (open source_module + LLM columns), v4 drops the
 *                  dead pattern_observations table.
 *   - tools()    : 5 MCP tools — list / dismiss / acted / run / apply_action.
 *   - events()   : emits subconscious.bootstrap_failed; listens engine.ready.
 *                  The run lifecycle is written by the cognition engine under
 *                  `cognition.subconscious.*` (event_log directly, NOT the bus).
 *   - init()     : resolves the instance config, sets handler context; on
 *                  engine.ready, dispatches `igris_schedule_create` if the
 *                  schedule isn't already present (idempotent).
 *
 * Scheduler bootstrap (FR-106 plan, Concern 3):
 *   The schedules component supports `handler_type: 'mcp-tool'` with
 *   `handler_config: { tool, args }` — that's the supported invocation
 *   path. We dispatch the create through the gateway `dispatch` captured
 *   off `engine.ready`, never via the raw schedules handler, so the
 *   normal schedule-creation events fire.
 *
 * @module engine/components/subconscious
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
import { errMsg } from '../../helpers.js';
import { subconsciousMigrations } from './schema.js';
import {
  handleSuggestionList,
  handleSuggestionDismiss,
  handleSuggestionActed,
  handleSuggestionApplyAction,
  handleSubconsciousRun,
  setHandlerContext,
  VALID_PRIORITIES,
  LEGACY_SOURCE_MODULE_HINTS,
  VALID_STATUSES,
} from './handlers.js';
import {
  DEFAULT_DETECTOR_CONFIG,
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type SubconsciousConfig,
} from './types.js';
import type { LlmExtractorGlobalConfig } from '../cognition/engine/index.js';

/** The well-known name used to detect an existing schedule on init. */
const SCHEDULE_NAME = 'subconscious_engine';
/** Every six hours: minute=0 every 6th hour every day. */
const SCHEDULE_CRON_EXPR = '0 */6 * * *';

// ---------------------------------------------------------------------------
// Config resolution (FR-118 M2)
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
 * Resolve the subconscious instance config (FR-118 M2). Reads BOTH the new
 * `cognition.subconscious` path and the legacy top-level `subconscious` block
 * (back-compat — the `subconscious.enabled` dotted key stays grep-able for
 * MAINTAINING.md:67). The new path wins where both set a key; absent keys fall
 * back to `DEFAULT_SUBCONSCIOUS_CONFIG`.
 */
export function resolveSubconsciousConfig(
  config: Record<string, unknown> = readIgrisConfig(),
): SubconsciousConfig {
  const legacy = asObject(config.subconscious) ?? {};
  const cognition = asObject(config.cognition);
  const nested = (cognition && asObject(cognition.subconscious)) ?? {};
  const pick = <T>(key: string, fallback: T): T => {
    if (nested[key] !== undefined) return nested[key] as T;
    if (legacy[key] !== undefined) return legacy[key] as T;
    return fallback;
  };
  return {
    enabled: pick('enabled', DEFAULT_SUBCONSCIOUS_CONFIG.enabled),
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_SUBCONSCIOUS_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_SUBCONSCIOUS_CONFIG.llm_daily_budget),
    min_digest_bytes: pick('min_digest_bytes', DEFAULT_SUBCONSCIOUS_CONFIG.min_digest_bytes),
    harness: pick('harness', DEFAULT_SUBCONSCIOUS_CONFIG.harness),
  };
}

/**
 * Resolve the global `llm_extractor` config section (FR-118) — the shared
 * cognition-backend harness default + fallback order. Absent/malformed yields
 * `{}` (the backend defaults the harness to `'claude'`). Mirrors perception's
 * `resolveLlmExtractorGlobalConfig`.
 */
export function resolveLlmExtractorGlobalConfig(
  config: Record<string, unknown> = readIgrisConfig(),
): LlmExtractorGlobalConfig {
  return (asObject(config.llm_extractor) as LlmExtractorGlobalConfig) ?? {};
}

export function createSubconsciousComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

  /**
   * Capture the gateway dispatcher off `engine.ready`. Once we have it,
   * register the cron schedule (idempotently) so the daemon picks it
   * up on its next polling tick.
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
   * Idempotent schedule bootstrap. Reads the `schedules` table directly
   * (the table is owned by the schedules component but reading is
   * cross-component-safe), and dispatches `igris_schedule_create` only
   * if no row matches `name = subconscious_engine`. Re-running init is a
   * no-op.
   *
   * Note we use the gateway dispatch (not handleScheduleCreate
   * directly) so the schedules component's own event emissions and
   * daemon recalculation fire.
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
      // schedules table missing — boot order will fix this on next start.
      _ctx.log.warn(`Could not query schedules table: ${errMsg(err)}`);
      return;
    }

    try {
      await _dispatchTool('igris_schedule_create', {
        name: SCHEDULE_NAME,
        description: 'FR-106 subconscious engine: passive detector pipeline (every 6h)',
        cron_expr: SCHEDULE_CRON_EXPR,
        handler_type: 'mcp-tool',
        handler_config: { tool: 'igris_subconscious_run', args: {} },
        enabled: true,
        tags: ['subconscious', 'fr-106'],
      });
      _ctx.log.info(`Bootstrapped schedule: ${SCHEDULE_NAME} (${SCHEDULE_CRON_EXPR})`);
    } catch (err) {
      const message = errMsg(err);
      _ctx.log.warn(`Failed to bootstrap schedule "${SCHEDULE_NAME}": ${message}`);
      // Emit `subconscious.bootstrap_failed` so the monitoring component
      // captures the failure in event_log. The warn-log alone is not a
      // signal that downstream observability picks up.
      _ctx.bus.emit('subconscious.bootstrap_failed', {
        error_message: message,
      });
    }
  }

  return {
    name: 'subconscious',
    version: '1.1.0',
    depends: [],

    schema(): Migration[] {
      return subconsciousMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_suggestion_list
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_list',
          description:
            'List subconscious-engine suggestions with optional filters. Default sort: priority (high>medium>low) then created_at DESC. Use status="pending" + limit=3 in /awaken to render the top actionable items.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                enum: [...VALID_STATUSES],
                description: 'Filter by status (pending, dismissed, acted)',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug',
              },
              source_module: {
                type: 'string',
                description:
                  'Filter by suggestion kind (OPEN — the LLM names it). Legacy rule kinds: ' +
                  LEGACY_SOURCE_MODULE_HINTS.join(', ') +
                  '. Any non-empty string is accepted.',
              },
              priority: {
                type: 'string',
                enum: [...VALID_PRIORITIES],
                description: 'Filter by priority (high, medium, low)',
              },
              limit: {
                type: 'integer',
                description: 'Maximum suggestions to return (default 25, max 1000)',
              },
              offset: {
                type: 'integer',
                description: 'Pagination offset (default 0)',
              },
            },
          },
          handler: (args) => handleSuggestionList(args),
        },

        // -----------------------------------------------------------------
        // igris_suggestion_dismiss
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_dismiss',
          description:
            'Mark a suggestion as dismissed. The optional reason feeds the dismiss-reason learning loop: future suggestions with the same evidence signature will be suppressed once the dismiss count crosses the configured threshold (default 2 dismisses).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'integer',
                description: 'Suggestion id (positive integer)',
              },
              reason: {
                type: 'string',
                description: 'Optional free-text reason recorded for the learning loop',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleSuggestionDismiss(args),
        },

        // -----------------------------------------------------------------
        // igris_suggestion_acted
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_acted',
          description:
            "Mark a suggestion as acted on. Optional brief_id records which brief the user opened in response. Acted does NOT feed the suppression loop — it is a positive signal. For conflict-class suggestions, optionally pass action='superseded' (with winner_id + loser_id) to materialise a typed `supersedes` edge between the two learnings, or action='kept_both' to materialise a `related_to` edge marking the pair as reviewed-and-non-conflicting.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'integer',
                description: 'Suggestion id (positive integer)',
              },
              brief_id: {
                type: 'string',
                description: 'Optional brief id linking the action that resolved the suggestion',
              },
              action: {
                type: 'string',
                enum: ['superseded', 'kept_both'],
                description:
                  "For conflict suggestions: how the conflict was resolved. Omit for non-conflict suggestions or when no edge should be created.",
              },
              winner_id: {
                type: 'integer',
                description:
                  'Required when action is set: id of the learning that survives (or first of the kept pair).',
              },
              loser_id: {
                type: 'integer',
                description:
                  'Required when action is set: id of the other learning in the pair.',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleSuggestionActed(args),
        },

        // -----------------------------------------------------------------
        // igris_subconscious_run
        // -----------------------------------------------------------------
        {
          name: 'igris_subconscious_run',
          description:
            'Run the subconscious LLM extractor once (FR-118). Reads a deterministic brain digest, runs an isolated LLM call on the resolved harness, and queues open-typed suggestions for review. Invoked by the cron schedule "subconscious_engine" every 6 hours; also fireable manually. Returns the run outcome (succeeded/skipped/failed), the persisted count, and the skip/fail reason. Scope with project; force bypasses the cold-start + digest-size gate.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: "Project slug to scope the digest to (default: whole brain).",
              },
              force: {
                type: 'boolean',
                description:
                  'Bypass the cold-start + minimum-digest-size gate for an immediate sweep (does NOT bypass the daily budget or the disabled switch).',
              },
            },
          },
          handler: async (args) => handleSubconsciousRun(args),
        },

        // -----------------------------------------------------------------
        // igris_suggestion_apply_action (FR-118 M3)
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_apply_action',
          description:
            "OPERATOR-INVOKED: apply the suggested_action of a reviewed suggestion (one-click apply). NEVER auto-fires — creating a suggestion does not execute its action. Validates the target resolves, dispatches the action kind (tick_ac / dismiss_existing / create_brief / flag_for_review / add_edge; an unknown kind falls back to flag_for_review), and marks the suggestion 'acted' on success / leaves it 'pending' on failure. create_brief DRAFTS a brief for approval — it does NOT create one (the operator creates it via /register).",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'integer',
                description: 'Suggestion id (positive integer) to apply the action of',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleSuggestionApplyAction(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      // FR-118 M2: the run-lifecycle + per-suggestion + verifier events are no
      // longer emitted on the bus. The live path is the cognition engine, which
      // writes `cognition.subconscious.{run_started,run_succeeded,run_failed,
      // run_skipped}` DIRECTLY to `event_log` (observable via
      // `igris_event_log component='cognition.subconscious'`), NOT via bus.emit.
      // So the only surviving bus emit is the schedule-bootstrap failure. Every
      // declared emit below still has a literal `bus.emit` in this file (the
      // event-bus integrity invariant).
      return {
        emits: [
          {
            name: 'subconscious.bootstrap_failed',
            description:
              'The subconscious_engine schedule failed to bootstrap on engine.ready (TD-053)',
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

      // FR-118 M2: resolve the subconscious instance config (timeout/budget/
      // min-digest/enabled/harness) + the global llm_extractor config (harness
      // default + fallback order). These drive the live LLM run path
      // (`igris_subconscious_run` → runSubconscious → the cognition engine). The
      // FR-108 verifier wiring is GONE (the rule path it served is no longer
      // live; the detector files were deleted in FR-118 M4b).
      const subconsciousConfig = resolveSubconsciousConfig();
      const globalConfig = resolveLlmExtractorGlobalConfig();
      setHandlerContext({
        bus: ctx.bus,
        config: DEFAULT_DETECTOR_CONFIG,
        subconsciousConfig,
        globalConfig,
      });
      ctx.log.info(
        `Subconscious component initialized (LLM extractor: enabled=${subconsciousConfig.enabled}, ` +
          `harness=${subconsciousConfig.harness ?? globalConfig.harness ?? 'claude'}, ` +
          `budget=${subconsciousConfig.llm_daily_budget}/day, min_digest=${subconsciousConfig.min_digest_bytes}B)`,
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
