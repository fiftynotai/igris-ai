/**
 * loopback.ts — shared HTTP loopback helper for vitest cases.
 *
 * NOTE: filename intentionally lacks the `.test.` infix so vitest's default
 * include glob (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) does NOT pick this up
 * as a test file. See TD-126.
 *
 * Extracted from sync-data.test.ts (TD-119 / TD-126). Now consumed by
 * sync-data.test.ts and channel.test.ts (TD-127). Add new consumers as
 * additional tests need a real loopback server with captured-call inspection.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedCall {
  jsonrpc?: string;
  method?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  rawBody: string;
  /**
   * HTTP request method (`GET` / `POST` / …). Distinct from `method` above,
   * which is the JSON-RPC method (`tools/call`) parsed from a POST body. Added
   * (FR-195 M3) so GET-endpoint tests (e.g. `GET /sync/pull`) can assert the
   * verb + path; #356 requires asserting the exact endpoint, not 200-any-path.
   */
  httpMethod?: string;
  /** Raw request URL incl. query string (e.g. `/sync/pull?since_learnings=...`). */
  url?: string;
}

/**
 * Build a loopback HTTP server that captures every request body (parsed as
 * JSON-RPC if possible) and lets the test choose how to respond.
 *
 * `respond(call, callIndex)` returns `{ status, body }` where body is sent
 * verbatim as the response payload. The server must be `.listen()`-ed by
 * the caller and `.close()`-ed in cleanup.
 */
export function makeLoopback(
  respond: (call: CapturedCall, callIndex: number) =>
    | { status: number; body: string }
    | Promise<{ status: number; body: string }>,
): { server: ReturnType<typeof createServer>; calls: CapturedCall[]; port: () => number } {
  const calls: CapturedCall[] = [];
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      let buf = "";
      req.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
      });
      req.on("end", async () => {
        const call: CapturedCall = {
          rawBody: buf,
          httpMethod: req.method,
          url: req.url,
        };
        try {
          const parsed = JSON.parse(buf) as {
            jsonrpc?: string;
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          call.jsonrpc = parsed.jsonrpc;
          call.method = parsed.method;
          call.toolName = parsed.params?.name;
          call.args = parsed.params?.arguments;
        } catch {
          // leave fields undefined
        }
        calls.push(call);
        const { status, body } = await respond(call, calls.length - 1);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    },
  );
  return {
    server,
    calls,
    port: () => (server.address() as AddressInfo).port,
  };
}
