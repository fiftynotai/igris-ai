/**
 * Brain Engine v7.0 — Perception Component (FR-109)
 *
 * Wires the perception channel into the engine:
 *   - Owns the `perception_watermarks` schema (v1).
 *   - Registers 5 MCP tools (+1 helper) for the perception lifecycle.
 *   - Resolves the LLM extractor from a 3-layer config chain (defaults →
 *     `~/.igris/config.json` → env vars).
 *   - Probes the `claude` CLI once at init via FR-108's cached probe so
 *     VPS deployments (CLI absent) cleanly fall back to the noop extractor.
 *
 * The component is otherwise stateless — handlers reach into `getDb()` for
 * persistence and the runner for orchestration.
 *
 * @module engine/components/perception
 * @author fifty.dev
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { perceptionMigrations } from './schema.js';
import {
  DEFAULT_PERCEPTION_CONFIG,
  type PerceptionExtractorConfig,
} from './types.js';
import {
  handlePerceptionApprove,
  handlePerceptionDashboard,
  handlePerceptionExpireStale,
  handlePerceptionExtractNow,
  handlePerceptionGet,
  handlePerceptionReject,
  handlePerceptionReviewPending,
  handlePerceptionSubmit,
  setHandlerContext,
} from './handlers.js';
import { selectLlmExtractor } from './extractors/llm_via_claude_code.js';
import type { LlmExtractorGlobalConfig } from '../cognition/backend/env.js';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active config via the 3-layer chain:
 *   1. `DEFAULT_PERCEPTION_CONFIG` (typed defaults)
 *   2. `~/.igris/config.json` `perception` section (operator override)
 *   3. Env vars: `IGRIS_PERCEPTION_LLM_ENABLED`, `IGRIS_PERCEPTION_LLM_TIMEOUT_MS`,
 *      `IGRIS_PERCEPTION_AUTO_APPROVE` (TD-066)
 *
 * Mirrors `subconscious/runner.ts` config handling. Failure to read the
 * file is silent — defaults still apply.
 */
export function resolvePerceptionConfig(log?: { info: (m: string) => void; warn: (m: string) => void }): PerceptionExtractorConfig {
  let cfg: PerceptionExtractorConfig = { ...DEFAULT_PERCEPTION_CONFIG };

  // Layer 2: ~/.igris/config.json
  try {
    const configPath = path.join(os.homedir(), '.igris', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const section = parsed.perception;
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      cfg = { ...cfg, ...(section as Partial<PerceptionExtractorConfig>) };
    }
  } catch {
    // file absent or malformed — defaults already in place
  }

  // Layer 3: env vars
  if (process.env.IGRIS_PERCEPTION_LLM_ENABLED === '1') cfg.extractor_llm_enabled = true;
  if (process.env.IGRIS_PERCEPTION_LLM_ENABLED === '0') cfg.extractor_llm_enabled = false;

  if (process.env.IGRIS_PERCEPTION_AUTO_APPROVE === '1') cfg.auto_approve_enabled = true;
  if (process.env.IGRIS_PERCEPTION_AUTO_APPROVE === '0') cfg.auto_approve_enabled = false;

  const timeoutEnv = process.env.IGRIS_PERCEPTION_LLM_TIMEOUT_MS;
  if (timeoutEnv) {
    const n = parseInt(timeoutEnv, 10);
    if (Number.isFinite(n) && n > 0) cfg.llm_timeout_ms = n;
  }

  // TD-086 dedup env overrides — operator kill switch + threshold tuning.
  if (process.env.IGRIS_PERCEPTION_DEDUP_ENABLED === '1') cfg.dedup_enabled = true;
  if (process.env.IGRIS_PERCEPTION_DEDUP_ENABLED === '0') cfg.dedup_enabled = false;

  const dedupThresholdEnv = process.env.IGRIS_PERCEPTION_DEDUP_THRESHOLD;
  if (dedupThresholdEnv) {
    const n = parseFloat(dedupThresholdEnv);
    if (Number.isFinite(n) && n >= 0 && n <= 1) cfg.dedup_cosine_threshold = n;
  }

  if (log) {
    log.info(
      `perception config resolved (llm_enabled=${cfg.extractor_llm_enabled}, timeout=${cfg.llm_timeout_ms}ms, min_bytes=${cfg.llm_min_transcript_bytes}, auto_approve=${cfg.auto_approve_enabled}, dedup_enabled=${cfg.dedup_enabled}, dedup_threshold=${cfg.dedup_cosine_threshold})`,
    );
  }
  return cfg;
}

/**
 * Resolve the global `llm_extractor` config section (FR-118) — the shared
 * cognition-backend harness default + fallback order. Read from
 * `~/.igris/config.json`'s `llm_extractor` block; absent/malformed yields `{}`
 * (the backend defaults the harness to `'claude'`, preserving perception's
 * back-compat behavior). This is the section `resolveHarness` reads so a
 * non-claude install can re-point the extraction harness globally.
 */
export function resolveLlmExtractorGlobalConfig(): LlmExtractorGlobalConfig {
  try {
    const configPath = path.join(os.homedir(), '.igris', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const section = parsed.llm_extractor;
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      return section as LlmExtractorGlobalConfig;
    }
  } catch {
    // file absent or malformed — default harness ('claude') applies downstream
  }
  return {};
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createPerceptionComponent(): BrainComponent {
  return {
    name: 'perception',
    version: '1.0.0',
    depends: ['memory'],

    schema(): Migration[] {
      return perceptionMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -------------------------------------------------------------------
        // igris_perception_submit
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_submit',
          description:
            'Ingest a transcript window and queue candidate learnings for review. Called by the detached background extractor (`scripts/perception_extract_cli.ts`), itself spawned by the session_end / pre_compact hooks. Runs the LLM-only extractor pipeline, inserts pending_review learnings tagged provenance=inferred, and returns counts plus the LLM gate status.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: { type: 'string', description: 'Project slug.' },
              transcript_text: {
                type: 'string',
                description: 'Transcript blob (JSONL preferred, plain text accepted).',
              },
              source: {
                type: 'string',
                description: "Trigger source label (e.g. 'session_end', 'pre_compact').",
              },
              brief_id: { type: 'string', description: 'Optional brief id for context.' },
              window_start_ts: { type: 'string', description: 'ISO start of window (advisory).' },
              window_end_ts: {
                type: 'string',
                description: 'ISO end of window — written to perception_watermarks on success.',
              },
            },
            required: ['project', 'transcript_text', 'source'],
          },
          handler: (args) => handlePerceptionSubmit(args),
        },

        // -------------------------------------------------------------------
        // igris_perception_review_pending
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_review_pending',
          description:
            "List pending_review learnings (perception candidates) sorted by confidence DESC, created_at DESC. Lazy-on-read TTL filter excludes rows older than the configured window. Used by /awaken section 4.9 with limit=5.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: { type: 'string', description: 'Optional project filter.' },
              limit: {
                type: 'integer',
                description: 'Maximum candidates to return (default 25, max 1000).',
              },
            },
          },
          handler: (args) => handlePerceptionReviewPending(args),
        },

        // -------------------------------------------------------------------
        // igris_perception_approve
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_approve',
          description:
            "Promote a pending_review learning to approved. Optional `edit` allows fixing title/content/tags/category/confidence/tech_stack before approval. Provenance ('inferred') is permanent — approval is a status flip only.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              learning_id: { type: 'integer', description: 'Learning id to approve.' },
              edit: {
                type: 'object',
                description: 'Optional partial edit applied before flipping status.',
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' },
                  tags: { type: 'string' },
                  category: { type: 'string' },
                  confidence: { type: 'number' },
                  tech_stack: { type: 'string' },
                },
              },
            },
            required: ['learning_id'],
          },
          handler: (args) => handlePerceptionApprove(args),
        },

        // -------------------------------------------------------------------
        // igris_perception_reject
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_reject',
          description:
            'Reject a pending_review learning. Hard DELETE — perception channel does not soft-delete. Optional reason recorded as a bus event for analytics.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              learning_id: { type: 'integer', description: 'Learning id to reject.' },
              reason: { type: 'string', description: 'Free-form rejection reason.' },
            },
            required: ['learning_id'],
          },
          handler: (args) => handlePerceptionReject(args),
        },

        // -------------------------------------------------------------------
        // igris_perception_extract_now
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_extract_now',
          description:
            'Manual perception extraction with optional force_llm bypass of the bytes-floor cost gate. Useful for /harvest integration and operator triage. Watermark advance is opt-in (defaults false) so manual runs do not shadow the next session_end.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: { type: 'string', description: 'Project slug.' },
              transcript_text: { type: 'string', description: 'Transcript blob.' },
              brief_id: { type: 'string', description: 'Optional brief id for context.' },
              force_llm: {
                type: 'boolean',
                description:
                  'Bypass the bytes-floor cost gate and force LLM extraction. The disabled gate (extractor_llm_enabled=false) is NEVER bypassed.',
              },
              advance_watermark: {
                type: 'boolean',
                description: 'Advance the perception_watermarks row (default false).',
              },
            },
            required: ['project'],
          },
          handler: (args) => handlePerceptionExtractNow(args),
        },

        // -------------------------------------------------------------------
        // TD-171 M3 — igris_perception_get
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_get',
          description:
            'Return the full row of a single pending_review learning. Use this when igris_perception_review_pending shows truncated content and you need the full candidate before approve/reject. Errors on approved/non-existent rows.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              learning_id: {
                type: 'integer',
                description: 'ID of the pending_review learning to fetch.',
              },
            },
            required: ['learning_id'],
          },
          handler: (args) => handlePerceptionGet(args),
        },

        // -------------------------------------------------------------------
        // TD-171 M3 — igris_perception_dashboard
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_dashboard',
          description:
            'Aggregate dashboard for the perception channel. Reports inbox size (pending), recent approve/reject volume, run outcomes (succeeded/failed/skipped) from event_log, and dedup rediscovery counts. Per L-152 strictly perception scope — no subconscious or janitor concerns.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Optional project filter — narrows totals AND recent windows.',
              },
              days: {
                type: 'number',
                description: 'Time window for recent and *_last_n totals. Default 30.',
              },
              summary_only: {
                type: 'boolean',
                description: 'Counts only — omit samples.top_extractors. Default false.',
              },
            },
          },
          handler: (args) => handlePerceptionDashboard(args),
        },

        // -------------------------------------------------------------------
        // igris_perception_expire_stale (helper, not part of the 5-tool count)
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_expire_stale',
          description:
            'Manually delete pending_review learnings older than ttl_days (default = config.pending_review_ttl_days). Lazy-on-read filter normally hides them; this tool reclaims storage.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              ttl_days: {
                type: 'number',
                description: 'Override the TTL window (default = config.pending_review_ttl_days).',
              },
              project: { type: 'string', description: 'Optional project filter.' },
            },
          },
          handler: (args) => handlePerceptionExpireStale(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'perception.run_complete', description: 'A perception extraction run completed.' },
          {
            name: 'perception.candidate_approved',
            description: 'A pending learning was approved (review_status flipped).',
          },
          {
            name: 'perception.candidate_rejected',
            description: 'A pending learning was rejected (DELETEd).',
          },
          // TD-074 lifecycle events. Emitted via bus.emit() in handlers.ts
          // so the event-bus integrity test sees a literal call site, AND
          // written directly to event_log via writePerceptionEvent so the
          // detached CLI (no bus) produces the same observable rows.
          {
            name: 'perception.run_started',
            description: 'A perception extraction run began (transcript parsed, gate evaluated).',
          },
          {
            name: 'perception.run_succeeded',
            description: 'A perception extraction run completed without error (candidates persisted).',
          },
          {
            name: 'perception.run_failed',
            description:
              'A perception extraction run failed (EPIPE, timeout, non-zero exit, db_error, etc.).',
          },
          {
            name: 'perception.run_skipped',
            description:
              'A perception extraction run was skipped without invoking the LLM (gate fired, min-window, no transcript).',
          },
          // TD-086 cheap-dedup events. `perception.rediscovery` fires when a
          // candidate matches an existing learning (any review_status) above
          // the cosine threshold — the insert is skipped and the matched
          // row's `seen_again_count` is incremented. The payload carries
          // `existing_status` so a single event covers both pending_review
          // and approved matches without proliferating event names.
          {
            name: 'perception.rediscovery',
            description:
              'A perception candidate matched an existing learning (any status) above the dedup cosine threshold. Insert was skipped; seen_again_count was incremented on the matched row.',
          },
          // Forward-compatibility declaration. Reject is currently a hard
          // DELETE (handlers.ts:igris_perception_reject), so no rejected row
          // exists to match against — this event is declared but never emitted
          // in TD-086 v1. When FR-116 ships soft-delete (review_status='rejected'
          // + deleted_at), the dedup helper will surface rejected matches and
          // this event will start firing. The literal bus.emit() call site
          // (required by event-bus integrity test) is gated in handlers.ts
          // behind a perpetually-false branch — see TODO(FR-116) there.
          {
            name: 'perception.rejected_pattern_recurring',
            description:
              'A perception candidate matched a previously-rejected fingerprint. Declared but not emitted in TD-086 v1 — reject is hard DELETE today; activates when FR-116 introduces soft-delete.',
          },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      const config = resolvePerceptionConfig(ctx.log);
      // FR-118 M1: the production extractor now rides the shared brain-isolated
      // cognition backend (selectLlmExtractor → makeBackendLlmExtractor →
      // runBackend). The harness is resolved via the shared 4-layer chain from
      // the global `llm_extractor` config; perception's default stays 'claude'.
      const globalConfig = resolveLlmExtractorGlobalConfig();
      const llmExtractor = selectLlmExtractor(config, ctx.log, globalConfig);
      setHandlerContext({
        bus: ctx.bus,
        config,
        llmExtractor,
      });
      ctx.log.info(
        `Perception component initialized (extractor_llm_enabled=${config.extractor_llm_enabled})`,
      );
    },

    destroy(): void {
      // Stateless component — nothing to clean up.
    },
  };
}
