import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * TD-347 — an env-gated bundle COMPOSITION report.
 *
 * `DASH_BUNDLE_REPORT=1 bash cli/scripts/build-dashboard.sh` writes
 * `dist/dashboard/.bundle-report.json`: for every emitted chunk, the bytes each
 * module contributed (`renderedLength`, i.e. post-transform and post-treeshake
 * but pre-minify), grouped by top-level `node_modules/<pkg>` and by
 * `src/<dir>`.
 *
 * WHY THIS AND NOT `rollup-plugin-visualizer`: no new dependency, and the
 * question TD-347 had to answer is "which named package is in which chunk, in
 * bytes" — a number the ledger quotes — not "what does the treemap look like".
 *
 * WHY IT IS GATED: a normal build must emit nothing extra into
 * `dist/dashboard/`, which `cli/package.json` `files` ships wholesale. The
 * report is a diagnostic, not an artifact.
 */
function bundleReport(): Plugin {
  return {
    name: "igris-bundle-report",
    apply: "build",
    generateBundle(_options, bundle) {
      if (process.env.DASH_BUNDLE_REPORT !== "1") return;
      const group = (id: string): string => {
        const nm = id.lastIndexOf("node_modules/");
        if (nm !== -1) {
          const rest = id.slice(nm + "node_modules/".length).split("/");
          return `node_modules/${rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]}`;
        }
        const src = id.lastIndexOf("/src/");
        if (src !== -1) return `src/${id.slice(src + "/src/".length).split("/")[0]}`;
        return "other";
      };
      const chunks = [];
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type !== "chunk") continue;
        const byGroup: Record<string, number> = {};
        const own: Array<{ module: string; bytes: number }> = [];
        let total = 0;
        for (const [id, mod] of Object.entries(out.modules)) {
          const n = mod.renderedLength;
          if (n === 0) continue;
          total += n;
          const g = group(id);
          byGroup[g] = (byGroup[g] ?? 0) + n;
          // First-party modules are listed INDIVIDUALLY as well as grouped:
          // "which chunk is my change charged against" is a per-FILE question,
          // and `src/pages` aggregated over four pages cannot answer it.
          const src = id.lastIndexOf("/src/");
          if (src !== -1) own.push({ module: id.slice(src + 1), bytes: n });
        }
        chunks.push({
          file,
          isEntry: out.isEntry,
          isDynamicEntry: out.isDynamicEntry,
          name: out.name,
          renderedTotal: total,
          groups: Object.entries(byGroup)
            .sort((a, b) => b[1] - a[1])
            .map(([g, bytes]) => ({ group: g, bytes })),
          srcModules: own.sort((a, b) => b.bytes - a.bytes),
        });
      }
      chunks.sort((a, b) => b.renderedTotal - a.renderedTotal);
      this.emitFile({
        type: "asset",
        fileName: ".bundle-report.json",
        source: JSON.stringify({ chunks }, null, 2),
      });
    },
  };
}

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
  plugins: [react(), tailwindcss(), bundleReport()],
  base: "./",
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    // AC #4: no runtime network fetch. Inlining is fine, off-origin is not.
    assetsInlineLimit: 4096,
    sourcemap: false,
    // ─────────────────────────────────────────────────────────────────────
    // A SURPRISE DETECTOR. NOT THE GATE. (TD-347 lowered 560 -> 300.)
    // ─────────────────────────────────────────────────────────────────────
    // THE GATE IS `cli/src/__tests__/dashboard-chunks.test.ts`, which asserts
    // an INITIAL-LOAD ceiling and a TOTAL ceiling over the built artifact and
    // can go RED. This number is a build-time WARNING: `build-dashboard.sh`
    // runs `vite build` and exits 0 whether it fires or not. Read that
    // sentence before treating a green build as a green budget — for six
    // briefs this line WAS the whole chunk budget, and that is the defect
    // TD-347 fixed.
    //
    // WHAT THIS NUMBER IS FOR NOW: one loud, always-visible alarm on the
    // LARGEST single chunk, sitting just above it so it is capable of firing.
    // At 560 with no post-split chunk within 250 KB of it, it could never fire
    // again and measured nothing — a threshold nothing can reach is not a
    // lenient threshold, it is an absent one.
    //
    // THE RULE, so the next planner does not have to re-derive it: keep this
    // just above the LARGEST measured chunk. It is deliberately TIGHTER than
    // the gate's initial-set ceiling (which carries 24_000 B of headroom), so
    // eager growth shows up as a warning on the build BEFORE it shows up as a
    // red test. Early alarm, then gate.
    //
    // HISTORY, kept because each move was the same argument at a different
    // size: 400 -> 520 (FR-239, the vendored `force-graph` put the single app
    // chunk at ~477 KB and the warning fired on every build); 520 -> 560
    // (FR-240, four views + the record components + the in-repo markdown
    // renderer took it to 524.69 KB). Both raises had the same justification —
    // a warning that always fires is one people learn to scroll past. TD-347
    // is the first move DOWNWARD, and it is a different act: the route split
    // removed the bytes rather than accommodating them.
    //
    // REJECTED HERE, RECORDED SO IT IS NOT RE-PROPOSED (TD-347):
    //  - a vendor `build.rollupOptions.output.manualChunks` split — moves
    //    ~190 KB of React out of the entry FILE and changes the initial LOAD by
    //    343 B, because the browser fetches the vendor chunk before it can run
    //    the entry. It shrinks the headline this warning watches while buying
    //    essentially nothing. The gate reads the modulepreload closure precisely
    //    so it refuses the trick; TD-347's plant C is the recorded
    //    demonstration (entry file 285_390 -> 95_394 B, initial set 285_390 ->
    //    285_047 B, gate GREEN and correctly so).
    //    NOTE THE FORM, because the obvious one does not build here: under
    //    Vite 8 / rolldown the OBJECT form `manualChunks: { vendor: [...] }`
    //    throws `TypeError: manualChunks is not a function`. Plant C had to use
    //    the function form, `manualChunks: (id) => ... ? "react" : undefined`.
    //    Recorded so this note reads as a description and not as a recipe.
    //  - an idle-time PREFETCH of the lazy route chunks — it re-charges the
    //    initial load in a form a byte gate cannot see, and directly
    //    contradicts G-BR-15's `15d` deferral check. If the cold-nav cost ever
    //    justifies it, that is its own brief with its own gate, not a tweak
    //    here.
    //
    // NOTE THE UNITS: Vite reports kB as 1000 bytes. `PACK_HARD_CEILING_DELTA`
    // in `tarball.test.ts` is KiB over the whole gzipped tarball and is a
    // different measurement of a different thing. TD-347 did not touch it.
    chunkSizeWarningLimit: 300,
  },
});
