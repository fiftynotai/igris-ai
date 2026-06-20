/**
 * TD-233 (GAP-3 remediation): the PURE canonical→per-harness orchestrator-
 * identity shaper.
 *
 * This is the ONE place the TypeScript per-harness identity-region shape is
 * defined. It is the §18.1 parity twin of the bash `normalize_identity_shape`
 * (`core/scripts/cli-adapters/_common.sh`) — the golden-fixture parity test
 * (`identity-shape.test.ts` + the bats `#parity` test in
 * `test/harness_identity.test.bash`) pins the two byte-for-byte so they cannot
 * silently diverge (L-554 hash-stable-parity).
 *
 * The identity surface projects the canonical identity block
 * (`core/templates/identity.tmpl`) into each harness's natively auto-read
 * project-root context file (gemini → `GEMINI.md`, codex → `AGENTS.md`;
 * empirically confirmed 2026-06-10), wrapped in an Igris-managed delimited
 * region so pre-existing user content in those files is preserved (the
 * merge-into-region clobber posture locked by the TD-233 plan).
 *
 * Model A ONLY ("the agent IS Igris AI"): the `{{HARNESS_SELF_NAME}}` token
 * rewords the negation line per harness ("Not Gemini CLI using Igris AI." /
 * "Not Codex using Igris AI.") — a non-Claude output never says "Claude".
 * Model B ("I am <model> running Igris OS") is parked; do NOT add it here.
 *
 * It is PURE: it renders strings. It does NOT read config.json, does NOT
 * resolve paths, and does NOT write files — the compile-side merge is bash-only
 * (`merge_identity_region`), per the locked direct-bash-write +
 * TS-parity-twin form.
 *
 * TD-244 (BI-3): the identity region ALSO carries the delegation recipe when the
 * target harness's `delegation_model` is `dynamic-define` (the boot-injection
 * surface). `buildHarnessIdentityFile` takes an optional `recipeRaw` + a
 * `delegationModel`; when `dynamic-define` it appends the recipe (one blank line
 * separator, one trailing newline) — byte-identical to the bash
 * `normalize_identity_shape` dynamic-define branch (the golden + bats parity
 * tests pin the two). `native-static` (the default) is identity-only — the
 * pre-TD-244 shape, so existing fixtures and the CLAUDE.md inline path are
 * unchanged.
 */

/** Harnesses that can carry an identity-file target (mirrors the schema enum). */
export type IdentityHarness = "claude" | "codex" | "gemini" | "opencode";

/**
 * Per-harness delegation mechanism (the TD-244 sixth-surface descriptor).
 * `native-static`: statically-loaded agents; `subagent_type:<agent>` resolves
 * directly (identity-only region). `dynamic-define`: runtime subagent definition
 * → the region carries the delegation recipe.
 */
export type DelegationModel = "native-static" | "dynamic-define";

/**
 * The Model-A self-name reword map. Substituted for `{{HARNESS_SELF_NAME}}`
 * so each harness's negation line names ITSELF ("Not Gemini CLI using Igris
 * AI."). MUST stay byte-identical to the map inside the bash
 * `normalize_identity_shape` (the parity tests pin this).
 */
export const HARNESS_SELF_NAMES: Record<IdentityHarness, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

/**
 * Region markers. Detection matches on `IDENTITY_BEGIN_PREFIX` (so an edited
 * BEGIN comment still locates the region and surfaces as DRIFTED, not as a
 * duplicate region) and on the exact `IDENTITY_END_LINE`. Keep all three
 * byte-identical to the bash helpers in `_common.sh`.
 */
export const IDENTITY_BEGIN_PREFIX = "<!-- IGRIS:OS_IDENTITY:BEGIN";
export const IDENTITY_BEGIN_LINE = `${IDENTITY_BEGIN_PREFIX} (Igris-managed identity region — edit core/templates/identity.tmpl, then run 'igris harness compile'; see TD-233) -->`;
export const IDENTITY_END_LINE = "<!-- IGRIS:OS_IDENTITY:END -->";

/**
 * Render the canonical identity template body for one harness.
 *
 * Substitutes `{{IGRIS_VERSION}}` and `{{HARNESS_SELF_NAME}}` globally and
 * normalizes the result to end with exactly one trailing newline. Any other
 * `{{...}}` token passes through verbatim (the canonical identity template
 * carries only these two).
 */
export function renderIdentityBody(
  templateRaw: string,
  harness: IdentityHarness,
  version: string,
): string {
  const selfName = HARNESS_SELF_NAMES[harness];
  if (selfName === undefined) {
    throw new Error(`renderIdentityBody: unknown harness '${harness}'`);
  }
  let body = templateRaw
    .replace(/\{\{IGRIS_VERSION\}\}/g, () => version)
    .replace(/\{\{HARNESS_SELF_NAME\}\}/g, () => selfName);
  body = body.replace(/\n+$/, "");
  return `${body}\n`;
}

/**
 * Append the delegation recipe to an identity body for a dynamic-define harness.
 *
 * The recipe template carries no `{{...}}` tokens — it is rendered verbatim,
 * normalized to exactly one trailing newline, separated from the identity body
 * by exactly one blank line. MUST stay byte-identical to the dynamic-define
 * branch of the bash `normalize_identity_shape` (the golden + bats parity tests
 * pin the two together; L-554).
 *
 * `body` is assumed to already end with exactly one `\n` (the
 * `renderIdentityBody` contract). Throws when `recipeRaw` is undefined — a
 * dynamic-define harness with no recipe is an observable error (never a silent
 * identity-only fallback that would strand the harness).
 */
export function appendDelegationRecipe(
  body: string,
  recipeRaw: string | undefined,
): string {
  if (recipeRaw === undefined) {
    throw new Error(
      "appendDelegationRecipe: delegation_model=dynamic-define requires a recipe template",
    );
  }
  const recipe = `${recipeRaw.replace(/\n+$/, "")}\n`;
  return `${body}\n${recipe}`;
}

/**
 * Build the FULL delimited identity region for one harness — BEGIN marker +
 * rendered body + END marker, trailing newline included. This is the byte
 * payload the bash compile pass writes between the markers and the bash drift
 * pass re-derives for comparison; byte-identical to
 * `normalize_identity_shape <tmpl> <harness> <version> [model] [recipe]`
 * (§18.1 / L-554).
 *
 * TD-244 (BI-3): pass `delegationModel="dynamic-define"` + the recipe template
 * raw to append the boot-injection delegation recipe inside the region. The
 * default (`native-static`, no recipe) is the pre-TD-244 identity-only shape.
 */
export function buildHarnessIdentityFile(
  templateRaw: string,
  harness: IdentityHarness,
  version: string,
  delegationModel: DelegationModel = "native-static",
  recipeRaw?: string,
): string {
  let body = renderIdentityBody(templateRaw, harness, version);
  if (delegationModel === "dynamic-define") {
    body = appendDelegationRecipe(body, recipeRaw);
  }
  return `${IDENTITY_BEGIN_LINE}\n${body}${IDENTITY_END_LINE}\n`;
}
