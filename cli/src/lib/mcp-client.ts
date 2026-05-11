/**
 * Minimal HTTP MCP client for `igris sync data` (M4 of MG-014).
 *
 * Talks directly to the VPS brain's HTTP MCP endpoint to drain queued
 * brain operations via the `igris_sync_queue_drain` tool. This is the
 * ONLY runtime path where the local CLI talks to the VPS brain; per
 * L-252 the architecture is "local stdio MCP per instance, VPS as pure
 * HTTP sync hub." This client does NOT depend on the user's MCP server
 * registry (~/.claude.json) — it talks directly to the configured
 * `remote_brain.url` from `~/.igris/config.json` (per L-256: MCP config
 * changes only take effect on next CLI launch, so a freshly-configured
 * remote_brain is reachable here without any registry round-trip).
 *
 * Tests mock `node:https` / `node:http` at the boundary, NOT the wrapper
 * (per L-159 / TD-098: never `vi.mock` the module under test). The
 * sync-data tests exercise this module via real fixture queue files +
 * mocked HTTP boundary.
 */

import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL as NodeURL } from "node:url";
import { configJsonPath } from "./paths.js";

export interface RemoteBrainConfig {
  url: string;
  apiKey: string;
}

export interface McpToolCallResult {
  /** HTTP status code from the response. */
  statusCode: number;
  /** Response body (utf-8). May be JSON or plain text on error. */
  body: string;
  /** Parsed JSON when statusCode == 200 and body is valid JSON; null otherwise. */
  json: unknown;
}

/**
 * Read `remote_brain.{url, api_key}` from `~/.igris/config.json`. Returns
 * null when config is missing, malformed, or `remote_brain` is not
 * configured. Mirrors the contract in `lib/remote-push.ts` for shape
 * consistency.
 */
export function readRemoteBrainConfig(): RemoteBrainConfig | null {
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
 * VPS config — separate block from `remote_brain` because it carries
 * SSH credentials (host/user/repo_path) used by `sync code`. Read once
 * by the code-sync verb; the data-sync verb does not need this.
 */
export interface VpsConfig {
  host: string;
  user: string;
  repoPath: string;
  brainPath?: string;
}

/**
 * Read the `vps.{host,user,repo_path,brain_path}` block from
 * `~/.igris/config.json`. Returns null when missing or malformed.
 * Used by `sync code` (NOT by `sync data` or `sync status`).
 */
export function readVpsConfig(): VpsConfig | null {
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      vps?: {
        host?: string;
        user?: string;
        repo_path?: string;
        brain_path?: string;
      };
    };
    const v = cfg.vps;
    if (v === undefined || v === null) return null;
    const host = typeof v.host === "string" ? v.host : "";
    const user = typeof v.user === "string" ? v.user : "";
    const repoPath = typeof v.repo_path === "string" ? v.repo_path : "";
    if (host.length === 0 || user.length === 0 || repoPath.length === 0) {
      return null;
    }
    return {
      host,
      user,
      repoPath,
      brainPath: typeof v.brain_path === "string" ? v.brain_path : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * HTTP HEAD against `<remote_brain.url>/health`. Returns the HTTP status
 * code on success, or null on network error / timeout / DNS failure.
 *
 * Used by `sync status` to determine VPS reachability without invoking
 * any MCP tool (the VPS exposes a plain `/health` GET endpoint that
 * doesn't require API key). HEAD is preferred over GET to keep the
 * payload minimal — we only care about reachability + status code.
 *
 * `timeoutMs` defaults to 5 seconds (matches lib/remote-push.ts).
 */
export async function healthCheck(
  remoteUrl: string,
  timeoutMs = 5_000,
): Promise<{ statusCode: number | null; body: string }> {
  let parsed: NodeURL;
  try {
    parsed = new NodeURL(`${remoteUrl.replace(/\/$/, "")}/health`);
  } catch {
    return { statusCode: null, body: "" };
  }

  const isHttps = parsed.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      code: number | null,
      body: string,
    ): void => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: code, body });
    };

    // Use GET (not HEAD) so callers can read the version/status JSON the
    // brain exposes at /health. Some HTTP servers respond to HEAD with
    // empty body; GET is universally supported.
    const req = requester(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          settle(res.statusCode ?? null, Buffer.concat(chunks).toString("utf-8"));
        });
        res.on("error", () => settle(res.statusCode ?? null, ""));
      },
    );
    req.on("error", () => settle(null, ""));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      settle(null, "");
    });
    req.end();
  });
}

/**
 * Invoke an MCP tool over HTTP against the configured remote brain.
 *
 * Posts to `<remote_brain.url>/mcp` with the canonical JSON-RPC 2.0
 * envelope that the brain server expects:
 *
 *   {
 *     "jsonrpc": "2.0",
 *     "method":  "tools/call",
 *     "params":  { "name": "<tool>", "arguments": { ... } },
 *     "id":      1
 *   }
 *
 * The brain dispatches at `brain-mcp-server/src/index.ts:1490` (direct
 * dispatch fallback): when no MCP session is active, it pulls
 * `body.params.name` and `body.params.arguments` and routes through
 * `dispatchToolCall(name, toolArgs)`. There is NO `/mcp/call` route —
 * only `/mcp` (line 1421). Sending the wrong shape silently 404s.
 *
 * Returns `{statusCode, body, json}`. Promise never rejects; network
 * failure surfaces as `{statusCode: 0, body: <message>, json: null}`.
 *
 * Auth: `Authorization: Bearer <api_key>` (matches lib/remote-push.ts).
 */
export async function mcpCall(
  remote: RemoteBrainConfig,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<McpToolCallResult> {
  let parsed: NodeURL;
  try {
    parsed = new NodeURL(`${remote.url.replace(/\/$/, "")}/mcp`);
  } catch {
    return { statusCode: 0, body: "malformed url", json: null };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
    id: 1,
  });

  const isHttps = parsed.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: McpToolCallResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requester(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${remote.apiKey}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const respBody = Buffer.concat(chunks).toString("utf-8");
          let parsedJson: unknown = null;
          if (res.statusCode === 200) {
            try {
              parsedJson = JSON.parse(respBody);
            } catch {
              parsedJson = null;
            }
          }
          settle({
            statusCode: res.statusCode ?? 0,
            body: respBody,
            json: parsedJson,
          });
        });
        res.on("error", (err) =>
          settle({ statusCode: 0, body: err.message, json: null }),
        );
      },
    );
    req.on("error", (err: Error) =>
      settle({ statusCode: 0, body: err.message, json: null }),
    );
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      settle({ statusCode: 0, body: "request timed out", json: null });
    });
    req.write(body);
    req.end();
  });
}
