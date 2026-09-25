/**
 * Cognition backend — the isolated HOME reaches no MCP server and no metered-key
 * file, for every harness (BR-108; the FILE half of TD-472's env allowlist).
 *
 * Every case builds through the REAL `buildExtractorSpawn(h, PROMPT, opts)` and
 * reads `spawn.cwd` (the isolated HOME). No CLI is spawned anywhere.
 *
 * Fence (the TD-471/TD-472 shape): HOME is `<tmp>/home`, a FIXTURE operator HOME
 * seeded by `seedOperatorHome`; `homedir()` is asserted to be the fake AND to
 * differ from `os.userInfo().homedir` (the passwd home, independent of HOME), so
 * the operator's real ~/.claude.json, ~/.codex, ~/.gemini, ~/.config/opencode and
 * ~/.local/share/opencode are never read. The scratch root is `<tmp>/scratch`, and
 * `<tmp>/.env` is the ancestor `.env` F6's positive control must be able to see.
 *
 * D6: assertions are on key PATHS and name ARRAYS; fixture values are placeholders.
 *
 * Cases (plan "Testing Strategy"): F1 no MCP name visible; F2 exact manifest
 * membership; F3 the Linux claude credential link; F4 auth keys survive, exec keys
 * do not; F5 no write-through (byte witness); F5m owned files are 0o600 regular;
 * F6 `.env` sentinels + a verbatim gemini-cli `findEnvFile` replica; F7 fail-closed
 * parsing; F8 forbidden markers; F9 the fence; P1-P3 the argv pins; P4-P5 (BR-109) the gemini
 * argv against gemini-cli 0.45.0's declared options, and the agy argv unchanged.
 *
 * @module engine/components/cognition/__tests__/isolation-file-channels.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import * as path from 'node:path';
import { buildExtractorSpawn, FORBIDDEN_IGRIS_MARKERS, forwardPathsFor } from '../backend/index.js';
import type { ExtractorSpawn } from '../backend/spawn-map.js';
import type { ExtractorHarness, ExtractorPrompt } from '../types.js';
import {
  CODEX_FIXTURE_ROOT_KEYS,
  EXPECTED_CODEX_FEATURE_DENY,
  EXPECTED_FORBIDDEN_MARKERS,
  EXPECTED_FORWARD,
  EXPECTED_OWNED,
  GEMINI_NO_MCP_SENTINEL,
  NEVER_FORWARDED,
  childVisibleMcpNames,
  seedOperatorHome,
} from './fixtures/br108-isolated-home.js';
import { GEMINI_045_OPTIONS } from './fixtures/br109-cli-failures.js';

const PROMPT: ExtractorPrompt = { system: 'extract', user: 'ctx' };
const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'];
const GEMINI_FAMILY: ExtractorHarness[] = ['gemini', 'antigravity'];

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

let root = '';
let fakeHome = '';
let scratch = '';

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'br108-')));
  fakeHome = path.join(root, 'home');
  scratch = path.join(root, 'scratch');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  seedOperatorHome(fakeHome);
  // The ancestor .env files above the scratch root (F6's positive control must see them).
  writeFileSync(path.join(root, '.env'), 'GEMINI_API_KEY=fx\n');
  mkdirSync(path.join(root, '.gemini'));
  writeFileSync(path.join(root, '.gemini', '.env'), 'GEMINI_API_KEY=fx\n');
  vi.stubEnv('HOME', fakeHome);
  // Armed, not assumed: homedir() is the fixture, and it is not the passwd home.
  expect(homedir()).toBe(fakeHome);
  expect(homedir()).not.toBe(userInfo().homedir);
});

afterEach(() => {
  vi.unstubAllEnvs(); // restores by key — never `process.env = saved`
  rmSync(root, { recursive: true, force: true });
});

function build(h: ExtractorHarness): ExtractorSpawn {
  return buildExtractorSpawn(h, PROMPT, { env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });
}

/** Build, hand the isolated HOME to `fn`, always reap. */
function withHome<T>(h: ExtractorHarness, fn: (iso: string, spawn: ExtractorSpawn) => T): T {
  const spawn = build(h);
  try {
    return fn(spawn.cwd, spawn);
  } finally {
    spawn.cleanup();
  }
}

type Kind = 'link' | 'file' | 'dir';

/** The isolated HOME's manifest, walked WITHOUT following links: `rel:kind`, sorted. */
function manifest(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs)) {
      const a = path.join(abs, e);
      const r = rel ? `${rel}/${e}` : e;
      const st = lstatSync(a);
      const kind: Kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
      out.push(`${r}:${kind}`);
      if (kind === 'dir') walk(a, r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Expected manifest: FORWARD as links, OWNED as files, every ancestor as a dir. */
function expectedManifest(h: ExtractorHarness): string[] {
  const out = new Set<string>();
  const addParents = (rel: string): void => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) out.add(`${parts.slice(0, i).join('/')}:dir`);
  };
  for (const rel of EXPECTED_FORWARD[h]) {
    out.add(`${rel}:link`);
    addParents(rel);
  }
  for (const rel of EXPECTED_OWNED[h]) {
    out.add(`${rel}:file`);
    addParents(rel);
  }
  return [...out].sort();
}

/** sha256 of every regular file under the fake operator HOME (no link following). */
function operatorShas(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs)) {
      const a = path.join(abs, e);
      const r = rel ? `${rel}/${e}` : e;
      const st = lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else out[r] = createHash('sha256').update(readFileSync(a)).digest('hex');
    }
  };
  walk(fakeHome, '');
  return out;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

/** The bare root keys of a TOML text (lines before the first table header). */
function tomlRootKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// gemini-cli 0.45.0 `findEnvFile`, a VERBATIM REPLICA (F6)
// Source: /opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-EUYIPFPA.js:16388-16419
// (read 2026-09-25; the three bundle copies are identical). Changes: `homedir()` → the `home`
// parameter, `path3`/`fs4` → node:path/node:fs, GEMINI_DIR → '.gemini'. Nothing else.
// ---------------------------------------------------------------------------

function findEnvFile(startDir: string, isTrusted: boolean, ignoreLocalEnv: boolean, home: string): string | null {
  const GEMINI_DIR = '.gemini';
  let currentDir = path.resolve(startDir);
  while (true) {
    if (isTrusted) {
      const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
      if (existsSync(geminiEnvPath)) {
        return geminiEnvPath;
      }
    }
    const envPath = path.join(currentDir, '.env');
    if (existsSync(envPath)) {
      if (!ignoreLocalEnv || currentDir === home) {
        return envPath;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      if (isTrusted) {
        const homeGeminiEnvPath = path.join(home, GEMINI_DIR, '.env');
        if (existsSync(homeGeminiEnvPath)) {
          return homeGeminiEnvPath;
        }
      }
      const homeEnvPath = path.join(home, '.env');
      if (existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * The four D4 rows: [folder trusted, ignoreLocalEnv, the sentinel the replica must stop at,
 * what it returns WITHOUT the sentinels (an ancestor file relative to the test root, or null)].
 */
const D4_ROWS: Array<[boolean, boolean, string, string | null]> = [
  [false, false, '.env', '.env'],
  [true, false, '.gemini/.env', '.gemini/.env'],
  [true, true, '.gemini/.env', '.gemini/.env'],
  [false, true, '.env', null], // ignoreLocalEnv skips every non-home .env; the walk ends at null
];

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('BR-108 — the fence (F9)', () => {
  it('F9: homedir() is the fixture HOME, not the passwd home, and the scratch root is under tmpdir()', () => {
    expect(homedir()).toBe(fakeHome);
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(path.relative(realpathSync(tmpdir()), scratch).startsWith('..')).toBe(false);
    // The fixture is live: its own files declare MCP servers (else F1 would pass vacuously).
    expect(childVisibleMcpNames(fakeHome)).toContain('igris-brain');
    expect(childVisibleMcpNames(fakeHome)).toContain('igris-fixture-future');
  });
});

describe('BR-108 — no MCP server declaration reaches any extractor child (AC-1, F1)', () => {
  it.each(HARNESSES)('F1: no file reachable in the %s isolated HOME declares an MCP server (symlinks followed)', (h) => {
    expect(withHome(h, (iso) => childVisibleMcpNames(iso))).toEqual([]);
  });
});

describe('BR-108 — the isolated HOME holds exactly the allowlist (F2)', () => {
  it.each(HARNESSES)('F2: the %s manifest equals EXPECTED_FORWARD (links) ∪ EXPECTED_OWNED (files) ∪ their parent dirs', (h) => {
    withHome(h, (iso) => {
      expect(manifest(iso)).toEqual(expectedManifest(h));
      for (const rel of EXPECTED_FORWARD[h]) {
        expect(readlinkSync(path.join(iso, rel))).toBe(path.join(fakeHome, rel));
      }
      for (const rel of NEVER_FORWARDED) {
        const st = lstatOrNull(path.join(iso, rel));
        if (st === null) continue;
        expect(`${rel}:${st.isSymbolicLink() ? 'link' : 'owned'}`).toBe(`${rel}:owned`);
        expect(EXPECTED_OWNED[h]).toContain(rel);
      }
    });
  });

  it('F2: the production FORWARD list equals the second spelling for every harness', () => {
    for (const h of HARNESSES) expect([...forwardPathsFor(h)]).toEqual([...EXPECTED_FORWARD[h]]);
  });
});

describe('BR-108 — the Linux claude credential store (AC-4, F3)', () => {
  it('F3: .claude/.credentials.json is a link to the operator file, and .claude/ holds nothing else', () => {
    withHome('claude', (iso) => {
      const p = path.join(iso, '.claude', '.credentials.json');
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(readlinkSync(p)).toBe(path.join(fakeHome, '.claude', '.credentials.json'));
      expect(readdirSync(path.join(iso, '.claude'))).toEqual(['.credentials.json']);
    });
  });
});

describe('BR-108 — auth selection survives, exec keys do not (F4)', () => {
  it.each(GEMINI_FAMILY)('F4: the %s owned .gemini/settings.json keeps only model + security.auth', (h) => {
    withHome(h, (iso) => {
      const j = readJson(path.join(iso, '.gemini', 'settings.json'));
      expect(Object.keys(j).sort()).toEqual(['model', 'security']);
      const security = j.security as Record<string, unknown>;
      expect(Object.keys(security)).toEqual(['auth']);
      expect(Object.keys(security.auth as object)).toEqual(['selectedType']);
    });
  });

  it('F4: the antigravity owned antigravity-cli/settings.json keeps exactly {model}', () => {
    withHome('antigravity', (iso) => {
      expect(Object.keys(readJson(path.join(iso, '.gemini', 'antigravity-cli', 'settings.json')))).toEqual(['model']);
    });
  });

  it('F4: the codex owned config.toml keeps the allowlisted root keys plus the [features] deny block, and nothing else', () => {
    withHome('codex', (iso) => {
      const text = readFileSync(path.join(iso, '.codex', 'config.toml'), 'utf-8');
      expect(tomlRootKeys(text)).toEqual([...CODEX_FIXTURE_ROOT_KEYS]);
      const headers = text.split('\n').filter((l) => /^\s*\[/.test(l)).map((l) => l.trim());
      expect(headers).toEqual(['[features]']);
      const featureLines = text.slice(text.indexOf('[features]')).split('\n').slice(1).filter((l) => l.trim().length > 0);
      expect(featureLines).toEqual(EXPECTED_CODEX_FEATURE_DENY.map((n) => `${n} = false`));
      expect(text).not.toMatch(/notify/);
    });
  });

  it('F4: the claude owned .claude.json keeps oauthAccount + numStartups and drops mcpServers, projects, primaryApiKey', () => {
    withHome('claude', (iso) => {
      const keys = Object.keys(readJson(path.join(iso, '.claude.json')));
      expect(keys).toContain('oauthAccount');
      expect(keys).toContain('numStartups');
      expect(keys.filter((k) => ['mcpServers', 'projects', 'primaryApiKey'].includes(k))).toEqual([]);
    });
  });
});

describe('BR-108 — owned copies never write through to the operator (F5, F5m)', () => {
  it.each(HARNESSES)('F5: %s — operator file bytes are identical after build, after appending to every owned copy, and after cleanup', (h) => {
    const before = operatorShas();
    const spawn = build(h);
    try {
      expect(operatorShas()).toEqual(before);
      for (const rel of EXPECTED_OWNED[h]) {
        const p = path.join(spawn.cwd, rel);
        const st = lstatOrNull(p);
        if (st === null || !st.isFile()) continue; // a link is F2/F5m's concern; appending to it would BE the incident
        const size = st.size;
        appendFileSync(p, '\n');
        expect(statSync(p).size).toBe(size + 1); // positive control: the append landed in the copy
      }
      expect(operatorShas()).toEqual(before);
    } finally {
      spawn.cleanup();
    }
    expect(operatorShas()).toEqual(before);
    expect(existsSync(spawn.cwd)).toBe(false);
  });

  it.each(HARNESSES.filter((h) => EXPECTED_OWNED[h].length > 0))('F5m: every %s owned file is lstat-regular with mode 0o600', (h) => {
    withHome(h, (iso) => {
      const modes = EXPECTED_OWNED[h].map((rel) => {
        const st = lstatSync(path.join(iso, rel));
        return `${rel}:${st.isFile() ? 'file' : 'not-file'}:${(st.mode & 0o777).toString(8)}`;
      });
      expect(modes).toEqual(EXPECTED_OWNED[h].map((rel) => `${rel}:file:600`));
    });
  });
});

describe('BR-108 — .env credential channels end at an owned empty file (AC-3, F6)', () => {
  it.each(GEMINI_FAMILY)('F6: %s — <iso>/.env and <iso>/.gemini/.env are regular EMPTY files, and the replica stops at them in all four D4 rows', (h) => {
    withHome(h, (iso) => {
      for (const rel of ['.env', '.gemini/.env']) {
        const st = lstatSync(path.join(iso, rel));
        expect(`${rel}:${st.isFile() ? 'file' : 'not-file'}:${st.size}`).toBe(`${rel}:file:0`);
      }
      for (const [trusted, ignore, rel] of D4_ROWS) {
        expect(findEnvFile(iso, trusted, ignore, iso)).toBe(path.join(iso, rel));
      }
      // Positive control: without the sentinels the replica DOES reach the ancestor files.
      rmSync(path.join(iso, '.env'));
      rmSync(path.join(iso, '.gemini', '.env'));
      for (const [trusted, ignore, , control] of D4_ROWS) {
        expect(findEnvFile(iso, trusted, ignore, iso)).toBe(control === null ? null : path.join(root, control));
      }
    });
  });
});

describe('BR-108 — fail-closed parsing (F7)', () => {
  it('F7: codex — the multi-line string, dotted root key, inline table and array never reach the copy', () => {
    withHome('codex', (iso) => {
      const text = readFileSync(path.join(iso, '.codex', 'config.toml'), 'utf-8');
      for (const bad of ['fx-evil', 'notify', 'igris-fixture', 'mcp_servers', '"""', 'instructions', 'projects', 'plugins."']) {
        expect(`${bad}:${text.includes(bad)}`).toBe(`${bad}:false`);
      }
    });
  });

  it('F7: gemini — the fixture settings.json is JSONC (plain JSON.parse fails) and the copy still carries security.auth', () => {
    expect(() => JSON.parse(readFileSync(path.join(fakeHome, '.gemini', 'settings.json'), 'utf-8'))).toThrow();
    withHome('gemini', (iso) => {
      const j = readJson(path.join(iso, '.gemini', 'settings.json'));
      expect(Object.keys((j.security as { auth: object }).auth)).toEqual(['selectedType']);
    });
  });

  it('F7: an unparseable .gemini/settings.json yields an owned {}', () => {
    writeFileSync(path.join(fakeHome, '.gemini', 'settings.json'), '{');
    withHome('gemini', (iso) => {
      expect(readJson(path.join(iso, '.gemini', 'settings.json'))).toEqual({});
    });
  });

  it('F7: an unparseable .claude.json yields an owned {}', () => {
    writeFileSync(path.join(fakeHome, '.claude.json'), '{');
    withHome('claude', (iso) => {
      const p = path.join(iso, '.claude.json');
      expect(lstatSync(p).isFile()).toBe(true);
      expect(readJson(p)).toEqual({});
    });
  });
});

describe('BR-108 — no Igris-global or MCP-bearing marker (F8)', () => {
  it('F8: the production FORBIDDEN_IGRIS_MARKERS carry every marker of the second spelling', () => {
    expect(EXPECTED_FORBIDDEN_MARKERS.filter((m) => !FORBIDDEN_IGRIS_MARKERS.includes(m))).toEqual([]);
  });

  it.each(HARNESSES)('F8: the %s isolated HOME contains none of the markers', (h) => {
    withHome(h, (iso) => {
      const present = EXPECTED_FORBIDDEN_MARKERS.filter((m) => lstatOrNull(path.join(iso, m)) !== null);
      expect(present).toEqual([]);
    });
  });
});

describe('BR-108 — argv pins (P1-P3)', () => {
  it('P1: claude runs --strict-mcp-config with no --mcp-config, and --allowedTools is followed by an empty string', () => {
    withHome('claude', (_iso, spawn) => {
      expect(spawn.args).toContain('--strict-mcp-config');
      expect(spawn.args).not.toContain('--mcp-config');
      expect(spawn.args[spawn.args.indexOf('--allowedTools') + 1]).toBe('');
    });
  });

  it('P2: codex argv carries no mcp_servers override (an override on an absent table CREATES a server)', () => {
    withHome('codex', (_iso, spawn) => {
      expect(spawn.args.filter((a) => /mcp_servers/.test(a))).toEqual([]);
      expect(spawn.args).not.toContain('-c');
    });
  });

  it('P3: gemini argv allows exactly the no-MCP sentinel, which no fixture server is named, and never passes --ignore-env', () => {
    withHome('gemini', (_iso, spawn) => {
      const i = spawn.args.indexOf('--allowed-mcp-server-names');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(spawn.args[i + 1]).toBe(GEMINI_NO_MCP_SENTINEL);
      expect(spawn.args.filter((a) => a === '--allowed-mcp-server-names')).toHaveLength(1);
      expect(childVisibleMcpNames(fakeHome)).not.toContain(GEMINI_NO_MCP_SENTINEL);
      expect(spawn.args).not.toContain('--ignore-env');
    });
  });

  it('P3: the antigravity argv carries no --allowed-mcp-server-names (agy has no such flag)', () => {
    withHome('antigravity', (_iso, spawn) => {
      expect(spawn.args).not.toContain('--allowed-mcp-server-names');
    });
  });
});

describe('BR-109 — the gemini argv is one gemini-cli 0.45.0 accepts (P4, P5)', () => {
  // `--skip-trust` (BR-109 live): trusted mode reads `<cwd>/.gemini/.env` with ALL keys and turns
  // on the MCP start path; F6's trusted rows and P3's sentinel are what keep both closed.
  it('P4: gemini args are exactly the sentinel pair, `--skip-trust`, then `--prompt \'\'`, delivered on stdin, and every flag is a declared 0.45.0 option', () => {
    withHome('gemini', (_iso, spawn) => {
      expect(spawn.args).toEqual(['--allowed-mcp-server-names', GEMINI_NO_MCP_SENTINEL, '--skip-trust', '--prompt', '']);
      expect(spawn.delivery).toBe('stdin');
      expect(spawn.args.filter((a) => a.startsWith('-') && !GEMINI_045_OPTIONS.includes(a))).toEqual([]);
    });
  });

  it('P4: a model pin appends a declared option, and the sentinel pair stays first', () => {
    const spawn = buildExtractorSpawn('gemini', PROMPT, { model: 'fx', env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });
    try {
      expect(spawn.args.slice(0, 2)).toEqual(['--allowed-mcp-server-names', GEMINI_NO_MCP_SENTINEL]);
      expect(spawn.args.filter((a) => a.startsWith('-') && !GEMINI_045_OPTIONS.includes(a))).toEqual([]);
      expect(spawn.args).toContain('--model');
    } finally {
      spawn.cleanup();
    }
  });

  it('P5 (control): the antigravity argv still carries --print-timeout <n>s and --print with argv delivery', () => {
    withHome('antigravity', (_iso, spawn) => {
      expect(spawn.args).toEqual(['--print-timeout', '120s', '--print']);
      expect(spawn.delivery).toBe('argv');
    });
  });
});
