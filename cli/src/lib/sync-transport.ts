/**
 * sync-transport.ts — transport-security classifier for the remote VPS sync
 * (TD-252).
 *
 * The CLI → VPS hop is the ONLY path where the brain `api_key` travels over
 * the network (every request builder in `mcp-client.ts` / `remote-push.ts`
 * sends `Authorization: Bearer <api_key>`). Over plain `http://` to a remote
 * host that key is sent in cleartext, so this module is the SINGLE choke point
 * that classifies the configured `remote_brain.url` and refuses non-local
 * `http://` by default.
 *
 * The threat model is the CLI client path ONLY — per L-252 the architecture is
 * "local stdio MCP per instance, VPS as pure HTTP sync hub", so the brain-side
 * handlers (`brain-mcp-server/src/tools/sync.ts`) run server-side / VPS-local
 * and are deliberately NOT guarded here (guarding them would break the
 * VPS-internal loopback push).
 *
 * Design contract:
 *   - `classifySyncTransport` is PURE: no I/O, no env read. Just URL → kind.
 *   - `isInsecureSyncAllowed` is the SINGLE reader of the override (env var
 *     `IGRIS_ALLOW_INSECURE_SYNC=1` primary; optional persistent
 *     `config.json` `remote_brain.allow_insecure: true`). Read at RUNTIME —
 *     the default (unset) REFUSES non-local http (#376: never invert the
 *     polarity).
 *   - `assertSyncTransportAllowed` NEVER throws. It returns `{ok:false,reason}`
 *     for refused insecure-http; callers map that to their own structured
 *     failure shape so the never-block contracts (boot-sync exit 0, install
 *     best-effort) hold. On the override path it emits a loud one-line warning
 *     and returns `{ok:true}`.
 */

import { existsSync, readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { configJsonPath } from "./paths.js";
import { warn } from "./log.js";

export type SyncTransport = "https" | "localhost-http" | "insecure-http";

/**
 * Hostnames that are local-only and therefore safe to use over plain http —
 * the api_key never leaves the machine. `new URL(...).hostname` strips the
 * brackets from `[::1]`, yielding the bare `::1`, so both forms are listed
 * defensively.
 */
const LOCAL_HOSTNAMES = new Set<string>([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * Pure classification — no I/O, no env read.
 *
 * - `https:` → `"https"` (always safe).
 * - `http:` to a local host (`localhost`/`127.0.0.1`/`::1`/`[::1]`) →
 *   `"localhost-http"` (dev convenience; what every test fixture uses).
 * - `http:` to any other host → `"insecure-http"`.
 * - A malformed URL is treated as `"insecure-http"` (defensive — refuse what
 *   we cannot prove safe; matches the existing `catch → malformed url`
 *   branches at the call sites).
 */
export function classifySyncTransport(url: string): SyncTransport {
  let parsed: NodeURL;
  try {
    parsed = new NodeURL(url);
  } catch {
    return "insecure-http";
  }
  if (parsed.protocol === "https:") return "https";
  if (parsed.protocol === "http:") {
    return LOCAL_HOSTNAMES.has(parsed.hostname)
      ? "localhost-http"
      : "insecure-http";
  }
  // Any other scheme (file:, ws:, …) is not a valid sync transport — refuse.
  return "insecure-http";
}

/**
 * Read the insecure-sync override. SINGLE reader (the choke point so the
 * polarity lives in exactly one place — #376).
 *
 * Precedence:
 *   1. env var `IGRIS_ALLOW_INSECURE_SYNC=1` — primary, one-shot, consistent
 *      with the `IGRIS_BYPASS_*` pattern (never `export`).
 *   2. `config.json` `remote_brain.allow_insecure: true` — optional persistent
 *      form for an operator who knowingly runs a permanent http VPS on a
 *      trusted LAN.
 *
 * Default (neither set) → false → non-local http is REFUSED. Read at RUNTIME
 * so a missing/unset override always refuses.
 */
export function isInsecureSyncAllowed(): boolean {
  if (process.env.IGRIS_ALLOW_INSECURE_SYNC === "1") return true;
  return readConfigAllowInsecure();
}

/** Read the optional persistent `remote_brain.allow_insecure` config key. */
function readConfigAllowInsecure(): boolean {
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      remote_brain?: { allow_insecure?: unknown };
    };
    return cfg.remote_brain?.allow_insecure === true;
  } catch {
    return false;
  }
}

/** Result of the enforcement gate. NEVER thrown — always returned. */
export type TransportGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Enforcement gate. Returns `{ok:true}` when the transport is safe to use
 * (`https` | `localhost-http`), OR `insecure-http` WITH the override active
 * (after emitting the loud one-line warning each sync). Returns
 * `{ok:false, reason}` for `insecure-http` with NO override.
 *
 * NEVER throws — callers map `{ok:false}` to their own structured failure
 * shape so the never-block contracts (boot-sync exit 0, install best-effort)
 * hold.
 */
export function assertSyncTransportAllowed(url: string): TransportGateResult {
  const transport = classifySyncTransport(url);
  if (transport === "https" || transport === "localhost-http") {
    return { ok: true };
  }
  // insecure-http
  const host = hostLabel(url);
  if (isInsecureSyncAllowed()) {
    warn(
      `WARNING: syncing over insecure http:// to ${host} — api_key sent in ` +
        `cleartext (IGRIS_ALLOW_INSECURE_SYNC override active).`,
    );
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `refusing to sync over http:// to ${host} — your api_key would be sent ` +
      `in cleartext. Use an https:// URL, or set IGRIS_ALLOW_INSECURE_SYNC=1 ` +
      `to override (NOT recommended on untrusted networks).`,
  };
}

/** Best-effort host label for the warning/refusal message. */
function hostLabel(url: string): string {
  try {
    return new NodeURL(url).host || url;
  } catch {
    return url;
  }
}
