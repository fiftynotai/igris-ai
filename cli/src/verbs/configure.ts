/**
 * `igris configure [--persona <name>] [--skip-remote] [--dry-run] [-y/--yes]`
 *
 * FR-122: the opt-in onboarding verb — the re-runnable counterpart to the
 * FR-191 zero-config / all-OFF install. It dials an EXISTING install: pick a
 * persona, set identity, enable/disable the VPS by address presence, and toggle
 * perception/subconscious via the nested `cognition.*` keys.
 *
 * Sequence:
 *   1. Require config.json (configure dials an existing install — `igris init`
 *      owns config.json creation).
 *   2. gatherConfigureInputs — seed from live state; `--yes`/non-TTY keeps the
 *      current values (a no-op on values).
 *   3. --dry-run: enumerate the would-be writes via DryRunCollector, exit 0.
 *   4. Apply: persona → remote_brain → perception toggle → subconscious toggle
 *      → USER.md. Each step logs its outcome.
 *   5. Final summary.
 *
 * Never writes a top-level `perception`/`subconscious` block (FR-191 door
 * contract — `setCognitionEnabled` writes the nested key only). Every config
 * write is atomic + chmod 600 (TD-220 — api_key is a secret).
 *
 * Returns process exit code (0 = success, non-zero = failure).
 */

import { existsSync, writeFileSync } from "node:fs";
import { DryRunCollector } from "../lib/dry-run.js";
import {
  setCognitionEnabled,
  setRemoteBrain,
} from "../lib/init-config.js";
import { applyPersona } from "../lib/persona.js";
import { configJsonPath, soulMdPath, userMdPath } from "../lib/paths.js";
import { gatherConfigureInputs, type PromptFn } from "../lib/init/prompts.js";
import { writeUserMdPrefs } from "../lib/user-md.js";
import { renderUserTemplate } from "./init.js";
import { info, warn, error as logError } from "../lib/log.js";

export interface ConfigureOptions {
  /** Pre-select a persona (skips the persona prompt). */
  persona?: string;
  /** Skip the VPS prompt; leave remote_brain unchanged. */
  skipRemote?: boolean;
  /** Print the plan only, no writes. */
  dryRun?: boolean;
  /** Accept current values; skip prompts (a no-op on values). */
  yes?: boolean;
  /**
   * Repo root for the persona canonical-write checkout detection. Absent = cwd:
   * `igris configure` is a cwd-relative verb (the operator runs it standing in
   * the checkout they mean), so cwd is the correct production target — TD-406
   * only requires that the site STATE it rather than inherit it silently.
   */
  projectRoot?: string;
  /** Test seam: inject a fake prompt function. Production callers omit this. */
  prompt?: PromptFn;
  /** Test seam: override TTY detection. Production callers omit this. */
  isTTY?: boolean;
}

export async function runConfigure(opts: ConfigureOptions): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  // --- 1. Require an existing install ----------------------------------
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) {
    logError(
      `No Igris install found (${cfgPath} is absent). Run \`igris init\` first.`,
    );
    return 1;
  }

  // --- 2. Gather (seeded from live state) ------------------------------
  const inputs = await gatherConfigureInputs({
    yes: opts.yes === true,
    skipRemote: opts.skipRemote === true,
    persona: opts.persona,
    prompt: opts.prompt,
    isTTY: opts.isTTY,
  });

  // --- 3. Dry-run: enumerate the would-be writes -----------------------
  if (dry !== null) {
    dry.wouldWriteFile(
      soulMdPath(),
      `apply persona '${inputs.persona}'`,
    );
    dry.wouldWriteFile(
      cfgPath,
      inputs.remoteBrain === null
        ? "clear remote_brain (VPS disabled)"
        : `set remote_brain (VPS ${inputs.remoteBrain.url})`,
    );
    dry.wouldWriteFile(
      cfgPath,
      `set cognition.perception.enabled=${inputs.perceptionEnabled}`,
    );
    dry.wouldWriteFile(
      cfgPath,
      `set cognition.subconscious.enabled=${inputs.subconsciousEnabled}`,
    );
    dry.wouldWriteFile(userMdPath(), "write USER.md identity");
    dry.wouldWriteFile(
      userMdPath(),
      `write USER.md prefs (addressing='${inputs.prefs.addressing}', ` +
        `notification='${inputs.prefs.notificationStyle}', ` +
        `auto-approve='${inputs.prefs.autoApprove}')`,
    );
    dry.print();
    return 0;
  }

  // --- 4. Apply --------------------------------------------------------
  // 4a. Persona.
  const personaResult = applyPersona(
    inputs.persona,
    opts.projectRoot ?? process.cwd(),
  );
  if (personaResult.outcome === "template_missing") {
    logError(
      `Persona template not found for '${inputs.persona}'. ` +
        `Run \`igris configure\` interactively to see available presets, ` +
        `or pick one of the shipped SOUL.<name>.md templates.`,
    );
    return 1;
  }
  if (personaResult.outcome === "invalid_template") {
    logError(
      `Persona template '${inputs.persona}' is missing required frontmatter ` +
        `(layer/tier/scope/summary) — refusing to install it (it would break ` +
        `the OS index generator). SOUL.md left unchanged.`,
    );
    return 1;
  }
  if (personaResult.canonicalRefusal !== null) {
    warn(
      `Persona: canonical core/SOUL.md NOT written ` +
        `(${personaResult.canonicalRefusal}) — the runtime copy WAS written, so core/SOUL.md and its ~/.igris mirror now differ (TD-096). See IGRIS_REPO_DIR (TD-406).`,
    );
  }
  info(`Persona: ${inputs.persona} (${personaResult.outcome})`);

  // 4b. Remote brain (VPS-by-address).
  const rbResult = setRemoteBrain(inputs.remoteBrain);
  if (rbResult === "refused-insecure") {
    // setRemoteBrain already warned; surface it but do not abort the rest.
    warn("remote_brain left unchanged (insecure http refused).");
  } else if (rbResult === "cleared") {
    info("Remote brain: disabled (no VPS).");
  } else if (rbResult === "written") {
    info(`Remote brain: enabled (${inputs.remoteBrain?.url}).`);
  }

  // 4c. Cognition toggles (nested keys only — FR-191 door contract).
  setCognitionEnabled("perception", inputs.perceptionEnabled);
  info(`Perception: ${inputs.perceptionEnabled ? "ON" : "OFF"}`);
  setCognitionEnabled("subconscious", inputs.subconsciousEnabled);
  info(`Subconscious: ${inputs.subconsciousEnabled ? "ON" : "OFF"}`);

  // 4d. USER.md identity (same template path as init).
  writeFileSync(
    userMdPath(),
    renderUserTemplate({
      userName: inputs.userName,
      userEmail: inputs.userEmail,
    }),
  );
  info(`Identity: ${inputs.userName}${inputs.userEmail ? ` <${inputs.userEmail}>` : ""}`);

  // 4e. USER.md operator prefs (FR-235). Parse + rewrite the three managed
  // field lines IN PLACE, preserving the rest of the file. Runs AFTER the
  // identity write so the prefs land on the freshly-rendered USER.md.
  writeUserMdPrefs(inputs.prefs);
  info(
    `Prefs: addressing='${inputs.prefs.addressing}', ` +
      `notification='${inputs.prefs.notificationStyle}', ` +
      `auto-approve='${inputs.prefs.autoApprove}'`,
  );

  // --- 5. Summary ------------------------------------------------------
  info("");
  info("Igris configure complete.");
  info(`  persona:      ${inputs.persona}`);
  info(`  remote brain: ${inputs.remoteBrain === null ? "off" : inputs.remoteBrain.url}`);
  info(`  perception:   ${inputs.perceptionEnabled ? "on" : "off"}`);
  info(`  subconscious: ${inputs.subconsciousEnabled ? "on" : "off"}`);
  info(`  addressing:   ${inputs.prefs.addressing}`);
  info(`  notification: ${inputs.prefs.notificationStyle}`);
  info(`  auto-approve: ${inputs.prefs.autoApprove}`);

  return 0;
}
