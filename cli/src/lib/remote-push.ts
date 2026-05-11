/**
 * Remote-brain push at install time — `igris install` Phase 2 (M2, Risk A4).
 *
 * Ports the curl block from `scripts/igris_install.sh:463-523`:
 * when `~/.igris/config.json` has a configured `remote_brain.{url,api_key}`,
 * POST the project row to `<remote_brain.url>/sync/push` so a multi-machine
 * brain stays consistent across hosts.
 *
 * Contract (preserved from shell):
 *
 *   - Skipped silently if config.json is absent or `remote_brain` is unset
 *     (no error — matches shell's `echo "remote brain not configured" + continue`).
 *   - HTTP timeout matches shell: 5s connect, 10s total. We use a manual
 *     timeout via `setTimeout(req.destroy)` because `node:https` does not
 *     expose a "max-time" option directly.
 *   - Failure (non-200, network error, timeout) is LOGGED via warn() and
 *     does NOT fail the install — the shell behavior. Network availability
 *     is best-effort by design here.
 *   - Body shape exactly matches shell's `tables.projects` schema.
 */

import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL as NodeURL } from "node:url";
import { configJsonPath } from "./paths.js";
import { warn } from "./log.js";

export interface RemotePushArgs {
  slug: string;
  path: string;
  techStack: string;
  cliVersion: string;
}

export type RemotePushOutcome =
  | "not_configured"
  | "pushed"
  | "http_error"
  | "network_error"
  | "config_malformed";

interface RemoteBrainConfig {
  url: string;
  apiKey: string;
}

/**
 * Read remote_brain.{url,api_key} from runtime config.json. Returns null
 * when config is missing, malformed, or remote_brain is not configured.
 */
function readRemoteConfig(): RemoteBrainConfig | null {
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      remote_brain?: { url?: string; api_key?: string };
    };
    const rb = cfg.remote_brain;
    if (rb === undefined || rb === null) return null;
    const url = typeof rb.url === "string" ? rb.url : "";
    const apiKey = typeof rb.api_key === "string" ? rb.api_key : "";
    if (url.length === 0 || apiKey.length === 0) return null;
    return { url, apiKey };
  } catch {
    return null;
  }
}

/**
 * Push the registered project to remote brain. Returns outcome but never
 * throws — the install pipeline is robust to remote-brain downtime.
 */
export async function pushProjectToRemote(
  args: RemotePushArgs,
): Promise<RemotePushOutcome> {
  const cfg = readRemoteConfig();
  if (cfg === null) return "not_configured";

  const now = new Date().toISOString();
  const body = JSON.stringify({
    tables: {
      projects: [
        {
          slug: args.slug,
          name: args.slug,
          path: args.path,
          tech_stack: args.techStack,
          igris_version: args.cliVersion,
          status: "active",
          registered_at: now,
          last_session_at: now,
          metadata: "{}",
        },
      ],
    },
  });

  let parsed: NodeURL;
  try {
    parsed = new NodeURL(`${cfg.url.replace(/\/$/, "")}/sync/push`);
  } catch {
    return "config_malformed";
  }

  const isHttps = parsed.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;
  const reqOptions = {
    method: "POST",
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    timeout: 5_000,
  };

  return new Promise((resolve) => {
    const req = requester(reqOptions, (res) => {
      // Drain response so the socket can close.
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve("pushed");
        } else {
          warn(`remote brain push returned HTTP ${res.statusCode ?? "unknown"}`);
          resolve("http_error");
        }
      });
    });
    let settled = false;
    const settle = (out: RemotePushOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        // ignore
      }
      resolve(out);
    };

    req.on("error", (err: Error) => {
      warn(`remote brain push failed: ${err.message}`);
      settle("network_error");
    });
    req.on("timeout", () => {
      warn("remote brain push timed out");
      settle("network_error");
    });

    // Maximum total time matches shell's --max-time 10.
    const maxTimer = setTimeout(() => {
      settle("network_error");
    }, 10_000);
    maxTimer.unref();
    req.on("close", () => {
      clearTimeout(maxTimer);
    });

    req.write(body);
    req.end();
  });
}
