/**
 * TD-338 — Generate the CLI-side brief-normalize mirror from brief-normalize.ts.
 *
 * `brain-mcp-server/src/tools/brief-normalize.ts` is the single source of truth
 * for the brief metadata vocabulary and its fold tables. The CLI's own
 * `mergeRows` (`cli/src/lib/brain-db.ts`) — the ingress door that runs on a
 * workstation during awaken / `igris boot-sync` — needs the same folds, and the
 * two packages have ZERO cross-imports. This script runs the pure
 * `buildBriefNormalizeMirror` builder and writes the ONE committed,
 * never-hand-edited artifact:
 *
 *   cli/src/lib/brief-normalize.generated.ts
 *
 * Usage:
 *   npx tsx scripts/gen-brief-normalize-mirror.ts            # write the artifact
 *   npx tsx scripts/gen-brief-normalize-mirror.ts --check    # CI parity: exit 1 on drift
 *
 * The parity test (`src/tools/__tests__/brief-normalize-mirror-parity.test.ts`)
 * is the primary drift gate; `--check` gives the same guarantee from CI. Modeled
 * byte-for-byte on `gen-egress-manifest.ts` (TD-253).
 *
 * @module scripts/gen-brief-normalize-mirror
 * @author fifty.dev
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBriefNormalizeMirror,
  MIRROR_CLI_REL_PATH,
} from '../src/tools/brief-normalize-mirror.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Artifact {
  relPath: string;
  content: string;
}

function buildArtifacts(): Artifact[] {
  const { cliModule } = buildBriefNormalizeMirror();
  return [{ relPath: MIRROR_CLI_REL_PATH, content: cliModule }];
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
        'brief-normalize mirror drift detected — regenerate with `npm run gen:brief-normalize-mirror`:',
      );
      for (const p of drifted) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log('brief-normalize mirror is in sync with brief-normalize.ts.');
    return;
  }

  for (const { relPath, content } of artifacts) {
    writeFileSync(resolve(REPO_ROOT, relPath), content);
    console.log(`wrote ${relPath}`);
  }
}

main();
