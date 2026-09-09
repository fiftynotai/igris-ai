/**
 * FR-240 · G-EP-6 — **the markdown parser emits no markup, ever.**
 *
 * WRITTEN BEFORE THE PARSER, in the order the plan requires (step 15): the
 * injection block is first in this file because it was first in time. The
 * fidelity block below it is the ordinary correctness suite.
 *
 * WHAT THIS FILE PROVES
 *   The AST produced from hostile source carries the hostile substring as a
 *   `text` (or `code`) node — a LITERAL — and never as a node kind a renderer
 *   could turn into an element, and the link allowlist drops every scheme
 *   outside `http`/`https`/`#`.
 *
 * WHAT IT DOES **NOT** PROVE
 *   That the RENDERER honours the AST. A parser that returns
 *   `{kind:"text", value:"<script>"}` is still exploitable if `Markdown.tsx`
 *   interpolates `value` into `dangerouslySetInnerHTML`.
 *   **Siblings: `Markdown.test.tsx`** (renders the same hostile fixtures through
 *   `react-dom/server` and asserts the emitted markup is ESCAPED) and the
 *   whole-tree `dangerouslySetInnerHTML` grep in
 *   `cli/src/__tests__/dashboard-layers-source.test.ts`. Neither of the three
 *   is sufficient alone: this one covers the data, the second covers the
 *   mapping, the third covers the file that has not been written yet.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_SOURCE_CHARS,
  inlineText,
  parseInline,
  parseMarkdown,
  safeHref,
  type BlockNode,
  type InlineNode,
} from "../parse.js";

/** Every node kind reachable in a tree, so "no html kind exists" is assertable. */
function kinds(blocks: readonly BlockNode[]): Set<string> {
  const out = new Set<string>();
  const walkInline = (nodes: readonly InlineNode[]): void => {
    for (const n of nodes) {
      out.add(`inline:${n.kind}`);
      if (n.kind === "strong" || n.kind === "em" || n.kind === "link") {
        walkInline(n.children);
      }
    }
  };
  const walk = (bs: readonly BlockNode[]): void => {
    for (const b of bs) {
      out.add(`block:${b.kind}`);
      if (b.kind === "heading" || b.kind === "paragraph") walkInline(b.children);
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "list") {
        for (const it of b.items) {
          walkInline(it.children);
          walk(it.blocks);
        }
      } else if (b.kind === "table") {
        for (const c of b.head) walkInline(c);
        for (const r of b.rows) for (const c of r) walkInline(c);
      }
    }
  };
  walk(blocks);
  return out;
}

/** Concatenated literal text of a whole document. */
function documentText(blocks: readonly BlockNode[]): string {
  let out = "";
  const walk = (bs: readonly BlockNode[]): void => {
    for (const b of bs) {
      if (b.kind === "heading" || b.kind === "paragraph") out += inlineText(b.children);
      else if (b.kind === "fence") out += b.value;
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "list") {
        for (const it of b.items) {
          out += inlineText(it.children);
          walk(it.blocks);
        }
      } else if (b.kind === "table") {
        for (const c of b.head) out += inlineText(c);
        for (const r of b.rows) for (const c of r) out += inlineText(c);
      }
      out += "\n";
    }
  };
  walk(blocks);
  return out;
}

/** Every `link` node in a tree. */
function links(blocks: readonly BlockNode[]): Array<{ href: string }> {
  const out: Array<{ href: string }> = [];
  const walkInline = (nodes: readonly InlineNode[]): void => {
    for (const n of nodes) {
      if (n.kind === "link") {
        out.push({ href: n.href });
        walkInline(n.children);
      } else if (n.kind === "strong" || n.kind === "em") walkInline(n.children);
    }
  };
  const walk = (bs: readonly BlockNode[]): void => {
    for (const b of bs) {
      if (b.kind === "heading" || b.kind === "paragraph") walkInline(b.children);
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "list") {
        for (const it of b.items) {
          walkInline(it.children);
          walk(it.blocks);
        }
      } else if (b.kind === "table") {
        for (const c of b.head) walkInline(c);
        for (const r of b.rows) for (const c of r) walkInline(c);
      }
    }
  };
  walk(blocks);
  return out;
}

// ===========================================================================
// 1 — INJECTION. Written first, on purpose.
// ===========================================================================

describe("G-EP-6 · hostile source becomes literal text, never markup", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<iframe src=javascript:alert(1)></iframe>",
    "<svg/onload=alert(1)>",
    "<!-- comment --><b>bold</b>",
    "<style>body{display:none}</style>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<a href='javascript:alert(1)'>click</a>",
  ];

  it.each(HOSTILE)("carries %j through as text, with no new node kind", (src) => {
    const ast = parseMarkdown(src);
    // The substring survives verbatim — nothing is stripped, because nothing
    // needed stripping. It is data.
    expect(documentText(ast)).toContain(src);
    // And the tree contains only the seven inline kinds and seven block kinds
    // this parser can produce. An `html`/`raw` kind appearing here is the
    // regression this assertion exists to catch.
    for (const k of kinds(ast)) {
      expect(
        [
          "block:heading", "block:paragraph", "block:fence", "block:list",
          "block:quote", "block:table", "block:rule",
          "inline:text", "inline:code", "inline:strong", "inline:em",
          "inline:link",
        ],
        `unexpected node kind ${k}`,
      ).toContain(k);
    }
  });

  it("a markup-looking heading is a heading whose TEXT is the markup", () => {
    const ast = parseMarkdown("# <script>alert(1)</script>");
    expect(ast).toEqual([
      {
        kind: "heading",
        level: 1,
        children: [{ kind: "text", value: "<script>alert(1)</script>" }],
      },
    ]);
  });

  it("markup inside a fence stays inside the fence's literal value", () => {
    const ast = parseMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(ast).toEqual([
      { kind: "fence", lang: "html", value: "<script>alert(1)</script>" },
    ]);
  });

  it("markup inside inline code is a code span, not a span of code", () => {
    const ast = parseMarkdown("run `<script>` carefully");
    const para = ast[0];
    if (para?.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(para.children).toContainEqual({ kind: "code", value: "<script>" });
  });
});

describe("G-EP-6 · the link allowlist drops every non-allowlisted scheme", () => {
  const REFUSED = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "jAvAsCrIpT:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com/x",
    "/absolute/path",
    "relative/path",
    "mailto:someone@example.com",
  ];

  it.each(REFUSED)("refuses %j at the allowlist", (href) => {
    expect(safeHref(href)).toBeNull();
  });

  it.each(REFUSED)("renders [text](%j) as literal text, keeping no link", (href) => {
    const ast = parseMarkdown(`see [click me](${href}) now`);
    // No link node at all — the href is not "stripped from a link", there is
    // no link. And the source is visible, so a refusal is not a silent drop.
    expect(links(ast)).toEqual([]);
    expect(documentText(ast)).toContain(`[click me](${href})`);
  });

  it("a control character cannot smuggle a scheme past the check", () => {
    // `java\nscript:` defeats a `startsWith("javascript:")` blocklist. An
    // allowlist plus an explicit control-character refusal does not care.
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java\u0000script:alert(1)")).toBeNull();
    expect(safeHref("\u0001https://ok.example.com")).toBeNull();
  });

  const ALLOWED = [
    "https://fifty.dev/docs",
    "http://127.0.0.1:7317/api/health",
    "HTTPS://FIFTY.DEV",
    "#/layers/briefs/igris-ai/BR-001",
    "#",
  ];

  it.each(ALLOWED)("allows %j", (href) => {
    expect(safeHref(href)).toBe(href.trim());
    const ast = parseMarkdown(`see [click](${href})`);
    expect(links(ast)).toEqual([{ href: href.trim() }]);
  });

  it("drops a link title without dropping the link", () => {
    const ast = parseMarkdown('[x](https://a.example.com "the title")');
    expect(links(ast)).toEqual([{ href: "https://a.example.com" }]);
    expect(documentText(ast)).not.toContain("the title");
  });

  it("never nests a link inside a link", () => {
    const ast = parseMarkdown(
      "[outer [inner](https://b.example.com)](https://a.example.com)",
    );
    // One link node, whose children carry the inner construct as text.
    expect(links(ast)).toEqual([{ href: "https://a.example.com" }]);
  });
});

// ===========================================================================
// 2 — SELF-NEGATIVE-CONTROL (learning 1094).
//
// The block above is a set of assertions that "nothing bad appears". Such a
// suite passes against a parser that returns an EMPTY tree for every input. It
// would also pass against `parseMarkdown = () => []`. These two cases fail
// exactly that parser, so the block above cannot be vacuously green.
// ===========================================================================

describe("the suite above can fail — the parser is not returning nothing", () => {
  it("produces a non-empty tree for the hostile fixtures", () => {
    for (const src of ["<script>alert(1)</script>", "# hi", "- a"]) {
      expect(parseMarkdown(src).length, src).toBeGreaterThan(0);
    }
  });

  it("`documentText` really can observe a missing substring", () => {
    // If `documentText` returned every possible string (e.g. via a bug that
    // concatenated the raw source), the `toContain` assertions above would be
    // meaningless. It cannot.
    expect(documentText(parseMarkdown("hello"))).not.toContain("<script>");
  });
});

// ===========================================================================
// 3 — FIDELITY. What the renderer is entitled to assume it will get.
// ===========================================================================

describe("blocks", () => {
  it("parses the six ATX heading levels and rejects a seventh", () => {
    for (let level = 1; level <= 6; level += 1) {
      const ast = parseMarkdown(`${"#".repeat(level)} title`);
      expect(ast[0]).toEqual({
        kind: "heading",
        level,
        children: [{ kind: "text", value: "title" }],
      });
    }
    // Seven hashes is not a heading — it is a paragraph, literally.
    const seven = parseMarkdown("####### title");
    expect(seven[0]?.kind).toBe("paragraph");
  });

  it("closes a heading's optional trailing hashes", () => {
    expect(parseMarkdown("## title ##")[0]).toEqual({
      kind: "heading",
      level: 2,
      children: [{ kind: "text", value: "title" }],
    });
  });

  it("parses a fence with and without a language", () => {
    expect(parseMarkdown("```\nplain\n```")[0]).toEqual({
      kind: "fence",
      lang: null,
      value: "plain",
    });
    expect(parseMarkdown("~~~ts\nconst a = 1;\n~~~")[0]).toEqual({
      kind: "fence",
      lang: "ts",
      value: "const a = 1;",
    });
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const ast = parseMarkdown("```\na\n~~~\nb\n```");
    expect(ast).toEqual([{ kind: "fence", lang: null, value: "a\n~~~\nb" }]);
  });

  it("runs an unterminated fence to EOF rather than losing the body", () => {
    expect(parseMarkdown("```\nunclosed body")[0]).toEqual({
      kind: "fence",
      lang: null,
      value: "unclosed body",
    });
  });

  it("parses the three thematic-rule spellings", () => {
    for (const src of ["---", "***", "___", "- - -", "----"]) {
      expect(parseMarkdown(src), src).toEqual([{ kind: "rule" }]);
    }
  });

  it("parses an unordered list, including its markers", () => {
    for (const marker of ["-", "*", "+"]) {
      const ast = parseMarkdown(`${marker} one\n${marker} two`);
      expect(ast).toEqual([
        {
          kind: "list",
          ordered: false,
          start: 1,
          items: [
            { checked: null, children: [{ kind: "text", value: "one" }], blocks: [] },
            { checked: null, children: [{ kind: "text", value: "two" }], blocks: [] },
          ],
        },
      ]);
    }
  });

  it("parses an ordered list and keeps its start number", () => {
    const ast = parseMarkdown("3. three\n4. four");
    expect(ast[0]).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("parses task-list checkboxes — briefs' AC blocks", () => {
    const ast = parseMarkdown("- [ ] not yet\n- [x] done\n- [X] also done\n- plain");
    expect(ast[0]).toMatchObject({
      kind: "list",
      items: [
        { checked: false, children: [{ kind: "text", value: "not yet" }] },
        { checked: true, children: [{ kind: "text", value: "done" }] },
        { checked: true, children: [{ kind: "text", value: "also done" }] },
        { checked: null, children: [{ kind: "text", value: "plain" }] },
      ],
    });
  });

  it("nests a sub-list under its parent item", () => {
    const ast = parseMarkdown("- parent\n  - child\n- sibling");
    const list = ast[0];
    if (list?.kind !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.blocks[0]).toMatchObject({
      kind: "list",
      items: [{ children: [{ kind: "text", value: "child" }] }],
    });
  });

  it("parses a blockquote, recursively", () => {
    const ast = parseMarkdown("> quoted **bold**\n> still quoted");
    expect(ast[0]).toMatchObject({ kind: "quote" });
    const quote = ast[0];
    if (quote?.kind !== "quote") throw new Error("expected a quote");
    expect(quote.blocks[0]?.kind).toBe("paragraph");
  });

  it("bounds recursion depth instead of overflowing the stack", () => {
    // 400 levels of nesting. An unbounded recursive-descent parser dies here,
    // and the source is brain data rather than something the operator typed.
    const deep = `${"> ".repeat(400)}bottom`;
    const ast = parseMarkdown(deep);
    let node: BlockNode | undefined = ast[0];
    let depth = 0;
    while (node?.kind === "quote") {
      depth += 1;
      node = node.blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH + 1);
    expect(documentText(ast)).toContain("bottom");
  });

  it("parses a table with a leading/trailing pipe and an alignment row", () => {
    const ast = parseMarkdown(
      "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |",
    );
    expect(ast[0]).toEqual({
      kind: "table",
      head: [[{ kind: "text", value: "a" }], [{ kind: "text", value: "b" }]],
      rows: [
        [[{ kind: "text", value: "1" }], [{ kind: "text", value: "2" }]],
        [[{ kind: "text", value: "3" }], [{ kind: "text", value: "4" }]],
      ],
    });
  });

  it("treats a pipe line with no divider as a paragraph", () => {
    // MAINTAINING rows are pipe-dense prose. Guessing "table" from a pipe
    // alone would shred them.
    expect(parseMarkdown("a | b | c")[0]?.kind).toBe("paragraph");
  });

  it("keeps an escaped pipe inside a table cell", () => {
    const ast = parseMarkdown("| a |\n|---|\n| x \\| y |");
    expect(ast[0]).toMatchObject({
      rows: [[[{ kind: "text", value: "x | y" }]]],
    });
  });

  it("joins a soft-wrapped paragraph and breaks it on a block opener", () => {
    const ast = parseMarkdown("one\ntwo\n\n# heading");
    expect(ast).toHaveLength(2);
    expect(ast[0]).toEqual({
      kind: "paragraph",
      children: [{ kind: "text", value: "one\ntwo" }],
    });
    expect(ast[1]?.kind).toBe("heading");
  });

  it("interrupts a paragraph with a list, a quote and a fence", () => {
    for (const opener of ["- item", "> quote", "```", "## h"]) {
      const ast = parseMarkdown(`text\n${opener}`);
      expect(ast.length, opener).toBe(2);
      expect(ast[0]?.kind).toBe("paragraph");
    }
  });

  it("returns an empty tree for empty and whitespace-only source", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n\t\n")).toEqual([]);
  });

  it("reports a truncated document rather than silently shortening it", () => {
    const src = `${"a".repeat(MAX_SOURCE_CHARS + 10)}`;
    const ast = parseMarkdown(src);
    expect(documentText(ast)).toContain("document truncated");
  });
});

describe("inline spans", () => {
  it("parses bold and italic in both spellings", () => {
    expect(parseInline("**b**")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "b" }] },
    ]);
    expect(parseInline("__b__")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "b" }] },
    ]);
    expect(parseInline("*i*")).toEqual([
      { kind: "em", children: [{ kind: "text", value: "i" }] },
    ]);
    expect(parseInline("_i_")).toEqual([
      { kind: "em", children: [{ kind: "text", value: "i" }] },
    ]);
  });

  it("does NOT italicise inside an identifier", () => {
    // `brief_files.content`, `access_count`, `source_extractor` — this lens
    // renders column names constantly, and eating the underscores would make
    // them wrong in a way that looks intentional.
    expect(parseInline("brief_files_content")).toEqual([
      { kind: "text", value: "brief_files_content" },
    ]);
    expect(parseInline("a_b_c and access_count")).toEqual([
      { kind: "text", value: "a_b_c and access_count" },
    ]);
  });

  it("leaves an unclosed delimiter as literal text", () => {
    expect(parseInline("**unclosed")).toEqual([
      { kind: "text", value: "**unclosed" },
    ]);
    expect(parseInline("a `unclosed")).toEqual([
      { kind: "text", value: "a `unclosed" },
    ]);
    expect(parseInline("[unclosed](")).toEqual([
      { kind: "text", value: "[unclosed](" },
    ]);
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([
      { kind: "text", value: "*not italic*" },
    ]);
    expect(parseInline("\\`not code\\`")).toEqual([
      { kind: "text", value: "`not code`" },
    ]);
  });

  it("keeps a backslash that escapes nothing", () => {
    expect(parseInline("C:\\path\\to")).toEqual([
      { kind: "text", value: "C:\\path\\to" },
    ]);
  });

  it("supports a multi-backtick code span containing a backtick", () => {
    expect(parseInline("``a ` b``")).toEqual([{ kind: "code", value: "a ` b" }]);
  });

  it("nests emphasis inside emphasis", () => {
    expect(parseInline("**bold *and italic***")).toMatchObject([
      {
        kind: "strong",
        children: [{ kind: "text", value: "bold " }, { kind: "em" }],
      },
    ]);
  });

  it("resolves a triple-asterisk run to strong wrapping em", () => {
    expect(parseInline("***both***")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "em", children: [{ kind: "text", value: "both" }] },
        ],
      },
    ]);
  });

  it("`inlineText` flattens every kind", () => {
    const nodes = parseInline("a **b** `c` [d](https://e.example.com) *f*");
    expect(inlineText(nodes)).toBe("a b c d f");
  });
});
