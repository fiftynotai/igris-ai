/**
 * `.igris_version` writer — `igris install` Phase 2 (M2).
 *
 * Replaces the python3 inline block in `scripts/igris_install.sh:531-545`.
 * Writes a JSON marker at `<projectPath>/.igris_version` recording when
 * Igris was installed and which CLI did it.
 *
 * Schema:
 *   {
 *     "igris_ai_version": "<x.y.z>",
 *     "install_mode":     "global",
 *     "brain_path":       "<absolute path to ~/.igris/>",
 *     "installed_at":     "<ISO-8601 timestamp>",
 *     "last_updated":     "<ISO-8601 timestamp>"
 *   }
 *
 * Idempotency: re-write preserves `installed_at` if the file already exists
 * (matches the shell-script behavior of overwriting both timestamps to
 * "now" — but we don't, because preserving the original install date is
 * more useful for diagnostics). Only `last_updated` bumps on subsequent
 * writes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { brainDir } from "./paths.js";

export interface IgrisVersionFile {
  igris_ai_version: string;
  install_mode: "global";
  brain_path: string;
  installed_at: string;
  last_updated: string;
}

/**
 * Write `<projectPath>/.igris_version` for the given CLI version.
 *
 * Returns the absolute path written.
 *
 * - Atomic via tmp+rename so a crash mid-write doesn't corrupt the file.
 * - Preserves `installed_at` from a prior write; bumps `last_updated`.
 */
export function writeIgrisVersion(
  projectPath: string,
  cliVersion: string,
): string {
  const target = join(projectPath, ".igris_version");
  const now = new Date().toISOString();

  let installedAt = now;
  if (existsSync(target)) {
    try {
      const raw = readFileSync(target, "utf-8");
      const prior = JSON.parse(raw) as Partial<IgrisVersionFile>;
      if (typeof prior.installed_at === "string" && prior.installed_at.length > 0) {
        installedAt = prior.installed_at;
      }
    } catch {
      // Malformed prior file — overwrite with fresh data, treat as a new install.
    }
  }

  const content: IgrisVersionFile = {
    igris_ai_version: cliVersion,
    install_mode: "global",
    brain_path: brainDir(),
    installed_at: installedAt,
    last_updated: now,
  };

  ensureParent(target);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(content, null, 2) + "\n");
  renameSync(tmp, target);
  return target;
}

function ensureParent(target: string): void {
  const parent = dirname(target);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
