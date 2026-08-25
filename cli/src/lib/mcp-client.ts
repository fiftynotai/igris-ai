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
import { randomUUID } from "node:crypto";
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
  /**
   * The JSON-RPC message read out of a 200 response by `readMcpResponseBody`
   * — which reads a `text/event-stream` body as well as an `application/json`
   * one (BR-094). Null on any other status, and null when a 200 body carries
   * no answer to this call; the caller treats that null as indeterminate.
   */
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
 * A fresh JSON-RPC `id` for ONE `mcpCall`, and the id a response frame must
 * echo to be read as THAT call's answer (BR-094 round 2).
 *
 * It MUST be per-call unique, not a module constant. Two facts make a constant
 * a data-loss path rather than a cosmetic wart:
 *
 *   1. The SDK's Streamable HTTP transport demultiplexes replies by JSON-RPC
 *      id, PER TRANSPORT: `WebStandardStreamableHTTPServerTransport` keeps a
 *      `_requestToStreamMapping` keyed on `message.id` and `.set()`s it on
 *      every incoming request, then `.get()`s it to decide which SSE stream a
 *      response is written to. (`StreamableHTTPServerTransport` is a thin
 *      wrapper that delegates to it — verified in the vendored SDK 1.26.0 at
 *      `dist/esm/server/webStandardStreamableHttp.js`.) A second request
 *      carrying the SAME id OVERWRITES the first request's mapping, so the
 *      first answer is written into the SECOND caller's response body.
 *   2. The brain funnels every session-less POST into ONE transport:
 *      `brain-mcp-server/src/index.ts` fallback A picks
 *      `activeSessions[activeSessions.length - 1]` and injects it. SSE is only
 *      reachable when that list is non-empty, so any run that observes SSE has
 *      by definition proved a co-tenant session exists to collide with.
 *
 * Under a module constant the correlation below therefore checked the call
 * CLASS, not the call: a concurrent `igris sync data` / `boot-sync` would read
 * the OTHER run's success envelope as its own, `dispatchEntry` would count an
 * entry the brain never received as replayed, and `finalizeDrainSnapshot(_,
 * true)` would unlink the only copy of it. That is BR-080's loss class.
 *
 * `randomUUID()` also removes the server-side stream collision itself, for
 * every client of this brain — not just for our reader.
 */
function newMcpRequestId(): string {
  return randomUUID();
}

/**
 * Byte cap on the response body `mcpCall` will accumulate (BR-094 round 2).
 *
 * `timeout` on a node http request is a SOCKET IDLE timeout, so it never fires
 * on a peer that keeps emitting — and `text/event-stream` is a media type
 * DESIGNED to stay open. The brain sits behind nginx with `proxy_buffering off`
 * and `proxy_read_timeout 86400` (`scripts/igris_brain_deploy.sh`), so nothing
 * between us and it bounds the stream either. Without this cap a chatty or
 * hostile stream grows the buffer until the CLI is OOM-killed.
 *
 * 8 MiB is ~1000x the largest real `tools/call` answer on this path (a drain
 * summary or a brief-write acknowledgement, both a few hundred bytes). Exceeding
 * it settles as a transport failure (`statusCode: 0`), which is FAIL-SAFE on
 * both callers: `callRemoteDrain` exits 1 and `dispatchEntry` treats a non-200
 * as not-replayed, so the queue is preserved rather than unlinked.
 *
 * RESIDUAL, recorded rather than fixed: this bounds MEMORY, not TIME. A stream
 * that trickles bytes slowly forever stays under the cap and under the idle
 * timeout, so the call can still hang; there is no wall-clock deadline on the
 * whole response. And `syncPull` / `healthCheck` still accumulate unbounded —
 * deliberately, because a `/sync/pull` body legitimately carries brain deltas
 * (nginx allows 128m on this vhost) and a cap sized for `tools/call` would
 * refuse real pulls. Both are pre-existing and neither is on the SSE path.
 */
export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * `Accept` for the MCP Streamable HTTP transport. The server-side check is a
 * substring test for BOTH tokens against the raw header — see
 * `@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:378`
 * — and a request without them is answered `406 Not Acceptable` at the
 * transport, before any dispatch. BR-094: omitting this header 406'd every
 * remote drain.
 */
const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * Read a `tools/call` response body into its JSON-RPC message.
 *
 * TWO wire shapes are live on `/mcp`, decided by whether the brain has an
 * active MCP session (BR-094, both observed against brain.fifty.dev):
 *   - `application/json` — the direct-dispatch fallback (`res.json`, no active
 *     session, `brain-mcp-server/src/index.ts`);
 *   - `text/event-stream` — the transport path taken whenever a session IS
 *     active. `enableJsonResponse` defaults to false and the brain never sets
 *     it, so that path ALWAYS answers a POST with SSE, never with JSON.
 *
 * `expectedId` is the JSON-RPC id THIS call sent (see `newMcpRequestId`); the
 * SSE reader accepts only a frame echoing it. The JSON arm does NOT correlate,
 * and deliberately: the direct-dispatch fallback is a plain `res.json(...)` on
 * the one socket that carried the request, so HTTP itself is the correlation
 * and there is no multiplexer to confuse. Adding an id check there would be a
 * new refusal class with no measured defect behind it.
 *
 * Returns `null` when the body carries no answer to THIS call. `null` is a
 * DEFINED unknown here: `classifyToolCallBody` (`lib/sync/data.ts`) routes it
 * to the `indeterminate` tier, which never authorises deleting a queue entry
 * (BR-080). Never fall back to "the last frame that looked like a reply".
 */
export function readMcpResponseBody(
  body: string,
  contentType: string,
  expectedId: unknown,
): unknown {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return readSseJsonRpc(body, expectedId);
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * First SSE frame whose `data:` payload is a JSON-RPC RESPONSE echoing
 * `expectedId`. Frame shape is the SDK's own `writeSSEEvent`:
 * `event: message\n` + optional `id: <eventId>\n` + `data: <json>\n\n`. The
 * frame's `id:` line is a resumability cursor, NOT the JSON-RPC id — only
 * `data:` lines are read here, and per the SSE spec several of them in one
 * frame concatenate with `\n`.
 *
 * Three conditions, and the last two are what let downstream prose say an SSE
 * 200 reaches `classifyToolCallBody` as a JSON-RPC response or as `null` and
 * never as some other object: the payload must be a non-null non-array object,
 * it must carry `jsonrpc: "2.0"` and one of `result` / `error`, and its `id`
 * must equal `expectedId`. Anything else is skipped and the scan continues; if
 * no frame qualifies the function returns `null`, which is the indeterminate
 * tier — the fail-safe direction on every caller.
 *
 * That the checks do not refuse a REAL answer was measured on the wire, not
 * assumed: a live `tools/list` POST to `brain.fifty.dev/mcp` carrying a uuid id
 * came back `content-type: text/event-stream` with
 * `data: {"result":{...},"jsonrpc":"2.0","id":"<that same uuid>"}` — so the
 * brain does not constrain the id to an integer, and its frames satisfy all
 * three conditions (2026-08-24).
 *
 * SCOPE OF THAT MEASUREMENT, stated because it is narrower than the claim it
 * supports. `tools/list` on a session-less brain takes the AUTO-CREATE-SESSION
 * branch (`brain-mcp-server/src/index.ts:1358-1381`). The `tools/call` this
 * module actually sends takes the SESSION-INJECTION branch (`:1336-1343`) when
 * a session already exists. The measurement therefore does not exercise this
 * module's own request path. It generalises because the id echo is the SDK's
 * response serialisation, which both branches share — but that is an argument,
 * not the measurement, and a reader should not infer otherwise.
 *
 * A JSON-RPC NOTIFICATION is excluded TWICE over — it carries neither `result`
 * nor `error`, and it carries no `id` — so keep-alive and progress frames on
 * the same stream cannot be read as this call's answer. Do not read that as an
 * attribution to either check on its own; the three are a conjunction, and any
 * mutation census over them has to isolate one at a time.
 */
function readSseJsonRpc(body: string, expectedId: unknown): unknown {
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (data.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const msg = parsed as Record<string, unknown>;
    if (msg.jsonrpc !== "2.0") continue;
    const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
    const hasError = Object.prototype.hasOwnProperty.call(msg, "error");
    if (!hasResult && !hasError) continue;
    if (msg.id !== expectedId) continue;
    return parsed;
  }
  return null;
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
 *     "id":      "<a fresh uuid per call — see newMcpRequestId>"
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

  // Fresh per CALL, not per module — see `newMcpRequestId`. The same value is
  // sent on the wire and handed to the reader below, so the outbound body and
  // the SSE correlation cannot drift apart.
  const requestId = newMcpRequestId();

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
    id: requestId,
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
          Accept: MCP_ACCEPT,
          Authorization: `Bearer ${remote.apiKey}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let overflowed = false;
        res.on("data", (c) => {
          if (overflowed) return;
          const chunk = c as Buffer;
          received += chunk.length;
          if (received > MCP_MAX_RESPONSE_BYTES) {
            // Bounded buffering (BR-094 round 2). Drop what we have rather than
            // hold it, kill the socket so the peer stops sending, and settle as
            // a transport failure — the fail-safe verdict on both callers.
            overflowed = true;
            chunks.length = 0;
            try {
              res.destroy();
            } catch {
              // ignore
            }
            settle({
              statusCode: 0,
              body: `response body exceeded ${MCP_MAX_RESPONSE_BYTES} bytes; aborted`,
              json: null,
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (overflowed) return;
          const respBody = Buffer.concat(chunks).toString("utf-8");
          let parsedJson: unknown = null;
          if (res.statusCode === 200) {
            const ct = res.headers["content-type"];
            parsedJson = readMcpResponseBody(
              respBody,
              typeof ct === "string" ? ct : "",
              requestId,
            );
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
