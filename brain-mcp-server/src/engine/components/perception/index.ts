/**
 * Brain Engine v5.0 — Perception Component (FR-109)
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
 * @author Fifty.ai
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
  handlePerceptionExpireStale,
  handlePerceptionExtractNow,
  handlePerceptionReject,
  handlePerceptionReviewPending,
  handlePerceptionSubmit,
  setHandlerContext,
} from './handlers.js';
import { selectLlmExtractor } from './extractors/llm_via_claude_code.js';

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

  if (log) {
    log.info(
      `perception config resolved (llm_enabled=${cfg.extractor_llm_enabled}, timeout=${cfg.llm_timeout_ms}ms, min_bytes=${cfg.llm_min_transcript_bytes}, auto_approve=${cfg.auto_approve_enabled})`,
    );
  }
  return cfg;
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
            'Ingest a transcript window and queue candidate learnings for review. Called by the session_end / pre_compact hooks via the perception inbox drain. Inserts pending_review learnings tagged provenance=inferred. Returns counts and the LLM gate status.',
          inputSchema: {
            type: 'object' as const,
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
            'Manual perception extraction with optional force_llm bypass of the heuristic-first cost gate. Useful for /distill integration and operator triage. Watermark advance is opt-in (defaults false) so manual runs do not shadow the next session_end.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: { type: 'string', description: 'Project slug.' },
              transcript_text: { type: 'string', description: 'Transcript blob.' },
              brief_id: { type: 'string', description: 'Optional brief id for context.' },
              force_llm: {
                type: 'boolean',
                description:
                  'Bypass cost gates (transcript bytes + rules-sufficient). The disabled gate (extractor_llm_enabled=false) is NEVER bypassed.',
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
        // igris_perception_expire_stale (helper, not part of the 5-tool count)
        // -------------------------------------------------------------------
        {
          name: 'igris_perception_expire_stale',
          description:
            'Manually delete pending_review learnings older than ttl_days (default = config.pending_review_ttl_days). Lazy-on-read filter normally hides them; this tool reclaims storage.',
          inputSchema: {
            type: 'object' as const,
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
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      const config = resolvePerceptionConfig(ctx.log);
      const llmExtractor = selectLlmExtractor(config, ctx.log);
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
