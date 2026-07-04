/**
 * `~/.igris/USER.md` operator preferences — structured read + in-place rewrite
 * (FR-235).
 *
 * Three operator prefs live as human-readable lines in USER.md (NOT config.json):
 *
 *   - **Default Addressing:** — how Igris addresses the user (feeds the persona
 *     greeting at Login).
 *   - **Notification Style:**  — e.g. "concise".
 *   - **Auto-approve Plans:**  — the auto-approve effort threshold, e.g.
 *     "S and M effort only (L/XL require approval)".
 *
 * `igris configure` (FR-235) makes these editable: it seeds each prompt from
 * {@link readUserMdPrefs} and persists the chosen values via
 * {@link writeUserMdPrefs}, which rewrites ONLY the matched field lines in place
 * — every other line in USER.md is preserved byte-for-byte. A field that is
 * absent is appended under a `## Preferences` section (created if missing), so a
 * fresh template-shaped USER.md gains the managed lines without clobbering the
 * rest of the file.
 *
 * The label match is tolerant of the shipped bold markup (`- **Default
 * Addressing:** X`) AND a plain `- Default Addressing: X`, and preserves the
 * matched line's prefix (bullet + bold + colon) so the rewrite keeps the file's
 * existing formatting.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userMdPath } from "./paths.js";

/** The three USER.md operator prefs configure reads + writes (FR-235). */
export interface UserMdPrefs {
  /** How Igris addresses the user (e.g. "Partner") — feeds the persona greeting. */
  addressing: string;
  /** Notification verbosity (e.g. "concise"). */
  notificationStyle: string;
  /** Auto-approve effort threshold (e.g. "S and M effort only (L/XL require approval)"). */
  autoApprove: string;
}

/** The USER.md label each pref is stored under (the exact shipped line labels). */
const FIELD_LABELS = {
  addressing: "Default Addressing",
  notificationStyle: "Notification Style",
  autoApprove: "Auto-approve Plans",
} as const;

/** Safe fallbacks when USER.md is absent or a field line is missing. */
const DEFAULT_PREFS: UserMdPrefs = {
  addressing: "Partner",
  notificationStyle: "concise",
  autoApprove: "S and M effort only (L/XL require approval)",
};

/**
 * Build a whole-line regex for a USER.md pref field. Captures the line's
 * formatting prefix (bullet + optional bold + label + colon + optional bold) as
 * group 1 and the value as group 2, so a rewrite preserves the prefix. Tolerant
 * of `- **Label:** value`, `- Label: value`, and mixed bold placements.
 */
function fieldRegex(label: string): RegExp {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(\\s*[-*]\\s*\\*{0,2}${esc}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*)(.*?)\\s*$`,
    "mi",
  );
}

/**
 * Read the three operator prefs from USER.md, falling back to the shipped
 * defaults for an absent file or any field whose line is missing/blank. Never
 * throws — an unreadable USER.md yields the defaults.
 */
export function readUserMdPrefs(): UserMdPrefs {
  const path = userMdPath();
  const prefs: UserMdPrefs = { ...DEFAULT_PREFS };
  if (!existsSync(path)) return prefs;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return prefs;
  }
  for (const key of Object.keys(FIELD_LABELS) as (keyof UserMdPrefs)[]) {
    const m = fieldRegex(FIELD_LABELS[key]).exec(raw);
    if (m && m[2].trim() !== "") prefs[key] = m[2].trim();
  }
  return prefs;
}

/**
 * Rewrite one field's value in place, preserving the matched line's prefix. When
 * the field line is absent, append it (bold shape) under a `## Preferences`
 * section — creating that section at end-of-file if it does not exist.
 */
function upsertField(text: string, label: string, value: string): string {
  const re = fieldRegex(label);
  if (re.test(text)) {
    return text.replace(re, (_full, prefix: string) => `${prefix}${value}`);
  }
  const line = `- **${label}:** ${value}`;
  if (/^##\s+Preferences\s*$/m.test(text)) {
    // Insert the line right after the Preferences heading.
    return text.replace(
      /^(##\s+Preferences\s*)$/m,
      (_full, heading: string) => `${heading}\n\n${line}`,
    );
  }
  const sep = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}## Preferences\n\n${line}\n`;
}

/**
 * Write the three operator prefs back to USER.md in place — rewriting only the
 * matched field lines (or appending absent ones under `## Preferences`) and
 * preserving every other line. Creates USER.md if it does not yet exist.
 */
export function writeUserMdPrefs(prefs: UserMdPrefs): void {
  const path = userMdPath();
  let text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  text = upsertField(text, FIELD_LABELS.addressing, prefs.addressing);
  text = upsertField(text, FIELD_LABELS.notificationStyle, prefs.notificationStyle);
  text = upsertField(text, FIELD_LABELS.autoApprove, prefs.autoApprove);
  writeFileSync(path, text);
}
