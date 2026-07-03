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
import { assertSyncTransportAllowed } from "./sync-transport.js";

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
  // TD-252: refuse non-local http:// before the api_key path is exercised.
  const gate = assertSyncTransportAllowed(remoteUrl);
  if (!gate.ok) {
    return { statusCode: null, body: gate.reason };
  }

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

/** Result of a `GET /sync/pull` call against the remote brain. */
export interface SyncPullResult {
  /** HTTP status code (0 on network failure / timeout / malformed url). */
  statusCode: number;
  /**
   * The `tables` map from the response body: `{ <table>: rows[] }`. Empty
   * object when statusCode != 200, the body is not valid JSON, or it carried
   * no `tables` field. (The brain omits tables with zero changed rows, so an
   * empty map legitimately means "nothing newer remotely".)
   */
  tables: Record<string, Record<string, unknown>[]>;
  /** Raw response body (utf-8) — surfaced for diagnostics on non-200. */
  body: string;
}

/**
 * `GET <remote_brain.url>/sync/pull?<since params>` — the VPS→local row-pull
 * endpoint (`brain-mcp-server/src/index.ts:1690`). This is the CLIENT half of
 * the brain's own `handleBrainPull` (`tools/sync.ts:913`): the CLI GETs the
 * remote rows here and merges them into the LOCAL db (via
 * `brain-db.ts#mergePulledTables`), rather than `mcpCall`-ing
 * `igris_brain_pull` against the VPS — which would run the brain's pull handler
 * on the VPS against the VPS's OWN db (VPS→VPS, circular; learning #169). A CLI
 * process has no stdio MCP server, so it reproduces the pull's local half here.
 *
 * `sinceByTable` maps table name → the local `sync_state.last_pull_at` cursor;
 * each becomes a `since_<table>=<ts>` query param (the brain defaults a missing
 * param to the epoch, so the map need only carry the tables boot-sync pulls).
 *
 * Returns `{statusCode, tables, body}`. Promise NEVER rejects — a network
 * failure surfaces as `{statusCode: 0, tables: {}, body: <message>}` so the
 * caller records a skip and continues (boot-sync's never-block contract).
 *
 * Auth: `Authorization: Bearer <api_key>` (matches healthCheck / the brain's
 * own pull, sync.ts:935). GET — no request body.
 */
export async function syncPull(
  remote: RemoteBrainConfig,
  sinceByTable: Record<string, string>,
  timeoutMs = 30_000,
): Promise<SyncPullResult> {
  // TD-252: refuse non-local http:// before the Bearer header is sent.
  const gate = assertSyncTransportAllowed(remote.url);
  if (!gate.ok) {
    return { statusCode: 0, tables: {}, body: gate.reason };
  }

  const params = new URLSearchParams();
  for (const [table, since] of Object.entries(sinceByTable)) {
    params.set(`since_${table}`, since);
  }

  let parsed: NodeURL;
  try {
    const qs = params.toString();
    parsed = new NodeURL(
      `${remote.url.replace(/\/$/, "")}/sync/pull${qs ? `?${qs}` : ""}`,
    );
  } catch {
    return { statusCode: 0, tables: {}, body: "malformed url" };
  }

  const isHttps = parsed.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: SyncPullResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requester(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          Authorization: `Bearer ${remote.apiKey}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const respBody = Buffer.concat(chunks).toString("utf-8");
          let tables: Record<string, Record<string, unknown>[]> = {};
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(respBody) as {
                tables?: Record<string, Record<string, unknown>[]>;
              };
              if (json && typeof json === "object" && json.tables && typeof json.tables === "object") {
                tables = json.tables;
              }
            } catch {
              tables = {};
            }
          }
          settle({ statusCode: res.statusCode ?? 0, tables, body: respBody });
        });
        res.on("error", (err) =>
          settle({ statusCode: 0, tables: {}, body: err.message }),
        );
      },
    );
    req.on("error", (err: Error) =>
      settle({ statusCode: 0, tables: {}, body: err.message }),
    );
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      settle({ statusCode: 0, tables: {}, body: "request timed out" });
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
  // TD-252: refuse non-local http:// before the Bearer header is sent.
  const gate = assertSyncTransportAllowed(remote.url);
  if (!gate.ok) {
    return { statusCode: 0, body: gate.reason, json: null };
  }

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
