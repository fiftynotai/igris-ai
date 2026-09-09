/**
 * persona.ts — SOUL persona applier (FR-122).
 *
 * The opt-in onboarding counterpart to FR-191's all-OFF install: the operator
 * picks a persona preset and `applyPersona` copies the chosen
 * `SOUL.<name>.md` template over the runtime `~/.igris/core/SOUL.md` (the
 * consumer-facing copy `gen_os_index.sh` parses into the OS module index).
 *
 * Hard constraint (the OS-index gate): the runtime SOUL.md MUST always carry
 * the `layer / tier / scope / summary` frontmatter or `gen_os_index.sh`
 * hard-fails. `applyPersona` therefore ASSERTS the template has that
 * frontmatter BEFORE writing — it refuses to install a frontmatter-less
 * SOUL.md rather than break the generator at the next boot/regen.
 *
 * In a repo checkout (the igris-ai source tree, detected by the presence of
 * `core/SOUL.md` under the resolved repo root) the canonical `core/SOUL.md` is
 * also written so a contributor's working tree matches the runtime. At a
 * consumer install there is no checkout, so only the runtime copy is touched.
 *
 * TD-406: that canonical write is CONTAINED by `canonical-root.ts` — under a
 * test context it is refused unless `IGRIS_REPO_DIR` declares the subtree it may
 * land in, the way `IGRIS_BRAIN_DIR` already contains the runtime write.
 *
 * Nothing here reads or logs a secret; SOUL.md is non-secret persona text.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  resolveCanonicalRoot,
  type CanonicalRootRefusal,
} from "./canonical-root.js";
import { brainDir, soulMdPath, soulTemplatePath } from "./paths.js";

/** The frontmatter keys `gen_os_index.sh` requires on a SOUL persona file. */
const REQUIRED_FRONTMATTER_KEYS = [
  "layer",
  "tier",
  "scope",
  "summary",
] as const;

/** Outcome of {@link applyPersona}. */
export type ApplyPersonaOutcome =
  | "applied"          // template copied over the runtime SOUL.md
  | "unchanged"        // the runtime SOUL.md already matched the template byte-for-byte
  | "template_missing" // no SOUL.<name>.md template found
  | "invalid_template"; // template present but missing required frontmatter

export interface ApplyPersonaResult {
  outcome: ApplyPersonaOutcome;
  /** The persona name that was requested. */
  name: string;
  /** The runtime SOUL.md path written (when applied). */
  soulPath: string;
  /** The canonical core/SOUL.md path written when in a checkout, else null. */
  canonicalPath: string | null;
  /**
   * TD-406: why the canonical write was refused by the containment seam, or
   * null when it was not refused. Disambiguates a null `canonicalPath`, which
   * otherwise reads identically for "not a checkout" and "refused".
   */
  canonicalRefusal: CanonicalRootRefusal | null;
}

/**
 * Enumerate the available persona names by globbing `SOUL.<name>.md` templates
 * under the runtime core dir (`~/.igris/core/`). Returns the bare names
 * (`["character", "professional", …]`), sorted, with the bare `SOUL.md`
 * (the active persona, not a template) excluded.
 */
export function listPersonas(): string[] {
  const coreDir = join(brainDir(), "core");
  if (!existsSync(coreDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(coreDir)) {
    // Match SOUL.<name>.md but NOT the bare SOUL.md (the active persona).
    const m = /^SOUL\.([^.]+)\.md$/.exec(entry);
    if (m !== null) names.push(m[1]);
  }
  return names.sort();
}

/**
 * Parse the leading `---`-fenced frontmatter scalars from a file's contents.
 * Mirrors the hand-rolled parser in `gen_os_index.sh` (simple `key: value`
 * scalars between the first two `---` fences) so the assertion uses the SAME
 * notion of "has frontmatter" the generator enforces.
 */
function parseFrontmatterKeys(contents: string): Set<string> {
  const lines = contents.split(/\r?\n/);
  const keys = new Set<string>();
  if (lines.length === 0 || lines[0].trim() !== "---") return keys;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key !== "" && value !== "") keys.add(key);
  }
  return keys;
}

/** True when `contents` carries every required SOUL frontmatter key. */
export function hasRequiredFrontmatter(contents: string): boolean {
  const keys = parseFrontmatterKeys(contents);
  return REQUIRED_FRONTMATTER_KEYS.every((k) => keys.has(k));
}

/**
 * Detect a repo checkout: a `core/SOUL.md` exists under `repoRoot`. Mirrors the
 * `add` verb's core auto-detect (the igris-ai source tree carries `core/`).
 *
 * TD-406: containment is checked FIRST, so a refused target is never even
 * stat'ed as a candidate.
 */
function canonicalSoulPathFor(repoRoot: string): {
  path: string | null;
  refusal: CanonicalRootRefusal | null;
} {
  const decision = resolveCanonicalRoot(repoRoot);
  if (!decision.allowed) return { path: null, refusal: decision.reason };
  const canonical = join(decision.root, "core", "SOUL.md");
  return { path: existsSync(canonical) ? canonical : null, refusal: null };
}

/** Atomically write `contents` to `dest` (tmp file → rename). */
function writeAtomic(dest: string, contents: string): void {
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, dest);
}

/**
 * Apply a persona preset: copy `SOUL.<name>.md` over the runtime
 * `~/.igris/core/SOUL.md` (byte-for-byte), and over the canonical
 * `core/SOUL.md` when run inside a checkout.
 *
 * Refuses (returns `invalid_template`, writes nothing) when the template lacks
 * the required frontmatter — installing it would break `gen_os_index.sh`.
 *
 * @param name      Persona name (`professional` | `character` | any shipped preset).
 * @param repoRoot  Repo root for the canonical-write checkout detection.
 *                  REQUIRED (TD-406): a function that overwrites a tracked repo
 *                  file must not infer its target from ambient process state, so
 *                  a caller that wants cwd has to say so. The runtime copy is
 *                  always under brainDir().
 */
export function applyPersona(
  name: string,
  repoRoot: string,
): ApplyPersonaResult {
  const soulPath = soulMdPath();
  const templatePath = soulTemplatePath(name);

  if (!existsSync(templatePath)) {
    return {
      outcome: "template_missing",
      name,
      soulPath,
      canonicalPath: null,
      canonicalRefusal: null,
    };
  }

  const templateContents = readFileSync(templatePath, "utf-8");

  // Assert the frontmatter BEFORE writing — a frontmatter-less SOUL.md would
  // hard-fail the OS-index generator at the next boot/regen.
  if (!hasRequiredFrontmatter(templateContents)) {
    return {
      outcome: "invalid_template",
      name,
      soulPath,
      canonicalPath: null,
      canonicalRefusal: null,
    };
  }

  const { path: canonicalPath, refusal: canonicalRefusal } =
    canonicalSoulPathFor(repoRoot);

  // Idempotence: if the runtime SOUL.md already matches the template AND (when
  // in a checkout) the canonical does too, this is a no-op.
  const runtimeMatches =
    existsSync(soulPath) &&
    readFileSync(soulPath, "utf-8") === templateContents;
  const canonicalMatches =
    canonicalPath === null ||
    (existsSync(canonicalPath) &&
      readFileSync(canonicalPath, "utf-8") === templateContents);
  if (runtimeMatches && canonicalMatches) {
    return {
      outcome: "unchanged",
      name,
      soulPath,
      canonicalPath,
      canonicalRefusal,
    };
  }

  writeAtomic(soulPath, templateContents);
  if (canonicalPath !== null) {
    writeAtomic(canonicalPath, templateContents);
  }

  return {
    outcome: "applied",
    name,
    soulPath,
    canonicalPath,
    canonicalRefusal,
  };
}

/**
 * Infer which persona the runtime SOUL.md currently matches, by comparing it
 * byte-for-byte against each shipped template. Returns the matching persona
 * name, or `null` when the SOUL.md is a custom/edited copy that matches no
 * template. On `null`, `readConfigureSeed` falls back to the first template
 * (or "character") for the persona prompt's default.
 */
export function inferActivePersona(): string | null {
  const soulPath = soulMdPath();
  if (!existsSync(soulPath)) return null;
  const current = readFileSync(soulPath, "utf-8");
  for (const name of listPersonas()) {
    const tplPath = soulTemplatePath(name);
    if (!existsSync(tplPath)) continue;
    if (readFileSync(tplPath, "utf-8") === current) return name;
  }
  return null;
}
