import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * FR-238 — dashboard bundle build config.
 *
 * `base: './'` is load-bearing, not cosmetic: the bundle is served by the
 * CLI's own `node:http` server from an arbitrary loopback origin, and R1 (the
 * packaging risk) is precisely that an absolute `/assets/...` base breaks
 * under a globally-installed layout. Origin-relative URLs are immune.
 *
 * `outDir` lands inside `cli/dist/`, which `cli/package.json` `files` already
 * ships as `"dist"` — so no manifest change is needed (D6).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    // AC #4: no runtime network fetch. Inlining is fine, off-origin is not.
    assetsInlineLimit: 4096,
    sourcemap: false,
    // Keep the tarball honest — a silent chunk-size regression is a budget
    // regression (FR-238 D2).
    //
    // Raised 400 -> 520 by FR-239. The vendored `force-graph` is ~178 KB
    // minified (+55.3 KB packed, measured), which puts the single app chunk at
    // ~477 KB and made this warning fire on EVERY build. A warning that always
    // fires is a warning people learn to scroll past, which is worse than no
    // warning at all — so the threshold moves to sit just above the real
    // post-FR-239 size and keeps its ability to catch the next surprise.
    // The authoritative gate remains `tarball.test.ts`'s packed-size ceiling.
    //
    // Raised 520 -> 560 by FR-240 for the SAME reason, not a different one. Its
    // four views, the shared record components and the in-repo markdown renderer
    // put the chunk at 524.69 KB minified (measured), 4.69 KB past the FR-239
    // threshold — so the warning had started firing on every build again. It
    // moves to sit just above the real post-FR-240 size.
    //
    // FR-240 deliberately did NOT touch `PACK_HARD_CEILING_DELTA`: the packed
    // delta measured +48.4 KB for this brief, +331.8 KB cumulative against the
    // +400 KB ceiling, leaving ~68.2 KB for FR-241 (re-measured at the end of
    // the warden pass — `tarball.test.ts` carries the full provenance and the
    // two earlier, now-superseded readings). Note the two numbers move very
    // differently — this one is one minified chunk, that one is the whole
    // gzipped tarball. Only that one is a gate.
    chunkSizeWarningLimit: 560,
  },
});
