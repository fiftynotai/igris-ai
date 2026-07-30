/**
 * FR-239 — the ONLY module in the application that imports `force-graph`.
 *
 * It is one line long on purpose. `force-graph` dereferences `window` at import
 * time, so any module that imports it becomes unreachable from the
 * node-environment vitest run. `instance.ts` carries the AC-#5 pause/resume
 * state machine and therefore MUST stay reachable — so the constructor call
 * lives here, alone, and `instance.ts` receives it as a parameter.
 *
 * THE CAST IS THE TYPE PIN. `ForceGraphLike` in `instance.ts` is a hand-written
 * structural mirror of the subset of the library's API this app uses. The
 * assignment below is a plain, non-`unknown` cast, so if the real API ever
 * stops satisfying that interface — a renamed accessor, a changed signature —
 * `npm run typecheck:dashboard` fails HERE rather than at runtime in a browser.
 *
 * Nothing else belongs in this file. Adding a second library call here would
 * move the seam out of `instance.ts` and defeat the T8 scan.
 */

import ForceGraph from "force-graph";
import type { ForceGraphFactory, ForceGraphLike } from "./instance";

export const forceGraphFactory: ForceGraphFactory = (el) =>
  new ForceGraph(el) as ForceGraphLike;
