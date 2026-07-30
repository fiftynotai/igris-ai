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
    chunkSizeWarningLimit: 520,
  },
});
