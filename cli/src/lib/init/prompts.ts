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
import { info, warn } from "../log.js";
import {
  classifySyncTransport,
  isInsecureSyncAllowed,
} from "../sync-transport.js";

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

    const nameRaw = (await ask("Your name [you]: ")).trim();
    const userName = nameRaw === "" ? "you" : nameRaw;

    const emailRaw = (await ask("Your email []: ")).trim();
    const userEmail = emailRaw;

    if (opts.skipRemote) {
      return { userName, userEmail, remoteBrain: null };
    }

    info("");
    info("Optional: remote brain (VPS) for cross-machine sync.");
    const urlRaw = (
      await ask("Remote brain URL (blank to skip) []: ")
    ).trim();
    if (urlRaw === "") {
      return { userName, userEmail, remoteBrain: null };
    }

    // TD-252: fail-fast at configure time — never persist a non-local http://
    // URL (the api_key would later travel in cleartext), unless the override
    // is active. https:// and localhost http:// pass silently.
    if (
      classifySyncTransport(urlRaw) === "insecure-http" &&
      !isInsecureSyncAllowed()
    ) {
      warn(
        `refusing to save remote brain URL '${urlRaw}' — http:// to a ` +
          `non-local host sends your api_key in cleartext. Use an https:// ` +
          `URL, or set IGRIS_ALLOW_INSECURE_SYNC=1 to override (NOT ` +
          `recommended). Remote brain left unconfigured; edit ` +
          `~/.igris/config.json later to set it.`,
      );
      return { userName, userEmail, remoteBrain: null };
    }

    info("Note: input is visible — clear scrollback after if sensitive.");
    const apiKeyRaw = (await ask("Remote brain API key []: ")).trim();
    if (apiKeyRaw === "") {
      warn(
        "remote_brain configured without api_key — " +
          "set it later via ~/.igris/config.json",
      );
      return {
        userName,
        userEmail,
        remoteBrain: { url: urlRaw, apiKey: null },
      };
    }
    return {
      userName,
      userEmail,
      remoteBrain: { url: urlRaw, apiKey: apiKeyRaw },
    };
  } finally {
    if (rl !== null) (rl as ReturnType<typeof createInterface>).close();
  }
}
