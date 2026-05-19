#!/usr/bin/env node
/**
 * postinstall.mjs — BR-068.
 *
 * Runs after `npm install -g igris-ai`. The published package ships the
 * bundled brain MCP at `dist/brain-mcp-server/` with its package.json +
 * package-lock.json but NO node_modules — native addons (better-sqlite3,
 * sqlite-vec) must be built for the END USER's OS/arch, not the publish
 * machine's. This script runs a production-only install inside that
 * bundle so the `igris-brain` MCP can spawn.
 *
 * ROBUSTNESS CONTRACT:
 *  - MUST NOT hard-fail the parent `npm install -g igris-ai`. A broken
 *    brain should degrade gracefully, not block the whole CLI install.
 *    On ANY inner-install error we print an actionable WARNING and
 *    exit 0.
 *  - Skips cleanly (exit 0, no noise) when `dist/brain-mcp-server/` is
 *    absent — e.g. a source checkout that was never built/packed.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This script lives at cli/scripts/postinstall.mjs; the bundle is a
// sibling of scripts/ under cli/ at dist/brain-mcp-server/.
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(cliRoot, "dist", "brain-mcp-server");

const RECOVERY_CMD = `npm install --omit=dev --prefix "${bundleDir}"`;

/** Print a clearly-delimited, actionable WARNING. Never throws. */
function warn(reason) {
  process.stdout.write(
    [
      "",
      "  ============================================================",
      "  WARNING: igris-brain MCP dependency install did not complete.",
      "  ============================================================",
      `  Reason: ${reason}`,
      "",
      "  The Igris CLI installed fine, but the bundled brain MCP server",
      "  (igris-brain — persistent memory + 124 tools) needs its native",
      "  dependencies built for your machine before it can spawn.",
      "",
      "  Recover manually by running:",
      "",
      `    cd "${bundleDir}"`,
      "    npm install --omit=dev",
      "",
      "  (one-line equivalent:)",
      `    ${RECOVERY_CMD}`,
      "",
      "  If npm is configured with ignore-scripts, the brain's native",
      "  modules cannot build — re-run the command above with",
      "  scripts enabled, or run: npm config set ignore-scripts false",
      "  ============================================================",
      "",
    ].join("\n"),
  );
}

function main() {
  // Skip cleanly when there is no bundle (unbuilt source checkout).
  if (!existsSync(bundleDir)) {
    return;
  }
  if (!existsSync(join(bundleDir, "package.json"))) {
    return;
  }

  // Prefer `npm ci` when a lockfile shipped (reproducible, tested
  // versions — copy-templates.sh regenerates the lockfile to match the
  // pruned bundle manifest at build time); fall back to `npm install`
  // otherwise. `--omit=optional` is deliberately NOT passed: it would
  // strip sqlite-vec's required nested platform binaries.
  const hasLock = existsSync(join(bundleDir, "package-lock.json"));
  const args = hasLock
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund"];

  process.stdout.write(
    "igris-ai: installing igris-brain MCP dependencies...\n",
  );

  let result;
  try {
    result = spawnSync("npm", args, {
      cwd: bundleDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch (err) {
    warn(`failed to launch npm — ${err && err.message ? err.message : err}`);
    return;
  }

  if (result.error) {
    warn(
      `failed to launch npm — ${result.error.message || result.error}`,
    );
    return;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    warn(`npm exited with status ${result.status}`);
    return;
  }
  if (result.signal) {
    warn(`npm was terminated by signal ${result.signal}`);
    return;
  }

  // Sanity-check a representative runtime dep landed.
  if (
    !existsSync(
      join(bundleDir, "node_modules", "@modelcontextprotocol", "sdk"),
    )
  ) {
    warn("install completed but @modelcontextprotocol/sdk is still missing");
    return;
  }

  process.stdout.write("igris-ai: igris-brain MCP dependencies ready.\n");
}

// The robustness contract is absolute: this hook MUST exit 0 regardless
// of what happens inside, so an unexpected throw cannot abort the parent
// `npm install -g igris-ai`.
try {
  main();
} catch (err) {
  warn(`unexpected error — ${err && err.message ? err.message : err}`);
}
process.exit(0);
