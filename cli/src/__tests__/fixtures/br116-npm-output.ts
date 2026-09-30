/**
 * BR-116 fixture — MEASURED npm output bytes (test_standards BR-109 rule: a
 * live capture, never a paraphrase). Captured 2026-09-30 with node v22.23.2 /
 * npm 10.9.8 in a scratch dir OUTSIDE the repo with HOME fenced
 * (`HOME=<scratch>/home npm_config_cache=<scratch>/home/.npm`). The ONE
 * substitution: the scratch HOME path in npm's "complete log" line is
 * replaced by `<SCRATCH_HOME>`.
 *
 * - NPM_EBADENGINE_ONLY: `package.json` with `"engines":{"node":">=99"}` +
 *   `npm install --no-audit --no-fund` → exit 0 (warnings only).
 * - NPM_EBADENGINE_THEN_ERROR: the same engines field plus a dependency the
 *   lockfile lacks, `npm ci --no-audit --no-fund` → exit 1 — the real
 *   EBADENGINE block FOLLOWED by a real `npm error` block, in one run.
 * - The incident shape (warnings only, non-zero rc) is NPM_EBADENGINE_ONLY
 *   paired with a SYNTHETIC rc (the tests name it as synthetic).
 */

/** Measured: exit 0. */
export const NPM_EBADENGINE_ONLY = "npm warn EBADENGINE Unsupported engine {\nnpm warn EBADENGINE   package: 'br116-cap-a@1.0.0',\nnpm warn EBADENGINE   required: { node: '>=99' },\nnpm warn EBADENGINE   current: { node: 'v22.23.2', npm: '10.9.8' }\nnpm warn EBADENGINE }\n\nup to date in 415ms\n";

/** Measured: exit 1. */
export const NPM_EBADENGINE_THEN_ERROR = "npm warn EBADENGINE Unsupported engine {\nnpm warn EBADENGINE   package: 'br116-cap-c@1.0.0',\nnpm warn EBADENGINE   required: { node: '>=99' },\nnpm warn EBADENGINE   current: { node: 'v22.23.2', npm: '10.9.8' }\nnpm warn EBADENGINE }\nnpm error code EUSAGE\nnpm error\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.\nnpm error\nnpm error Missing: left-pad@1.3.0 from lock file\nnpm error\nnpm error Clean install a project\nnpm error\nnpm error Usage:\nnpm error npm ci\nnpm error\nnpm error Options:\nnpm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]\nnpm error [--global-style] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]\nnpm error [--include <prod|dev|optional|peer> [--include <prod|dev|optional|peer> ...]]\nnpm error [--strict-peer-deps] [--foreground-scripts] [--ignore-scripts] [--no-audit]\nnpm error [--no-bin-links] [--no-fund] [--dry-run]\nnpm error [-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]\nnpm error [-ws|--workspaces] [--include-workspace-root] [--install-links]\nnpm error\nnpm error aliases: clean-install, ic, install-clean, isntall-clean\nnpm error\nnpm error Run \"npm help ci\" for more info\nnpm error A complete log of this run can be found in: <SCRATCH_HOME>/.npm/_logs/2026-09-30T08_36_16_073Z-debug-0.log\n";
