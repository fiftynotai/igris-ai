/**
 * Brain Engine v7.1 — Cognition extractors barrel (FR-118).
 *
 * The SINGLE place a cognition instance is listed. The registry's
 * `discoverInstances` reads `EXTRACTORS` (re-exported from `registry.ts` and
 * extended here as instances land) so a new extractor is ONE re-export line —
 * the engine never branches on instance identity (the FR-202 zero-host-change
 * extensibility property).
 *
 * M1 lands the perception instance (`extractors/perception.ts`); subconscious
 * (M2) is added the same way. They appear in the registry + engine
 * automatically — ONE re-export line is the whole cost of a new instance.
 *
 * @module engine/components/cognition/extractors
 * @author fifty.dev
 */

import type { CognitionInstance } from '../types.js';
import { perceptionInstance } from './perception.js';

/**
 * Every bundled cognition instance, in boot order. A new instance is added by
 * importing it and appending it here (one line) — discovery
 * (`registry.ts:discoverInstances`) registers them all with no engine change
 * (the FR-202 zero-host-change extensibility property).
 *
 * M1: perceptionInstance (the proving instance + correctness oracle).
 * M2: import { subconsciousInstance } from './subconscious.js';
 */
export const EXTRACTOR_INSTANCES: readonly CognitionInstance[] = [
  perceptionInstance,
  // M2: subconsciousInstance,
];

export { perceptionInstance, createPerceptionInstance } from './perception.js';
