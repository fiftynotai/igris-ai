/**
 * TD-253 — Egress-manifest drift gate.
 *
 * Regenerates both committed artifacts in-memory from `SYNC_TABLES` via
 * `buildEgressManifest` and asserts byte-equality with the committed files
 * (read by repo-relative fs path — a FILE READ, never a cross-package import).
 * Any `SYNC_TABLES` edit that isn't regenerated with `npm run gen:egress-manifest`
 * fails here — the disclosure cannot silently drift from what actually egresses.
 *
 * Also asserts every `redactCols` column name exists in that config's `columns`
 * array — a typo'd redaction target would otherwise silently no-op at runtime.
 *
 * @module tools/__tests__/egress-manifest-parity.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNC_TABLES } from '../sync.js';
import {
  buildEgressManifest,
  MANIFEST_DOC_REL_PATH,
  MANIFEST_CLI_REL_PATH,
} from '../egress-manifest.js';

// __tests__ → tools → src → brain-mcp-server → repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readCommitted(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('egress manifest parity (TD-253)', () => {
  const { markdown, cliModule } = buildEgressManifest(SYNC_TABLES);

  it('docs/reference/sync-egress-manifest.md is byte-identical to a fresh regeneration', () => {
    expect(readCommitted(MANIFEST_DOC_REL_PATH)).toBe(markdown);
  });

  it('cli/src/lib/sync/egress-manifest.generated.ts is byte-identical to a fresh regeneration', () => {
    expect(readCommitted(MANIFEST_CLI_REL_PATH)).toBe(cliModule);
  });

  it('every redactCols column exists in that table config columns array', () => {
    for (const cfg of SYNC_TABLES) {
      for (const col of cfg.redactCols ?? []) {
        expect(
          cfg.columns,
          `redactCols entry '${col}' on table '${cfg.table}' is not in its columns array`,
        ).toContain(col);
      }
    }
  });

  it('declares redaction for the two known local-path columns', () => {
    const redacted = SYNC_TABLES.flatMap((cfg) =>
      (cfg.redactCols ?? []).map((c) => `${cfg.table}.${c}`),
    );
    expect(redacted).toContain('projects.path');
    expect(redacted).toContain('instances.project_path');
  });
});
