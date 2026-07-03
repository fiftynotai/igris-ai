/**
 * FR-180 (D7 — Option B): the hook PROJECTOR's shape helper.
 *
 * Given a hook block's canonical spec (command + optional matcher/timeout) it
 * builds the native claude `settings.json` hook GROUP that `project-hook` merges
 * into the target. This is a TS-ONLY shaper — unlike identity/agents, hooks have
 * NO §18.1 bash↔TS dual-impl: hook drift is PRESENCE-BASED (the hook is
 * identified by its command PATH in the merged JSON via
 * `_common.sh::verify_hook_entry_present`, not a byte-shape comparison), so there
 * is no bash `normalize_hook_shape` twin to keep byte-identical. The output here
 * is pinned by a TS-only golden in `hook-shape.test.ts` (it locks the projector's
 * own bytes; it is NOT a cross-impl parity test).
 *
 * Per-harness shapes:
 *   claude   → one group `{matcher?, hooks:[{type:"command", command, timeout?}]}`
 *              appended into `settings.json` `hooks.<Event>[]`. The matcher is
 *              omitted entirely for non-tool events (SessionStart/SessionEnd/
 *              Pre/PostCompact); for Pre/PostToolUse it carries the tool-glob.
 *   opencode → NOT a settings.json group — opencode hooks ride the FR-104
 *              plugin (igris-bridge.ts), which already routes all six events to
 *              the shared scripts. The projector treats an opencode target as
 *              "covered by the plugin" (verify the plugin exists), NOT a config
 *              write. So this helper only shapes the claude group.
 *
 * The hook entry NEVER carries a secret — `command` is a script path the
 * harness runs.
 */

/** One Igris hook entry in a claude `settings.json` `hooks.<Event>[]` array. */
export interface ClaudeHookGroup {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** The canonical hook spec a block declares (the schema `canonical` object). */
export interface HookCanonicalSpec {
  command: string;
  matcher?: string;
  timeout?: number;
}

/**
 * Build the claude `settings.json` hook GROUP for one canonical hook spec. The
 * matcher is only emitted for the tool events (PreToolUse / PostToolUse); for
 * the other four events it is omitted (a bare group fires unconditionally). The
 * timeout is emitted only when present. Pinned by a TS-only golden in
 * `hook-shape.test.ts` (the projector's own bytes — there is no bash twin; see
 * the module docstring).
 */
export function buildClaudeHookGroup(
  event: string,
  canonical: HookCanonicalSpec,
): ClaudeHookGroup {
  const isToolEvent = event === "PreToolUse" || event === "PostToolUse";
  const hookObj: { type: "command"; command: string; timeout?: number } = {
    type: "command",
    command: canonical.command,
  };
  if (canonical.timeout !== undefined) {
    hookObj.timeout = canonical.timeout;
  }
  const group: ClaudeHookGroup = { hooks: [hookObj] };
  // Only attach a matcher on the tool events AND only when one was declared.
  if (isToolEvent && canonical.matcher !== undefined && canonical.matcher.length > 0) {
    group.matcher = canonical.matcher;
  }
  return group;
}

/**
 * Canonical compact-JSON serialization of a claude hook group with SORTED keys.
 * Used for stable equality/snapshotting of the projector's output and pinned by
 * the TS-only golden in `hook-shape.test.ts`. (Object.keys order is normalized
 * via a sorted re-walk so `{matcher, hooks}` and `{hooks, matcher}` serialize
 * identically.) NOTE: this is NOT compared against any bash output — hook drift
 * is presence-based (verify_hook_entry_present), not byte-shape.
 */
export function serializeClaudeHookGroup(group: ClaudeHookGroup): string {
  return JSON.stringify(sortKeysDeep(group));
}

/** Recursively sort object keys so serialization is order-independent. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
