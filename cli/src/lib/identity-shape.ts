/**
 * Harness self-name map — the CLAUDE.md render dependency.
 *
 * FR-202 M4 retired the `os_identity` projection surface (the §18.1 shaper that
 * region-merged an identity block into GEMINI.md / AGENTS.md is gone, along with
 * its bash twin `normalize_identity_shape`, the golden fixtures, and the bats
 * suite). This file is reduced to the ONE thing that survives the teardown:
 * `HARNESS_SELF_NAMES`, still consumed by `claude-md.ts` to render the
 * `{{IGRIS_IDENTITY}}` include in `CLAUDE.md.tmpl`.
 *
 * The CLAUDE.md identity-denial sweep (dropping the `{{IGRIS_IDENTITY}}` include
 * + the `## Identity` block) is the FR-187 cutover's job, not M4's — so this map
 * and the `core/templates/identity.tmpl` it feeds remain until that cutover.
 */

/** Harnesses that can render the CLAUDE.md identity self-name (Model A reword). */
export type IdentityHarness = "claude" | "codex" | "gemini" | "opencode";

/**
 * The Model-A self-name reword map. Substituted for `{{HARNESS_SELF_NAME}}` in
 * the CLAUDE.md identity block so the negation line names the harness itself
 * ("Not Gemini CLI using Igris AI."). For Claude-rendered CLAUDE.md the value is
 * "Claude".
 */
export const HARNESS_SELF_NAMES: Record<IdentityHarness, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};
