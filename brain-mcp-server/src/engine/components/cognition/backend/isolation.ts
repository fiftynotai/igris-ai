/**
 * Brain Engine v7.1 — Cognition backend: brain-isolation (the LOAD-BEARING safety item).
 *
 * R-BRAIN-LEAK: the extractor's LLM child must NOT reach the live brain. A
 * prompt-injected brief title could call `igris_memory_store` mid-extraction;
 * the model could read/poison the very DB it reasons about. So every extraction
 * call runs in a CLEAN, brain-owned, per-run isolated HOME with ZERO MCP:
 *   - isolated HOME anchored under a brain-owned scratch root
 *     (`~/.igris/cache/llm-extractor/`), NEVER the operator's real HOME;
 *   - an EMPTY `mcpServers` config the isolation OWNS (`{"mcpServers": {}}`) — so
 *     no igris-brain, no tools, no reach into the live DB;
 *   - the harness's own auth files SYMLINKED forward (subscription auth still
 *     works under the redirected HOME);
 *   - `assertUnderRoot` guards EVERY write path — a programming bug that would
 *     write under the real HOME fails fast.
 *
 * PORTED FROM FR-201 (COPY, don't import — R-PORT-DRIFT):
 *   - `makeIsolatedHome` / `assertUnderRoot` / the auth+hybrid symlink machinery
 *       ← `~/StudioProjects/igris-os-eval/b5/harness/home-isolation.ts`
 *         (whole module — the symlink-forward auth pattern, the hybrid-dir
 *         exclude lists, the measure-only `assertUnderRoot` guard).
 *   - the empty-`mcpServers` pattern
 *       ← `b5/judge.ts:423-514` (`buildJudgeGeminiHome` / `makeJudgeGeminiHome` —
 *         the eval-owned `config/mcp_config.json` written as `{"mcpServers": {}}`).
 *
 * FR-201's WHY was cold-baseline purity; here it is not exposing the LIVE brain
 * to an untrusted LLM call — same mechanism, different motivation.
 *
 * @module engine/components/cognition/backend/isolation
 * @author fifty.dev
 */

import {
  resolve,
  relative,
  isAbsolute,
} from 'node:path';
import {
  mkdirSync,
  existsSync,
  symlinkSync,
  rmSync,
  lstatSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ExtractorHarness } from '../types.js';

// ---------------------------------------------------------------------------
// Scratch root (brain-owned — NEVER the operator's real HOME)
// ---------------------------------------------------------------------------

/**
 * The brain-owned scratch ROOT under which every isolated HOME is anchored.
 * `~/.igris/cache/llm-extractor/`. This is NOT the operator's real HOME — it is
 * a dir the brain owns; isolated homes are `<root>/<harness>-<uuid>/`, unique
 * per run (concurrency-safe). Overridable via env for tests (a temp dir).
 */
export function extractorScratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT;
  if (override && override.trim().length > 0) return resolve(override);
  return resolve(homedir(), '.igris', 'cache', 'llm-extractor');
}

// ---------------------------------------------------------------------------
// Auth files / hybrid dirs (ported from home-isolation.ts AUTH_FILES/HYBRID_DIRS)
// ---------------------------------------------------------------------------

/** The macOS login keychain — HOME-scoped; bring it forward so OAuth tokens resolve. */
const MACOS_KEYCHAIN = 'Library/Keychains';

/**
 * Direct auth files brought forward as read-only-by-usage symlinks (the whole
 * file/dir linked at the same relative path). Missing entries are skipped.
 * Ported from `home-isolation.ts:AUTH_FILES`, extended to gemini/opencode/
 * antigravity (which all run through the `agy`/`gemini` Gemini home, handled by
 * the hybrid dirs below).
 */
const AUTH_FILES: Record<ExtractorHarness, string[]> = {
  // Claude: ~/.claude.json + the macOS Keychain (the OAuth token).
  claude: ['.claude.json', MACOS_KEYCHAIN],
  // Codex: ~/.codex/auth.json (hybrid dir below) + the macOS Keychain.
  codex: [MACOS_KEYCHAIN],
  // Gemini: OAuth/state live under ~/.gemini (hybrid dir below) + keychain.
  gemini: [MACOS_KEYCHAIN],
  // OpenCode: token under ~/.local/share/opencode + keychain.
  opencode: ['.local/share/opencode', MACOS_KEYCHAIN],
  // Antigravity runs through the `agy` Gemini home (hybrid dir below) + keychain.
  antigravity: [MACOS_KEYCHAIN],
};

/**
 * Hybrid directories: an operator state dir whose CONTENTS are symlinked in
 * one-by-one EXCEPT the listed `exclude` basenames (the Igris-global files we
 * keep ABSENT so the isolated home stays clean — AND, critically here, we OWN
 * the MCP config so it stays empty). Ported from `home-isolation.ts:HYBRID_DIRS`.
 *
 * For the gemini-family harnesses we exclude `config/mcp_config.json`-adjacent
 * surfaces and write our own empty mcpServers below (the `buildJudgeGeminiHome`
 * pattern). For claude/codex/opencode we exclude their global OS-context files.
 */
interface HybridDir {
  /** The dir RELATIVE to the operator's real HOME (e.g. '.codex'). */
  rel: string;
  /** Basenames inside that dir to NOT bring forward. */
  exclude: string[];
}

const HYBRID_DIRS: Record<ExtractorHarness, HybridDir[]> = {
  // Claude: ~/.claude.json + keychain are sufficient for headless -p; bringing
  // the whole ~/.claude dir forward would leak global Igris agents/skills.
  claude: [],
  // Codex: bring ~/.codex forward EXCEPT the global AGENTS.md (OS-context leak).
  codex: [{ rel: '.codex', exclude: ['AGENTS.md'] }],
  // Gemini: bring ~/.gemini forward EXCEPT config/ (we own config/mcp_config.json
  // → empty mcpServers, written by buildEmptyGeminiMcp below).
  gemini: [{ rel: '.gemini', exclude: ['config'] }],
  // OpenCode: bring the config dir forward EXCEPT global AGENTS.md/CLAUDE.md/opencode.json.
  opencode: [
    { rel: '.config/opencode', exclude: ['AGENTS.md', 'CLAUDE.md', 'opencode.json'] },
  ],
  // Antigravity: same Gemini home as gemini (config/ owned → empty mcpServers).
  antigravity: [{ rel: '.gemini', exclude: ['config'] }],
};

/** Harnesses that read a Gemini-style `config/mcp_config.json` we must own+empty. */
const GEMINI_FAMILY: ReadonlySet<ExtractorHarness> = new Set<ExtractorHarness>([
  'gemini',
  'antigravity',
]);

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface IsolatedHome {
  /** Absolute path to the clean per-run isolated HOME (pass as env.HOME to the CLI). */
  home: string;
  /** Reap the isolated HOME dir (best-effort). MUST be called after the spawn settles. */
  cleanup: () => void;
}

/**
 * Build a clean, brain-owned, per-run isolated HOME for one extraction call.
 *
 *   - Anchored under `extractorScratchRoot()` (NEVER the real HOME).
 *   - A fresh empty dir: ZERO Igris-global files, no MCP.
 *   - The harness's auth files / hybrid state are symlinked forward so headless
 *     subscription auth works (R-AUTH).
 *   - For the gemini family, an empty `config/mcp_config.json` (`{mcpServers:{}}`)
 *     is written so the brain MCP can never be wired in.
 *   - `assertUnderRoot` guards every write path (R-BRAIN-LEAK / measure-only).
 *
 * @param harness which harness (selects the auth files + hybrid dirs)
 * @param env     env to read the scratch-root override from (tests inject a temp dir)
 */
export function makeIsolatedHome(
  harness: ExtractorHarness,
  env: NodeJS.ProcessEnv = process.env,
): IsolatedHome {
  const scratchRoot = extractorScratchRoot(env);
  // <scratchRoot>/<harness>-<uuid>/ — unique per run (concurrency-safe).
  const home = resolve(scratchRoot, `${harness}-${randomUUID().slice(0, 8)}`);
  assertUnderRoot(home, scratchRoot);
  // A fresh, empty dir: the clean isolation floor.
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  // Bring auth/state forward as read-only-by-usage symlinks (R-AUTH) WITHOUT the
  // Igris-global OS files NOR any MCP config.
  symlinkAuthFiles(harness, home);
  symlinkHybridDirs(harness, home);

  // The gemini family reads config/mcp_config.json: own it, write empty mcpServers
  // so the isolated child has ZERO brain/tool access (the FR-201 C1 fix).
  if (GEMINI_FAMILY.has(harness)) {
    writeEmptyGeminiMcp(home);
  }

  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort reap */
      }
    },
  };
}

/**
 * Write the eval-OWNED `~/.gemini/config/mcp_config.json` as `{"mcpServers": {}}`
 * inside the isolated home — ZERO MCP servers, so a gemini/antigravity child can
 * never resolve the operator's live brain. Ported from
 * `judge.ts:buildJudgeGeminiHome:450-453`. Every path is asserted under the home.
 */
export function writeEmptyGeminiMcp(home: string): void {
  const configDir = resolve(home, '.gemini', 'config');
  assertUnderRoot(configDir, home);
  mkdirSync(configDir, { recursive: true });
  const dest = resolve(configDir, 'mcp_config.json');
  assertUnderRoot(dest, home);
  writeFileSync(dest, JSON.stringify({ mcpServers: {} }, null, 2));
}

// ---------------------------------------------------------------------------
// Symlink machinery (ported from home-isolation.ts)
// ---------------------------------------------------------------------------

/**
 * Symlink each of the harness's direct auth files into the isolated HOME at the
 * SAME relative location. A missing source is skipped. The operator file is the
 * TARGET, never written. Ported from `home-isolation.ts:symlinkAuthFiles`.
 */
function symlinkAuthFiles(harness: ExtractorHarness, isolatedHome: string): void {
  const realHome = homedir();
  for (const rel of AUTH_FILES[harness]) {
    const src = resolve(realHome, rel);
    if (!existsSync(src) && !isSymlink(src)) continue; // operator doesn't have it — skip
    const dest = resolve(isolatedHome, rel);
    assertUnderRoot(dest, isolatedHome);
    mkdirSync(resolve(dest, '..'), { recursive: true });
    linkInto(src, dest);
  }
}

/**
 * For each hybrid dir, create it inside the isolated HOME and symlink in each of
 * the operator dir's entries EXCEPT the excluded basenames. Brings auth/state
 * forward (CLI stays "logged in") while leaving the OS-identity + MCP files OUT.
 * Ported from `home-isolation.ts:symlinkHybridDirs`.
 */
function symlinkHybridDirs(harness: ExtractorHarness, isolatedHome: string): void {
  const realHome = homedir();
  for (const hd of HYBRID_DIRS[harness]) {
    const srcDir = resolve(realHome, hd.rel);
    if (!existsSync(srcDir)) continue; // operator doesn't have this dir — skip
    const destDir = resolve(isolatedHome, hd.rel);
    assertUnderRoot(destDir, isolatedHome);
    mkdirSync(destDir, { recursive: true });
    const exclude = new Set(hd.exclude);
    for (const entry of readdirSync(srcDir)) {
      if (exclude.has(entry)) continue; // leave the excluded file OUT
      const src = resolve(srcDir, entry);
      const dest = resolve(destDir, entry);
      assertUnderRoot(dest, isolatedHome);
      linkInto(src, dest);
    }
  }
}

/**
 * Assert `target` resolves to a path INSIDE `root`. The measure-only guard: every
 * dir this module creates and every symlink LINK path it places must live under
 * the brain-owned scratch root, never escape into the operator's real HOME.
 * Throws (fail-fast) on an escape — a programming bug, not a runtime condition.
 * (Symlink TARGETS legitimately point outside; this guards the LINK paths.)
 * Ported verbatim from `home-isolation.ts:assertUnderRoot`.
 */
export function assertUnderRoot(target: string, root: string): void {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  if (rel === '') return; // target IS the root
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `cognition/isolation: refusing to operate on a path outside the brain-owned scratch root.\n` +
        `  root:   ${r}\n  target: ${t}\n` +
        `This is the R-BRAIN-LEAK safety guard — the extractor must never write under the ` +
        `operator's real HOME.`,
    );
  }
}

/** Replace any existing entry at dest with a symlink to src (idempotent). */
function linkInto(src: string, dest: string): void {
  try {
    if (existsSync(dest) || isSymlink(dest)) rmSync(dest, { recursive: true, force: true });
  } catch {
    /* re-symlink below surfaces a real failure */
  }
  symlinkSync(src, dest);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test/diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * The Igris-global markers an isolated HOME must NEVER contain. The unit test
 * asserts none are present. Ported from `home-isolation.ts:FORBIDDEN_IGRIS_MARKERS`.
 */
export const FORBIDDEN_IGRIS_MARKERS = [
  '.claude/CLAUDE.md',
  '.codex/AGENTS.md',
  '.igris/core',
  '.config/opencode/opencode.json',
  '.gemini/config/mcp_config.json', // present ONLY as our empty-mcpServers file (checked separately)
];

/** The direct auth FILES a given harness brings forward (read-only). For the test. */
export function authPathsFor(harness: ExtractorHarness): string[] {
  return AUTH_FILES[harness];
}

/** The hybrid state DIRS a given harness brings forward. For the test. */
export function hybridDirsFor(harness: ExtractorHarness): HybridDir[] {
  return HYBRID_DIRS[harness];
}
