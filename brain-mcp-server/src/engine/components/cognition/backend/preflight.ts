/**
 * Brain Engine v7.1 — Cognition backend: the call-free selection preflight
 * (BR-109; docs/COGNITION.md). Fail-open, cached per process.
 *
 * @module engine/components/cognition/backend/preflight
 * @author fifty.dev
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ExtractorHarness, HarnessPreflight } from '../types.js';
import { HARNESS_BIN, isHarnessCliAvailable, registerProbeCacheReset } from './env.js';
import { buildExtractorSpawn, type ExtractorSpawn } from './spawn-map.js';

/** The `--help` argv per harness: the subcommand whose flags the builder uses. */
export const HELP_ARGV: Readonly<Record<ExtractorHarness, readonly string[]>> = {
  claude: ['--help'],
  codex: ['exec', '--help'],
  antigravity: ['--help'],
  opencode: ['run', '--help'],
};

/** Which of `flags` appear in `help` as whole tokens. */
export function flagsInHelp(help: string, flags: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f] = new RegExp(`(^|[\\s,\\[])${f.replace(/[-]/g, '\\-')}([\\s,=\\]]|$)`, 'm').test(help);
  return out;
}

// A harness's SOLE subscription channel (existence only; the file is never opened).
const SOLE_AUTH_STORE: Partial<Record<ExtractorHarness, string>> = {
  opencode: '.local/share/opencode/auth.json',
};

const _preflight = new Map<ExtractorHarness, HarnessPreflight>();

/** Clear the preflight cache (also run by `resetHarnessCliProbeCache`). */
export function resetPreflightCache(): void {
  _preflight.clear();
}
registerProbeCacheReset(resetPreflightCache);

export interface PreflightOptions {
  /** Env for the scratch-root override. */
  env?: NodeJS.ProcessEnv;
  /** `--help` deadline (default 10 s). */
  helpTimeoutMs?: number;
}

/** Is `harness` usable as an extractor on this machine? Cached per process. */
export function preflightHarness(harness: ExtractorHarness, opts: PreflightOptions = {}): HarnessPreflight {
  const cached = _preflight.get(harness);
  if (cached) return cached;
  const verdict = runPreflight(harness, opts);
  _preflight.set(harness, verdict);
  return verdict;
}

function runPreflight(harness: ExtractorHarness, opts: PreflightOptions): HarnessPreflight {
  const bin = HARNESS_BIN[harness];
  if (!isHarnessCliAvailable(harness)) {
    return { usable: false, reason: 'cli_missing', detail: `\`${bin} --version\` did not exit 0` };
  }
  const missing = missingBuilderFlags(harness, opts);
  if (missing.length > 0) {
    const help = `${bin} ${HELP_ARGV[harness].join(' ')}`;
    return { usable: false, reason: 'cli_incompatible', detail: `builder flags absent from \`${help}\`: ${missing.join(', ')}` };
  }
  const store = SOLE_AUTH_STORE[harness];
  if (store && !existsSync(resolve(homedir(), store))) {
    return { usable: false, reason: 'not_logged_in', detail: `no ~/${store} (log in with the ${bin} CLI)` };
  }
  return { usable: true };
}

/** The builder's flags a READABLE help omits; `[]` when the help fails, times out or is empty. */
function missingBuilderFlags(harness: ExtractorHarness, opts: PreflightOptions): string[] {
  let spawn: ExtractorSpawn;
  try {
    spawn = buildExtractorSpawn(harness, { system: '', user: '' }, { env: opts.env ?? process.env });
  } catch {
    return [];
  }
  try {
    const flags = spawn.args.filter((a) => a.startsWith('-'));
    if (flags.length === 0) return [];
    const r = spawnSync(spawn.bin, [...HELP_ARGV[harness]], {
      cwd: spawn.cwd,
      env: spawn.env,
      encoding: 'utf-8',
      timeout: opts.helpTimeoutMs ?? 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const help = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (r.status !== 0 || !help.trim()) return [];
    return Object.entries(flagsInHelp(help, flags))
      .filter(([, present]) => !present)
      .map(([f]) => f);
  } finally {
    spawn.cleanup();
  }
}
