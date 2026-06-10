/**
 * Pure JSON-merge primitive for `<project>/.claude/settings.json`.
 *
 * Ports the algorithm from `scripts/hook-adapters/install_claude_hooks.sh:96-220`
 * verbatim — same semantics, same idempotence guarantees, same legacy-portable
 * filename handling. The shell version uses python; this is the TS equivalent.
 *
 * Algorithm (intra-event):
 *   1. Clone `existing` deeply (no mutation of caller's input).
 *   2. For each portable event (SessionStart, SessionEnd, PreCompact,
 *      PostCompact, PreToolUse, PostToolUse): split entries into Igris-owned
 *      and user-owned. Drop Igris-owned, preserve user-owned in original order.
 *      Strip legacy portable filenames (the pre-FR-104 set).
 *   3. Append canonical Igris entries AFTER any user-owned entries (D-1
 *      decision: Igris-first ordering matches the shell at line 217 — the
 *      shell version uses `igris_entries + user_entries` so Igris is first;
 *      this implementation matches by computing `[...igris, ...users]`).
 *   4. Replace `existing.hooks` with the merged map. NO other top-level key
 *      is touched — `permissions`, `env`, `model`, `includeGitInstructions`,
 *      etc. all preserved byte-for-byte.
 *
 * Throws `MalformedSettingsError` when `existing` is non-null but not a
 * plain object — the verb layer catches this and refuses to clobber.
 */

const PORTABLE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "PreToolUse",
  "PostToolUse",
] as const;

const IGRIS_HOOK_CMD_PREFIX = "$HOME/.igris/core/hooks/";

/**
 * FR-180 (D7 / R2): the PERSONAL-hook provenance prefix (mirror of
 * `PERSONAL_HOOK_CMD_PREFIX` in hook-merge.ts). A group whose command starts
 * with this prefix was projected by `igris add hook` and MUST survive the
 * canonical re-merge — it is explicitly NOT stripped here (it is neither the
 * CORE prefix above nor a legacy portable filename, so the default already
 * preserves it; this constant + the explicit guard in `isIgrisEntry` make the
 * R2 preservation a deliberate, regression-tested contract rather than an
 * incidental side effect of the prefix check). See FR-180 D7 + the
 * refresh-no-clobber test.
 */
const IGRIS_PERSONAL_HOOK_CMD_PREFIX = "$HOME/.igris/registry/hooks/";

/**
 * Pre-FR-104 Igris portable hooks lived in the project-local `.claude/hooks/`
 * directory. These exact filenames are legacy-Igris and should be stripped
 * during migration so we don't leave dead references pointing at deleted
 * scripts. Mirrors `LEGACY_PORTABLE_FILENAMES` in install_claude_hooks.sh.
 */
const LEGACY_PORTABLE_FILENAMES = new Set([
  "session_start.sh",
  "session_end.sh",
  "pre_compact.sh",
  "brief_gate.sh", // old name for pre_tool_use.sh
  "post_edit_lint.sh", // now post_tool_use.d/01-lint.sh
  "post_brief_sync.sh",
  "post_session_sync.sh",
]);

/**
 * Thrown when `existing` is unparseable or has a top-level shape that the
 * merge algorithm cannot reason about safely. Verb layer catches and refuses
 * to clobber the on-disk file.
 */
export class MalformedSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSettingsError";
  }
}

interface CanonicalShape {
  hooks: Record<string, unknown>;
}

export interface MergeOptions {
  /**
   * When true (default), legacy `.claude/hooks/<legacy-filename>` entries are
   * stripped from event arrays. Disable for tests that want to assert the
   * pure no-strip case.
   */
  stripLegacyIgrisFilenames?: boolean;
}

/**
 * Merge canonical hooks into an existing settings.json structure.
 *
 * @param existing  Parsed settings.json (any non-hooks key is preserved).
 * @param canonical Object with a `hooks` map (typically from canonical-settings.json).
 * @param opts      Optional merge tuning.
 * @returns         A new object — does not mutate `existing`.
 */
export function mergeCanonicalHooks(
  existing: Record<string, unknown> | null | undefined,
  canonical: CanonicalShape,
  opts: MergeOptions = {},
): Record<string, unknown> {
  const stripLegacy = opts.stripLegacyIgrisFilenames !== false;

  // Normalize null/undefined to empty object. Anything else non-plain-object → throw.
  if (existing === null || existing === undefined) {
    existing = {};
  }
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new MalformedSettingsError(
      "settings.json root must be a JSON object",
    );
  }

  // Deep clone to avoid mutating caller input.
  const merged = structuredClone(existing) as Record<string, unknown>;

  const existingHooks = (merged.hooks ?? {}) as Record<string, unknown>;
  if (typeof existingHooks !== "object" || Array.isArray(existingHooks)) {
    throw new MalformedSettingsError(
      "settings.json `hooks` must be a JSON object when present",
    );
  }

  const newHooks: Record<string, unknown> = { ...existingHooks };

  for (const event of PORTABLE_EVENTS) {
    const userEntries = stripIgrisFromEvent(
      newHooks[event],
      stripLegacy,
    );
    const canonicalEntries = canonical.hooks[event];
    const canonicalArr = Array.isArray(canonicalEntries)
      ? (canonicalEntries as unknown[])
      : [];
    // D-1: Igris-first ordering to match install_claude_hooks.sh:217.
    newHooks[event] = [...canonicalArr, ...userEntries];
  }

  merged.hooks = newHooks;
  return merged;
}

/**
 * Given the list-of-groups for one event, drop any group that contains at
 * least one Igris-owned hook object. User-owned groups (no Igris hooks at all)
 * are preserved verbatim in their original order. Mirrors
 * `strip_igris_from_event` in install_claude_hooks.sh.
 *
 * If the input is not an array (corrupt or absent), returns [].
 */
function stripIgrisFromEvent(
  raw: unknown,
  stripLegacy: boolean,
): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((g) => !isIgrisEntry(g, stripLegacy));
}

/**
 * Entry shape: `{matcher?: string, hooks: [{type, command|url, timeout?}, ...]}`.
 * Returns true when at least one of the entry's hook objects has a command
 * that starts with the Igris prefix or matches a legacy portable filename.
 */
function isIgrisEntry(entry: unknown, stripLegacy: boolean): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const sub = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(sub)) return false;
  for (const h of sub) {
    if (typeof h !== "object" || h === null) continue;
    const cmd = (h as { command?: unknown }).command;
    if (typeof cmd !== "string") continue;
    // FR-180 (D7 / R2): a PERSONAL-added hook (registry-prefix command) is NEVER
    // stripped — it is preserved across the canonical re-merge so install /
    // update / doctor --fix cannot clobber it. The early-continue makes this an
    // explicit, deliberate carve-out (not merely "it doesn't match the core
    // prefix"). This is the merge gate the refresh-no-clobber regression locks.
    if (cmd.startsWith(IGRIS_PERSONAL_HOOK_CMD_PREFIX)) continue;
    if (cmd.startsWith(IGRIS_HOOK_CMD_PREFIX)) return true;
    if (stripLegacy && commandIsLegacyPortable(cmd)) return true;
  }
  return false;
}

/**
 * Matches `...claude/hooks/{legacy-portable-name}` (quoted or not, literal
 * or expanded `$CLAUDE_PROJECT_DIR` prefix). Ignores other user-owned files
 * in the same directory like `agent_metrics.sh`, `teammate_idle_assign.sh`.
 *
 * Mirrors the regex in install_claude_hooks.sh:131:
 *   r"\.claude/hooks/([A-Za-z0-9_.-]+)(?:\s|$|\")"
 */
function commandIsLegacyPortable(cmd: string): boolean {
  const m = /\.claude\/hooks\/([A-Za-z0-9_.-]+)(?:\s|$|")/.exec(cmd);
  if (m === null) return false;
  return LEGACY_PORTABLE_FILENAMES.has(m[1]);
}
