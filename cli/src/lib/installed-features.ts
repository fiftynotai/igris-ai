/**
 * Read/write/migrate `~/.igris/projects/<slug>/installed_features.json`.
 *
 * Schema (v2 — current; M2 added brain_channel + brain_ref):
 *   {
 *     "schema_version": 2,
 *     "cli_version":    "<x.y.z>",
 *     "brain_channel":  "release" | "main" | "tag" | null,
 *     "brain_ref":      "<tag>" | "main" | null,
 *     "hooks_version":  "<sha256 of canonical-settings.json>" | null,
 *     "agents_version": "<sha256 of brain agents/manifest.yaml>" | null,
 *     "skills_version": "<sha256 of recursive sort+hash of brain skills/>" | null,
 *     "rules_version":  "<sha256 of brain rules/00-igris-universal.md>" | null,
 *     "installed_at":   "<ISO-8601>",
 *     "updated_at":     "<ISO-8601>"
 *   }
 *
 * Migration is forward-only: readers MUST migrate older versions on load,
 * writers MUST emit the current schema_version. v0 (no schema_version field)
 * and v1 (no brain_channel/brain_ref fields) are handled by `migrateForwardOnly`.
 *
 * Hash determinism note: `skills_version` walks the runtime skills/ dir
 * recursively, sorts paths lexicographically, and hashes
 * `<relative-path>:<file-sha256>` for each file. Same skills dir → same hash.
 */

import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  agentsManifestPath,
  installedFeaturesPath,
  rulesFilePath,
  skillsDirPath,
} from "./paths.js";
import { readCanonicalHooksRaw } from "./canonical-hooks.js";
import type { InstalledFeatures } from "../types.js";

const CURRENT_SCHEMA_VERSION = 2;

/**
 * Read installed_features.json for the given slug, migrating if needed.
 * Returns null when the file is absent.
 */
export function readInstalledFeatures(slug: string): InstalledFeatures | null {
  const path = installedFeaturesPath(slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<InstalledFeatures>;
  return migrateForwardOnly(parsed);
}

/** Atomic write of installed_features.json for the given slug. */
export function writeInstalledFeatures(
  slug: string,
  features: InstalledFeatures,
): void {
  const path = installedFeaturesPath(slug);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(features, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Forward-only migration. v0 (no schema_version field) → v1 → v2 (current).
 * Subsequent migrations append new branches here; existing branches MUST
 * NOT mutate fields they don't own (the §13 rule applied to schema fields).
 *
 * v1 → v2 (M2): adds brain_channel + brain_ref. Existing v1 rows default
 * both to null; doctor's `channel-mismatch` drift class (M5) backfills.
 */
export function migrateForwardOnly(
  raw: Partial<InstalledFeatures>,
): InstalledFeatures {
  const v = (raw.schema_version as number | undefined) ?? 0;
  let cur: Partial<InstalledFeatures> = { ...raw };

  if (v < 1) {
    cur = {
      schema_version: 1,
      cli_version: cur.cli_version ?? "7.0.0",
      hooks_version: cur.hooks_version ?? null,
      agents_version: cur.agents_version ?? null,
      skills_version: cur.skills_version ?? null,
      rules_version: cur.rules_version ?? null,
      installed_at: cur.installed_at ?? new Date().toISOString(),
      updated_at: cur.updated_at ?? new Date().toISOString(),
    };
  }

  if (v < 2) {
    // v1 row → v2 row. Add brain_channel + brain_ref, default to null.
    // Existing fields preserved verbatim.
    cur = {
      ...cur,
      schema_version: 2,
      brain_channel: cur.brain_channel ?? null,
      brain_ref: cur.brain_ref ?? null,
    };
  }

  // Future migrations:
  // if (v < 3) { ... }

  return cur as InstalledFeatures;
}

/**
 * Compute current canonical content hashes. When the brain runtime is missing
 * any of the underlying files, the corresponding hash is null (the writer
 * stores null; updater treats null vs hash as "stale, re-install").
 */
export function computeFeatureHashes(opts: {
  includeHooks: boolean;
}): {
  hooks_version: string | null;
  agents_version: string | null;
  skills_version: string | null;
  rules_version: string | null;
} {
  const hooks_version = opts.includeHooks ? hashCanonicalHooks() : null;
  const agents_version = hashIfExists(agentsManifestPath());
  const skills_version = hashSkillsDir();
  const rules_version = hashIfExists(rulesFilePath());
  return { hooks_version, agents_version, skills_version, rules_version };
}

function hashCanonicalHooks(): string | null {
  const raw = readCanonicalHooksRaw();
  if (raw === null) return null;
  return sha256(raw);
}

function hashIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

function hashSkillsDir(): string | null {
  const dir = skillsDirPath();
  if (!existsSync(dir)) return null;
  const files = walkFilesSorted(dir);
  if (files.length === 0) return null;
  const hasher = createHash("sha256");
  for (const abs of files) {
    const rel = relative(dir, abs);
    hasher.update(rel);
    hasher.update(":");
    hasher.update(sha256(readFileSync(abs)));
    hasher.update("\n");
  }
  return hasher.digest("hex");
}

function walkFilesSorted(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

function sha256(data: string | Buffer): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

export const __testing__ = { CURRENT_SCHEMA_VERSION };
