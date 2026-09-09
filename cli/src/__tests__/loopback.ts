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
  /**
   * The request's own headers, lower-cased keys, exactly as node parsed them.
   * Added (BR-094) so a test can assert what the CLI SENDS, not only what it
   * does with the answer: the 406 that broke every remote drain was an
   * outbound-header defect, and no fixture here could see one.
   */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * One SSE frame in the SDK's own `writeSSEEvent` shape (BR-094):
 * `event: message\n` + an OPTIONAL `id: <eventId>\n` resumability cursor +
 * `data: <json>\n\n`. Transcribed from
 * `@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js`
 * (`writeSSEEvent`) rather than hand-typed from the shape a reader would
 * prefer — the frame's `id:` line is NOT the JSON-RPC id, and that is exactly
 * the confusion a hand-written fixture would hide.
 *
 * Lives here rather than in one test file (BR-094 round 2) because the
 * boot-sync suite needs the same shape: its `queue_drain` digest was pinned
 * only on the `application/json` arm, which a live brain session never returns.
 */
export function sseFrame(json: string, eventId?: number): string {
  const cursor = eventId === undefined ? "" : `id: ${eventId}\n`;
  return `event: message\n${cursor}data: ${json}\n\n`;
}

/**
 * The JSON-RPC id the CLI put on THIS request, read straight out of the raw
 * captured body (BR-094 round 2).
 *
 * `mcpCall` mints a fresh uuid per call, so a fixture that hardcodes an id no
 * longer speaks the protocol: on the SSE arm the reader correlates and would
 * refuse the answer, and on the JSON arm it would be a standing lie that hides
 * any future correlation there.
 *
 * Deliberately NOT wrapped in try/catch. If the captured body is not JSON this
 * throws and reds the test, which is the honest outcome — swallowing it would
 * yield `undefined`, and an envelope carrying `id: undefined` serialises with
 * NO id at all, which the reader skips. Every such fixture would then quietly
 * become an indeterminate-tier test that still passes its "queue preserved"
 * assertions for entirely the wrong reason.
 */
export function rpcRequestId(call: CapturedCall): unknown {
  return (JSON.parse(call.rawBody) as { id?: unknown }).id;
}

/**
 * The JSON-RPC 2.0 success envelope the brain's `/mcp` endpoint actually
 * returns for a `tools/call` that did not throw.
 *
 * BR-080: the CLI now READS this body rather than trusting `statusCode === 200`
 * (a thrown tool error also arrives at HTTP 200, wrapped as
 * `{content:[...], isError:true}`). A fixture returning a bare `{ok:true}` is
 * therefore classified INDETERMINATE — correct, but it means the shorthand
 * bodies these tests used are no longer "a success". Fixtures that need a
 * success must speak the real protocol; use this helper rather than hand-rolling
 * the shape per test.
 *
 * BR-094 round 2: `id` is the FIRST parameter and it is REQUIRED, so that every
 * call site has to decide what it echoes rather than inherit a default. Pass
 * `rpcRequestId(call)`. The forcing function is the point — the previous
 * signature defaulted the id to `1`, which matched the CLI's then-constant id
 * and so kept passing when the constant became the defect.
 */
export function mcpOkEnvelope(id: unknown, text = "ok"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    result: { content: [{ type: "text", text }] },
    id,
  });
}

/**
 * Build a loopback HTTP server that captures every request body (parsed as
 * JSON-RPC if possible) and lets the test choose how to respond.
 *
 * `respond(call, callIndex)` returns `{ status, body }` where body is sent
 * verbatim as the response payload. The server must be `.listen()`-ed by
 * the caller and `.close()`-ed in cleanup.
 *
 * `contentType` is optional and defaults to `application/json` — the shape
 * every pre-BR-094 fixture assumed. Pass `text/event-stream` to speak the
 * brain's OTHER live wire shape (the transport path); `mcpCall` selects its
 * reader off this header, so a fixture that omits it is not an SSE fixture.
 */
export function makeLoopback(
  respond: (call: CapturedCall, callIndex: number) =>
    | { status: number; body: string; contentType?: string }
    | Promise<{ status: number; body: string; contentType?: string }>,
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
          headers: req.headers,
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
        const { status, body, contentType } = await respond(
          call,
          calls.length - 1,
        );
        res.writeHead(status, {
          "Content-Type": contentType ?? "application/json",
        });
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
