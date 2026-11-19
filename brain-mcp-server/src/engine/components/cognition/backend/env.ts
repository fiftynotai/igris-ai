/**
 * Brain Engine v7.1 — Cognition backend: env + CLI availability + harness resolution.
 *
 * PORTED FROM FR-201 (separate repo, no published package — COPY, don't import;
 * R-PORT-DRIFT, follow-on TD to extract a shared package):
 *   - `subscriptionOnlyEnv`        ← `~/StudioProjects/igris-os-eval/b5/judge.ts:323-328`
 *                                    (narrowed to an allowlist by TD-472)
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
  RETIRED_GEMINI_HARNESS,
  type ExtractorHarness,
  type ExtractorHarnessSelection,
  type HarnessPreflight,
  type HarnessRefusal,
  type ResolvedBackend,
} from '../types.js';

// ---------------------------------------------------------------------------
// Harness → CLI binary map
// ---------------------------------------------------------------------------

/**
 * The CLI binary name for each harness. `antigravity` runs through the `agy`
 * binary (the FR-201/antigravity convention — the antigravity adapter shells
 * `agy --print`); the rest match their harness id. TD-474: no `gemini` entry —
 * the retired token never reaches a spawn, so it never needs a binary name.
 */
export const HARNESS_BIN: Record<ExtractorHarness, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
};

// ---------------------------------------------------------------------------
// TD-474 — the retired gemini token's refusal detail
// ---------------------------------------------------------------------------

/**
 * The exact detail text a `gemini` selection is refused with, at every
 * resolution layer. Quoted verbatim by `docs/COGNITION.md`'s "gemini — retired
 * from the extractor" subsection — one string, one place it is authored.
 */
export const GEMINI_RETIRED_DETAIL =
  "gemini is retired from the Igris extractor (TD-474): the vendor retired gemini-cli's personal Code Assist tier and Antigravity is Google's harness now. Use the antigravity harness instead (llm_extractor.harness, or list it first in fallback_order).";

// ---------------------------------------------------------------------------
// subscriptionOnlyEnv (ported from FR-201 judge.ts:323-328; narrowed to an
// allowlist by TD-471 → TD-472)
// ---------------------------------------------------------------------------

/** The only names a child INHERITS (TD-472; classes in docs/COGNITION.md). */
const CHILD_ENV_ALLOW = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE', 'CODEX_CA_CERTIFICATE', '__CF_USER_TEXT_ENCODING',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
]);
const CHILD_ENV_ALLOW_PREFIXES = ['LC_'] as const;
const METERED_KEY_SUFFIX = '_API_KEY';

/**
 * A FRESH child env (never mutates `base`): only allowlisted INHERITED names,
 * then `extra`, then no `*_API_KEY` at all (FR-201: no metered credits).
 * See docs/COGNITION.md and MAINTAINING.md's extractor child-env row.
 */
export function subscriptionOnlyEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (CHILD_ENV_ALLOW.has(name) || CHILD_ENV_ALLOW_PREFIXES.some((p) => name.startsWith(p))) {
      inherited[name] = value;
    }
  }
  const env: NodeJS.ProcessEnv = { ...inherited, ...extra };
  for (const key of Object.keys(env)) if (key.endsWith(METERED_KEY_SUFFIX)) delete env[key];
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
 * acceptable. `codex`/`opencode`/`antigravity` follow the same contract: a
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

const _probeCacheResets: Array<() => void> = [];

/** Register another per-process probe cache for `resetHarnessCliProbeCache` (preflight.ts; no import cycle). */
export function registerProbeCacheReset(reset: () => void): void {
  _probeCacheResets.push(reset);
}

/** Reset the cached probes (the `--version` cache and every registered one, e.g. the preflight). */
export function resetHarnessCliProbeCache(): void {
  _cliAvailable.clear();
  for (const reset of _probeCacheResets) reset();
}

// ---------------------------------------------------------------------------
// resolveHarness — the 4-layer chain
// ---------------------------------------------------------------------------

/** The global `llm_extractor` config section (read from ~/.igris/config.json). */
export interface LlmExtractorGlobalConfig {
  /**
   * Global default backend. Defaults to 'claude' when unset. TD-474: widened to
   * `ExtractorHarnessSelection` so an operator's `"harness": "gemini"` is
   * RECOGNIZED (and refused loudly by `resolveBackend`) rather than treated as
   * noise.
   */
  harness?: ExtractorHarnessSelection | null;
  /** Order to try when the chosen harness CLI is absent. Same TD-474 widening. */
  fallback_order?: ExtractorHarnessSelection[];
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
 * instance. TD-474: the retired `gemini` token is NOT invalid at this layer —
 * it is recognized (`isExtractorHarnessSelection`) so `resolveBackend` can
 * refuse it LOUDLY rather than this parser silently dropping it as noise.
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
  instanceHarness: ExtractorHarnessSelection | null,
  env: NodeJS.ProcessEnv = process.env,
): ExtractorHarnessSelection {
  // Layer 1: default.
  let chosen: ExtractorHarnessSelection = 'claude';

  // Layer 2: global config.
  if (isExtractorHarnessSelection(global.harness)) chosen = global.harness;

  // Layer 3: per-instance config (null = inherit).
  if (isExtractorHarnessSelection(instanceHarness)) chosen = instanceHarness;

  // Layer 4: env overrides. Global env first, then the per-instance env so the
  // per-instance one wins (highest precedence).
  const globalEnv = env.IGRIS_LLM_EXTRACTOR_HARNESS;
  if (isExtractorHarnessSelection(globalEnv)) chosen = globalEnv;

  const instanceEnvKey = `IGRIS_${instanceId.toUpperCase()}_HARNESS`;
  const instanceEnv = env[instanceEnvKey];
  if (isExtractorHarnessSelection(instanceEnv)) chosen = instanceEnv;

  return chosen;
}

/**
 * Resolve the harness AND its availability for a run. Picks the harness via the
 * 4-layer chain, then probes it; if absent, walks the fallback order (global
 * `fallback_order`, else all harnesses) and returns the first present one. When
 * NONE is present, returns `{ harness: null }` — the engine maps that to
 * `run_skipped` (no rule fallback, they are deleted). A probe may return a
 * `HarnessPreflight` (BR-109): a refused harness is skipped and listed in
 * `refused`; a boolean probe yields the pre-BR-109 object.
 *
 * TD-474: when the walk reaches the retired `gemini` token it is refused
 * IMMEDIATELY — `reason: 'harness_retired'`, `detail: GEMINI_RETIRED_DETAIL` —
 * WITHOUT ever calling `isAvailable`/`preflightHarness`. The retirement is a
 * static, permanent fact (the vendor discontinued the tier), not a per-machine
 * condition to probe. The walk then CONTINUES, so a present harness (claude, by
 * default) still runs — gemini is never silently dropped and never becomes
 * `ResolvedBackend.harness`.
 *
 * The chosen harness is always tried FIRST (regardless of where it sits in the
 * fallback order) so an explicit selection is honoured before alternatives.
 *
 * @param global          the `llm_extractor` config section
 * @param instanceId      the instance id
 * @param instanceHarness the per-instance `config.harness`
 * @param env             the env (overrides + probe availability are pure here)
 * @param isAvailable     availability probe or preflight (injectable; defaults to the `--version` probe)
 */
export function resolveBackend(
  global: LlmExtractorGlobalConfig,
  instanceId: string,
  instanceHarness: ExtractorHarnessSelection | null,
  env: NodeJS.ProcessEnv = process.env,
  isAvailable: (h: ExtractorHarness) => boolean | HarnessPreflight = isHarnessCliAvailable,
): ResolvedBackend {
  const chosen = resolveHarness(global, instanceId, instanceHarness, env);

  // Build the probe order: the chosen harness first, then the configured
  // fallback order (de-duplicated), then any remaining harnesses.
  const configuredFallback =
    Array.isArray(global.fallback_order) && global.fallback_order.length > 0
      ? global.fallback_order.filter(isExtractorHarnessSelection)
      : [...ALL_EXTRACTOR_HARNESSES];
  const tried: ExtractorHarnessSelection[] = [];
  const seen = new Set<ExtractorHarnessSelection>();
  for (const h of [chosen, ...configuredFallback, ...ALL_EXTRACTOR_HARNESSES]) {
    if (!seen.has(h)) {
      seen.add(h);
      tried.push(h);
    }
  }

  const refused: HarnessRefusal[] = [];
  const result = (harness: ExtractorHarness | null): ResolvedBackend =>
    refused.length > 0 ? { harness, fallback_order: tried, refused } : { harness, fallback_order: tried };
  for (const h of tried) {
    if (h === RETIRED_GEMINI_HARNESS) {
      // TD-474: static, permanent refusal — never probed, walk continues.
      refused.push({ harness: h, reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL });
      continue;
    }
    const verdict = isAvailable(h);
    if (verdict === true) return result(h);
    if (verdict === false) continue;
    if (verdict.usable) return result(h);
    refused.push({ harness: h, reason: verdict.reason, detail: verdict.detail });
  }
  return result(null);
}

/** Narrow an unknown value to a valid `ExtractorHarness` (runnable — excludes the retired token). */
function isValidHarness(v: unknown): v is ExtractorHarness {
  return (
    typeof v === 'string' &&
    (ALL_EXTRACTOR_HARNESSES as readonly string[]).includes(v)
  );
}

/**
 * Narrow an unknown value to a valid `ExtractorHarnessSelection` — a runnable
 * harness, OR the retired `gemini` token (TD-474). Used at every layer of
 * `resolveHarness`'s chain so an explicit `gemini` selection is RECOGNIZED
 * (never treated as an invalid/unknown string) and can reach `resolveBackend`'s
 * loud refusal.
 */
export function isExtractorHarnessSelection(v: unknown): v is ExtractorHarnessSelection {
  return isValidHarness(v) || v === RETIRED_GEMINI_HARNESS;
}
