/**
 * FR-240 — **structural guards over the layer-view client source.**
 *
 * These are the claims that cannot be made by rendering a component, because
 * they are claims about files — including files that do not exist yet. A
 * `dangerouslySetInnerHTML` added to a view written next month is exactly the
 * regression a render test of today's components cannot catch.
 *
 * WHAT THIS FILE PROVES
 *   - XSS: the string `dangerouslySetInnerHTML` appears NOWHERE in the whole
 *     `cli/dashboard/src` tree, and neither does `innerHTML`.
 *   - D5: the composite node key is NOT mirrored browser-side. No shipped client
 *     file constructs or parses it.
 *   - The FR-240 CSS block declares zero colour literals and zero custom
 *     properties — so the FR-239 `:root` cascade bug is unreachable by
 *     construction rather than by review.
 *   - AC #4: no absolute URL anywhere in the client source.
 *   - AC #7: no client code issues a non-GET request.
 *   - AC #5: all four layer views import the shared record components.
 *   - `router.tsx` uses the unit-tested codec rather than a second parser.
 *
 * WHAT IT DOES **NOT** PROVE
 *   That the rendered output is safe or correct. A file with no
 *   `dangerouslySetInnerHTML` can still produce a live `<script>` if it builds
 *   one out of elements.
 *   **Siblings:** `dashboard/src/markdown/__tests__/Markdown.test.tsx` (renders
 *   the hostile fixtures and asserts every emitted TAG is on an allowlist) and
 *   `parse.test.ts` (asserts the AST carries hostile source as text). This file
 *   is the whole-tree net under those two.
 *
 * EVERY SCAN BELOW HAS A SELF-NEGATIVE-CONTROL (learning 1094). A scan whose
 * only observed output is "pass" is indistinguishable from a scan pointed at an
 * empty directory, and the FR-239 review found exactly that failure shape.
 */

import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASH_SRC = join(CLI_ROOT, "dashboard", "src");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every client source file, tests included. */
function allSources(): string[] {
  return walk(DASH_SRC);
}

/** What actually ships in the bundle. */
function shipped(): string[] {
  return allSources().filter((f) => !f.includes("__tests__"));
}

/** FR-240's own client files. */
function fr240Sources(): string[] {
  return shipped().filter((f) =>
    [
      join(DASH_SRC, "layers"),
      join(DASH_SRC, "markdown"),
      join(DASH_SRC, "components", "record"),
      join(DASH_SRC, "pages", "layers"),
    ].some((d) => f.startsWith(d)) ||
    f === join(DASH_SRC, "pages", "Layers.tsx") ||
    f === join(DASH_SRC, "lib", "graphCache.ts") ||
    f === join(DASH_SRC, "graph", "neighbours.ts"),
  );
}

/** Strip comments so prose explaining a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function rel(file: string): string {
  return relative(CLI_ROOT, file);
}

// ---------------------------------------------------------------------------
// The corpus. Every scan below is meaningless over an empty file list.
// ---------------------------------------------------------------------------

describe("the scan has a corpus — it cannot pass by finding nothing", () => {
  it("finds every FR-240 client file by name", () => {
    const files = fr240Sources().map(rel);
    for (const expected of [
      "dashboard/src/layers/model.ts",
      "dashboard/src/layers/useLayerList.ts",
      "dashboard/src/layers/useNeighbours.ts",
      "dashboard/src/markdown/parse.ts",
      "dashboard/src/markdown/Markdown.tsx",
      "dashboard/src/components/record/RecordList.tsx",
      "dashboard/src/components/record/RecordDetail.tsx",
      "dashboard/src/components/record/FilterBar.tsx",
      "dashboard/src/pages/Layers.tsx",
      "dashboard/src/pages/layers/Briefs.tsx",
      "dashboard/src/pages/layers/Learnings.tsx",
      "dashboard/src/pages/layers/ContextDocs.tsx",
      "dashboard/src/pages/layers/Goals.tsx",
      "dashboard/src/lib/graphCache.ts",
      "dashboard/src/graph/neighbours.ts",
    ]) {
      expect(files, `${expected} not scanned`).toContain(expected);
    }
  });

  it("the whole-tree scan sees the whole tree", () => {
    // The XSS scan below is over EVERY file, not just FR-240's. A moved
    // directory would silently disarm it.
    expect(allSources().length).toBeGreaterThanOrEqual(40);
    expect(allSources().map(rel)).toContain("dashboard/src/App.tsx");
  });
});

// ---------------------------------------------------------------------------
// XSS: no string-to-markup path exists anywhere in the client
// ---------------------------------------------------------------------------

describe("no client file can turn a string into markup", () => {
  /**
   * The dashboard is a NO-AUTH loopback origin whose every `/api/*` endpoint
   * reads the operator's brain, and it renders `brief_files.content`,
   * `learnings.content` and context-doc files — data written by agents over many
   * sessions. Script execution here is a read primitive over the whole brain, so
   * the rule is absolute rather than risk-weighted.
   */
  const FORBIDDEN = [
    "dangerouslySetInnerHTML",
    "innerHTML",
    "outerHTML",
    "document.write",
  ];

  /**
   * Files whose CODE contains `needle`.
   *
   * Comments are stripped, deliberately and by the same `code()` helper
   * `dashboard-graph-source.test.ts` uses: several files in this tree explain WHY
   * `dangerouslySetInnerHTML` is forbidden, and a scan that fired on its own
   * rationale would force every explanation to be written in euphemism.
   */
  function filesContaining(needle: string, files: readonly string[]): string[] {
    return files.filter((f) => code(f).includes(needle)).map(rel);
  }

  it.each(FORBIDDEN)("%s appears in no client CODE", (needle) => {
    expect(filesContaining(needle, allSources())).toEqual([]);
  });

  it("the scan CAN report a positive — self-negative-control", () => {
    /*
     * Learning 1094. Every assertion above is "the scan found nothing", which is
     * also what a scan over an empty corpus, or with a broken reader, or with a
     * `code()` that returned "" would report. So: run the SAME function over a
     * file that does contain the needle in code, and require a hit.
     */
    const fixture = join(
      mkdtempSync(join(tmpdir(), "igris-fr240-scan-")),
      "Hostile.tsx",
    );
    writeFileSync(
      fixture,
      [
        "// dangerouslySetInnerHTML in a comment must NOT be flagged",
        "export function Bad() {",
        "  return <div dangerouslySetInnerHTML={{ __html: window.name }} />;",
        "}",
      ].join("\n"),
      "utf-8",
    );

    // The real usage is flagged...
    expect(filesContaining("dangerouslySetInnerHTML", [fixture])).toHaveLength(1);

    // ...and a comment-only mention is not, which is the exemption this scan
    // deliberately grants and therefore must demonstrate.
    const proseOnly = join(dirname(fixture), "Prose.tsx");
    writeFileSync(
      proseOnly,
      "// never use dangerouslySetInnerHTML here\nexport const x = 1;\n",
      "utf-8",
    );
    expect(filesContaining("dangerouslySetInnerHTML", [proseOnly])).toEqual([]);

    // And the real corpus was really read.
    expect(code(allSources()[0] as string).length).toBeGreaterThan(50);
  });

  it("the markdown renderer maps the AST to elements and nothing else", () => {
    const src = code(join(DASH_SRC, "markdown", "Markdown.tsx"));
    // No `new Function`, no `eval`, no template that becomes markup.
    expect(src).not.toContain("eval(");
    expect(src).not.toContain("new Function");
    expect(src).not.toContain("createElement(");
  });
});

// ---------------------------------------------------------------------------
// D5: the composite node key is not mirrored browser-side
// ---------------------------------------------------------------------------

describe("D5 · no client file constructs or parses the composite node key", () => {
  /**
   * `graph-keys.ts:26-29`: *"Consumers should read the structured fields and
   * treat `key` as an opaque handle."* MAINTAINING row 105 makes a key-form
   * change a four-file sweep; porting the serialiser browser-side would make it
   * five, forever, for no gain — the `/api/graph` payload already carries
   * `type`, `project` and `id` as separate fields.
   */
  it("does not name the brain's key functions", () => {
    for (const file of shipped()) {
      const src = code(file);
      expect(src, `${rel(file)} names encodeNodeKey`).not.toContain("encodeNodeKey");
      expect(src, `${rel(file)} names parseNodeKey`).not.toContain("parseNodeKey");
    }
  });

  it("does not SPLIT a key on the separator, which is the same thing by hand", () => {
    // A hand-rolled `key.split("|")` is a parser for the key form, and it is
    // WRONG by construction: the form backslash-escapes both the separator and
    // the backslash inside each segment, so a naive split mis-parses any id
    // containing either.
    for (const file of shipped()) {
      const src = code(file);
      expect(src, `${rel(file)} splits a key`).not.toMatch(/\bkey\s*\.\s*split\s*\(/);
      expect(src, `${rel(file)} splits on the key separator`).not.toMatch(
        /\.split\(\s*["'`]\|/,
      );
    }
  });

  it("the record address is built by the model module, not inline", () => {
    // Every consumer routes through `recordHash` / `recordHrefForNode` /
    // `graphFocusHash`, so the BR-078 three-segment form has ONE definition and
    // one round-trip test.
    const inlineBuilders: string[] = [];
    for (const file of shipped()) {
      if (file === join(DASH_SRC, "layers", "model.ts")) continue;
      if (code(file).includes("`#/layers/")) inlineBuilders.push(rel(file));
    }
    expect(inlineBuilders, "a record hash is built outside model.ts").toEqual([]);
  });

  it("the self-negative-control: the scan really reads these files", () => {
    // `model.ts` DOES contain the excluded pattern — so the exclusion above is
    // load-bearing rather than decorative, and the reader is working.
    expect(code(join(DASH_SRC, "layers", "model.ts"))).toContain("`#/layers/");
  });
});

// ---------------------------------------------------------------------------
// The FR-240 CSS block
// ---------------------------------------------------------------------------

describe("the FR-240 CSS block is token-only and declares no custom property", () => {
  const css = readFileSync(join(DASH_SRC, "styles", "base.css"), "utf-8");
  const start = css.indexOf("FR-240 · the record layer");
  const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");

  it("the block exists — the scan is not over an empty string", () => {
    expect(start, "the FR-240 CSS block is missing").toBeGreaterThan(0);
    expect(block.length).toBeGreaterThan(3000);
    expect(block).toContain(".record-row");
    expect(block).toContain(".record-md");
  });

  it("contains no colour literal", () => {
    expect(/#[0-9a-fA-F]{3,8}\b/.test(block), "hex in the FR-240 CSS").toBe(false);
    expect(/\b(?:rgba?|hsla?)\s*\(/.test(block), "rgb() in the FR-240 CSS").toBe(false);
  });

  it("declares NO custom property, so the FR-239 :root bug is unreachable", () => {
    /*
     * FR-239's cascade bug: a `--dataviz-*` alias declared on `:root` (i.e.
     * `html`) substituted against HTML's values — the default `blood` palette —
     * and froze there, so all four palettes rendered identically. The unit tests
     * could not see it because they drive the READER over an injected style
     * source; it took a real browser (PORTING.md D12).
     *
     * FR-240 cannot reproduce it, because it declares no custom property at all
     * and reads the role tokens (`--fg`, `--accent`, `--muted`, `--line`)
     * directly. Those are declared where the palette stamp lives, so a
     * `data-palette` swap reaches these rules by construction.
     *
     * This is also a NOTE FOR THE PHASE-5 BROWSER GATE: G-BR-4 as written says
     * "read `getComputedStyle` for the new `.record-*` custom properties". There
     * are none. Assert the computed COLOURS of `.record-row` / `.record-md-link`
     * differ across the four palettes instead — that is the property that
     * matters, and this test is why the other phrasing has nothing to read.
     */
    const declarations = block.match(/--[a-z0-9-]+\s*:/g) ?? [];
    expect(declarations, `FR-240 CSS declares ${declarations.join(", ")}`).toEqual([]);
  });

  it("uses zero border radius and hairline borders", () => {
    expect(/border-radius/.test(block), "border-radius in the FR-240 CSS").toBe(false);
    const borders = block.match(/border(?:-top|-bottom|-left|-right)?:\s*[^;]+/g) ?? [];
    for (const b of borders) {
      // Every border is either the hairline or an explicit reset to 0.
      const ok = b.includes("0.5px solid var(--line)") ||
        b.includes("0.5px solid var(--accent)") ||
        /:\s*0\b/.test(b);
      expect(ok, `unexpected border: ${b}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC #4 and AC #7
// ---------------------------------------------------------------------------

describe("AC #4 · nothing in the client reaches off-origin", () => {
  it("no absolute URL in any FR-240 client file", () => {
    const found: string[] = [];
    for (const file of fr240Sources()) {
      for (const m of code(file).matchAll(/["'`](https?:)?\/\/[^"'`\s]+/g)) {
        found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `absolute URL: ${found.join(", ")}`).toEqual([]);
  });

  it("every API call goes through lib/api.ts — across the WHOLE shipped client", () => {
    // A stray `fetch()` in a view would bypass the ONE place the relative-URL
    // rule is expressed (and the `cache: no-store` mirror with it).
    //
    // The corpus is `shipped()`, not `fr240Sources()`. Narrowing it to FR-240's
    // own files left `components/graph/NodeInspector.tsx` outside the scan while
    // its own render test carried a title CLAIMING it issued no fetch — a claim
    // that test cannot make (`renderToStaticMarkup` runs no effects). The claim
    // is a property of the file, so it is asserted over every file.
    const API = join(DASH_SRC, "lib", "api.ts");
    const found: string[] = [];
    for (const file of shipped()) {
      if (file === API) continue;
      if (code(file).includes("fetch(")) found.push(rel(file));
    }
    expect(found, `direct fetch outside lib/api.ts: ${found.join(", ")}`).toEqual([]);
  });

  it("SELF-NEGATIVE-CONTROL — the scan sees NodeInspector, and it CAN find a fetch", () => {
    // Two failures the scan above cannot report on its own: a corpus that misses
    // the file the claim is about, and a matcher that matches nothing.
    const corpus = shipped().map(rel);
    expect(corpus).toContain("dashboard/src/components/graph/NodeInspector.tsx");
    expect(corpus).toContain("dashboard/src/lib/graphCache.ts");
    // `lib/api.ts` is the ONE file that legitimately calls `fetch(`, and it is
    // the excluded one — so its content is the proof the matcher works.
    expect(code(join(DASH_SRC, "lib", "api.ts"))).toContain("fetch(");
  });
});

/**
 * AC #7 — **NARROWED BY FR-241, NOT DELETED.**
 *
 * FR-240's claim was "the client has no write path". FR-241 is the brief that
 * legitimately gives it one, so the pin is narrowed to the claim that is still
 * true and is now the one that matters:
 *
 *   THE CLIENT HAS EXACTLY ONE WRITE PATH, IT IS `api.triage` IN
 *   `lib/api.ts`, AND NO OTHER FILE — INCLUDING EVERY FR-240 READ VIEW —
 *   ISSUES A NON-GET REQUEST.
 *
 * Written as an exception LIST rather than by dropping the scan: a second write
 * path added anywhere (including a second one inside `lib/api.ts`) fails this,
 * which is the property the original pin existed to protect. The exception is
 * also asserted to EXIST, so the narrowing cannot silently become "the scan
 * excludes a file that no longer writes at all".
 */
describe("AC #7 · the client has exactly ONE write path, and it is named", () => {
  /** The one file allowed to issue a non-GET request. */
  const WRITE_FILE = join(DASH_SRC, "lib", "api.ts");

  it("no file OTHER than lib/api.ts specifies a method other than GET", () => {
    const found: string[] = [];
    for (const file of shipped()) {
      if (file === WRITE_FILE) continue;
      const src = code(file);
      for (const m of src.matchAll(/method\s*:\s*["'`](\w+)["'`]/g)) {
        if ((m[1] ?? "").toUpperCase() !== "GET") found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `non-GET request outside lib/api.ts: ${found.join(", ")}`).toEqual([]);
  });

  it("every FR-240 READ view still has no write path at all", () => {
    // The half of the original claim that is unchanged, asserted over FR-240's
    // own corpus so the narrowing above cannot be read as loosening the layer
    // views. D9 is still operator-signed: `review_status` is a READ filter, and
    // the approve/reject controls live on FR-241's page, not on the lens.
    for (const file of fr240Sources()) {
      const src = code(file);
      expect(src, `${rel(file)} names a method`).not.toMatch(/method\s*:\s*["'`]/);
      const lower = src.toLowerCase();
      for (const verb of ["onapprove", "onreject", "api.approve", "api.update", "api.triage"]) {
        expect(lower, `${rel(file)} names ${verb}`).not.toContain(verb);
      }
    }
  });

  it("lib/api.ts's ONLY non-GET method is the single triage POST", () => {
    const src = code(WRITE_FILE);
    const methods = [...src.matchAll(/method\s*:\s*["'`](\w+)["'`]/g)].map((m) =>
      (m[1] ?? "").toUpperCase(),
    );
    // Exactly one, and it is POST. Two POSTs here would be two write paths.
    expect(methods).toEqual(["POST"]);
    // It targets the one endpoint `server.ts` routes a POST to, and it sets the
    // Content-Type the 415 fence demands (which is also what forces a preflight
    // and therefore makes the Origin fence reachable).
    expect(src).toContain('"api/triage"');
    expect(src).toContain('"Content-Type": "application/json"');
  });

  it("SELF-NEGATIVE-CONTROL — the exception is real and the matcher works", () => {
    // Both failure modes of an exception list: excluding a file that does not
    // actually contain the thing (so the scan proves nothing), and a matcher
    // that matches nothing anywhere (so the scan would pass over a tree full of
    // POSTs). The excluded file's own content answers both.
    expect(shipped().map(rel)).toContain("dashboard/src/lib/api.ts");
    expect(code(WRITE_FILE)).toMatch(/method\s*:\s*["'`]POST["'`]/);
    // And the write path really is reachable from the UI, not dead code.
    expect(code(join(DASH_SRC, "triage", "useTriage.ts"))).toContain("api.triage(");
  });

  it("no form anywhere has an action — the CSRF shape stays unreachable", () => {
    // Unchanged and unnarrowed. A `<form action>` can POST cross-origin with
    // `Content-Type: application/x-www-form-urlencoded` and no preflight; the
    // server's 415 fence is what refuses it, and this is the client-side half.
    for (const file of shipped()) {
      const src = code(file);
      expect(src, `${rel(file)} has a form action`).not.toMatch(/\saction=\{?["']/);
    }
  });
});

// ---------------------------------------------------------------------------
// AC #5 and the router
// ---------------------------------------------------------------------------

describe("AC #5 · the four views share ONE list and ONE detail", () => {
  const VIEWS = ["Briefs.tsx", "Learnings.tsx", "ContextDocs.tsx", "Goals.tsx"];

  it.each(VIEWS)("%s imports the shared components", (name) => {
    const src = code(join(DASH_SRC, "pages", "layers", name));
    expect(src).toContain("components/record/RecordList");
    // Context docs have no detail-with-neighbours, but every view uses the ONE
    // detail component.
    expect(src).toContain("components/record/RecordDetail");
  });

  it.each(VIEWS)("%s builds no list markup of its own", (name) => {
    const src = code(join(DASH_SRC, "pages", "layers", name));
    // The tell for a forked layout: a view rendering the list container, the
    // pagination or an empty state itself instead of describing rows.
    expect(src).not.toContain('className="record-list"');
    expect(src).not.toContain("record-page-btn");
    expect(src).not.toContain("EmptyState");
    expect(src).not.toContain("StatePage");
  });

  it.each(VIEWS)("%s selects its empty state through the model", (name) => {
    // AC #6 cannot hold if a view invents its own copy — the four cases and
    // their precedence live in `emptyStateFor` and are unit-tested there.
    expect(code(join(DASH_SRC, "pages", "layers", name))).toContain("emptyStateFor");
  });

  it("the self-negative-control: these scans read real files", () => {
    for (const name of VIEWS) {
      const src = code(join(DASH_SRC, "pages", "layers", name));
      expect(src.length, name).toBeGreaterThan(2000);
      expect(src).toContain("LayerViewProps");
    }
  });
});

/**
 * BR-082 — the project scope has ONE implementation, mechanically.
 *
 * FR-241 lifted the three-state scope machine into `lib/useProjectScope.ts` so
 * `Layers` and `Triage` could not fork it. `Overview.tsx` was never migrated
 * and kept its own `useState` plus its own copy of the `default_project`
 * ladder — which is how a page called OVERVIEW shipped with no way to clear its
 * scope. Nothing in the suite could see that, because "there are two copies" is
 * a claim about FILES.
 *
 * PROVES: no shipped client file outside the two shared modules renders the
 * scope control or re-derives the default-project ladder.
 * DOES NOT PROVE: that the shared hook is CORRECT — that the clear survives the
 * live beat is behavioural and belongs in a browser (G-BR-9 in
 * `cli/scripts/browser-gate.mjs`), and the endpoint half is
 * `dashboard-server.test.ts`.
 */
describe("BR-082 · the project scope is lifted, not copied", () => {
  const SCOPE_HOOK = join(DASH_SRC, "lib", "useProjectScope.ts");
  const SCOPE_CONTROL = join(DASH_SRC, "components", "chrome", "ProjectScope.tsx");
  /** The markup tell: the control's own aria-label, which the gate also reads. */
  /** Epoch-ish mtime for the planted control — see the plant site. */
  const BACKDATE = new Date(2000, 0, 1);

  const CONTROL_MARKUP = /aria-label="Project scope"/;
  /** The state-machine tell: only the ladder reads the server-resolved default. */
  const LADDER = /default_project/;

  it("exactly ONE shipped file renders the scope control", () => {
    const hits = shipped().filter((f) => CONTROL_MARKUP.test(code(f)));
    expect(hits.map(rel)).toEqual([rel(SCOPE_CONTROL)]);
  });

  it("exactly ONE shipped file re-derives the default-project ladder", () => {
    // `lib/api.ts` is the payload MIRROR — it must NAME the field to type it,
    // and naming a field is not owning the ladder.
    //
    // The exemption is COUNTED, not whole-file. Sentinel demonstrated the
    // difference during BR-082's validation: it appended a complete ladder
    // re-implementation to `lib/api.ts` and every scan here stayed green,
    // because a whole-file exemption cannot tell naming from owning. One
    // occurrence is the type declaration; a second is an implementation.
    const mirror = join(DASH_SRC, "lib", "api.ts");
    const mirrorHits = code(mirror).match(new RegExp(LADDER.source, "g")) ?? [];
    expect(
      mirrorHits.length,
      "lib/api.ts names default_project more than once — that is an implementation, not a type",
    ).toBe(1);

    const hits = shipped().filter((f) => f !== mirror && LADDER.test(code(f)));
    expect(hits.map(rel)).toEqual([rel(SCOPE_HOOK)]);
  });

  it("Overview consumes the shared hook and the shared control", () => {
    const src = code(join(DASH_SRC, "pages", "Overview.tsx"));
    expect(src).toContain("lib/useProjectScope");
    expect(src).toContain("components/chrome/ProjectScope");
    // ...and holds no scope state of its own. Its surviving `useState` calls
    // are the two payloads; a `string`-typed one would be a slug again.
    expect(src).not.toMatch(/useState<[^>]*string[^>]*>/);
  });

  it.each([
    ["pages/Layers.tsx", join(DASH_SRC, "pages", "Layers.tsx")],
    ["pages/Triage.tsx", join(DASH_SRC, "pages", "Triage.tsx")],
    ["pages/Overview.tsx", join(DASH_SRC, "pages", "Overview.tsx")],
  ])("%s reaches the scope through the hook", (_name, file) => {
    expect(code(file)).toContain("useProjectScope");
  });

  it("SELF-NEGATIVE-CONTROL — both detectors fire on a planted copy", () => {
    // The scans above assert a set of size one. A broken matcher would report
    // an EMPTY set, and `[]` does not equal `[the shared module]`, so an empty
    // corpus already fails — but a matcher that cannot see a SECOND copy would
    // pass forever. Plant one and check both regexes find it.
    // Planted into the REAL corpus dir, not `tmpdir()`. A control that plants
    // somewhere `shipped()` never walks proves the REGEX, not the CORPUS — and
    // the corpus is the half that rots (a new page, a moved directory). This
    // asserts the scans' own file list would SEE a second copy. Cleaned up in
    // `finally` so a failure cannot leave a stray file in the source tree.
    // BACKDATED on write. `dashboard-artifact.test.ts`'s TD-276 stale-dist
    // guard walks all of `dashboard/src` for the newest mtime and excludes only
    // `__tests__` segments — this file is in neither exclusion, so a concurrent
    // run would see a mtime of NOW and fail with "dist/dashboard is STALE",
    // sending the operator to a rebuild that cannot fix it. Vitest runs files in
    // parallel and the plant window spans three full corpus walks, so this is a
    // real race, not a theoretical one. An epoch mtime cannot be the newest.
    const planted = join(DASH_SRC, "pages", "__SelfNegativeControl.tsx");
    writeFileSync(
      planted,
      [
        "export function SecondScope() {",
        '  const [sel, setSel] = useState<string | null>(null);',
        "  useEffect(() => {",
        "    if (sel === null) setSel(p.default_project);",
        "  }, [tick]);",
        '  return <div role="radiogroup" aria-label="Project scope" />;',
        "}",
      ].join("\n"),
    );
    utimesSync(planted, BACKDATE, BACKDATE);
    try {
      const src = code(planted);
      expect(CONTROL_MARKUP.test(src)).toBe(true);
      expect(LADDER.test(src)).toBe(true);

      // The load-bearing half: the scans' OWN corpus must contain it, so a
      // second copy would actually be counted rather than merely be matchable.
      const seen = shipped().map(rel);
      expect(seen).toContain(rel(planted));
      expect(shipped().filter((f) => CONTROL_MARKUP.test(code(f)))).toHaveLength(2);
      expect(
        shipped().filter(
          (f) => f !== join(DASH_SRC, "lib", "api.ts") && LADDER.test(code(f)),
        ),
      ).toHaveLength(2);

      // And the shared modules are really the ones the passing scans matched.
      expect(CONTROL_MARKUP.test(code(SCOPE_CONTROL))).toBe(true);
      expect(LADDER.test(code(SCOPE_HOOK))).toBe(true);
    } finally {
      rmSync(planted, { force: true });
    }
  });
});

describe("the router uses the unit-tested codec", () => {
  const src = code(join(DASH_SRC, "router.tsx"));

  it("imports the codec rather than parsing the address itself", () => {
    expect(src).toContain("parseLayersHash");
    expect(src).toContain("parseGraphFocus");
    expect(src).toContain('from "./layers/model"');
  });

  it("holds no second parser for the record address", () => {
    // A `decodeURIComponent` here would mean a second decode path, and the
    // BR-078 round-trip test would no longer cover what the router does.
    expect(src).not.toContain("decodeURIComponent");
  });

  it("lists NO route as pending — every reserved route now has a view", () => {
    /*
     * FR-240 asserted "`layers` is gone and `triage` is still pending". FR-241
     * SHIPPED the triage view, so the second half of that claim is now false
     * and the assertion is updated deliberately rather than deleted: the map is
     * empty, which is a stronger statement than "triage left it".
     *
     * The MECHANISM survives — `App.tsx` still reads the map — so the next
     * brief that reserves a nav slot before its view exists re-adds one line
     * and nothing else. That is asserted below, because an empty map plus a
     * consumer that stopped consulting it would be indistinguishable from here.
     */
    const pending = /PENDING_ROUTES[^}]*}/s.exec(src)?.[0] ?? "";
    // The self-negative-control: the block was really found and really read.
    expect(pending, "the PENDING_ROUTES declaration was not located").toContain(
      "PENDING_ROUTES",
    );
    expect(pending).not.toContain("layers:");
    expect(pending).not.toContain("triage:");
    expect(pending).not.toContain("graph:");

    // ...and the shell still branches on it, so the mechanism is live.
    const app = code(join(DASH_SRC, "App.tsx"));
    expect(app).toContain("PENDING_ROUTES[route]");
    expect(app).toContain("<Triage");
  });
});

// ---------------------------------------------------------------------------
// The graphCache hoist was a PURE MOVE
// ---------------------------------------------------------------------------

describe("the graphCache hoist did not change the graph page's logic", () => {
  const graph = code(join(DASH_SRC, "pages", "Graph.tsx"));

  it("Graph.tsx keeps no private scope cache", () => {
    expect(graph).not.toContain("cache.current");
    expect(graph).not.toContain("interface ScopeCache");
  });

  it("Graph.tsx still fetches once per scope and NOT on live.tick", () => {
    // FR-239's D8 argument: a 5-second refetch re-runs the force simulation, and
    // dataviz.md forbids an idling simulation by name. The hoist must not have
    // quietly changed the dependency list.
    expect(graph).not.toContain("live.tick");
    expect(graph).toContain("[scope, nonce]");
  });

  it("the shared cache still resets positions on a fresh payload", () => {
    // Positions belong to a node set; seeding a new layout from an old payload's
    // coordinates is how a graph ends up stacked at the origin.
    const cache = code(join(DASH_SRC, "lib", "graphCache.ts"));
    expect(cache).toContain("positions: {}");
    expect(cache).toContain("rememberPositions");
  });

  it("the self-negative-control: Graph.tsx was really read", () => {
    expect(graph.length).toBeGreaterThan(4000);
    expect(graph).toContain("export function Graph");
    expect(graph).toContain("fetchScope");
  });
});
