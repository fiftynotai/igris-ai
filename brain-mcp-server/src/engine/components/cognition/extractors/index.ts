/**
 * Brain Engine v7.1 — Cognition extractors barrel (FR-118).
 *
 * The SINGLE place a cognition instance is listed. The registry's
 * `discoverInstances` reads `EXTRACTORS` (re-exported from `registry.ts` and
 * extended here as instances land) so a new extractor is ONE re-export line —
 * the engine never branches on instance identity (the FR-202 zero-host-change
 * extensibility property).
 *
 * M0 ships DORMANT — no real instances yet. Perception (M1) and subconscious
 * (M2) are added here as `extractors/perception.ts` / `extractors/subconscious.ts`
 * land; they appear in the registry + engine automatically.
 *
 * @module engine/components/cognition/extractors
 * @author fifty.dev
 */

import type { CognitionInstance } from '../types.js';

/**
 * Every bundled cognition instance, in boot order. M0: empty. A new instance is
 * added by importing it and appending it here (one line) — discovery
 * (`registry.ts:discoverInstances`) registers them all with no engine change.
 *
 * M1: import { perceptionInstance } from './perception.js';
 * M2: import { subconsciousInstance } from './subconscious.js';
 */
export const EXTRACTOR_INSTANCES: readonly CognitionInstance[] = [
  // M1: perceptionInstance,
  // M2: subconsciousInstance,
];
