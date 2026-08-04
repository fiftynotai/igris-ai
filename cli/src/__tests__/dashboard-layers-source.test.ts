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
import { PROJECT_SCOPES } from "../lib/dashboard/params.js";
import { SLUG_RE } from "../lib/slug.js";

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
      // FR-245 — the board. Named here so a moved or renamed file disarms the
      // AC-6 read-only scan below LOUDLY rather than by scanning nothing.
      "dashboard/src/layers/board.ts",
      "dashboard/src/layers/useBoardColumns.ts",
      "dashboard/src/layers/useLayersView.ts",
      "dashboard/src/components/record/RecordBoard.tsx",
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

describe("the FR-245 CSS block exists inside that same scan", () => {
  const css = readFileSync(join(DASH_SRC, "styles", "base.css"), "utf-8");

  it("declares the board classes, and is downstream of the FR-240 marker", () => {
    // The scan above runs from the FR-240 marker to EOF, so this block inherits
    // its four constraints (no colour literal, no custom property, no radius,
    // hairline borders) BY POSITION. That inheritance is only load-bearing if
    // the block is actually there and actually after the marker.
    const marker = css.indexOf("FR-240 · the record layer");
    const board = css.indexOf("FR-245 · the briefs board");
    expect(board, "the FR-245 CSS block is missing").toBeGreaterThan(0);
    expect(board).toBeGreaterThan(marker);
    for (const cls of [
      ".record-board",
      ".record-board-col",
      ".record-board-head",
      ".record-board-more",
      ".record-head-actions",
    ]) {
      expect(css.slice(board), `${cls} is not styled`).toContain(cls);
    }
  });

  it("states the layout grammar in words, for the design_system grounding pass", () => {
    // FR-245's stated obligation: `design_system.md` does not exist yet and is
    // filed as its own brief, so the grammar this board introduces has to be
    // WRITTEN somewhere a grounding pass can lift it from rather than
    // reverse-engineer it out of declarations.
    const block = css.slice(css.indexOf("FR-245 · the briefs board"));
    expect(block).toContain("LAYOUT GRAMMAR");
    expect(block).toContain("TD-333");
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

/**
 * FR-245 AC-6 — **the board is read-only, and this scan can report a positive.**
 *
 * The claim is not "the board happens to issue no writes today". It is that the
 * board has no affordance that could ever change a brief's state — and the
 * reason it is absolute rather than risk-weighted is what `status` IS:
 * `brief_status.status` is the CANONICAL build-state source (MAINTAINING row
 * 94), the single authoritative answer to "is this brief built?". TD-311
 * forbids resolving a state contradiction by editing brief data. So a
 * drag-to-change-status affordance would be a write path into the column the
 * whole build state is read from, arriving as a convenience.
 *
 * WHY THE SCAN IS SHAPED LIKE THIS. "This page issues no writes" is TRIVIALLY
 * TRUE of a page with no write code, which is the vacuity learnings 1092-1096
 * record: the assertion and a scan pointed at an empty file list produce
 * identical output. So the drag VOCABULARY is grepped (the concept, not one
 * spelling — learning 1131), the corpus is asserted by name above, and S4 below
 * plants a real affordance and requires the SAME matcher to find it.
 *
 * DOES NOT PROVE that no write happens at runtime. That is `G-BR-12f`, which
 * drags a card with real CDP mouse events and reads an in-page non-GET counter
 * that ALSO reports `GET > 0`, so its zero is a measurement rather than a dead
 * counter — with one mutation per half.
 */
describe("FR-245 AC-6 · the board has no state-mutating affordance", () => {
  const BOARD_FILES = [
    join(DASH_SRC, "layers", "board.ts"),
    join(DASH_SRC, "layers", "useBoardColumns.ts"),
    join(DASH_SRC, "layers", "useLayersView.ts"),
    join(DASH_SRC, "components", "record", "RecordBoard.tsx"),
    join(DASH_SRC, "pages", "layers", "Briefs.tsx"),
  ];

  /**
   * The drag concept in every spelling it can arrive in: the attribute, the
   * React handler props, the DOM event names, the payload object and the
   * lowercase HTML forms. Matched over LOWERCASED code, so `onDragStart`,
   * `ondragstart` and `"dragstart"` are one pattern rather than three.
   */
  const DRAG = [/\bdrag[a-z]*\b/, /\bondrop\b/, /\bdatatransfer\b/];

  function dragHits(files: readonly string[]): string[] {
    const out: string[] = [];
    for (const file of files) {
      const lower = code(file).toLowerCase();
      for (const re of DRAG) {
        const m = re.exec(lower);
        if (m !== null) out.push(`${rel(file)}: ${m[0]}`);
      }
    }
    return out;
  }

  it("S1 — no drag affordance in any board file", () => {
    expect(dragHits(BOARD_FILES), `drag affordance: ${dragHits(BOARD_FILES).join(", ")}`).toEqual([]);
  });

  /**
   * The write vocabulary, in every spelling it can arrive in.
   *
   * FR-247 added two: `applyrefs` (the brief-write entry point on `useTriage`)
   * and `briefwriteaction` (the two brief-addressed map rows). A vocabulary
   * that did not grow with the write surface would keep passing while the
   * surface it guards acquired new verbs.
   */
  const WRITE_VOCAB = [
    "api.triage",
    "triageaction",
    "triage_actions",
    "usetriage",
    "applyrefs",
    "briefwriteaction",
    "onapprove",
    "onreject",
  ];

  /**
   * `Briefs.tsx` hosts BOTH arrangements, so FR-247 broke this scan's shape —
   * legitimately, and the fix is not an exemption.
   *
   * The LIST now carries a real write path (a priority picker and a goal
   * attach). The BOARD must not. Dropping `Briefs.tsx` from the corpus would
   * have satisfied the assertion and silently ended its coverage; keeping the
   * whole-file grep would have forbidden a feature the brief exists to ship.
   *
   * So the file is SLICED. `BriefBoardView` and everything it renders lives
   * between the two section banners below, and the write vocabulary is asserted
   * absent from THAT REGION. The slice is delimited by comment banners that
   * already existed for readers, which makes them a contract — if either is
   * renamed, `boardSlice()` throws rather than silently scanning "".
   */
  const BOARD_SLICE_START = "// Board (FR-245)";
  const BOARD_SLICE_END = "// Detail";

  /**
   * The RAW file, because `code()` strips the very banners the slice is
   * delimited by. Comments are stripped from the SLICE afterwards, so the
   * assertions still run over code rather than over prose that names the verbs
   * in order to forbid them.
   */
  function rawBriefs(): string {
    return readFileSync(join(DASH_SRC, "pages", "layers", "Briefs.tsx"), "utf-8");
  }
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  function boardSlice(): string {
    const src = rawBriefs();
    const from = src.indexOf(BOARD_SLICE_START);
    const to = src.indexOf(BOARD_SLICE_END, from);
    if (from < 0 || to < 0) {
      throw new Error(
        `Briefs.tsx section banners moved (${BOARD_SLICE_START} / ${BOARD_SLICE_END}) — ` +
          "this scan's corpus is delimited by them and would otherwise be empty",
      );
    }
    return stripComments(src.slice(from, to));
  }

  /** Everything BEFORE the board banner — the shared mapper and the list. */
  function listSlice(): string {
    const src = rawBriefs();
    return stripComments(src.slice(0, src.indexOf(BOARD_SLICE_START)));
  }

  it("S2 — no board file names the write path", () => {
    for (const file of BOARD_FILES) {
      if (file === join(DASH_SRC, "pages", "layers", "Briefs.tsx")) continue;
      const lower = code(file).toLowerCase();
      for (const verb of WRITE_VOCAB) {
        expect(lower, `${rel(file)} names ${verb}`).not.toContain(verb);
      }
    }
  });

  it("S2b — FR-247: the BOARD REGION of Briefs.tsx names no write verb", () => {
    const lower = boardSlice().toLowerCase();
    expect(lower.length, "the board slice is empty — the banners moved").toBeGreaterThan(
      500,
    );
    for (const verb of WRITE_VOCAB) {
      expect(lower, `the board region of Briefs.tsx names ${verb}`).not.toContain(verb);
    }
  });

  it("S2c — SELF-NEGATIVE-CONTROL: the LIST region DOES name them", () => {
    /*
     * Without this, S2b is satisfiable by a slicer that returns the wrong
     * region, by one that returns a comment block, and by a vocabulary that
     * matches nothing anywhere. The exclusion above is load-bearing precisely
     * because the same FILE contains both answers — so both are asserted.
     */
    const lower = listSlice().toLowerCase();
    expect(lower, "the list region names no write path — is the write surface gone?").toContain(
      "usetriage",
    );
    expect(lower).toContain("applyrefs");
  });

  it("S2d — FR-247: the board's row mapper is called with NO affordance builder", () => {
    /*
     * The structural half, and the one a vocabulary grep cannot reach.
     * `briefRow` is ONE mapper shared by both arrangements (that sharing is
     * FR-245's own guarantee that a card and a list row cannot drift), so the
     * only thing keeping checkboxes and the priority control off board cards is
     * that the board passes no second argument.
     *
     * `.map(briefRow)` would hand `Array#map`'s INDEX in as the builder — the
     * compiler refuses that today, but a future `.map((r, i) => briefRow(r, i))`
     * would type-check against a different signature. So the call shape is
     * pinned here as well.
     *
     * Sibling: `browser-gate.mjs` G-BR-14c counts `.record-select` and write
     * controls inside `.record-board` in a real browser, with
     * `br14-affordance-on-board` to prove it can fire. Both are required.
     */
    const slice = boardSlice();
    const calls = [...slice.matchAll(/briefRow\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(calls, "the board stopped calling briefRow — has it forked the mapper?").not.toEqual(
      [],
    );
    for (const argList of calls) {
      expect(argList.includes(","), `the board passed a second argument: briefRow(${argList})`).toBe(
        false,
      );
    }
    // ...and the mapper is never passed by reference, where `map` would supply
    // the index as the second argument.
    expect(slice).not.toMatch(/\.map\s*\(\s*briefRow\s*\)/);
  });

  it("S3 — no board file specifies a request method or calls fetch", () => {
    // Structurally covered by the whole-tree scans above (this file's AC #7 and
    // AC #4 blocks), which these files joined automatically by being in
    // `shipped()`. Asserted again over the NAMED set, because the whole-tree
    // scan's corpus is a directory walk and this one is a list: if the walk ever
    // misses the board directory, this still fails.
    for (const file of BOARD_FILES) {
      const src = code(file);
      expect(src, `${rel(file)} names a method`).not.toMatch(/method\s*:\s*["'`]/);
      expect(src, `${rel(file)} calls fetch`).not.toContain("fetch(");
    }
  });

  it("S4 — SELF-NEGATIVE-CONTROL: the matcher finds a planted affordance", () => {
    /*
     * Learning 1094, and it is mandatory here rather than nice to have: every
     * assertion above is "the scan found nothing", which is also what a scan
     * over an empty corpus, a broken reader, or a `code()` returning "" would
     * report. So run the SAME function over a file that DOES carry the
     * affordance and require a hit — then over a file that only MENTIONS it in
     * a comment and require none, because that exemption is the one this file's
     * own header prose depends on.
     */
    const dir = mkdtempSync(join(tmpdir(), "igris-fr245-scan-"));
    const hostile = join(dir, "Hostile.tsx");
    writeFileSync(
      hostile,
      [
        "export function DraggableCard({ row, onMove }) {",
        "  return (",
        '    <div draggable="true"',
        "      onDragStart={(e) => e.dataTransfer.setData('id', row.key)}",
        "      onDragOver={(e) => e.preventDefault()}",
        "      onDrop={() => onMove(row.key)}",
        "    />",
        "  );",
        "}",
      ].join("\n"),
      "utf-8",
    );
    const hits = dragHits([hostile]);
    expect(hits.length, "the drag matcher found NOTHING in a file full of drag code").toBeGreaterThan(0);
    expect(hits.join(" ")).toContain("draggable");
    expect(hits.join(" ")).toContain("datatransfer");

    const prose = join(dir, "Prose.tsx");
    writeFileSync(
      prose,
      "// never make these draggable — status is the canonical build state\nexport const x = 1;\n",
      "utf-8",
    );
    expect(dragHits([prose])).toEqual([]);

    // ...and the real corpus was really read, not silently empty.
    rmSync(dir, { recursive: true, force: true });
    for (const file of BOARD_FILES) {
      expect(code(file).length, `${rel(file)} read as empty`).toBeGreaterThan(400);
    }
  });

  it("S5 — the corpus is the SHIPPED corpus, so a new board file joins it", () => {
    const shippedRel = shipped().map(rel);
    for (const file of BOARD_FILES) {
      expect(shippedRel, `${rel(file)} is not in the shipped corpus`).toContain(rel(file));
    }
    // The board is reachable from the page, so none of this is dead code being
    // scanned for show.
    const briefs = code(join(DASH_SRC, "pages", "layers", "Briefs.tsx"));
    expect(briefs).toContain("RecordBoard");
    expect(briefs).toContain("useBoardColumns");
    expect(briefs).toContain("useLayersView");
  });

  it("the toggle is persisted in sessionStorage, in exactly ONE file (D4)", () => {
    // D4 rejected `localStorage` (it would outlive the session) and the URL (it
    // would force `layerHash`/`recordHash` to carry a filter). Both rejections
    // are mechanical: a second file persisting a view, or this one reaching for
    // `localStorage`, fails here.
    const hook = join(DASH_SRC, "layers", "useLayersView.ts");
    const hits = shipped().filter((f) => code(f).includes("igris.dashboard.layers.view"));
    expect(hits.map(rel)).toEqual([rel(hook)]);
    const src = code(hook);
    expect(src).toContain("sessionStorage");
    expect(src, "the view toggle must not outlive the session").not.toContain("localStorage");
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

/**
 * TD-326 — the brain-level scope, across the client/server seam.
 *
 * `cli/dashboard/` and `cli/src/` compile separately and share NO import, so
 * the two ends of this contract are two literals in two files. That is the
 * shape that drifts silently, and the drift is invisible: a client sending
 * `project_scope=brainlevel` would be answered 200 with the value DROPPED and
 * named in `params`, so the page would render the UNSCOPED list under a chip
 * that says `(brain-level)` — the `everything`/`brain-level` blur TD-326 exists
 * to prevent, arrived at by typo.
 *
 * PROVES: the literal the client puts on the wire is one the server's allowlist
 * accepts; the UI sentinel can never collide with a project slug; and only the
 * triage page emits the param.
 * DOES NOT PROVE: that the endpoint answers correctly — that is
 * `dashboard-layers-endpoint.test.ts` G-EP-4.
 */
describe("TD-326 · the brain-level scope agrees across the client/server seam", () => {
  const HOOK = join(DASH_SRC, "lib", "useProjectScope.ts");
  const TRIAGE = join(DASH_SRC, "pages", "Triage.tsx");

  /** Pull an exported string literal out of the client source. */
  function literal(file: string, name: string): string | null {
    const m = new RegExp(`${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`).exec(code(file));
    return m?.[1] ?? null;
  }

  it("the WIRE value the client sends is in the server's allowlist", () => {
    const wire = literal(HOOK, "BRAIN_LEVEL_PARAM");
    expect(wire, "BRAIN_LEVEL_PARAM was not found in the hook").not.toBeNull();
    expect(PROJECT_SCOPES as readonly string[]).toContain(wire);
  });

  it("the UI sentinel is NOT a valid project slug, so the chip cannot be ambiguous", () => {
    const sentinel = literal(HOOK, "BRAIN_LEVEL_SCOPE");
    expect(sentinel).not.toBeNull();
    expect(SLUG_RE.test(sentinel as string), `${sentinel} is a legal slug`).toBe(false);
    // ...and it is DISTINCT from the wire value: they live in different layers
    // and a single constant would hide which one a future edit changed.
    expect(sentinel).not.toBe(literal(HOOK, "BRAIN_LEVEL_PARAM"));
  });

  it("exactly ONE shipped file emits the project_scope param", () => {
    const hits = shipped().filter((f) => code(f).includes("project_scope"));
    expect(hits.map(rel)).toEqual([rel(TRIAGE)]);
  });

  it("no shipped file hard-codes the sentinel — both ends import it", () => {
    // A second copy of `(brain-level)` is a second definition, and the ladder
    // exemption in the hook keys off the constant.
    const hits = shipped().filter((f) => f !== HOOK && code(f).includes("(brain-level)"));
    expect(hits.map(rel)).toEqual([]);
    expect(code(TRIAGE)).toContain("BRAIN_LEVEL_SCOPE");
    expect(code(TRIAGE)).toContain("BRAIN_LEVEL_PARAM");
  });

  it("the ladder's sentinel exemption is present in the one file that owns it", () => {
    // The FR-240 defect's third incarnation: a value the ladder does not
    // recognise is replaced by the default project on the next `/api/projects`
    // poll. This asserts the exemption EXISTS in the one file that owns it; the
    // behavioural half is the browser gate (G-BR-10c), which is where a claim
    // about the beat belongs.
    const src = code(join(DASH_SRC, "lib", "useProjectScope.ts"));
    expect(src).toMatch(/cur === BRAIN_LEVEL_SCOPE/);
  });

  it("SELF-NEGATIVE-CONTROL — the reader really extracts, and really can miss", () => {
    // Both failure modes of a regex-over-source scan: a matcher that returns
    // null for everything (so the assertions above never run on a real value)
    // and one that matches anything.
    expect(literal(HOOK, "BRAIN_LEVEL_SCOPE")).toMatch(/\S/);
    expect(literal(HOOK, "A_CONSTANT_THAT_DOES_NOT_EXIST")).toBeNull();
    expect(PROJECT_SCOPES as readonly string[]).not.toContain(
      literal(HOOK, "BRAIN_LEVEL_SCOPE"),
    );
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

describe("BR-085 · the review-scope banner is sourced from the RESPONSE", () => {
  /**
   * The claim these scans own, which no unit test can make: that the VIEW wires
   * `scopeBanner` to the payload rather than to its own filter state.
   * `model.test.ts` proves the decision; `renderToStaticMarkup` runs no effects,
   * so no render test can see the search payload arrive. What is left is the
   * wiring, and the wiring is a property of the file.
   *
   * The regression this refuses is not "the banner disappears" — it is the
   * banner being fed a hand-made source built from the filter control, which
   * restores BR-085 exactly while keeping every other test green.
   */
  const LEARNINGS = join(DASH_SRC, "pages", "layers", "Learnings.tsx");

  /**
   * The ARGUMENT of the `scopeBanner` call, and only that.
   *
   * The predicate below is scoped to this slice rather than to the file, and
   * the first draft of this scan proved why: file-wide, `review_status:
   * reviewStatus` also matches the REQUEST builder
   * (`searchQuery({ values: { review_status: reviewStatus } })`), which is the
   * correct and necessary way to ask the server for a scope. A detector that
   * cannot tell the request from the banner would forbid the fix along with
   * the bug.
   */
  function scopeBannerArgs(src: string): string {
    const from = src.indexOf("scopeBanner({");
    if (from < 0) return "";
    const to = src.indexOf("})", from);
    return to < 0 ? src.slice(from) : src.slice(from, to);
  }

  /** The defect, as a predicate over that slice. Used on the real file AND a plant. */
  function fakesTheSource(args: string): boolean {
    return /source:\s*\{/.test(args) || /review_status/.test(args);
  }

  it("exactly ONE shipped file renders the scope banner", () => {
    const hits = shipped().filter((f) => /SHOWING \{scope/.test(code(f)));
    expect(hits.map(rel)).toEqual([rel(LEARNINGS)]);
  });

  it("that file takes the scope from the shared decision, not from its filter state", () => {
    const args = scopeBannerArgs(code(LEARNINGS));
    // The slice is non-empty and is the right slice — without this the two
    // assertions below would both pass over "".
    expect(args, "no scopeBanner call in Learnings.tsx").toContain("requested:");
    // The payload that produced the VISIBLE rows — browse payload or search
    // hits, chosen by the same flag that chooses the rows.
    expect(args).toMatch(/source:\s*browsing \? payload : hits/);
    expect(fakesTheSource(args), "Learnings.tsx builds a synthetic scope source").toBe(
      false,
    );
  });

  it("SELF-NEGATIVE-CONTROL — the detector fires on a hand-made source", () => {
    // Without this, `fakesTheSource` returning false above is indistinguishable
    // from a regex that matches nothing. The plant goes through the SAME slicer,
    // so the control exercises the extraction as well as the predicate.
    const planted = scopeBannerArgs(
      "const s = scopeBanner({ source: { review_status: reviewStatus }, requested: reviewStatus });",
    );
    expect(planted).toContain("requested:");
    expect(fakesTheSource(planted)).toBe(true);
    // ...and the shipped spelling is NOT a false positive, including the
    // request builder that legitimately names the field elsewhere in the file.
    expect(
      fakesTheSource(
        scopeBannerArgs(
          "scopeBanner({ source: browsing ? payload : hits, requested: reviewStatus });",
        ),
      ),
    ).toBe(false);
  });

  it("the search payload's own params render — a reported drop is shown, not buried", () => {
    // FR-246 made `/api/learnings/search` REPORT a dropped parameter; this view
    // rendered only the BROWSE payload's notes, so the report landed in a
    // banner nobody drew. A drop that is reported and not rendered is still a
    // silent one on screen.
    const src = code(LEARNINGS);
    expect(src).toMatch(/browsing \? payload\?\.params : hits\?\.params/);
    expect(src).toContain("REQUEST ADJUSTED");
  });
});
