/**
 * FR-238 (T6 / T7) — the built dashboard bundle: present, current, and
 * network-free.
 *
 * T6 (AC #4) is the important one: "no network fetch at runtime — no CDN
 * scripts, no CDN fonts, fully local". That is not a property of the source, it
 * is a property of the BUILT ARTIFACT, so it is asserted against
 * `dist/dashboard/` bytes, not against `cli/dashboard/src`.
 *
 * T7 is the TD-276 stale-`dist` guard: `prepublishOnly` runs `npm run build`,
 * but a developer running the suite against a hand-built tree can still have a
 * bundle older than its sources. `build-dashboard.sh` builds unconditionally
 * (the braces); this is the belt.
 */

import { describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(CLI_ROOT, "dist", "dashboard");
const INDEX = join(BUNDLE, "index.html");
const SRC = join(CLI_ROOT, "dashboard", "src");
const PUBLIC = join(CLI_ROOT, "dashboard", "public");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Newest mtime of files that can actually change the BUNDLE.
 *
 * `__tests__` is excluded, and the exclusion is load-bearing rather than
 * cosmetic. FR-239 put the graph engine's unit tests under
 * `dashboard/src/graph/__tests__/` (per `coding_guidelines.md` §12, so the
 * `cli` vitest run reaches them). Nothing in `main.tsx`'s module graph imports
 * them, so Vite never sees them and they cannot make `dist/dashboard` stale —
 * but an unfiltered mtime walk counts them anyway, and a guard that fires on
 * an edit it knows is irrelevant is a guard people start ignoring.
 */
function newestMtime(dir: string): number {
  return walk(dir)
    .filter((f) => !f.includes(`${sep}__tests__${sep}`))
    .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
}

describe("T7 — the bundle is present", () => {
  it("dist/dashboard/index.html exists", () => {
    expect(
      existsSync(INDEX),
      `no bundle at ${BUNDLE} — run \`npm run build\` in cli/`,
    ).toBe(true);
  });

  it("every asset index.html references exists on disk", () => {
    const html = readFileSync(INDEX, "utf-8");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((r) => !r.startsWith("#") && !/^[a-z]+:/i.test(r));
    expect(local.length).toBeGreaterThan(0);
    for (const ref of local) {
      const rel = ref.replace(/^\.?\//, "");
      expect(existsSync(join(BUNDLE, rel)), `missing asset: ${ref}`).toBe(true);
    }
  });

  it("the three vendored font files ship", () => {
    for (const f of [
      "anton-latin-400-normal.woff2",
      "space-grotesk-latin-wght-normal.woff2",
      "jetbrains-mono-latin-400-normal.woff2",
    ]) {
      expect(existsSync(join(BUNDLE, "fonts", f)), `missing font: ${f}`).toBe(true);
    }
  });

  it("the SIL OFL notice ships beside the fonts", () => {
    expect(existsSync(join(BUNDLE, "fonts", "OFL.txt"))).toBe(true);
  });
});

describe("T7 — the bundle is CURRENT (TD-276 stale-dist guard)", () => {
  it("no source under dashboard/{src,public} is newer than the built index.html", () => {
    const built = statSync(INDEX).mtimeMs;
    const newestSrc = Math.max(newestMtime(SRC), newestMtime(PUBLIC));
    expect(
      newestSrc,
      "dist/dashboard is STALE — run `npm run build` in cli/",
    ).toBeLessThanOrEqual(built + 1000);
  });
});

describe("T6 — AC #4: no network fetch at runtime", () => {
  const bundleFiles = () =>
    walk(BUNDLE).filter((f) => /\.(html|js|css)$/.test(f));

  /**
   * NON-NAMESPACE off-origin string literals that are provably not fetch
   * targets, each verified by reading its surrounding bytes in the built
   * artifact.
   *
   * NOTE the scope: this list covers only the literals left after the
   * `http://www.w3.org/` XML-namespace class is skipped below. Measured on the
   * FR-238 bundle, the full inventory is 25 occurrences over 8 distinct URLs —
   * 21 namespace occurrences, plus the 4 covered here (`react.dev` appears
   * twice). Reading this list as the complete set of http literals in the
   * bundle is a mistake; it is the complete set of ADJUDICATED NON-NAMESPACE
   * ones.
   *
   * This is an ALLOWLIST, not a relaxation: any host not on it and not a w3.org
   * namespace fails the test below and has to be adjudicated the same way these
   * were. Adding an entry means someone read the surrounding bytes and
   * confirmed nothing fetches it.
   */
  const NON_FETCH_LITERALS: Array<{ url: string; why: string }> = [
    {
      url: "https://tailwindcss.com",
      why: "`/*! tailwindcss v4 | MIT License | ... */` — a CSS license banner comment",
    },
    {
      url: "https://react.dev/errors/",
      why: "React's error-decoder message string (`var t = '...' + code`) — printed to the console, never requested",
    },
    {
      url: "https://gsap.com",
      why: "GSAP's `GSAP target ... not found. https://gsap.com` console warning string",
    },
  ];

  /**
   * The real AC. An off-origin URL in a FETCH POSITION — `url(...)`, a
   * `src`/`href` attribute, a dynamic `import()`, `fetch()`, or `new URL()` —
   * is a runtime network dependency. An off-origin URL inside a comment or an
   * error message is not.
   */
  it("no off-origin URL appears in a fetch position", () => {
    const FETCH_POSITIONS = [
      /url\(\s*["']?(https?:\/\/[^)"']+)/gi,
      /\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi,
      /\bimport\s*\(\s*["'`](https?:\/\/[^"'`]+)/gi,
      /\bfetch\s*\(\s*["'`](https?:\/\/[^"'`]+)/gi,
      /\bnew\s+URL\s*\(\s*["'`](https?:\/\/[^"'`]+)/gi,
      /\bimportScripts\s*\(\s*["'`](https?:\/\/[^"'`]+)/gi,
    ];
    const offending: string[] = [];
    for (const file of bundleFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const re of FETCH_POSITIONS) {
        for (const m of text.matchAll(re)) {
          const url = m[1];
          if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) continue;
          offending.push(`${file}: ${m[0]}`);
        }
      }
    }
    expect(
      offending,
      `off-origin fetch targets in the bundle:\n${offending.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The tripwire. Every off-origin URL literal in the bundle must be on the
   * adjudicated allowlist above — so a NEW vendored dependency that phones
   * home cannot slip in behind the fetch-position check.
   */
  it("every off-origin URL literal is on the adjudicated non-fetch allowlist", () => {
    const unknown = new Set<string>();
    for (const file of bundleFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)\\,;]+/g)) {
        const url = m[0];
        // The server's OWN origin is not a network fetch.
        if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) continue;
        // XML NAMESPACE IDENTIFIERS — never fetched, by definition: a
        // namespace URI is an opaque identifier, not a locator.
        //
        // This class is the BULK of the bundle's http literals, not an edge
        // case: 21 of the 25 occurrences (5 distinct URLs — `2000/svg`,
        // `1999/xlink`, `XML/1998/namespace`, `1998/Math/MathML`,
        // `1999/xhtml`). Most come from react-dom's `createElementNS`,
        // `setAttributeNS` and `namespaceURI ===` comparisons; one is the
        // `xmlns` attribute of the grain SVG, which sits INSIDE a `data:` URI
        // in a CSS `url()`. That last one is why the fetch-position scan above
        // anchors on `url(` + optional-quote + `http`: the `url()` there opens
        // with `data:`, so it correctly does not match.
        if (url.startsWith("http://www.w3.org/")) continue;
        if (NON_FETCH_LITERALS.some((e) => url.startsWith(e.url))) continue;
        unknown.add(url);
      }
    }
    expect(
      [...unknown],
      "NEW off-origin URL literal(s) in the bundle. Read the surrounding bytes: " +
        "if it is a fetch target, AC #4 is broken; if it is a banner/diagnostic " +
        "string, add it to NON_FETCH_LITERALS with the evidence.",
    ).toEqual([]);
  });

  it("no Google Fonts / CDN host appears anywhere in the bundle", () => {
    for (const file of bundleFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const host of [
        "fonts.googleapis",
        "fonts.gstatic",
        "cdn.jsdelivr",
        "unpkg.com",
        "cdnjs.cloudflare",
        "esm.sh",
        "googletagmanager",
      ]) {
        expect(text.includes(host), `${file} references ${host}`).toBe(false);
      }
    }
  });

  it("index.html loads only same-origin relative assets", () => {
    const html = readFileSync(INDEX, "utf-8");
    for (const m of html.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      expect(/^[a-z]+:\/\//i.test(ref), `off-origin tag: ${ref}`).toBe(false);
      expect(ref.startsWith("//"), `protocol-relative tag: ${ref}`).toBe(false);
    }
  });

  it("every @font-face src is a relative, bundle-local woff2", () => {
    const css = walk(BUNDLE).filter((f) => f.endsWith(".css"));
    expect(css.length).toBeGreaterThan(0);
    for (const file of css) {
      const text = readFileSync(file, "utf-8");
      const urls = [...text.matchAll(/url\(([^)]+)\)/g)].map((m) =>
        m[1].replace(/["']/g, ""),
      );
      for (const u of urls) {
        if (u.startsWith("data:")) continue; // the grain SVG — inline, local
        expect(/^[a-z]+:\/\//i.test(u), `off-origin font url: ${u}`).toBe(false);
        const rel = u.replace(/^\.\.\//, "");
        expect(existsSync(join(BUNDLE, rel)), `missing font asset: ${u}`).toBe(true);
      }
    }
  });
});
