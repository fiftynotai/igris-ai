/**
 * Cognition backend brain-isolation tests (FR-118 M0) — the LOAD-BEARING R-BRAIN-LEAK guard.
 *
 * Covers:
 *   - makeIsolatedHome anchors under the brain-owned scratch root (NEVER real HOME)
 *   - the gemini family gets an empty mcpServers config ({"mcpServers": {}})
 *   - NO Igris-global markers leak into the isolated home
 *   - assertUnderRoot REJECTS any write path escaping the scratch root
 *   - cleanup reaps the home
 *
 * HOME is fenced to an EMPTY temp dir (asserted armed): since BR-108 the builder
 * READS the operator's config files to write owned copies, so an unfenced run
 * would read the real ~/.claude.json, ~/.codex and ~/.gemini.
 *
 * @module engine/components/cognition/__tests__/isolation.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  makeIsolatedHome,
  assertUnderRoot,
  writeEmptyGeminiMcp,
  extractorScratchRoot,
  FORBIDDEN_IGRIS_MARKERS,
} from '../backend/isolation.js';
import type { ExtractorHarness } from '../types.js';

let fenceHome = '';
beforeEach(() => {
  fenceHome = mkdtempSync(join(tmpdir(), 'cog-iso-home-'));
  vi.stubEnv('HOME', fenceHome);
  expect(homedir()).toBe(fenceHome); // armed, not assumed
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fenceHome, { recursive: true, force: true });
});

describe('extractorScratchRoot', () => {
  it('defaults under ~/.igris/cache/llm-extractor and honours the env override', () => {
    const def = extractorScratchRoot({});
    expect(def).toContain('.igris');
    expect(def).toContain('llm-extractor');
    expect(def).not.toMatch(/llm-extractor$.*HOME/);
    const overridden = extractorScratchRoot({ IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: '/tmp/scratch' });
    expect(overridden).toBe(resolve('/tmp/scratch'));
  });
});

describe('makeIsolatedHome — anchored under the brain-owned scratch root', () => {
  let scratch: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cog-iso-'));
    env = { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } as NodeJS.ProcessEnv;
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('creates a per-run home UNDER the scratch root and cleanup reaps it', () => {
    const iso = makeIsolatedHome('claude', env);
    expect(iso.home.startsWith(resolve(scratch))).toBe(true);
    expect(existsSync(iso.home)).toBe(true);
    iso.cleanup();
    expect(existsSync(iso.home)).toBe(false);
  });

  it('each run gets a UNIQUE home (concurrency-safe)', () => {
    const a = makeIsolatedHome('claude', env);
    const b = makeIsolatedHome('claude', env);
    expect(a.home).not.toBe(b.home);
    a.cleanup();
    b.cleanup();
  });

  it('the gemini family gets an EMPTY mcpServers config (no brain reach)', () => {
    const iso = makeIsolatedHome('gemini', env);
    const mcpConfig = join(iso.home, '.gemini', 'config', 'mcp_config.json');
    expect(existsSync(mcpConfig)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpConfig, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toEqual({}); // ZERO MCP servers — R-BRAIN-LEAK
    iso.cleanup();
  });

  it('antigravity also gets the empty gemini mcpServers', () => {
    const iso = makeIsolatedHome('antigravity', env);
    const mcpConfig = join(iso.home, '.gemini', 'config', 'mcp_config.json');
    expect(existsSync(mcpConfig)).toBe(true);
    expect(JSON.parse(readFileSync(mcpConfig, 'utf-8')).mcpServers).toEqual({});
    iso.cleanup();
  });

  it.each(['claude', 'codex', 'gemini', 'antigravity', 'opencode'] as ExtractorHarness[])(
    'the %s home contains none of FORBIDDEN_IGRIS_MARKERS (clean isolation floor)',
    (h) => {
      mkdirSync(join(fenceHome, '.gemini', 'agents'), { recursive: true }); // an operator marker to NOT forward
      const iso = makeIsolatedHome(h, env);
      const present = FORBIDDEN_IGRIS_MARKERS.filter((m) => {
        if (m === '.gemini/config/mcp_config.json') return false; // the owned empty file, checked above
        try {
          lstatSync(join(iso.home, m));
          return true;
        } catch {
          return false;
        }
      });
      expect(present).toEqual([]);
      iso.cleanup();
    },
  );
});

describe('writeEmptyGeminiMcp', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cog-mcp-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('writes {"mcpServers": {}} under the home', () => {
    writeEmptyGeminiMcp(scratch);
    const dest = join(scratch, '.gemini', 'config', 'mcp_config.json');
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual({ mcpServers: {} });
  });
});

describe('assertUnderRoot — rejects any escape (R-BRAIN-LEAK / measure-only guard)', () => {
  const root = resolve('/tmp/scratch-root');

  it('accepts the root itself and paths under it', () => {
    expect(() => assertUnderRoot(root, root)).not.toThrow();
    expect(() => assertUnderRoot(join(root, '.gemini', 'config'), root)).not.toThrow();
    expect(() => assertUnderRoot(join(root, 'a', 'b', 'c'), root)).not.toThrow();
  });

  it('REJECTS a parent-traversal escape', () => {
    expect(() => assertUnderRoot(join(root, '..', 'evil'), root)).toThrow(/outside the brain-owned scratch root/);
  });

  it('REJECTS an absolute path outside the root (e.g. the real HOME)', () => {
    expect(() => assertUnderRoot('/Users/victim/.igris/memory/knowledge.db', root)).toThrow(
      /outside the brain-owned scratch root/,
    );
  });

  it('REJECTS a sibling dir that shares a prefix string but not the path', () => {
    expect(() => assertUnderRoot('/tmp/scratch-root-evil/x', root)).toThrow(/outside the brain-owned scratch root/);
  });
});
