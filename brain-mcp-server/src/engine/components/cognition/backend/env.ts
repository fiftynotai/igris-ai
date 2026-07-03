/**
 * Brain Engine v7.1 — Cognition backend: env + CLI availability + harness resolution.
 *
 * PORTED FROM FR-201 (separate repo, no published package — COPY, don't import;
 * R-PORT-DRIFT, follow-on TD to extract a shared package):
 *   - `subscriptionOnlyEnv`        ← `~/StudioProjects/igris-os-eval/b5/judge.ts:323-328`
 *   - the cached `--version` probe ← generalized from
 *                                    `subconscious/verifier.ts:184-197`
 *                                    (`isClaudeCliAvailable`) into a per-harness
 *                                    `isHarnessCliAvailable(harness)`.
 *   - `resolveHarness`             ← NEW (the 4-layer chain the plan §"config
 *                                    shape" specifies; mirrors
 *                                    `resolvePerceptionConfig`'s layered chain).
 *
 * @module engine/components/cognition/backend/env
 * @author fifty.dev
 */

import { spawnSync } from 'node:child_process';
import {
  ALL_EXTRACTOR_HARNESSES,
  type ExtractorHarness,
  type ResolvedBackend,
} from '../types.js';

// ---------------------------------------------------------------------------
// Harness → CLI binary map
// ---------------------------------------------------------------------------

/**
 * The CLI binary name for each harness. `antigravity` runs through the `agy`
 * binary (the FR-201/antigravity convention — the antigravity adapter shells
 * `agy --print`); the rest match their harness id.
 */
export const HARNESS_BIN: Record<ExtractorHarness, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
  antigravity: 'agy',
};

// ---------------------------------------------------------------------------
// subscriptionOnlyEnv (ported verbatim — FR-201 judge.ts:323-328)
// ---------------------------------------------------------------------------

/**
 * Strip metered-API-key vars from a child env so the CLI MUST use
 * subscription/account login (operator directive, FR-201: no API keys, no
 * metered credits anywhere). Returns a FRESH env (never mutates `base`).
 *
 * Ported verbatim from `b5/judge.ts:323-328`. The motivation here differs from
 * FR-201's (there: keep the eval off billed credits; here: the extraction call
 * runs unattended on a schedule and must never silently bill the operator), but
 * the mechanism is identical.
 */
export function subscriptionOnlyEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

// ---------------------------------------------------------------------------
// CLI availability probe (generalized from verifier.ts:isClaudeCliAvailable)
// ---------------------------------------------------------------------------

/**
 * Per-harness cache of the `--version` probe result so we only fork each CLI
 * once per process (matches `verifier.ts`'s single-cell cache, now keyed by
 * harness). `null` = not yet probed.
 */
const _cliAvailable = new Map<ExtractorHarness, boolean>();

/**
 * Probe whether a harness CLI is callable. Cached per harness after the first
 * call. Returns `false` on any exception, missing-binary, or non-zero exit.
 *
 * Generalized from `subconscious/verifier.ts:isClaudeCliAvailable` — same
 * `spawnSync('<bin>', ['--version'])` with a tight 5s timeout. Runs at instance
 * init / run-resolution time (not the hot path), so a blocking sync probe is
 * acceptable. `gemini`/`opencode`/`antigravity` follow the same contract: a
 * `--version` that exits 0 means "present and runnable".
 *
 * @param harness the harness to probe
 */
export function isHarnessCliAvailable(harness: ExtractorHarness): boolean {
  const cached = _cliAvailable.get(harness);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    const result = spawnSync(HARNESS_BIN[harness], ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf-8',
    });
    available = result.status === 0;
  } catch {
    available = false;
  }
  _cliAvailable.set(harness, available);
  return available;
}

/** Reset the cached probes — used by tests so the cache doesn't leak across files. */
export function resetHarnessCliProbeCache(): void {
  _cliAvailable.clear();
}

// ---------------------------------------------------------------------------
// resolveHarness — the 4-layer chain
// ---------------------------------------------------------------------------

/** The global `llm_extractor` config section (read from ~/.igris/config.json). */
export interface LlmExtractorGlobalConfig {
  /** Global default backend. Defaults to 'claude' when unset. */
  harness?: ExtractorHarness | null;
  /** Order to try when the chosen harness CLI is absent. */
  fallback_order?: ExtractorHarness[];
}

/**
 * Resolve which harness CLI runs an instance's extraction, via the 4-layer
 * chain (lowest precedence first):
 *
 *   1. DEFAULT          — `'claude'`.
 *   2. GLOBAL config    — `llm_extractor.harness`.
 *   3. PER-INSTANCE     — `instanceConfig.harness` (`null` = inherit the above).
 *   4. ENV override     — `IGRIS_<INSTANCE>_HARNESS` (per-instance, HIGHEST)
 *                         then `IGRIS_LLM_EXTRACTOR_HARNESS` (global).
 *
 * Env precedence: the per-instance env var wins over the global env var (a
 * targeted override beats a blanket one). An invalid harness value at any layer
 * is ignored (the lower layer stands), so a typo never silently disables the
 * instance.
 *
 * This returns only the CHOSEN harness (string) — availability is resolved
 * separately by `resolveBackend` so the choice and the probe are testable apart.
 *
 * @param global         the `llm_extractor` config section (may be empty)
 * @param instanceId     the instance id (used for the `IGRIS_<INSTANCE>_HARNESS` env key)
 * @param instanceHarness the per-instance `config.harness` (null ⇒ inherit)
 * @param env            the env to read overrides from (defaults to process.env)
 */
export function resolveHarness(
  global: LlmExtractorGlobalConfig,
  instanceId: string,
  instanceHarness: ExtractorHarness | null,
  env: NodeJS.ProcessEnv = process.env,
): ExtractorHarness {
  // Layer 1: default.
  let chosen: ExtractorHarness = 'claude';

  // Layer 2: global config.
  if (isValidHarness(global.harness)) chosen = global.harness;

  // Layer 3: per-instance config (null = inherit).
  if (isValidHarness(instanceHarness)) chosen = instanceHarness;

  // Layer 4: env overrides. Global env first, then the per-instance env so the
  // per-instance one wins (highest precedence).
  const globalEnv = env.IGRIS_LLM_EXTRACTOR_HARNESS;
  if (isValidHarness(globalEnv)) chosen = globalEnv;

  const instanceEnvKey = `IGRIS_${instanceId.toUpperCase()}_HARNESS`;
  const instanceEnv = env[instanceEnvKey];
  if (isValidHarness(instanceEnv)) chosen = instanceEnv;

  return chosen;
}

/**
 * Resolve the harness AND its availability for a run. Picks the harness via the
 * 4-layer chain, then probes it; if absent, walks the fallback order (global
 * `fallback_order`, else all harnesses) and returns the first present one. When
 * NONE is present, returns `{ harness: null }` — the engine maps that to
 * `run_skipped reason=cli_missing` (the brief's required skip; no rule fallback,
 * they are deleted).
 *
 * The chosen harness is always tried FIRST (regardless of where it sits in the
 * fallback order) so an explicit selection is honoured before alternatives.
 *
 * @param global          the `llm_extractor` config section
 * @param instanceId      the instance id
 * @param instanceHarness the per-instance `config.harness`
 * @param env             the env (overrides + probe availability are pure here)
 * @param isAvailable     availability probe (injectable for tests; defaults to the real CLI probe)
 */
export function resolveBackend(
  global: LlmExtractorGlobalConfig,
  instanceId: string,
  instanceHarness: ExtractorHarness | null,
  env: NodeJS.ProcessEnv = process.env,
  isAvailable: (h: ExtractorHarness) => boolean = isHarnessCliAvailable,
): ResolvedBackend {
  const chosen = resolveHarness(global, instanceId, instanceHarness, env);

  // Build the probe order: the chosen harness first, then the configured
  // fallback order (de-duplicated), then any remaining harnesses.
  const configuredFallback =
    Array.isArray(global.fallback_order) && global.fallback_order.length > 0
      ? global.fallback_order.filter(isValidHarness)
      : [...ALL_EXTRACTOR_HARNESSES];
  const tried: ExtractorHarness[] = [];
  const seen = new Set<ExtractorHarness>();
  for (const h of [chosen, ...configuredFallback, ...ALL_EXTRACTOR_HARNESSES]) {
    if (!seen.has(h)) {
      seen.add(h);
      tried.push(h);
    }
  }

  for (const h of tried) {
    if (isAvailable(h)) {
      return { harness: h, fallback_order: tried };
    }
  }
  return { harness: null, fallback_order: tried };
}

/** Narrow an unknown value to a valid `ExtractorHarness`. */
function isValidHarness(v: unknown): v is ExtractorHarness {
  return (
    typeof v === 'string' &&
    (ALL_EXTRACTOR_HARNESSES as readonly string[]).includes(v)
  );
}
