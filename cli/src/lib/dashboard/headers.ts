/**
 * FR-238 — response headers applied to EVERY dashboard response.
 *
 * Its own module deliberately: both `server.ts` (JSON / text / the
 * bundle-missing page) and `static.ts` (file responses) need these, and
 * `server.ts` already imports `static.ts` — defining them in either would
 * create an import cycle. One module, one definition, no cycle, and a single
 * place to add the next header.
 *
 * `X-Content-Type-Options: nosniff` closes the `<script src=...>`
 * JSON-hijacking route: a cross-origin page cannot get a JSON body executed as
 * script.
 *
 * `X-Frame-Options: DENY` **and** CSP `frame-ancestors 'none'` close framing.
 * Both, because they are honoured by different browser generations and
 * `frame-ancestors` is the one that survives.
 *
 * Today the framing headers are defence in depth, not a live fix: every
 * endpoint is a read, there are no cookies and no ambient authority, so a
 * clickjack has nothing to actuate. They land NOW because FR-241 adds the
 * first WRITE endpoint — at which point a framed dashboard becomes a real
 * clickjacking target — and retrofitting a header across four briefs' worth of
 * response paths is strictly harder than adding it while one module emits them.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};
