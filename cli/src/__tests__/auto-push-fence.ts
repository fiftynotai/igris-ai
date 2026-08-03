/**
 * FR-247 — **THE AUTO-PUSH EGRESS FENCE.**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT PART OF THE SANDBOX FENCE
 * ═════════════════════════════════════════════════════════════════════════════
 * FR-241's fence answers "did a test write to the operator's real brain?" and
 * answers it structurally: `brainDbPath()` resolves inside a `mkdtemp` sandbox,
 * `IGRIS_DB_PATH` is dead code once `setAdapter` has run, and G-TR-0 witnesses
 * every path the suite's handle resolved to.
 *
 * FR-247 introduces a SECOND, worse failure mode that that fence cannot see.
 * The chain, read out of the shipped source rather than assumed:
 *
 *   1. `briefs/index.ts:398` — `igris_brief_update`'s registration emits
 *      `brief.synced` on EVERY update, status or not. `set_priority` dispatches
 *      that tool, so the dashboard's first brief write is also the first
 *      dashboard mutation that emits this event at all (none of FR-241's five
 *      does).
 *   2. `sync/index.ts:720` — the sync component wires
 *      `bus.on('brief.synced', onImmediateEvent)` **unconditionally**. The
 *      comment there says so explicitly: "ALWAYS wire listeners (event-bus
 *      integrity tests require it). Handlers early-return when
 *      `_autoPushConfig` is null."
 *   3. `sync/index.ts:291-308` — that handler selects the brief's
 *      `brief_status` and `brief_files` rows and FIRE-AND-FORGETS
 *      `pushTables(...)` at `remote_brain.url`.
 *   4. `sync/index.ts:81-105` — `_autoPushConfig` is `loadAutoPushConfig()`,
 *      which reads `join(homedir(), '.igris', 'config.json')` and returns null
 *      unless `config.auto_push === true`.
 *   5. `sync` is DELIBERATELY ENABLED in the dashboard's write engine
 *      (`brain-write-bridge.ts#WRITE_ENGINE_COMPONENTS` disables `schedules`
 *      and nothing else, and G-TR-0 asserts that deviation set exactly).
 *
 * So a FIXTURE row written by a test does not merely touch a local sandbox DB —
 * on a machine where `auto_push` is true it EGRESSES to the operator's remote
 * brain. That is strictly worse than touching the local file, because it is not
 * undoable from this machine.
 *
 * Measured on this machine at build time (Phase-0 P0.5): `auto_push` is ABSENT
 * from `~/.igris/config.json`, so the path is inert HERE — and `remote_brain.url`
 * IS configured. The only thing between a fixture write and a real egress is one
 * boolean in a file no test owns. That is not a fence; that is luck.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FENCE DOES — TWO INDEPENDENT LAYERS, BOTH SELF-ASSERTED
 * ═════════════════════════════════════════════════════════════════════════════
 *  L1 — `HOME` is pointed at the sandbox, so `loadAutoPushConfig()` reads a
 *       config that the test owns (usually: none at all).
 *  L2 — `globalThis.fetch` is replaced by a RECORDING THROWER, so even a config
 *       that somehow said `auto_push: true` cannot reach the network, and the
 *       attempt is COUNTED rather than swallowed.
 *
 * Two layers rather than one because L1 alone is a claim about a file and L2
 * alone is a claim about a function — and each covers the other's failure. L1
 * fails if something else re-resolves the config; L2 fails if a future sync
 * path uses `node:https` instead of `fetch`. `assertArmed()` reads BOTH back
 * (learning: arm the flag, then READ IT BACK and assert it — a guard whose only
 * observed output is "nothing happened" is indistinguishable from a broken one).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AND IT IS PROVEN, NOT ASSERTED
 * ═════════════════════════════════════════════════════════════════════════════
 * A fence over a machine where `auto_push` is already false proves nothing: zero
 * egress attempts is what you observe from a fence that works, from a fence that
 * does nothing, AND from a listener that was never wired. So
 * `dashboard-triage-endpoint.test.ts` G-TR-13 ARMS THE OTHER ARM: it writes a
 * sandbox `config.json` with `auto_push: true` and a fictional remote, performs
 * a real priority write, and asserts the fence RECORDED an attempted POST to
 * that remote's `/sync/push`. That single test does three things at once —
 * it demonstrates the egress path is real, it demonstrates the fence catches it,
 * and it makes the zero-attempt assertion in every other test meaningful.
 *
 * The thrower's message deliberately begins `HTTP 4`: `fetchWithRetry`
 * (`tools/sync.ts:463-493`) re-throws immediately on a `HTTP 4`-prefixed error
 * and otherwise retries twice with 1s/2s backoff. A fence that made every
 * blocked call take three seconds would be a fence people delete.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One blocked outbound request. */
export interface EgressAttempt {
  url: string;
  method: string;
}

export interface AutoPushFence {
  /** The `HOME` this fence installed. `homedir()` must equal it. */
  home: string;
  /** Every outbound request the fence blocked, in order. */
  attempts: EgressAttempt[];
  /**
   * Read BOTH layers back and throw if either is not armed.
   *
   * Call it in the test body, not only in `beforeEach`: a vitest worker is its
   * own process with its own module registry, and a fence armed in one file
   * protects nothing in another file's worker.
   */
  assertArmed: () => void;
  /** Write a sandbox `~/.igris/config.json`. Used to ARM the other arm. */
  writeConfig: (config: Record<string, unknown>) => void;
  /** Restore `HOME` and the real `fetch`. */
  release: () => void;
}

/** The marker the fence stamps on its `fetch`, so `assertArmed` can read it. */
const FENCE_MARK = "__fr247AutoPushFence";

/**
 * Arm the fence for the current process, pointing `HOME` at `sandbox`.
 *
 * Idempotent-ish: calling it twice without `release()` throws, because a second
 * arm would capture the FIRST fence's `fetch` as "the real one" and `release()`
 * would then leave the thrower installed for the rest of the worker.
 */
export function armAutoPushFence(sandbox: string): AutoPushFence {
  const g = globalThis as unknown as Record<string, unknown>;
  if ((g.fetch as Record<string, unknown> | undefined)?.[FENCE_MARK] === true) {
    throw new Error("FR-247 auto-push fence is already armed — release() first");
  }

  const prevHome = process.env.HOME;
  process.env.HOME = sandbox;

  const attempts: EgressAttempt[] = [];
  const realFetch = g.fetch as typeof fetch;

  const fenced = ((input: unknown, init?: { method?: string }) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string })?.url ?? input);
    attempts.push({ url, method: init?.method ?? "GET" });
    // `HTTP 4…` so `fetchWithRetry` fails fast instead of retrying for 3s.
    return Promise.reject(
      new Error(
        `HTTP 499 FR-247 AUTO-PUSH FENCE blocked an outbound request to ${url}`,
      ),
    );
  }) as unknown as typeof fetch;
  (fenced as unknown as Record<string, unknown>)[FENCE_MARK] = true;
  g.fetch = fenced;

  const configPath = (): string => join(sandbox, ".igris", "config.json");

  return {
    home: sandbox,
    attempts,
    assertArmed(): void {
      // L1, read back from the OS resolver rather than from the env var we
      // just set — `homedir()` is what `loadAutoPushConfig` actually calls.
      const resolved = homedir();
      if (resolved !== sandbox) {
        throw new Error(
          `FR-247 fence NOT ARMED: homedir() is ${resolved}, expected the sandbox ${sandbox}`,
        );
      }
      // ...and the operator's real config must be out of reach, whatever it says.
      const real = join(String(prevHome ?? ""), ".igris", "config.json");
      if (configPath() === real) {
        throw new Error("FR-247 fence NOT ARMED: the sandbox config IS the real one");
      }
      // L2.
      const current = (globalThis as unknown as Record<string, unknown>).fetch;
      if ((current as Record<string, unknown> | undefined)?.[FENCE_MARK] !== true) {
        throw new Error("FR-247 fence NOT ARMED: globalThis.fetch is not the fenced one");
      }
    },
    writeConfig(config: Record<string, unknown>): void {
      const p = configPath();
      if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(config), "utf-8");
    },
    release(): void {
      g.fetch = realFetch;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    },
  };
}
