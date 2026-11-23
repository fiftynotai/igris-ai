/**
 * TD-518 — source guard: `src/index.ts` states NO version number at all; the
 * number lives in `brain-mcp-server/package.json` and is read at boot by
 * `src/server-version.ts` (MAINTAINING.md, the TD-518 row).
 *
 * WHY A RAW-TEXT GUARD. Before TD-518 six sites in `index.ts` carried their own
 * literal (`serverInfo.version`, the `/api/brain-stats` body, both startup
 * banners, the `@version` JSDoc and the module header), and all of them sat at
 * `7.2.0`/`v7.2` while the package shipped as `7.4.0`. The spawn tier
 * (`server-version-spawn.test.ts`) cannot catch the one regression that matters
 * most: a hard-coded literal that HAPPENS to equal the current package version
 * passes every behavioural test until the next bump. Only a text guard sees it.
 *
 * WHAT IS PINNED.
 *  - S1-S3 (negative): no object-literal `version:` key carrying a numeric
 *    string, no `v<digits>.<digits>` token anywhere, no `@version` tag.
 *  - S4 (positive): the derived forms are PRESENT — three `version: SERVER_VERSION`
 *    keys (serverInfo, `/api/brain-stats`, and since BR-121 the unauthenticated
 *    `/health`), both banners interpolate `${SERVER_VERSION}`, one assignment from
 *    `readServerVersion() ?? UNKNOWN_SERVER_VERSION`, one import. Without these
 *    a deletion of the version would pass S1-S3 vacuously.
 *  - S5: the reader never writes stdout (the stdio protocol channel).
 *  - S6: both ends of the stdio-banner contract with
 *    `cli/scripts/smoke-bundled-mcp.sh` (it waits on `MCP Server .* started
 *    (stdio)`), evaluated by the real `grep`.
 *  - S7: planted-positive vacuity controls — every S1-S3 detector, fed the
 *    exact pre-TD-518 lines, must FLAG them (the TD-456 lesson: a regex typo
 *    must red, never silently pass), and must NOT flag the derived forms.
 *  - S8 (decision D-2): no `console.*` call in `src/engine/index.ts` prints a
 *    `v<digits>.<digits>` generation label beside the server banner; the
 *    `[engine] Booting Brain Engine` prefix pinned by
 *    `cli/src/__tests__/sync-push.test.ts` survives.
 *
 * Imports no module under test (fs reads only), so its RED is recordable on a
 * tree where `server-version.ts` does not exist yet.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(BRAIN_ROOT, '..');
const INDEX_TS = join(BRAIN_ROOT, 'src', 'index.ts');
const READER_TS = join(BRAIN_ROOT, 'src', 'server-version.ts');
const ENGINE_INDEX_TS = join(BRAIN_ROOT, 'src', 'engine', 'index.ts');
const SMOKE_SH = join(REPO_ROOT, 'cli', 'scripts', 'smoke-bundled-mcp.sh');

// --- Detectors (S7 feeds them planted lines; S1-S3 feed them the real file) ---

/** S1: an object-literal `version:` key whose value is a quoted numeric string. */
const S1_LITERAL_VERSION_KEY = /\bversion\s*:\s*['"`]v?\d+\.\d+/;
/** S2: any `v<major>.<minor>[.<patch>]` token — index.ts states no number at all. */
const S2_VERSION_TOKEN = /\bv\d+\.\d+(?:\.\d+)?\b/;
/** S3a: a numeric `@version` JSDoc tag (AC-5). */
const S3_NUMERIC_VERSION_TAG = /@version\s+v?\d/;
/** S3b: the `@version` tag at all. */
const S3_ANY_VERSION_TAG = /@version\b/;
/** S5: anything that writes to stdout (console.info/debug go to stdout in Node). */
const S5_STDOUT_WRITE = /console\.(?:log|info|debug|table|dir)\b|process\.stdout/;

/** Return `<line>: <text>` for every line of `text` the detector matches. */
function flaggedLines(text: string, detector: RegExp): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => detector.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

/** Every `console.<level>(…);` call's argument text, multi-line calls included. */
function consoleCallArgs(text: string): string[] {
  const out: string[] = [];
  const re = /console\.(?:error|log|warn|info|debug)\(([\s\S]*?)\);/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]);
  return out;
}

/** S8: a generation/version label inside a console argument. */
const S8_LABEL = /\bv\d+\.\d+/;

/** Count non-overlapping matches of a global regex. */
function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

// --- The pre-TD-518 lines (c5c523f), verbatim, for the S7/S8 planted controls ---

const PLANTED_INDEX_LINES = {
  serverInfo: "      version: '7.2.0',",
  stdioBanner: "  console.error('Igris Brain MCP Server v7.2.0 started (stdio)');",
  httpBanner: '    console.error(`Igris Brain MCP Server v7.2.0 started (http, ${bind})`);',
  versionTag: ' * @version 7.2.0',
  header: ' * Igris AI Centralized Brain MCP Server v7.2',
};
const PLANTED_ENGINE_SOURCE = [
  "  console.error('[engine] Booting Brain Engine v7.0...');",
  '  console.error(',
  '    `[engine] Brain Engine v7.0 ready — ${gateway.toolCount()} tools, ${registry.getBootOrder().length} components`',
  '  );',
].join('\n');

describe('TD-518 source guard — src/index.ts states no version number', () => {
  const src = readFileSync(INDEX_TS, 'utf-8');

  it('S1: no object-literal version key carries a numeric string', () => {
    expect(flaggedLines(src, S1_LITERAL_VERSION_KEY)).toEqual([]);
  });

  it('S2: no v<major>.<minor> token anywhere in index.ts (header and both banners included)', () => {
    expect(flaggedLines(src, S2_VERSION_TOKEN)).toEqual([]);
  });

  it('S3: the @version JSDoc tag is gone (TD-518 AC-5)', () => {
    expect(flaggedLines(src, S3_NUMERIC_VERSION_TAG)).toEqual([]);
    expect(flaggedLines(src, S3_ANY_VERSION_TAG)).toEqual([]);
  });

  it('S4: the derived forms are present (a deleted version cannot pass S1-S3 vacuously)', () => {
    // serverInfo (createBrainServer), the /api/brain-stats body and (BR-121) /health.
    expect(count(src, /\bversion\s*:\s*SERVER_VERSION\b/g)).toBe(3);
    // Both startup banners interpolate the constant.
    expect(count(src, /MCP Server v\$\{SERVER_VERSION\} started \(stdio\)/g)).toBe(1);
    expect(count(src, /MCP Server v\$\{SERVER_VERSION\} started \(http, /g)).toBe(1);
    // Exactly one assignment, and it is the derived one.
    expect(count(src, /\bSERVER_VERSION\s*=(?!=)/g)).toBe(1);
    expect(src).toMatch(/\bconst SERVER_VERSION = readServerVersion\(\) \?\? UNKNOWN_SERVER_VERSION;/);
    // The reader is imported from the top-level module (its depth is load-bearing).
    expect(src).toMatch(
      /import\s*\{[^}]*\breadServerVersion\b[^}]*\bUNKNOWN_SERVER_VERSION\b[^}]*\}\s*from\s*'\.\/server-version\.js';/,
    );
  });

  it('S5: the reader never writes stdout — stdout is the stdio protocol channel', () => {
    const reader = readFileSync(READER_TS, 'utf-8');
    expect(flaggedLines(reader, S5_STDOUT_WRITE)).toEqual([]);
  });

  it('S6: the stdio banner still satisfies smoke-bundled-mcp.sh\'s grep (both ends pinned)', () => {
    // End 1: the pattern the build smoke actually waits on.
    const smoke = readFileSync(SMOKE_SH, 'utf-8');
    const m = smoke.match(/grep -q '([^']*started \(stdio\)[^']*)'/);
    expect(m, 'smoke-bundled-mcp.sh no longer greps for the stdio banner').not.toBeNull();
    const pattern = (m as RegExpMatchArray)[1];
    expect(pattern).toBe('MCP Server .* started (stdio)');

    // End 2: the banner as index.ts renders it (either quote style), with a
    // concrete version substituted for the interpolation.
    const b = src.match(/console\.error\((['"`])(.*?started \(stdio\))\1\)/);
    expect(b, 'index.ts no longer prints a "started (stdio)" banner').not.toBeNull();
    const rendered = (b as RegExpMatchArray)[2].replace('${SERVER_VERSION}', '1.2.3');
    expect(rendered).not.toContain('${');

    // Evaluated by the real grep (BRE semantics), not a JS re-translation.
    const grepQ = (input: string): number => {
      try {
        execFileSync('grep', ['-q', '--', pattern], {
          input: `${input}\n`,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
          timeout: 10_000,
        });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };
    expect(grepQ(rendered)).toBe(0);
    // Control: grep is really evaluating — a reworded banner does not match.
    expect(grepQ('Brain started')).toBe(1);
  });

  it('S7: every detector FLAGS the pre-TD-518 lines and passes the derived forms (vacuity controls)', () => {
    expect(S1_LITERAL_VERSION_KEY.test(PLANTED_INDEX_LINES.serverInfo)).toBe(true);
    expect(S2_VERSION_TOKEN.test(PLANTED_INDEX_LINES.stdioBanner)).toBe(true);
    expect(S2_VERSION_TOKEN.test(PLANTED_INDEX_LINES.httpBanner)).toBe(true);
    expect(S2_VERSION_TOKEN.test(PLANTED_INDEX_LINES.header)).toBe(true);
    expect(S3_NUMERIC_VERSION_TAG.test(PLANTED_INDEX_LINES.versionTag)).toBe(true);
    expect(S3_ANY_VERSION_TAG.test(PLANTED_INDEX_LINES.versionTag)).toBe(true);
    // flaggedLines reports the planted line by number (the reporter is live too).
    expect(flaggedLines(`a\n${PLANTED_INDEX_LINES.serverInfo}`, S1_LITERAL_VERSION_KEY)).toEqual([
      "2: version: '7.2.0',",
    ]);
    // The derived forms are NOT flagged (the detectors discriminate).
    const derived = [
      '      version: SERVER_VERSION,',
      '  console.error(`Igris Brain MCP Server v${SERVER_VERSION} started (stdio)`);',
    ];
    for (const line of derived) {
      expect(S1_LITERAL_VERSION_KEY.test(line)).toBe(false);
      expect(S2_VERSION_TOKEN.test(line)).toBe(false);
    }
    // S5's detector fires on a stdout write.
    expect(S5_STDOUT_WRITE.test('  warn = (m: string) => console.log(m),')).toBe(true);
    expect(S5_STDOUT_WRITE.test('  process.stdout.write(m);')).toBe(true);
    expect(S5_STDOUT_WRITE.test('  warn = (m: string) => console.error(m),')).toBe(false);
    // S8's extractor + detector fire on both pre-TD-518 engine lines, the
    // multi-line `ready` call included.
    const plantedArgs = consoleCallArgs(PLANTED_ENGINE_SOURCE);
    expect(plantedArgs).toHaveLength(2);
    expect(plantedArgs.filter((a) => S8_LABEL.test(a))).toHaveLength(2);
    // The engine FILE HEADER is not a console call and is not flagged.
    expect(consoleCallArgs(' * Brain Engine v7.0 — Engine Bootstrap')).toEqual([]);
  });

  it('S8 (D-2): no console call in src/engine/index.ts prints a v<major>.<minor> label', () => {
    const engine = readFileSync(ENGINE_INDEX_TS, 'utf-8');
    const args = consoleCallArgs(engine);
    // Positive floor: the extractor found the engine's calls (boot, ready, shutdown).
    expect(args.length).toBeGreaterThanOrEqual(3);
    expect(args.filter((a) => S8_LABEL.test(a))).toEqual([]);
    // The prefix cli/src/__tests__/sync-push.test.ts pins is preserved.
    expect(args.some((a) => a.includes('[engine] Booting Brain Engine'))).toBe(true);
    expect(args.some((a) => a.includes('[engine] Brain Engine ready'))).toBe(true);
  });
});
