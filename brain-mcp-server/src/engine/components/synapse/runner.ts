/**
 * Brain Engine v7.1 — Synapse Runner (FR-211).
 *
 * The LIVE run entry point `runSynapse` — the synapse edge-inference instance
 * driven through the agnostic cognition engine. Builds a fresh synapse instance
 * from the resolved config and drives it through `runExtractor`, which owns the
 * cold-start / budget / timeout / brain-isolated LLM call / one-terminal-event-
 * per-run lifecycle. The `synapse_engine` cron (daily 03:00) hits this via
 * `igris_synapse_run`.
 *
 * The lifecycle events are written by the engine under the per-instance
 * `cognition.synapse.*` namespace (event_log directly — observable via
 * `igris_event_log component='cognition.synapse'`). Synapse rides the engine +
 * backend UNCHANGED, inheriting brain-isolation (isolated HOME, empty
 * mcpServers, --strict-mcp-config, assertUnderRoot) for free (AC #4).
 *
 * @module engine/components/synapse/runner
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { DEFAULT_SYNAPSE_CONFIG, type SynapseConfig } from './types.js';
import { runExtractor, type LlmExtractorGlobalConfig } from '../cognition/engine/index.js';
import type { ExtractorResult } from '../cognition/types.js';
import { createSynapseInstance } from '../cognition/extractors/synapse.js';

/** Options for `runSynapse`. */
export interface RunSynapseOptions {
  /** The resolved synapse instance config (timeout/budget/min-bytes/enabled/harness + candidate knobs). */
  config?: SynapseConfig;
  /** The global `llm_extractor` config (harness default + fallback order). */
  globalConfig?: LlmExtractorGlobalConfig;
  /** Bypass the cold-start + bytes cost gate (manual `*_run` forces a run). */
  force?: boolean;
  /** What triggered this run ('cron' | 'manual' | a test tag) — observability. */
  trigger?: string;
  /**
   * Injectable engine seams (for tests: a mocked backend, a stubbed cold-start
   * probe). Forwarded verbatim to `runExtractor`'s `deps`. The default (omitted)
   * runs the real brain-isolated backend.
   */
  deps?: Parameters<typeof runExtractor>[3];
}

/**
 * Run the synapse edge-inference instance ONCE through the agnostic cognition
 * engine (FR-211). Builds a fresh synapse instance from the resolved config and
 * drives it through `runExtractor`. The schedule (`synapse_engine`, daily 03:00)
 * hits THIS via `igris_synapse_run`.
 *
 * @param db      the brain DB
 * @param project the project scope ('all' = whole brain)
 * @param options config + global config + force/trigger + injectable engine deps
 */
export async function runSynapse(
  db: Database.Database,
  project = 'all',
  options: RunSynapseOptions = {},
): Promise<ExtractorResult> {
  const config = options.config ?? DEFAULT_SYNAPSE_CONFIG;
  const instance = createSynapseInstance(config);
  const deps = {
    ...(options.globalConfig ? { globalConfig: options.globalConfig } : {}),
    ...(options.deps ?? {}),
  };
  return runExtractor(
    db,
    instance,
    {
      project,
      trigger: options.trigger ?? 'manual',
      ...(options.force ? { force: true } : {}),
    },
    deps,
  );
}
