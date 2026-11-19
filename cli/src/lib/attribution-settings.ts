/**
 * TD-470: the Claude Code `attribution` default, applied by the global
 * settings writer (`global-hooks.ts`) after the hooks merge. `json-merge.ts`
 * stays hooks-only. Object form: older Claude Code rejects a bare boolean.
 */

/** The value written when the user has set no attribution posture. */
export const IGRIS_ATTRIBUTION = Object.freeze({
  commit: "",
  pr: "",
  sessionUrl: false,
});

/**
 * `added`: the key was absent and is now set. `present`: already the Igris
 * object. `kept-user`: any other `attribution`, or `includeCoAuthoredBy`.
 */
export type AttributionOutcome = "added" | "present" | "kept-user";

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function isIgrisObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const o = v as Record<string, unknown>;
  return (
    keys.length === 3 &&
    o.commit === IGRIS_ATTRIBUTION.commit &&
    o.pr === IGRIS_ATTRIBUTION.pr &&
    o.sessionUrl === IGRIS_ATTRIBUTION.sessionUrl
  );
}

/**
 * Pure: never mutates `settings`. Writes only when neither `attribution` nor
 * the deprecated `includeCoAuthoredBy` is present (any value is the user's),
 * and appends the key last so existing key order survives.
 */
export function applyAttributionDefault(settings: Record<string, unknown>): {
  settings: Record<string, unknown>;
  outcome: AttributionOutcome;
} {
  if (hasOwn(settings, "attribution")) {
    return {
      settings,
      outcome: isIgrisObject(settings.attribution) ? "present" : "kept-user",
    };
  }
  if (hasOwn(settings, "includeCoAuthoredBy")) {
    return { settings, outcome: "kept-user" };
  }
  return {
    settings: { ...settings, attribution: { ...IGRIS_ATTRIBUTION } },
    outcome: "added",
  };
}

/** The `init`/`update` disclosure for an `added` outcome (TD-470 D4). */
export function attributionAddedNote(path: string): string {
  return (
    `Claude Code commit/PR attribution set off -> ${path}. ` +
    `A project's own .claude/settings.json "attribution" still wins; ` +
    `set your own "attribution" there or here to keep a byline.`
  );
}
