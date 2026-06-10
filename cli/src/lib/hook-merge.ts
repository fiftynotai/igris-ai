/**
 * FR-180 (D7 — Option B): the claude `settings.json` hook PROJECTOR + the R2
 * refresh-overwrite-hazard fix.
 *
 * A hook block projects into a project's `.claude/settings.json` by appending an
 * Igris hook GROUP (built by `buildClaudeHookGroup`) into the `hooks.<Event>[]`
 * array — idempotently (a re-project of the same command path is a no-op) and
 * non-destructively (pre-existing user groups + every other top-level key are
 * preserved byte-for-byte).
 *
 * R2 — THE CENTRAL HAZARD (a MERGE GATE). `install`/`update`/`doctor --fix`
 * re-merge `~/.igris/core/hooks/canonical-settings.json` via
 * `mergeCanonicalHooks` (json-merge.ts), which DROPS every group whose command
 * starts with the CORE prefix `$HOME/.igris/core/hooks/` (then re-appends the
 * canonical set). A personal-added hook must NOT be clobbered by that re-merge.
 * The fix is provenance-by-prefix: a personal hook's command lives under the
 * REGISTRY prefix `$HOME/.igris/registry/hooks/<name>/` — a DIFFERENT prefix
 * `mergeCanonicalHooks` treats as user-owned and PRESERVES. This module owns the
 * prefix constant + a `personalHookCommandPath` helper so the add path and the
 * preservation contract share ONE definition.
 */

import { isAbsolute } from "node:path";
import type { ClaudeHookGroup } from "./hook-shape.js";

/**
 * The provenance prefix a PERSONAL (`igris add hook`) command path carries. The
 * literal `$HOME` form matches the canonical-settings.json convention (Claude
 * Code expands `$HOME` at runtime). Because it is NOT the core prefix
 * (`$HOME/.igris/core/hooks/`) and NOT a legacy portable filename,
 * `mergeCanonicalHooks` (json-merge.ts) classifies a registry-prefixed group as
 * user-owned and PRESERVES it across the canonical re-merge — the R2 fix.
 */
export const PERSONAL_HOOK_CMD_PREFIX = "$HOME/.igris/registry/hooks/";

/** The CORE prefix (mirror of IGRIS_HOOK_CMD_PREFIX in json-merge.ts). */
export const CORE_HOOK_CMD_PREFIX = "$HOME/.igris/core/hooks/";

/**
 * Build the personal hook command path for `<name>` firing on `<event>`:
 *   $HOME/.igris/registry/hooks/<name>/<event>.sh
 * One definition shared by `add-hook.ts` (which writes the script + the overlay
 * block's `canonical.command`) and the R2 preservation contract.
 */
export function personalHookCommandPath(name: string, event: string): string {
  return `${PERSONAL_HOOK_CMD_PREFIX}${name}/${event}.sh`;
}

/** True iff `command` is a personal (registry-provenance) hook command. */
export function isPersonalHookCommand(command: string): boolean {
  return command.startsWith(PERSONAL_HOOK_CMD_PREFIX);
}

/**
 * Thrown when the target settings.json `hooks.<Event>` value is present but not
 * an array — the projector refuses to clobber an unexpected shape.
 */
export class HookMergeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookMergeShapeError";
  }
}

/**
 * Extract the command path from a hook group (the first command in its `hooks`
 * array), or null when the group has no command. Used to dedupe on re-project.
 */
function groupCommand(group: unknown): string | null {
  if (typeof group !== "object" || group === null) {
    return null;
  }
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) {
    return null;
  }
  for (const h of hooks) {
    if (typeof h === "object" && h !== null) {
      const cmd = (h as { command?: unknown }).command;
      if (typeof cmd === "string") {
        return cmd;
      }
    }
  }
  return null;
}

/**
 * Merge one Igris hook GROUP into a `settings.json` object's `hooks.<Event>[]`.
 *
 * - Deep-clones `existing` (never mutates the caller's input).
 * - If a group with the SAME command path already exists under that event, it
 *   is REPLACED in place (idempotent re-project; a matcher/timeout edit takes
 *   effect) — so projecting twice yields one group, not two.
 * - Otherwise the group is APPENDED after any pre-existing groups.
 * - Every other event + every top-level key is preserved byte-for-byte.
 *
 * Returns the new settings object. Throws `HookMergeShapeError` when the target
 * `hooks` value or the event array is a non-object / non-array (refuse to
 * clobber).
 */
export function mergeHookIntoSettings(
  existing: Record<string, unknown> | null | undefined,
  event: string,
  group: ClaudeHookGroup,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing === null || existing === undefined ? {} : existing;
  if (typeof base !== "object" || Array.isArray(base)) {
    throw new HookMergeShapeError("settings.json root must be a JSON object");
  }
  const merged = structuredClone(base) as Record<string, unknown>;

  const hooksVal = merged.hooks ?? {};
  if (typeof hooksVal !== "object" || hooksVal === null || Array.isArray(hooksVal)) {
    throw new HookMergeShapeError(
      "settings.json `hooks` must be a JSON object when present",
    );
  }
  const hooks = { ...(hooksVal as Record<string, unknown>) };

  const eventVal = hooks[event] ?? [];
  if (!Array.isArray(eventVal)) {
    throw new HookMergeShapeError(
      `settings.json hooks.${event} must be an array when present`,
    );
  }
  const eventArr = [...(eventVal as unknown[])];

  const newCmd = groupCommand(group);
  let replaced = false;
  for (let i = 0; i < eventArr.length; i++) {
    if (newCmd !== null && groupCommand(eventArr[i]) === newCmd) {
      eventArr[i] = group;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    eventArr.push(group);
  }

  hooks[event] = eventArr;
  merged.hooks = hooks;
  return merged;
}

/**
 * Does `settings`'s `hooks.<Event>` array contain a group whose command path is
 * exactly `command`? The drift-side reader: a hook is "projected" iff its
 * command path is present under its event. Used by the hook drift pass to emit
 * MATCH (present) / MISSING (absent).
 */
export function hookCommandPresent(
  settings: unknown,
  event: string,
  command: string,
): boolean {
  if (typeof settings !== "object" || settings === null) {
    return false;
  }
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return false;
  }
  const arr = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(arr)) {
    return false;
  }
  for (const g of arr) {
    if (groupCommand(g) === command) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a `$HOME`-prefixed hook command to an absolute path against `home`.
 * The canonical convention stores `$HOME/...`; the drift / compile passes
 * resolve it for existence checks. A non-`$HOME` absolute path is returned
 * verbatim; a bare relative path is returned as-is (caller decides).
 */
export function resolveHookCommandPath(command: string, home: string): string {
  if (command.startsWith("$HOME/")) {
    return `${home}/${command.slice("$HOME/".length)}`;
  }
  if (isAbsolute(command)) {
    return command;
  }
  return command;
}
