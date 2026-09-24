/**
 * TD-472 — the SECOND spelling of the extractor child-env allowlist.
 *
 * `backend/env.ts` (`CHILD_ENV_ALLOW` + `CHILD_ENV_ALLOW_PREFIXES`) is the rule;
 * this literal is the independent copy the tests hold it to (the BR-101
 * `RESEARCH_ARTIFACT` idiom). A0 in `env.test.ts` pins exact membership, so the
 * two spellings cannot drift silently. Adding a name edits BOTH and states the
 * name's class (MAINTAINING.md, the extractor child-env row).
 *
 * Shared by `env.test.ts` (A0/A1) and `backend-child-env-allowlist.test.ts`
 * (B3/S5) so the tier holds one copy, not two.
 *
 * Classes (plan D2): identity/filesystem, locale/time, network plumbing, CA,
 * platform (macOS), platform (Linux keyring — code-read only, F4).
 * `CODEX_CA_CERTIFICATE` is in because the Phase 0.2 static read found it in
 * the codex 0.135.0 binary (F9; `td472-evidence/phase0-static-codex.txt`).
 */
export const EXPECTED_ALLOW = [
  // identity / filesystem
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  // locale / time (LC_* is the anchored prefix below)
  'LANG',
  'TZ',
  // network plumbing (TD-471 E2 invariant)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // CA (TD-471 E2 invariant; F9)
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CODEX_CA_CERTIFICATE',
  // platform (macOS)
  '__CF_USER_TEXT_ENCODING',
  // platform (Linux keyring, F4)
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/** Anchored name prefixes the allowlist keeps (`LC_ALL`, `LC_CTYPE`, …). */
export const EXPECTED_ALLOW_PREFIXES = ['LC_'] as const;

/** True when `name` is allowed by the second spelling (exact name or anchored prefix). */
export function isExpectedAllowed(name: string): boolean {
  return (
    (EXPECTED_ALLOW as readonly string[]).includes(name) ||
    EXPECTED_ALLOW_PREFIXES.some((p) => name.startsWith(p))
  );
}
