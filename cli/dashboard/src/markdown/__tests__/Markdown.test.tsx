/**
 * FR-240 · G-EP-6 (the renderer half) — **the AST → element mapping emits no
 * markup, for the same fixtures `parse.test.ts` proves the AST carries as text.**
 *
 * WHY THIS FILE EXISTS AT ALL. The plan said the node vitest env "cannot render
 * components", so anything worth asserting had to live in a pure `.ts` module.
 * That turned out to be wrong on contact with the code: `react-dom/server`
 * renders to a STRING with no DOM, `react-dom` is already a devDependency, and
 * vitest resolves `dashboard/tsconfig.json` (`jsx: react-jsx`) for these files.
 * Verified empirically before this file was written. So the mapping is gated
 * here rather than deferred to the browser suite — which matters, because
 * "the AST holds it as text" and "the renderer escapes it" are two claims and
 * only the second one is the security property the operator relies on.
 *
 * WHAT THIS FILE PROVES
 *   Rendering hostile markdown produces escaped text in the emitted markup,
 *   with no live element; and the link allowlist survives the mapping.
 *
 * WHAT IT DOES **NOT** PROVE
 *   That a *different* component does not interpolate HTML. This file only ever
 *   sees `Markdown`. **Sibling:** the whole-tree `dangerouslySetInnerHTML` grep
 *   in `cli/src/__tests__/dashboard-layers-source.test.ts`, which covers every
 *   file including the ones not yet written.
 *   It also does not prove layout or CSS — no stylesheet is loaded here.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../Markdown";

function render(source: string | null): string {
  return renderToStaticMarkup(<Markdown source={source} />);
}

/**
 * Every element name that actually opens a tag in the emitted markup.
 *
 * Asserting over THIS rather than over "the output does not contain the string
 * `<script>`" is the difference between a real gate and a fragile one: escaped
 * text legitimately contains `&lt;script&gt;`, and it also legitimately
 * contains the literal characters `onload=` and `javascript:` — as TEXT. What
 * must never happen is a TAG appearing. So the assertion is over tags.
 */
function tagsIn(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    out.add((m[1] as string).toLowerCase());
  }
  return out;
}

/** The complete set of elements `Markdown` is allowed to emit. */
const ALLOWED_TAGS = new Set([
  "div", "p", "code", "strong", "em", "a", "h3", "h4", "h5", "h6", "pre", "hr",
  "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr",
  "th", "td",
]);

/** Any `on*=` handler in a TAG position — the attribute-injection signature. */
function inlineHandlers(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<[^>]*>/g)) {
    for (const h of (tag[0] as string).matchAll(/\son[a-z]+\s*=/gi)) {
      out.push(h[0] as string);
    }
  }
  return out;
}

describe("G-EP-6 · hostile markdown renders as escaped text", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<iframe src=javascript:alert(1)></iframe>",
    "<svg/onload=alert(1)>",
    "<style>body{display:none}</style>",
    "<a href='javascript:alert(1)'>click</a>",
  ];

  it.each(HOSTILE)("escapes %j", (src) => {
    const html = render(src);
    // The dangerous opener does not survive as an opener...
    expect(html).not.toContain(src);
    // ...but its text is all there, escaped, so the operator still reads the
    // document faithfully. Escaping, not stripping.
    expect(html).toContain("&lt;");
    // No tag outside our own element set, and no inline handler in any tag.
    for (const tag of tagsIn(html)) {
      expect(ALLOWED_TAGS, `unexpected element <${tag}>`).toContain(tag);
    }
    expect(inlineHandlers(html)).toEqual([]);
  });

  it("renders no anchor at all for a javascript: link", () => {
    const html = render("[click](javascript:alert(1))");
    expect(tagsIn(html).has("a")).toBe(false);
    // No ATTRIBUTE carries the scheme. The literal text may — and does, below.
    expect(html).not.toMatch(/=\s*"javascript:/i);
    // The refused construct is visible as its own source text.
    expect(html).toContain("[click](javascript:alert(1))");
  });

  it("renders an allowlisted external link with noreferrer and a new tab", () => {
    const html = render("[docs](https://fifty.dev/docs)");
    expect(html).toContain('href="https://fifty.dev/docs"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  it("renders an in-app hash link WITHOUT target/rel — it is a route", () => {
    const html = render("[brief](#/layers/briefs/igris-ai/BR-001)");
    expect(html).toContain('href="#/layers/briefs/igris-ai/BR-001"');
    expect(html).not.toContain("target=");
  });

  it("puts a fence language in an ATTRIBUTE, never in a class name", () => {
    const html = render('```" onmouseover="alert(1)\nbody\n```');
    expect(html).toContain("<pre");
    expect(html).not.toMatch(/class="[^"]*onmouseover/);
    expect(inlineHandlers(html)).toEqual([]);
  });

  it("every element the renderer can emit is on the allowed list", () => {
    // Renders one of EVERY block and inline kind at once, so `ALLOWED_TAGS`
    // above is a complete inventory rather than an aspiration — if a future
    // node kind emits a new element, this fails and the list gets reviewed.
    const html = render(
      [
        "# h1",
        "",
        "para with **b**, *i*, `c` and [l](https://a.example.com)",
        "",
        "- [x] task",
        "- plain",
        "",
        "1. first",
        "",
        "> quote",
        "",
        "| a |",
        "|---|",
        "| 1 |",
        "",
        "---",
        "",
        "```ts",
        "code",
        "```",
      ].join("\n"),
    );
    const tags = tagsIn(html);
    for (const tag of tags) {
      expect(ALLOWED_TAGS, `unexpected element <${tag}>`).toContain(tag);
    }
    // And the inventory really was exercised — not two tags and a pass.
    expect(tags.size).toBeGreaterThanOrEqual(18);
  });
});

describe("this suite can fail — the renderer is not returning nothing", () => {
  /**
   * Learning 1094: a guard whose only observed output is "pass" is
   * indistinguishable from a broken one. Every assertion above is of the form
   * "the output does not contain X", and they all hold for `render = () => ""`.
   * These three fail exactly that renderer.
   */
  it("emits real elements for ordinary markdown", () => {
    const html = render(
      "# Title\n\nA **bold** word and `code`.\n\n- [x] done\n- [ ] todo\n",
    );
    expect(html).toContain("<h3");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html).toContain("checkbox");
  });

  it("emits a table, a quote, a rule and a fence", () => {
    const html = render(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---\n\n```ts\nconst a = 1;\n```",
    );
    expect(html).toContain("<table");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<hr");
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain("const a = 1;");
  });

  it("escapes ordinary content too, not just the hostile fixtures", () => {
    expect(render("a < b & c > d")).toContain("a &lt; b &amp; c &gt; d");
  });
});

describe("structure", () => {
  it("offsets headings so a document h1 becomes an h3", () => {
    expect(render("# one")).toContain("<h3");
    expect(render("## two")).toContain("<h4");
    // Clamped at 6 — never an `<h7>`, which is not an element.
    expect(render("##### five")).toContain("<h6");
    expect(render("###### six")).toContain("<h6");
    expect(render("###### six")).not.toContain("<h7");
  });

  it("renders task checkboxes DISABLED — this lens is read-only (AC #7)", () => {
    const html = render("- [x] shipped");
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    // `readOnly` does nothing to a checkbox; asserting `disabled` is asserting
    // the thing that actually prevents the click.
    expect(html).not.toContain("readonly");
  });

  it("renders nothing for empty, blank and null source", () => {
    expect(render(null)).toBe("");
    expect(render("")).toBe("");
    expect(render("   \n\n ")).toBe("");
  });

  it("keeps an ordered list's start number", () => {
    expect(render("3. three")).toContain('start="3"');
  });
});
