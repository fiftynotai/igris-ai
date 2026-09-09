/**
 * FR-240 — the SINGLE definition of the "this suite may not reach the network"
 * guard, shared by every vitest file that crawls the layer endpoints.
 *
 * WHY IT IS ITS OWN MODULE AND NOT PART OF `dashboard-layers-fixture.ts`.
 * That was the first placement and the browser gate rejected it within one run.
 * `cli/scripts/browser-gate.mjs` TRANSPILES the fixture and evaluates it with
 * `node --input-type=module -e`, which has no file path — so any relative import
 * the fixture grows resolves against the wrong directory and the whole gate dies
 * with `ERR_MODULE_NOT_FOUND`. **The fixture must stay import-free apart from
 * `better-sqlite3` and node builtins.** This file has no such constraint because
 * only vitest imports it.
 *
 * WHY EVERY SUITE THAT CRAWLS THE LAYER ENDPOINTS NEEDS IT. The reader embeds
 * the query before it can reach `vectorSearch`, so ANY `/api/learnings/search`
 * request asks transformers.js for a model — and transformers.js v3 caches
 * PACKAGE-LOCALLY, inside
 * `cli/dist/brain-mcp-server/node_modules/@huggingface/transformers/.cache/`,
 * which `scripts/copy-templates.sh` `rm -rf`s on every build. So on a freshly
 * built tree there is no cache and the request FETCHES from the HuggingFace Hub:
 * slow, network-coupled, writing into a build artifact, and corrupting
 * `model.onnx` when two parallel vitest workers do it at once. All four were
 * observed while building FR-240 — and the warden pass caught `npm test` doing
 * it again through `dashboard-readonly.test.ts` and
 * `dashboard-layers-endpoint.test.ts`, whose crawls include the search path.
 * Only the search suite had the guard, and a vitest worker is its own process
 * with its own module registry, so one file's `beforeAll` protects nothing in
 * another file's worker. Measured: 87 MB reappeared in `cli/dist/` during a
 * `npm test` run started with the cache removed.
 *
 * `allowRemoteModels = false` turns the fetch into an immediate typed failure.
 * LOCAL loading stays on, so a warm cache is still used when one is present, and
 * the resulting no-cache path is not a fiction: it is the production state of an
 * offline host or a fresh install, which must degrade to a reported `bm25_only`.
 *
 * @module __tests__/hermetic-embeddings
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { bundledBrainNodeModulesDir } from "../lib/paths.js";

/**
 * The vendored transformers ENTRY FILE.
 *
 * The EXACT file, because it is the file the vendored `embeddings.js` itself
 * resolves to (`package.json` `exports.node.import.default` for v3.x) and the
 * ESM registry keys by resolved URL — so both get the same module object and the
 * flag set here is in effect before any pipeline is constructed.
 *
 * An earlier version of this comment claimed a package-DIRECTORY import would
 * throw `ERR_UNSUPPORTED_DIR_IMPORT`. That is true of plain Node ESM (and of the
 * browser gate's `--import` preload, which runs there) and NOT of this harness:
 * measured during the warden pass, vitest resolves a directory import through
 * Vite and returns the module, so pointing at the directory here would arm the
 * flag and pass. The reason to name the entry file is IDENTITY, not failure — do
 * not "simplify" it back to the directory on the strength of an argument that
 * only holds outside vitest.
 */
const TRANSFORMERS_ENTRY = join(
  bundledBrainNodeModulesDir(),
  "@huggingface",
  "transformers",
  "dist",
  "transformers.node.mjs",
);

export interface HermeticState {
  armed: boolean;
  reason: string | null;
}

let hermeticMemo: HermeticState | null = null;

/**
 * Block the ~90 MB MiniLM download for this worker process. Call from
 * `beforeAll` and ASSERT the result.
 *
 * The flag is read BACK. Setting a property on a frozen or proxied export would
 * otherwise fail silently, leaving a guard whose only observed outcome is "pass"
 * while the suite stays network-coupled (learning 1094, committed live during
 * FR-240). Hence `armed`, which every caller asserts as its own check.
 */
export async function armHermeticEmbeddings(): Promise<HermeticState> {
  if (hermeticMemo !== null) return hermeticMemo;
  const state: HermeticState = { armed: false, reason: "not attempted" };
  if (!existsSync(TRANSFORMERS_ENTRY)) {
    state.reason = `transformers entry not found at ${TRANSFORMERS_ENTRY}`;
    hermeticMemo = state;
    return state;
  }
  try {
    const mod = (await import(TRANSFORMERS_ENTRY)) as {
      env?: { allowRemoteModels?: boolean };
    };
    if (mod.env === undefined) {
      state.reason = "transformers module exposes no `env`";
    } else {
      mod.env.allowRemoteModels = false;
      state.armed = mod.env.allowRemoteModels === false;
      state.reason = state.armed ? null : "flag did not stick";
    }
  } catch (err) {
    state.reason = err instanceof Error ? err.message : String(err);
  }
  hermeticMemo = state;
  return state;
}

/** True when the vendored bundle is staged (`npm run build` has run in `cli/`). */
export function bundleStaged(): boolean {
  return existsSync(join(bundledBrainNodeModulesDir(), "sqlite-vec", "index.mjs"));
}
