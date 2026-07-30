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
 *   - ZERO write endpoints. Only GET and HEAD are routed at all; FR-241 owns
 *     the write path and will have to add it deliberately.
 *   - path-traversal guard on every static read (`static.ts#resolveStatic`).
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
  // Zero write endpoints — anything that is not a read is refused before any
  // routing happens.
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed", allow: ["GET", "HEAD"] });
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

  // FR-240 — the four layer views, nine paths. All exact-match, so
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
