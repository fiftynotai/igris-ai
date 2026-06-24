/**
 * Interactive prompts for `igris init` (TD-144).
 *
 * `igris init` previously claimed (via the `--skip-remote` help text) to
 * prompt for remote_brain config, but contained zero interactive prompts.
 * USER.md shipped with literal `{{USER_NAME}}` placeholders that were
 * replaced with `process.env.USER ?? "you"` and `""`, and config.json
 * always wrote `remote_brain: null` (or a placeholder).
 *
 * This module collects the four init inputs (name, email, remote URL,
 * remote API key) using `node:readline.createInterface`. It mirrors the
 * `doctor.ts` injectable `PromptFn` test-seam pattern so vitest can drive
 * the flow without monkey-patching `process.stdin`.
 *
 * Non-interactive paths (`--yes`, `--upgrade`, `--dry-run`, non-TTY) all
 * resolve to safe defaults so CI and `curl | bash` installers never hang.
 *
 * No new dependencies introduced (preserves the TD-120 zero-runtime-dep
 * posture: `better-sqlite3`, `commander`, `tar` only).
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { info, warn } from "../log.js";
import {
  classifySyncTransport,
  isInsecureSyncAllowed,
} from "../sync-transport.js";
import { configJsonPath, userMdPath } from "../paths.js";
import { inferActivePersona, listPersonas } from "../persona.js";

/**
 * Async prompt function — accepts a question string, resolves with the
 * user's raw answer (callers do their own trimming). Used as the test
 * seam in `gatherInitInputs` so vitest can inject a queue-backed fake
 * without battling Node's readline event timing.
 */
export type PromptFn = (question: string) => Promise<string>;

/**
 * Structured result of the prompt flow. Consumed by `renderUserTemplate`
 * (for USER.md) and `renderConfigTemplate` (for config.json.remote_brain).
 */
export interface InitInputs {
  /** "you" if user gave an empty response. */
  userName: string;
  /** "" if user gave an empty response. Allowed. */
  userEmail: string;
  /**
   * Null when the user skipped remote brain (empty URL OR `--skip-remote`
   * OR `--yes` OR non-TTY). When non-null, `apiKey` may still be null if
   * the user provided a URL but left the API key blank — they'll see a
   * warning to set it later via `~/.igris/config.json`.
   */
  remoteBrain: { url: string; apiKey: string | null } | null;
}

/**
 * Options for `gatherInitInputs`. All boolean flags default to false at
 * the call site (init.ts maps `opts.yes === true` etc.). The `prompt` and
 * `isTTY` fields are test seams — production callers omit both.
 */
export interface GatherOpts {
  yes: boolean;
  skipRemote: boolean;
  upgrade: boolean;
  dryRun: boolean;
  /** Test seam: inject a fake prompt to bypass readline. */
  prompt?: PromptFn;
  /** Test seam: override TTY detection. Defaults to `process.stdin.isTTY === true`. */
  isTTY?: boolean;
}

const DEFAULTS: InitInputs = {
  userName: "you",
  userEmail: "",
  remoteBrain: null,
};

/**
 * Collect identity + remote_brain inputs for `igris init`.
 *
 * Decision matrix (per TD-144 plan §6):
 *
 * | Flags                  | Prompts? | remote_brain    |
 * |------------------------|----------|-----------------|
 * | (none, TTY)            | All 4    | from prompts    |
 * | --yes                  | None     | null            |
 * | --skip-remote          | 1+2 only | null            |
 * | --upgrade              | None     | null (preserved on caller side) |
 * | --dry-run              | None     | null            |
 * | Non-TTY (any)          | None     | null            |
 *
 * The auto-skip on non-TTY is critical for `curl | bash` installers and
 * CI runs — `process.stdin.isTTY` is `undefined` (falsy) when stdin is a
 * pipe, so we short-circuit to defaults rather than block forever on a
 * readline that will never get input.
 */
export async function gatherInitInputs(opts: GatherOpts): Promise<InitInputs> {
  // Non-interactive paths: defaults only, no prompts.
  if (opts.upgrade || opts.dryRun || opts.yes) {
    return DEFAULTS;
  }
  const tty = opts.isTTY ?? process.stdin.isTTY === true;
  if (!tty) {
    info(
      "Non-interactive shell detected; using defaults. " +
        "Edit ~/.igris/USER.md and ~/.igris/config.json to customize.",
    );
    return DEFAULTS;
  }

  // Build a readline-backed prompt unless a test injected one.
  let rl: ReturnType<typeof createInterface> | null = null;
  const ask: PromptFn =
    opts.prompt ??
    ((q: string): Promise<string> => {
      if (rl === null) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }
      return new Promise((res) => rl!.question(q, (a) => res(a)));
    });

  try {
    info("");
    info("Configuring your install. Press Enter for defaults.");

    const { userName, userEmail } = await askIdentity(ask, {
      nameDefault: "you",
      emailDefault: "",
    });

    if (opts.skipRemote) {
      return { userName, userEmail, remoteBrain: null };
    }

    const remoteBrain = await askRemoteBrain(ask, null);
    return { userName, userEmail, remoteBrain };
  } finally {
    if (rl !== null) (rl as ReturnType<typeof createInterface>).close();
  }
}

// --------------------------------------------------------------------
// Shared prompt bodies (FR-122: factored so init + configure reuse them)
// --------------------------------------------------------------------

/**
 * Prompt for name + email, defaulting each to the provided seed (so pressing
 * Enter keeps the seeded value). The `[default]` label is shown verbatim — for
 * the init path the defaults are `you` / empty; for configure they are the
 * current USER.md values.
 */
async function askIdentity(
  ask: PromptFn,
  seed: { nameDefault: string; emailDefault: string },
): Promise<{ userName: string; userEmail: string }> {
  const nameRaw = (
    await ask(`Your name [${seed.nameDefault}]: `)
  ).trim();
  const userName = nameRaw === "" ? seed.nameDefault : nameRaw;

  const emailRaw = (
    await ask(`Your email [${seed.emailDefault}]: `)
  ).trim();
  const userEmail = emailRaw === "" ? seed.emailDefault : emailRaw;

  return { userName, userEmail };
}

/**
 * Prompt for the remote brain (VPS) URL + API key, seeded from the current
 * config (so Enter keeps it). VPS-by-address: a blank URL → `null` (disable);
 * a non-blank URL → `{url, apiKey}`. The TD-252 cleartext-http guard refuses a
 * non-local `http://` URL (returns the seed unchanged so a re-run doesn't lose
 * the prior value to an accidental insecure entry).
 *
 * @param seed Current remote_brain (null when none configured). The URL prompt
 *   defaults to the seeded URL; the API key prompt defaults to the seeded key
 *   (masked label) so Enter keeps the existing key without re-typing it.
 */
async function askRemoteBrain(
  ask: PromptFn,
  seed: { url: string; apiKey: string | null } | null,
): Promise<{ url: string; apiKey: string | null } | null> {
  info("");
  info("Optional: remote brain (VPS) for cross-machine sync.");
  const urlDefault = seed?.url ?? "";
  const urlRaw = (
    await ask(
      `Remote brain URL (blank to ${seed === null ? "skip" : "disable"}) [${urlDefault}]: `,
    )
  ).trim();
  // VPS-by-address: a blank URL ALWAYS means "no VPS" — it SKIPS when none was
  // configured and CLEARS (disables) when one was. To keep an existing VPS the
  // operator re-enters the URL (shown as the default label for copy). This is
  // the address-presence contract: present = enabled, blank = disabled. (We do
  // NOT auto-substitute the seed on blank — that would make disabling
  // impossible via a prompt.)
  const url = urlRaw;
  if (url === "") {
    return null;
  }

  // TD-252: fail-fast at configure time — never persist a non-local http://
  // URL (the api_key would later travel in cleartext), unless the override
  // is active. https:// and localhost http:// pass silently.
  if (
    classifySyncTransport(url) === "insecure-http" &&
    !isInsecureSyncAllowed()
  ) {
    warn(
      `refusing to save remote brain URL '${url}' — http:// to a ` +
        `non-local host sends your api_key in cleartext. Use an https:// ` +
        `URL, or set IGRIS_ALLOW_INSECURE_SYNC=1 to override (NOT ` +
        `recommended). Remote brain left unchanged; edit ` +
        `~/.igris/config.json later to set it.`,
    );
    return seed;
  }

  info("Note: input is visible — clear scrollback after if sensitive.");
  const keyLabel = seed?.apiKey != null ? "keep current" : "";
  const apiKeyRaw = (
    await ask(`Remote brain API key [${keyLabel}]: `)
  ).trim();
  // Enter keeps the seeded key (when present); a fresh value overrides it.
  const apiKey = apiKeyRaw === "" ? (seed?.apiKey ?? null) : apiKeyRaw;
  if (apiKey === null) {
    warn(
      "remote_brain configured without api_key — " +
        "set it later via ~/.igris/config.json",
    );
  }
  return { url, apiKey };
}

/** Parse a `y`/`n` answer, defaulting to `current` on a blank/unrecognized reply. */
function parseYesNo(answer: string, current: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return current;
}

// --------------------------------------------------------------------
// FR-122: configure inputs (seeded from live state)
// --------------------------------------------------------------------

/**
 * Structured result of the `igris configure` prompt flow. Extends the init
 * identity/remote_brain shape with the persona choice and the two cognition
 * toggles.
 */
export interface ConfigureInputs {
  userName: string;
  userEmail: string;
  remoteBrain: { url: string; apiKey: string | null } | null;
  /** Chosen persona name (e.g. "professional" | "character"). */
  persona: string;
  perceptionEnabled: boolean;
  subconsciousEnabled: boolean;
}

/** Options for {@link gatherConfigureInputs}. */
export interface ConfigureGatherOpts {
  yes: boolean;
  skipRemote: boolean;
  /** Pre-selected persona (the `--persona <name>` flag); skips the persona prompt. */
  persona?: string;
  /** Test seam: inject a fake prompt to bypass readline. */
  prompt?: PromptFn;
  /** Test seam: override TTY detection. Defaults to `process.stdin.isTTY === true`. */
  isTTY?: boolean;
}

/** The live state the configure prompts seed from. */
export interface ConfigureSeed {
  userName: string;
  userEmail: string;
  remoteBrain: { url: string; apiKey: string | null } | null;
  persona: string;
  perceptionEnabled: boolean;
  subconsciousEnabled: boolean;
}

/** Parse `- name: X` / `- email: Y` out of USER.md (the init template shape). */
function readUserMdIdentity(): { userName: string; userEmail: string } {
  const path = userMdPath();
  let userName = "you";
  let userEmail = "";
  if (!existsSync(path)) return { userName, userEmail };
  try {
    const raw = readFileSync(path, "utf-8");
    const nameMatch = /^[-*]\s*name:\s*(.*)$/m.exec(raw);
    const emailMatch = /^[-*]\s*email:\s*(.*)$/m.exec(raw);
    if (nameMatch && nameMatch[1].trim() !== "") userName = nameMatch[1].trim();
    if (emailMatch) userEmail = emailMatch[1].trim();
  } catch {
    // Unreadable USER.md → fall back to defaults.
  }
  return { userName, userEmail };
}

/**
 * Read the live state the configure prompts seed from: USER.md identity,
 * config.json `remote_brain` + `cognition.*.enabled`, and the active persona
 * (inferred by matching the runtime SOUL.md against the templates; falls back
 * to the first available template, else "character", so the prompt always has
 * a default).
 */
export function readConfigureSeed(): ConfigureSeed {
  const { userName, userEmail } = readUserMdIdentity();

  let remoteBrain: { url: string; apiKey: string | null } | null = null;
  let perceptionEnabled = false;
  let subconsciousEnabled = false;
  const cfgPath = configJsonPath();
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        remote_brain?: { url?: string; api_key?: string | null } | null;
        cognition?: {
          perception?: { enabled?: boolean };
          subconscious?: { enabled?: boolean };
        };
      };
      if (
        cfg.remote_brain != null &&
        typeof cfg.remote_brain.url === "string" &&
        cfg.remote_brain.url !== ""
      ) {
        remoteBrain = {
          url: cfg.remote_brain.url,
          apiKey:
            typeof cfg.remote_brain.api_key === "string"
              ? cfg.remote_brain.api_key
              : null,
        };
      }
      perceptionEnabled = cfg.cognition?.perception?.enabled === true;
      subconsciousEnabled = cfg.cognition?.subconscious?.enabled === true;
    } catch {
      // Malformed config → keep the safe defaults (no VPS, both OFF).
    }
  }

  const inferred = inferActivePersona();
  const available = listPersonas();
  const persona =
    inferred ?? (available.length > 0 ? available[0] : "character");

  return {
    userName,
    userEmail,
    remoteBrain,
    persona,
    perceptionEnabled,
    subconsciousEnabled,
  };
}

/**
 * Collect the `igris configure` inputs, SEEDED from live state.
 *
 * Decision matrix:
 *
 * | Flags        | Prompts? | Result                                  |
 * |--------------|----------|-----------------------------------------|
 * | (none, TTY)  | All      | seeded prompts (Enter keeps seed)       |
 * | --yes        | None     | the SEEDED current values (no-op)       |
 * | Non-TTY      | None     | the SEEDED current values (no-op)       |
 *
 * The `--yes` / non-TTY path returns the SEEDED current values — NOT defaults —
 * so a `--yes` run is a no-op on values (round-trip identity). A `--persona`
 * flag overrides the seeded persona (and skips the persona prompt).
 */
export async function gatherConfigureInputs(
  opts: ConfigureGatherOpts,
): Promise<ConfigureInputs> {
  const seed = readConfigureSeed();
  // A --persona flag overrides the seeded/inferred persona regardless of TTY.
  const seededPersona = opts.persona ?? seed.persona;

  // Non-interactive paths: return the seeded current values (no-op on values).
  const tty = opts.isTTY ?? process.stdin.isTTY === true;
  if (opts.yes || !tty) {
    if (!opts.yes) {
      info(
        "Non-interactive shell detected; keeping current values. " +
          "Edit ~/.igris/USER.md and ~/.igris/config.json to customize.",
      );
    }
    return {
      userName: seed.userName,
      userEmail: seed.userEmail,
      remoteBrain: seed.remoteBrain,
      persona: seededPersona,
      perceptionEnabled: seed.perceptionEnabled,
      subconsciousEnabled: seed.subconsciousEnabled,
    };
  }

  let rl: ReturnType<typeof createInterface> | null = null;
  const ask: PromptFn =
    opts.prompt ??
    ((q: string): Promise<string> => {
      if (rl === null) {
        rl = createInterface({ input: process.stdin, output: process.stdout });
      }
      return new Promise((res) => rl!.question(q, (a) => res(a)));
    });

  try {
    info("");
    info("Configuring Igris. Press Enter to keep the current value.");

    const { userName, userEmail } = await askIdentity(ask, {
      nameDefault: seed.userName,
      emailDefault: seed.userEmail,
    });

    // Persona: skip the prompt when --persona was passed.
    let persona = seededPersona;
    if (opts.persona === undefined) {
      const available = listPersonas();
      const choices = available.length > 0 ? available.join(", ") : "(none)";
      info("");
      info(`Persona presets: ${choices}`);
      const personaRaw = (
        await ask(`Persona [${seed.persona}]: `)
      ).trim();
      persona = personaRaw === "" ? seed.persona : personaRaw;
    }

    const remoteBrain = opts.skipRemote
      ? seed.remoteBrain
      : await askRemoteBrain(ask, seed.remoteBrain);

    info("");
    info("Cognition (LLM extraction engines — default OFF).");
    const perceptionRaw = await ask(
      `Enable perception? (y/n) [${seed.perceptionEnabled ? "y" : "n"}]: `,
    );
    const perceptionEnabled = parseYesNo(perceptionRaw, seed.perceptionEnabled);

    const subconsciousRaw = await ask(
      `Enable subconscious? (y/n) [${seed.subconsciousEnabled ? "y" : "n"}]: `,
    );
    const subconsciousEnabled = parseYesNo(
      subconsciousRaw,
      seed.subconsciousEnabled,
    );

    return {
      userName,
      userEmail,
      remoteBrain,
      persona,
      perceptionEnabled,
      subconsciousEnabled,
    };
  } finally {
    if (rl !== null) (rl as ReturnType<typeof createInterface>).close();
  }
}
