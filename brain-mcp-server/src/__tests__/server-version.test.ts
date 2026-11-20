/**
 * TD-518 — `readServerVersion()`, the brain's only version source.
 *
 * In-process, pure: every fixture is a temp file under a per-test mkdtemp, and
 * the warn sink is injected (or `console.error` is spied), so nothing here
 * spawns or reads HOME.
 *
 *  - U1 pins the DEFAULT url, which also pins the module's DEPTH: the module
 *    must sit at the src/ top level so `../package.json` is the package root
 *    from src/ (here, under vitest) and from dist/ (built) alike. Moving it to
 *    `src/utils/` reds U1 (`src/package.json` is ENOENT). The expectation is
 *    read from the manifest independently, never a literal on both sides.
 *  - U2 proves the value is DERIVED (a sentinel version no release will carry).
 *  - U3-U6 + U8: every failure returns null, warns exactly once, never throws.
 *    U6 is the coincidence trap: the monorepo ROOT manifest also says the
 *    release version, so a wrong ascent (`../../package.json`) would read the
 *    right number from the wrong file in the repo layout. The name check is
 *    what refuses it.
 *  - U7: the default sink is stderr (`console.error`), never stdout — stdout is
 *    the stdio MCP protocol channel.
 *  - U9: the defined unknown is valid semver and a prerelease of 0.0.0 (TD-411:
 *    it must SAY unknown, unlike the plausible `0.0.0`).
 *
 * RED-first on c5c523f: the module does not exist (import fails, whole file red).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BRAIN_PACKAGE_NAME,
  UNKNOWN_SERVER_VERSION,
  readServerVersion,
} from '../server-version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_MANIFEST = resolve(HERE, '..', '..', 'package.json');

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'td518-reader-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write `body` verbatim to a temp package.json and return its file URL. */
function manifest(body: string, file = 'package.json'): URL {
  const p = join(work, file);
  writeFileSync(p, body);
  return pathToFileURL(p);
}

/** Call the reader with a recording warn sink. */
function read(url?: URL): { result: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const result = readServerVersion(url, (m) => warnings.push(m));
  return { result, warnings };
}

describe('TD-518 readServerVersion — the brain version source', () => {
  it('U1: the default url reads THIS package\'s manifest (pins the module\'s src/ top-level depth)', () => {
    const expected = (JSON.parse(readFileSync(BRAIN_MANIFEST, 'utf-8')) as { name: string; version: string });
    expect(expected.name).toBe(BRAIN_PACKAGE_NAME);
    expect(expected.version).toMatch(/^\d+\.\d+\.\d+/);
    const { result, warnings } = read();
    expect(result).not.toBeNull();
    expect(result).toBe(expected.version);
    expect(warnings).toEqual([]);
  });

  it('U2: the value is derived from the manifest, not a literal', () => {
    const { result, warnings } = read(
      manifest(JSON.stringify({ name: BRAIN_PACKAGE_NAME, version: '9.8.7-td518' })),
    );
    expect(result).toBe('9.8.7-td518');
    expect(warnings).toEqual([]);
  });

  it('U3: a missing manifest returns null, warns once with the path, and does not throw', () => {
    const missing = pathToFileURL(join(work, 'nope', 'package.json'));
    let out: { result: string | null; warnings: string[] } | undefined;
    expect(() => {
      out = read(missing);
    }).not.toThrow();
    expect(out?.result).toBeNull();
    expect(out?.warnings).toHaveLength(1);
    expect(out?.warnings[0]).toContain('[brain] version unknown');
    expect(out?.warnings[0]).toContain(join(work, 'nope', 'package.json'));
  });

  it('U4: unparseable JSON returns null and warns once', () => {
    const { result, warnings } = read(manifest('{"name": "igris-brain-mcp-server", "version": '));
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[brain] version unknown');
  });

  it.each([
    ['missing', { name: BRAIN_PACKAGE_NAME }],
    ['a number', { name: BRAIN_PACKAGE_NAME, version: 7.4 }],
    ['an empty string', { name: BRAIN_PACKAGE_NAME, version: '' }],
  ])('U5: a manifest whose version is %s returns null and warns once', (_label, body) => {
    const { result, warnings } = read(manifest(JSON.stringify(body)));
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no version string');
  });

  it('U6: a foreign manifest (the monorepo root shape) is refused even with a plausible version', () => {
    const { result, warnings } = read(
      manifest(JSON.stringify({ name: 'igris-ai-monorepo', version: '7.4.0', private: true })),
    );
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('foreign name "igris-ai-monorepo"');
  });

  it('U7: the default warn sink is stderr (console.error), never stdout', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = readServerVersion(pathToFileURL(join(work, 'absent.json')));
    expect(result).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('[brain] version unknown');
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"7.4.0"'],
    ['an array', '["igris-brain-mcp-server", "7.4.0"]'],
  ])('U8: a manifest that parses to %s returns null, warns once, never throws', (_label, body) => {
    const { result, warnings } = read(manifest(body));
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('U9: the defined unknown is valid semver, a prerelease of 0.0.0, and says "unknown"', () => {
    // semver.org's recommended regex, core + prerelease (no build metadata needed here).
    const SEMVER =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
    const m = UNKNOWN_SERVER_VERSION.match(SEMVER);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray).slice(1, 4)).toEqual(['0', '0', '0']);
    expect((m as RegExpMatchArray)[4]).toContain('unknown');
  });
});
