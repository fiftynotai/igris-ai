/**
 * TD-253 — Generate the sync egress disclosure artifacts from SYNC_TABLES.
 *
 * SYNC_TABLES (in `src/tools/sync.ts`) is the single source of truth for what
 * replicates to a remote brain. This script runs the pure `buildEgressManifest`
 * builder over it and writes the TWO committed, never-hand-edited artifacts:
 *
 *   1. docs/reference/sync-egress-manifest.md            (public disclosure doc)
 *   2. cli/src/lib/sync/egress-manifest.generated.ts     (CLI-side copy)
 *
 * Usage:
 *   npx tsx scripts/gen-egress-manifest.ts            # write both artifacts
 *   npx tsx scripts/gen-egress-manifest.ts --check    # CI parity: exit 1 on drift
 *
 * The parity test (`src/tools/__tests__/egress-manifest-parity.test.ts`) is the
 * primary drift gate; `--check` gives the same guarantee from CI/pre-commit.
 *
 * @module scripts/gen-egress-manifest
 * @author fifty.dev
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNC_TABLES } from '../src/tools/sync.js';
import {
  buildEgressManifest,
  MANIFEST_DOC_REL_PATH,
  MANIFEST_CLI_REL_PATH,
} from '../src/tools/egress-manifest.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Artifact {
  relPath: string;
  content: string;
}

function buildArtifacts(): Artifact[] {
  const { markdown, cliModule } = buildEgressManifest(SYNC_TABLES);
  return [
    { relPath: MANIFEST_DOC_REL_PATH, content: markdown },
    { relPath: MANIFEST_CLI_REL_PATH, content: cliModule },
  ];
}

function readCommitted(relPath: string): string | null {
  try {
    return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  const check = process.argv.includes('--check');
  const artifacts = buildArtifacts();

  if (check) {
    const drifted: string[] = [];
    for (const { relPath, content } of artifacts) {
      if (readCommitted(relPath) !== content) drifted.push(relPath);
    }
    if (drifted.length > 0) {
      console.error(
        'egress manifest drift detected — regenerate with `npm run gen:egress-manifest`:',
      );
      for (const p of drifted) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log('egress manifest artifacts are in sync with SYNC_TABLES.');
    return;
  }

  for (const { relPath, content } of artifacts) {
    writeFileSync(resolve(REPO_ROOT, relPath), content);
    console.log(`wrote ${relPath}`);
  }
}

main();
