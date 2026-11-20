// TD-518: the brain's ONLY version source is its package.json. This module must
// stay at the src/ top level: `../package.json` then resolves to the package
// root from src/ (tsx) and dist/ (built) alike.
import { readFileSync } from 'node:fs';

export const BRAIN_PACKAGE_NAME = 'igris-brain-mcp-server';
/** The defined unknown (TD-411): valid semver, sorts below every release. */
export const UNKNOWN_SERVER_VERSION = '0.0.0-unknown';

/** The brain package.json `version`, or null (after one `warn` line) when unreadable. Never throws. */
export function readServerVersion(
  pkgUrl: URL = new URL('../package.json', import.meta.url),
  warn: (message: string) => void = (m) => console.error(m),
): string | null {
  let reason: string;
  try {
    const { name, version } = (JSON.parse(readFileSync(pkgUrl, 'utf-8')) ?? {}) as Record<string, unknown>;
    if (name === BRAIN_PACKAGE_NAME && typeof version === 'string' && version !== '') return version;
    reason = name === BRAIN_PACKAGE_NAME ? 'no version string' : `foreign name ${JSON.stringify(name)}`;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  warn(`[brain] version unknown: ${pkgUrl.href}: ${reason}`);
  return null;
}
