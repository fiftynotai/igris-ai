/**
 * FR-181: install Igris's brief-first hooks into Antigravity's hook config
 * (`~/.gemini/config/hooks.json`, gemini-cli hook format).
 *
 * Antigravity has no `surfaces.hooks[]` core block (parallel to Claude's
 * `canonical-settings.json` install-merge, NOT a compile surface). `igris
 * install` config-MERGES two groups into the antigravity hooks.json:
 *   PreToolUse  → core/hooks/bridges/antigravity/pre_tool_use.sh  (the brief gate)
 *   PostToolUse → core/hooks/bridges/antigravity/post_tool_use.sh (lint fan-out)
 * each `{ matcher:"*", hooks:[{type:"command", command:"$HOME/.igris/core/hooks/
 * bridges/antigravity/<event>.sh"}] }`. The matcher is `*` (fire on all tools);
 * the BRIDGE + the shared gate's is_exempt/file_path logic do the gating (the
 * proven path — antigravity's matcher semantics are unproven; FR-181 plan R4).
 *
 * `installAntigravityHooks()` is idempotent and NEVER throws — it folds every
 * failure into `{ outcome: "failed", error }` the caller warn-and-continues on
 * (mirrors `registerBrainAcrossHarnesses` / `linkAntigravitySkills`). It
 * PRESERVES any pre-existing hooks (other events + other groups) byte-for-byte
 * (the `pencil` MCP-merge precedent). Malformed existing file → `failed`, NEVER
 * clobbered (mirror `mcp-register.ts` ethic #1). The shared `~/.gemini/config/`
 * dir is benign-created (exactly like `runProjectMcp` does for the MCP file).
 *
 * Atomicity: temp-write + `renameSync` (rename(2), atomic on the same fs).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { antigravityHooksConfigPath } from "./paths.js";
import { buildClaudeHookGroup } from "./hook-shape.js";
import {
  mergeHookIntoSettings,
  HookMergeShapeError,
} from "./hook-merge.js";

/**
 * The two events Igris wires into antigravity (only PreToolUse/PostToolUse fire
 * headless — proven; session lifecycle rides /awaken + /rest, not a hook). Each
 * maps to its bridge entry script under `core/hooks/bridges/antigravity/`. The
 * `$HOME/.igris` literal matches the canonical-settings.json convention (the
 * harness expands it / Igris resolves it); antigravity runs the path directly.
 */
const ANTIGRAVITY_HOOK_EVENTS: Array<{ event: string; command: string }> = [
  {
    event: "PreToolUse",
    command: "$HOME/.igris/core/hooks/bridges/antigravity/pre_tool_use.sh",
  },
  {
    event: "PostToolUse",
    command: "$HOME/.igris/core/hooks/bridges/antigravity/post_tool_use.sh",
  },
];

/**
 * Outcome of an `installAntigravityHooks()` run.
 *  - "registered" : at least one group was newly written.
 *  - "unchanged"  : both groups already present (idempotent no-op, no write).
 *  - "failed"     : malformed existing file / unexpected shape / write error;
 *                   `error` carries an actionable message (never the file CONTENT).
 */
export interface AntigravityHooksResult {
  outcome: "registered" | "unchanged" | "failed";
  /** The hooks.json path operated on (`~/.gemini/config/hooks.json`). */
  path: string;
  error?: string;
}

/**
 * Config-merge the PreToolUse + PostToolUse Igris hook groups into antigravity's
 * `~/.gemini/config/hooks.json`. Idempotent (re-running with both groups present
 * → "unchanged", no write), preserve-existing (other events/groups untouched),
 * malformed-never-clobber, NEVER throws.
 *
 * Test seam: `opts.configPath` overrides the real-HOME path so tests drive a
 * sandbox file without touching the dev machine's real hooks.json.
 */
export function installAntigravityHooks(opts?: {
  configPath?: string;
}): AntigravityHooksResult {
  const path = opts?.configPath ?? antigravityHooksConfigPath();

  try {
    // Benign-create the shared ~/.gemini/config/ dir (exactly like runProjectMcp
    // does for the MCP file). Idempotent; failure folds to `failed` below.
    mkdirSync(dirname(path), { recursive: true });

    // Read existing hooks.json. A malformed file is NEVER clobbered — return
    // `failed` with an actionable message (mcp-register ethic #1).
    let existing: Record<string, unknown> | undefined;
    if (existsSync(path)) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf-8");
      } catch (err) {
        return {
          outcome: "failed",
          path,
          error: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {
          outcome: "failed",
          path,
          error: `refusing to clobber malformed JSON at ${path} — fix or remove it, then re-run`,
        };
      }
    }

    // Merge BOTH groups, tracking whether anything actually changed. The merge
    // replaces-in-place on a matching command path (idempotent), so the
    // serialized before/after diff is the change signal.
    let acc: Record<string, unknown> = existing ?? {};
    const before = JSON.stringify(acc);
    for (const { event, command } of ANTIGRAVITY_HOOK_EVENTS) {
      // matcher "*" — fire on all tools; the bridge + shared gate do the gating.
      const group = buildClaudeHookGroup(event, { command, matcher: "*" });
      try {
        acc = mergeHookIntoSettings(acc, event, group);
      } catch (err) {
        if (err instanceof HookMergeShapeError) {
          return {
            outcome: "failed",
            path,
            error: `refusing to clobber unexpected hooks.json shape at ${path}: ${err.message}`,
          };
        }
        throw err;
      }
    }
    const after = JSON.stringify(acc);

    if (after === before && existing !== undefined) {
      // Both groups already present (idempotent) — no write.
      return { outcome: "unchanged", path };
    }

    // Atomic temp-write + rename(2).
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(acc, null, 2)}\n`);
    renameSync(tmp, path);
    return { outcome: "registered", path };
  } catch (err) {
    return {
      outcome: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
