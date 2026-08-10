/**
 * FR-238 — the loopback-only HTTP server behind `igris dashboard`.
 *
 * SECURITY POSTURE (D4). This is the first network listener the CLI has ever
 * opened, so the posture is stated explicitly rather than assumed:
 *
 *   - binds `127.0.0.1` ONLY. Never `0.0.0.0`, never a configurable host.
 *   - `Host`-header allowlist (`127.0.0.1:<port>` / `localhost:<port>` /
 *     `[::1]:<port>`) -> 403 otherwise. This is what defeats DNS rebinding: a
 *     malicious page resolving `evil.test` to 127.0.0.1 reaches the socket but
 *     fails the header check.
 *   - NO CORS headers. Absent `Access-Control-Allow-Origin`, a cross-origin
 *     page cannot read a response even if it can cause the request.
 *   - `Cache-Control: no-store` on every `/api/*` response, so "reload shows
 *     current state" (an AC) cannot be defeated by a cached payload.
 *   - path-traversal guard on every static read (`static.ts#resolveStatic`).
 *
 * THE ONE WRITE ENDPOINT (FR-241) — AND WHY IT IS SAFE
 * ----------------------------------------------------
 * FR-238 through FR-240 shipped ZERO write endpoints and this header said so.
 * FR-241 adds exactly one: **`POST /api/triage`**. Nothing else accepts a POST,
 * and `/api/triage` accepts nothing else. Five fences stand in front of it, and
 * each one is here because it blocks a DIFFERENT attack:
 *
 *   1. **Method.** GET/HEAD everywhere; POST only on `/api/triage`. Every other
 *      path still 405s on a POST, so the write surface is one path, not a
 *      posture.
 *   2. **`Host` allowlist** (pre-existing). Defeats DNS rebinding — a page
 *      resolving `evil.test` to 127.0.0.1 reaches the socket and fails here.
 *   3. **`Origin` allowlist.** Absent (a `curl`, the `--smoke` probe) or exactly
 *      the served origin -> allowed; anything else -> 403. This is what stops a
 *      page on another origin firing a mutation whose RESPONSE it cannot read
 *      (the no-CORS posture only protects the response, not the side effect).
 *   4. **`Content-Type: application/json` required -> 415.** This is the fence
 *      that actually blocks the classic no-JS CSRF: an HTML `<form>` can POST
 *      cross-origin without a preflight, but it can only send
 *      `application/x-www-form-urlencoded`, `multipart/form-data` or
 *      `text/plain`. Requiring JSON forces a preflight, which fence 3 then
 *      answers.
 *   5. **64 KB body cap -> 413**, enforced while READING rather than after, so
 *      an unbounded upload cannot be buffered first and rejected second.
 *
 * What this does NOT defend against, stated rather than implied: a malicious
 * extension or another process running as the operator on this same machine.
 * A loopback personal tool cannot, and this brief does not pretend to.
 *
 * The mutation itself performs no SQL here — `routes.ts#triage` delegates every
 * write to the brain's own gateway through `brain-write-bridge.ts`'s frozen
 * frozen map (five rows at FR-241, SEVEN since FR-247's two brief writes).
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as routes from "./routes.js";
import { SECURITY_HEADERS } from "./headers.js";
import { bundleIndexPath, bundlePresent, resolveStatic, serveFile } from "./static.js";

/** The preferred port. Falls back to an OS-assigned one when taken (D4). */
export const DEFAULT_PORT = 7317;

export const LOOPBACK_HOST = "127.0.0.1";

export interface DashboardServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartServerOptions {
  /** Exact port. When omitted, `DEFAULT_PORT` then an OS-assigned port. */
  port?: number;
  /** When true, an unavailable `port` is a hard failure (explicit `--port`). */
  exactPort?: boolean;
  /** Reported by `/api/health`. */
  cliVersion: string;
}

/** Hostnames that may appear in a `Host` header for a loopback server. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** FR-241 — the ONE path that accepts a POST. */
export const WRITE_PATH = "/api/triage";

/**
 * FR-241 — max accepted request-body size, in bytes.
 *
 * `MAX_BULK` (200) ids plus a 2 KB reason is well under 8 KB; 64 KB is generous
 * headroom that still refuses an upload long before it costs memory.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Is this `Origin` allowed to POST?
 *
 * THREE CASES, and the middle one is the load-bearing choice:
 *  - ABSENT -> allowed. `curl`, the `--smoke` probe and any non-browser client
 *    send no `Origin`. Refusing it would break the smoke gate while stopping no
 *    browser attack, because a browser ALWAYS sets `Origin` on a cross-origin
 *    POST.
 *  - EXACTLY the served origin -> allowed. Compared as a whole string against
 *    both loopback spellings, never by `startsWith`: `http://127.0.0.1:7317` is
 *    a prefix of `http://127.0.0.1:7317.evil.test`.
 *  - anything else -> 403.
 *
 * `null` (the literal string a sandboxed iframe or a redirected request sends)
 * falls into the third case and is refused — it is not the absent header.
 */
export function isOriginAllowed(
  origin: string | undefined,
  port: number,
): boolean {
  if (origin === undefined) return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(origin);
}

/** Is the declared `Content-Type` JSON? Parameters (`; charset=utf-8`) are fine. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/**
 * Read a request body with a HARD cap.
 *
 * The cap is enforced as chunks ARRIVE, not after: buffering an unbounded
 * upload and then measuring it is the failure mode a cap exists to prevent.
 * `Content-Length` is checked first as a courtesy — it is a claim, not a fact,
 * so the streaming check is the one that actually holds.
 *
 * IT PAUSES, IT DOES NOT DESTROY. The first draft called `req.destroy()` on
 * overflow, which resets the connection before a response can be written — a
 * `curl` saw HTTP status **000** (ECONNRESET) instead of the 413 the fence is
 * supposed to state, so an operator hitting the cap got "connection reset by
 * peer" and no idea why. Found by driving a 1 MB body at a real server rather
 * than by reading this function. `pause()` stops consuming, the caller writes
 * the 413, and the caller destroys the socket AFTER the response is out.
 * FR-241 Phase 5 re-drove that same 1 MB body at `curl` against an
 * OUT-OF-PROCESS server and re-confirmed `CODE=413` with a readable body — see
 * the call site for the transcript and for why Node's `http.request` client
 * cannot observe it.
 */
function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (
      r: { ok: true; text: string } | { ok: false; status: number; reason: string },
    ): void => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };

    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.pause();
      settle({
        ok: false,
        status: 413,
        reason: `body too large (${declared} bytes; max ${MAX_BODY_BYTES})`,
      });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        settle({
          ok: false,
          status: 413,
          reason: `body too large (max ${MAX_BODY_BYTES} bytes)`,
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf-8") }));
    req.on("error", (err) =>
      settle({ ok: false, status: 400, reason: `request read failed: ${err.message}` }),
    );
  });
}


/**
 * Validate the `Host` header against the port we are actually listening on.
 *
 * A missing Host is rejected: every HTTP/1.1 client sends one, and an absent
 * header is more likely a hand-rolled probe than a browser.
 */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const lastColon = host.lastIndexOf(":");
  // An IPv6 literal ends in `]`; a bare `[::1]` with no port has no port part.
  const hasPort = lastColon > host.lastIndexOf("]");
  const hostname = hasPort ? host.slice(0, lastColon) : host;
  const portPart = hasPort ? host.slice(lastColon + 1) : "";
  if (!ALLOWED_HOSTNAMES.has(hostname.toLowerCase())) return false;
  if (portPart === "") return port === 80;
  return portPart === String(port);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Never let a cached API response mask live brain state (AC "data is live").
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

/**
 * The bundle-missing fallback page.
 *
 * Deliberately a plain, self-contained document with no external reference: if
 * the bundle is absent the shell's CSS is absent too, and pointing at a
 * stylesheet that does not exist would be a second failure on top of the first.
 */
function bundleMissingHtml(): string {
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<title>IGRIS — dashboard bundle missing</title></head>",
    "<body style=\"background:#0d0a08;color:#f6efe6;font-family:ui-monospace,monospace;padding:48px\">",
    "<h1 style=\"font-size:20px;letter-spacing:.2em\">DASHBOARD BUNDLE MISSING</h1>",
    `<p>Expected a built bundle at <code>${bundleIndexPath()}</code>.</p>`,
    "<p>Run <code>npm run build</code> in <code>cli/</code> to build it.</p>",
    "</body></html>",
  ].join("");
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  cliVersion: string,
): Promise<void> {
  // ONE write endpoint. Anything that is not a read, and is not a POST to
  // exactly `WRITE_PATH`, is refused before any routing happens.
  const isPost = req.method === "POST";
  if (req.method !== "GET" && req.method !== "HEAD" && !isPost) {
    sendJson(res, 405, {
      error: "method not allowed",
      allow: ["GET", "HEAD", "POST"],
    });
    return;
  }

  if (!isHostAllowed(req.headers.host, port)) {
    sendText(res, 403, "forbidden: unexpected Host header");
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
  } catch {
    sendJson(res, 400, { error: "malformed request URL" });
    return;
  }

  const pathname = url.pathname;
  const project = url.searchParams.get("project");

  // FR-241 — the write path. Handled BEFORE the read routes so no GET handler
  // can ever see a POST, and so a POST at any other path 405s here rather than
  // falling through to the static server.
  if (isPost) {
    if (pathname !== WRITE_PATH) {
      sendJson(res, 405, {
        error: `POST is accepted only at ${WRITE_PATH}`,
        allow: ["GET", "HEAD"],
      });
      return;
    }
    if (!isOriginAllowed(req.headers.origin, port)) {
      sendJson(res, 403, {
        error: "forbidden: cross-origin write",
        detail: `Origin '${String(req.headers.origin)}' is not the served origin`,
      });
      return;
    }
    if (!isJsonContentType(req.headers["content-type"])) {
      // 415, not 400: the body may be perfectly valid: it is the DECLARED type
      // that is refused, and that refusal is the CSRF fence (an HTML form
      // cannot set this header).
      sendJson(res, 415, {
        error: "unsupported media type: Content-Type must be application/json",
      });
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.reason });
      // The response is written; NOW stop the sender. Without this the socket
      // stays open with an unread stream and the connection hangs until the
      // client gives up — and with `req.destroy()` BEFORE the write, the client
      // sees a reset instead of the 413 (see `readBody`'s header).
      //
      // FR-241 PHASE 5 RE-VERIFIED THIS AT A REAL CLIENT rather than trusting
      // the paragraph above. Server started in its OWN process (an in-process
      // `execFileSync` probe blocks the event loop and makes EVERY request
      // appear to hang — a measurement artifact that briefly read as a defect):
      //
      //   curl -X POST -H 'content-type: application/json' \
      //        --data-binary @1MB.json  ->  {"error":"body too large
      //        (1000048 bytes; max 65536)"}|CODE=413   (curl exit 0)
      //   the same request with a 47-byte body      ->  CODE=200
      //
      // So this shape is CORRECT as written and was NOT changed. Node's own
      // `http.request` client is the one that cannot observe it: it raises
      // EPIPE while still uploading and discards the parsed response, which is
      // why `dashboard-server.test.ts`'s G-SEC-1 drives this case with `fetch`.
      res.on("finish", () => req.destroy());
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch (err) {
      sendJson(res, 400, {
        error: `malformed JSON body: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const result = await routes.triage(parsed);
    sendJson(res, result.status, result.payload);
    return;
  }

  // A GET at the write path is a 405, not a 404: the path EXISTS, the method is
  // wrong, and saying "no such endpoint" would send a reader hunting for a
  // routing bug that is not there.
  if (pathname === WRITE_PATH) {
    sendJson(res, 405, {
      error: `${WRITE_PATH} accepts POST only`,
      allow: ["POST"],
    });
    return;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, await routes.health(cliVersion));
    return;
  }
  if (pathname === "/api/projects") {
    sendJson(res, 200, routes.projects());
    return;
  }
  if (pathname === "/api/summary") {
    sendJson(res, 200, routes.summary(project));
    return;
  }
  if (pathname === "/api/graph/stats") {
    sendJson(res, 200, await routes.graphStats(project));
    return;
  }
  // FR-239. Ordered AFTER `/api/graph/stats` for readability only — these are
  // exact-match comparisons, not prefixes, so neither can shadow the other.
  if (pathname === "/api/graph") {
    sendJson(res, 200, await routes.graph(project));
    return;
  }

  // FR-240 — the four layer views, nine paths (ten since FR-246 added
  // `/api/briefs/search`). All exact-match, so
  // `/api/learnings/search` cannot be shadowed by `/api/learnings` regardless of
  // order; it is listed adjacent to its sibling for readability.
  //
  // The handlers take the WHOLE `URLSearchParams` rather than pre-extracted
  // strings: filter sets differ per layer, and threading 5 nullable strings per
  // route through this switch would put the parameter contract in two places.
  // `params.ts` owns the clamping and allowlisting; this function stays a router.
  const query = url.searchParams;
  if (pathname === "/api/briefs") {
    sendJson(res, 200, await routes.briefs(query));
    return;
  }
  // FR-246 — the ONE path this brief adds. Exact-match like its siblings, so
  // it cannot be shadowed by `/api/briefs`; listed adjacent for readability,
  // mirroring the `/api/learnings/search` pair below.
  if (pathname === "/api/briefs/search") {
    sendJson(res, 200, await routes.briefsSearch(query));
    return;
  }
  // FR-248 — the ONE path this brief adds, and the eighteenth on the surface.
  // Placed adjacent to the two per-layer search paths because it is their
  // fusion, not a sibling of the browse routes. Exact-match like every route in
  // this function, so nothing here can shadow anything.
  if (pathname === "/api/search") {
    sendJson(res, 200, await routes.fusedSearch(query));
    return;
  }
  if (pathname === "/api/brief") {
    sendJson(res, 200, await routes.brief(query));
    return;
  }
  if (pathname === "/api/learnings/search") {
    sendJson(res, 200, await routes.learningsSearch(query));
    return;
  }
  if (pathname === "/api/learnings") {
    sendJson(res, 200, await routes.learnings(query));
    return;
  }
  if (pathname === "/api/learning") {
    sendJson(res, 200, await routes.learning(query));
    return;
  }
  if (pathname === "/api/context-docs") {
    sendJson(res, 200, routes.contextDocs(query));
    return;
  }
  if (pathname === "/api/context-doc") {
    sendJson(res, 200, routes.contextDoc(query));
    return;
  }
  if (pathname === "/api/goals") {
    sendJson(res, 200, await routes.goals(query));
    return;
  }
  if (pathname === "/api/goal") {
    sendJson(res, 200, await routes.goal(query));
    return;
  }

  // FR-241 — the triage READ half. Same `openReadContext()` door as the nine
  // above, which is why it joins `LAYER_PATHS` in the read-only crawl.
  if (pathname === "/api/suggestions") {
    sendJson(res, 200, await routes.suggestions(query));
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: `no such endpoint: ${pathname}` });
    return;
  }

  if (!bundlePresent()) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    });
    res.end(bundleMissingHtml());
    return;
  }

  const resolved = resolveStatic(pathname);
  if (resolved.kind === "traversal") {
    sendText(res, 403, "forbidden");
    return;
  }
  if (resolved.kind === "file") {
    serveFile(res, resolved.path);
    return;
  }

  // SPA fallback: an unknown non-asset path is a client route, not a 404. An
  // unknown path UNDER a bundled asset dir is a genuine miss, so it 404s —
  // otherwise a mistyped script src would silently return HTML and surface as
  // an inscrutable MIME error in the console.
  if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) {
    sendText(res, 404, "not found");
    return;
  }
  serveFile(res, bundleIndexPath());
}

/**
 * Bind the server.
 *
 * Port ladder (D4): `opts.port` when given; otherwise `DEFAULT_PORT`, falling
 * back to an OS-assigned port on EADDRINUSE. An EXPLICIT `--port` never falls
 * back — explicit intent is not silently reassigned.
 */
export function startServer(
  opts: StartServerOptions,
): Promise<DashboardServer> {
  const wanted = opts.port ?? DEFAULT_PORT;
  const allowFallback = opts.exactPort !== true;

  const bind = (port: number): Promise<Server> =>
    new Promise((resolvePromise, rejectPromise) => {
      const server = createServer((req, res) => {
        const listening = server.address();
        const actual =
          typeof listening === "object" && listening !== null
            ? listening.port
            : port;
        handle(req, res, actual, opts.cliVersion).catch((err: unknown) => {
          // Last-resort net: a handler throw must not take the process down.
          // Any degraded-brain path already returns 200 above, so reaching
          // here means a genuine bug — report it as a 500 without a stack.
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: "internal error",
              detail: err instanceof Error ? err.message : String(err),
            });
          } else {
            res.destroy();
          }
        });
      });
      server.on("error", rejectPromise);
      server.listen(port, LOOPBACK_HOST, () => {
        server.removeListener("error", rejectPromise);
        resolvePromise(server);
      });
    });

  const finish = (server: Server): DashboardServer => {
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : wanted;
    return {
      server,
      port,
      url: `http://${LOOPBACK_HOST}:${port}/`,
      close: () =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          // `closeAllConnections` is what makes SIGINT actually exit while a
          // browser holds a keep-alive socket open. Without it, `close()`
          // waits for the idle timeout and the terminal appears hung.
          server.closeAllConnections();
        }),
    };
  };

  return bind(wanted)
    .then(finish)
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "EADDRINUSE" && allowFallback) {
        // 0 = OS-assigned. Always print the ACTUAL url afterwards.
        return bind(0).then(finish);
      }
      throw err;
    });
}
