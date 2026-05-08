/**
 * Shared slug grammar for the `igris install` and `igris register-project`
 * verbs. Lifted from cli/src/verbs/install.ts to enforce structurally what
 * was previously a comment-asserted invariant (TD-118).
 *
 * First char is alphanumeric; subsequent chars allow underscore, hyphen,
 * dot. Length cap at 64 chars. Tolerates uppercase (e.g. `lifeOS`) which
 * exists in the real registry today.
 *
 * NOTE: the brain-side slug grammar at `brain-mcp-server/src/index.ts`
 * is intentionally STRICTER (lowercase + hyphen only). It is a separate
 * concern (HTTP payload sanitation) and is NOT consolidated here.
 */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug '${slug}': must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ (alphanumeric start, then alphanumeric/underscore/hyphen/dot, max 64 chars).`,
    );
  }
}
