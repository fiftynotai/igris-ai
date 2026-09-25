/**
 * BR-108 — the SECOND SPELLING of the isolated-HOME file allowlist, a fixture
 * operator HOME, and a child-visible MCP scanner.
 *
 * `EXPECTED_FORWARD` / `EXPECTED_OWNED` / `EXPECTED_CODEX_FEATURE_DENY` restate
 * `isolation.ts` (`FORWARD`, the owned writers, `CODEX_FEATURE_DENY`) name by
 * name. F2 pins the isolated HOME's manifest against them by EXACT membership,
 * so a widening of the production list is red until this file moves with it
 * (test_standards: "an allowlist is pinned by EXACT membership against a second,
 * independent spelling").
 *
 * `seedOperatorHome(home)` writes a fake operator HOME whose every config file
 * declares MCP servers, `igris-brain` AND `igris-fixture-future` (the server
 * added later). Every value is a placeholder (`fx`, `oauth-personal`,
 * `/nonexistent/...`), so nothing here is credential-shaped (D6, gitleaks).
 *
 * `childVisibleMcpNames(dir)` walks a tree FOLLOWING symlinks and returns the
 * sorted unique MCP server NAMES any JSON/JSONC/TOML file declares. It is
 * written independently of the production sanitizers and is deliberately
 * stricter than any one CLI's loader.
 *
 * Excluded from compile (`brain-mcp-server/tsconfig.json` excludes
 * `src/**\/__tests__/**`), so it costs 0 packed bytes.
 *
 * @module engine/components/cognition/__tests__/fixtures/br108-isolated-home
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtractorHarness } from '../../types.js';

// ---------------------------------------------------------------------------
// The second spelling (plan D1 table)
// ---------------------------------------------------------------------------

const KEYCHAIN = 'Library/Keychains';
const GEMINI_AUTH = ['.gemini/oauth_creds.json', '.gemini/google_accounts.json', '.gemini/installation_id'];

/** Paths SYMLINKED from the operator HOME (auth stores only). */
export const EXPECTED_FORWARD: Record<ExtractorHarness, readonly string[]> = {
  claude: [KEYCHAIN, '.claude/.credentials.json'],
  codex: [KEYCHAIN, '.codex/auth.json'],
  antigravity: [
    KEYCHAIN,
    ...GEMINI_AUTH,
    '.gemini/antigravity-cli/antigravity-oauth-token',
    '.gemini/antigravity-cli/installation_id',
    '.gemini/antigravity-cli/cache/onboarding.json',
  ],
  // BR-109: the provider auth store only — not mcp-auth.json, the sessions DB, storage/ or snapshot/.
  opencode: [KEYCHAIN, '.local/share/opencode/auth.json'],
};

/** Paths WRITTEN by the isolation as owned regular files (given the full fixture operator HOME). */
export const EXPECTED_OWNED: Record<ExtractorHarness, readonly string[]> = {
  claude: ['.claude.json'],
  codex: ['.codex/config.toml'],
  antigravity: [
    '.gemini/settings.json',
    '.gemini/config/mcp_config.json',
    '.gemini/antigravity-cli/settings.json',
    '.env',
    '.gemini/.env',
  ],
  opencode: [],
};

/**
 * codex features enabled by default, not `removed`, whose name carries a whole
 * `_`-delimited token app(s) / connector / plugin(s) / mcp (codex-cli 0.135.0
 * `codex features list` under an EMPTY config, fixture HOME, 2026-09-25;
 * `br108-evidence/phase0-codex-offline.txt`, which also records why
 * `guardian_approval` and `tui_app_server` are not on it). The owned
 * config.toml sets each to false.
 */
export const EXPECTED_CODEX_FEATURE_DENY: readonly string[] = [
  'apps',
  'in_app_browser',
  'plugin_sharing',
  'plugins',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
];

/** The codex root keys the fixture sets that the owned copy must carry (4 of the 6 allowlisted). */
export const CODEX_FIXTURE_ROOT_KEYS: readonly string[] = [
  'model',
  'model_reasoning_effort',
  'cli_auth_credentials_store',
  'forced_login_method',
];

/** Igris-global / MCP-bearing paths no isolated HOME may contain (restates the extended markers). */
export const EXPECTED_FORBIDDEN_MARKERS: readonly string[] = [
  '.claude/CLAUDE.md',
  '.codex/AGENTS.md',
  '.igris/core',
  '.config/opencode/opencode.json',
  '.gemini/agents',
  '.gemini/extensions',
  '.config/opencode/command',
  '.codex/plugins',
];

/** Operator paths that must never be FORWARDED (a link); an owned file of the same name is allowed. */
export const NEVER_FORWARDED: readonly string[] = [
  '.gemini/.env',
  '.codex/.env',
  '.gemini/extensions',
  '.gemini/agents',
  '.gemini/config/hooks.json',
  '.codex/plugins',
  '.codex/memories_1.sqlite',
  '.config/opencode',
  '.claude/CLAUDE.md',
  '.gemini/settings.json',
  '.codex/config.toml',
  '.claude.json',
  // BR-109: opencode's data-dir siblings of auth.json (MCP OAuth, sessions, git snapshots).
  '.local/share/opencode/mcp-auth.json',
  '.local/share/opencode/opencode.db',
  '.local/share/opencode/storage',
  '.local/share/opencode/snapshot',
];

// ---------------------------------------------------------------------------
// The fixture operator HOME
// ---------------------------------------------------------------------------

const SERVER = { command: '/nonexistent/igris-fixture-mcp' };

const CODEX_TOML = [
  'model = "fx"',
  'model_reasoning_effort = "low"',
  'cli_auth_credentials_store = "file"',
  'forced_login_method = "chatgpt"',
  'notify = ["/nonexistent/fx"]',
  'mcp_servers.igris-fixture-dotted.command = "/nonexistent/x"',
  'instructions = """',
  '[mcp_servers.igris-fixture-ml]',
  'model = "fx-evil"',
  '"""',
  '',
  '[mcp_servers.igris-brain]',
  'command = "/nonexistent/igris-fixture-mcp"',
  '',
  '[mcp_servers.igris-fixture-future]',
  'command = "/nonexistent/igris-fixture-mcp"',
  '',
  '[mcp_servers.igris-fixture-future.env]',
  'FX = "fx"',
  '',
  '[x]',
  'mcp_servers = { igris-fixture-inline = { command = "y" } }',
  '',
  '[plugins."fx@fx"]',
  'enabled = true',
  '',
  '[projects."/fx"]',
  'trust_level = "trusted"',
  '',
  '[features]',
  'apps = true',
  '',
  '[hooks.state."fx"]',
  'x = 1',
  '',
].join('\n');

/** gemini settings as JSONC: a `//` comment line makes plain JSON.parse fail (F7 arms on it). */
const GEMINI_SETTINGS_JSONC = [
  '{',
  '  // fx comment',
  `  "mcpServers": ${JSON.stringify({ 'igris-brain': SERVER, 'igris-fixture-future': SERVER })},`,
  '  "security": {"auth": {"selectedType": "oauth-personal"}, "folderTrust": {"enabled": false}},',
  '  "mcp": {"serverCommand": "/nonexistent/fx"},',
  '  "hooks": {"BeforeTool": [{"command": "/nonexistent/fx"}]},',
  '  "tools": {"discoveryCommand": "/nonexistent/fx"},',
  '  "advanced": {"ignoreLocalEnv": true},',
  '  "model": {"name": "fx"}',
  '}',
  '',
].join('\n');

/** Every fixture file, relative to the fake operator HOME. Dirs are created on demand. */
const FILES: Record<string, string> = {
  '.claude.json': JSON.stringify({
    mcpServers: { 'igris-brain': SERVER, 'igris-fixture-future': SERVER },
    projects: { '/fx': { mcpServers: { 'igris-fixture-proj': SERVER } } },
    oauthAccount: { emailAddress: 'fx' },
    primaryApiKey: 'fx',
    numStartups: 1,
  }),
  '.claude/.credentials.json': '{}',
  '.claude/CLAUDE.md': 'fx\n',
  '.codex/config.toml': CODEX_TOML,
  '.codex/auth.json': '{}',
  '.codex/.env': 'OPENAI_API_KEY=fx\n',
  '.codex/AGENTS.md': 'fx\n',
  '.codex/plugins/cache/fx/1/.mcp.json': JSON.stringify({ mcpServers: { 'igris-fixture-plugin': SERVER } }),
  '.codex/memories_1.sqlite': 'fx',
  '.gemini/settings.json': GEMINI_SETTINGS_JSONC,
  '.gemini/oauth_creds.json': '{}',
  '.gemini/google_accounts.json': '{}',
  '.gemini/installation_id': 'fx\n',
  '.gemini/.env': 'GEMINI_API_KEY=fx\n',
  '.gemini/extensions/fx/gemini-extension.json': JSON.stringify({ mcpServers: { 'igris-fixture-ext': SERVER } }),
  '.gemini/agents/fx.md': 'fx\n',
  '.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { 'igris-brain': SERVER } }),
  '.gemini/config/hooks.json': '{}',
  '.gemini/tmp/fx/chat.jsonl': '{}\n',
  '.gemini/antigravity-cli/settings.json': JSON.stringify({
    model: 'fx',
    permissions: {},
    allowNonWorkspaceAccess: true,
    mcpServers: { 'igris-fixture-agy': SERVER },
  }),
  '.gemini/antigravity-cli/antigravity-oauth-token': 'fx',
  '.gemini/antigravity-cli/installation_id': 'fx\n',
  '.gemini/antigravity-cli/cache/onboarding.json': '{}',
  '.gemini/antigravity-cli/conversation_summaries.db': 'fx',
  '.config/opencode/opencode.json': JSON.stringify({ mcp: { 'igris-brain': SERVER } }),
  '.config/opencode/opencode.jsonc': `// fx\n${JSON.stringify({ mcp: { 'igris-fixture-future': SERVER } })}\n`,
  '.config/opencode/config.json': JSON.stringify({ mcp: { 'igris-fixture-cfg': SERVER } }),
  '.config/opencode/command/fx.md': 'fx\n',
  '.config/opencode/package.json': '{}',
  '.local/share/opencode/auth.json': '{}',
  '.local/share/opencode/mcp-auth.json': '{}',
  '.local/share/opencode/opencode.db': 'fx',
  '.local/share/opencode/storage/session_diff/fx.json': '{}',
  '.local/share/opencode/snapshot/fx/HEAD': 'fx\n',
};

/** Write the fixture operator HOME under `home` (which must be a fresh temp dir). */
export function seedOperatorHome(home: string): void {
  for (const [rel, text] of Object.entries(FILES)) {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
}

// ---------------------------------------------------------------------------
// The child-visible MCP scanner (names only)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Keys of every `mcpServers` object at any depth, plus the top-level `mcp` object's keys (opencode). */
function jsonNames(j: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    if (!isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === 'mcpServers' && isObj(child)) out.push(...Object.keys(child));
      walk(child);
    }
  };
  walk(j);
  if (isObj(j) && isObj(j.mcp)) out.push(...Object.keys(j.mcp));
  return out;
}

function tomlNames(text: string): string[] {
  const out: string[] = [];
  const key = '(?:"([^"]+)"|([A-Za-z0-9_-]+))';
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${key}`);
  const dotted = new RegExp(`^\\s*mcp_servers\\.${key}\\s*\\.`);
  for (const line of text.split('\n')) {
    for (const re of [header, dotted]) {
      const m = re.exec(line);
      if (m) out.push(m[1] ?? m[2]);
    }
    const inline = /mcp_servers\s*=\s*\{(.*)\}/.exec(line);
    if (inline) {
      for (const m of inline[1].matchAll(new RegExp(`(?:^|[{,])\\s*${key}\\s*=\\s*\\{`, 'g'))) out.push(m[1] ?? m[2]);
    }
  }
  return out;
}

/**
 * Every MCP server NAME declared by any JSON/JSONC/TOML file reachable under
 * `dir`, symlinks FOLLOWED (a cycle is visited once). An unparseable JSON file
 * that mentions `mcpServers` or `"mcp"` yields `<unparsed:rel>` so it can never
 * pass as clean.
 */
export function childVisibleMcpNames(dir: string): string[] {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (abs: string, rel: string): void => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return; // dangling link
    }
    if (seen.has(real)) return;
    seen.add(real);
    const st = statSync(real);
    if (st.isDirectory()) {
      for (const e of readdirSync(real)) visit(join(abs, e), rel ? `${rel}/${e}` : e);
      return;
    }
    if (/\.jsonc?$/.test(rel)) {
      const text = readFileSync(real, 'utf-8');
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        try {
          j = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
        } catch {
          if (/mcpServers|"mcp"/.test(text)) names.add(`<unparsed:${rel}>`);
          return;
        }
      }
      for (const n of jsonNames(j)) names.add(n);
    } else if (/\.toml$/.test(rel)) {
      for (const n of tomlNames(readFileSync(real, 'utf-8'))) names.add(n);
    }
  };
  if (existsSync(dir)) visit(dir, '');
  return [...names].sort();
}
