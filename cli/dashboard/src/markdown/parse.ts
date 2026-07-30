/**
 * FR-240 (D4) — markdown source → a block AST. **PURE. No DOM, no React.**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS RATHER THAN A DEPENDENCY
 * ─────────────────────────────────────────────────────────────────────────
 * Two forcing constraints, both from the plan's D4:
 *
 *  1. **The packed-size ceiling is ONE cumulative number** (+400 KB over
 *     `PACK_BASELINE_PACKED`, across FR-238/239/240/241). FR-239 spent
 *     +283.4 KB, so at authoring time FR-240 and FR-241 had ~116.6 KB between
 *     them. A markdown dependency is the single easiest way to spend all of it
 *     on one feature.
 *
 *     *Measured outcome, recorded so this reads as a decision rather than a
 *     forecast:* FR-240 shipped **+47.2 KB** all in, this parser included —
 *     under half the share it was budgeted. `tarball.test.ts` is the source of
 *     truth for the live cumulative figure and the remaining headroom; the one
 *     number above is history and does not move.
 *
 *  2. **A `marked`-style renderer emits an HTML STRING**, which means
 *     `dangerouslySetInnerHTML` on a no-auth origin whose every `/api/*`
 *     endpoint reads the operator's brain. An XSS there is a real read
 *     primitive, not a defacement. A parser that stops at an AST — and a
 *     renderer that turns the AST into React ELEMENTS — is XSS-free by
 *     construction, because React escapes text children and never parses a
 *     string as markup.
 *
 * The decisive third reason is testability: this module is a pure `.ts` unit,
 * so the injection cases are asserted in the node vitest env with no browser
 * (`__tests__/parse.test.ts`). `Markdown.tsx` is asserted there too, through
 * `react-dom/server`, so both halves of the claim are gated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE RULE
 * ─────────────────────────────────────────────────────────────────────────
 * **Anything this parser does not recognise becomes TEXT.** There is no
 * pass-through branch, no `html` node kind, and no place a raw source
 * substring can reach the renderer as markup. `<script>alert(1)</script>` is
 * not "sanitised" here — it is simply never treated as anything but a run of
 * characters, which is a stronger property than sanitisation because it has no
 * bypass list to keep current.
 *
 * SCOPE (the plan's list, complete): ATX headings, paragraphs, fenced code,
 * inline code, bold, italic, links (scheme-allowlisted), unordered and ordered
 * lists, task-list checkboxes (briefs' AC blocks), blockquotes, tables, and
 * thematic rules. Deliberately ABSENT: setext headings, reference links,
 * autolinks, images, footnotes, HTML blocks, inline HTML. Each absence means
 * "renders as its literal source", which is the honest failure mode for an
 * operator's own lens.
 */

// ---------------------------------------------------------------------------
// The AST. This is the contract between this file and `Markdown.tsx`; nothing
// else may consume it, and nothing in it can carry markup.
// ---------------------------------------------------------------------------

/** A span inside a block. `text` and `code` values are LITERAL characters. */
export type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] };

/** One table cell's spans. */
export type Cell = InlineNode[];

/** One list item. `checked` is `null` unless the item opened with `[ ]`/`[x]`. */
export interface ListItemNode {
  checked: boolean | null;
  children: InlineNode[];
  /** Nested content (a sub-list, a fence, a second paragraph). */
  blocks: BlockNode[];
}

export type BlockNode =
  | { kind: "heading"; level: number; children: InlineNode[] }
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "fence"; lang: string | null; value: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItemNode[] }
  | { kind: "quote"; blocks: BlockNode[] }
  | { kind: "table"; head: Cell[]; rows: Cell[][] }
  | { kind: "rule" };

// ---------------------------------------------------------------------------
// Guards. Both are bounds on a HOSTILE or merely enormous input, and both are
// asserted rather than assumed.
// ---------------------------------------------------------------------------

/**
 * Hard cap on the source this parser will look at.
 *
 * `/api/context-doc` already caps its disk read, but `brief_files.content` and
 * `learnings.content` have no length bound in the brain — a 2 MB brief is
 * legal. The cap is stated here rather than at the call sites so every consumer
 * inherits it, and the truncation is REPORTED as a trailing paragraph instead
 * of silently shortening the document.
 */
export const MAX_SOURCE_CHARS = 250_000;

/**
 * Nesting depth for blockquotes and nested lists.
 *
 * Past this, content is emitted as paragraphs. A markdown file is data from the
 * brain, and `> > > > > …` repeated a thousand times is a stack overflow in a
 * naive recursive-descent parser — which is a browser tab crash on the
 * operator's own lens, from a document they may not have written.
 */
export const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Link scheme allowlist — the security boundary that is not "escape harder".
// ---------------------------------------------------------------------------

/**
 * `http:`, `https:` and same-document `#` fragments. Nothing else.
 *
 * This is an ALLOWLIST, so it fails closed: `javascript:`, `data:`,
 * `vbscript:`, `file:`, a protocol-relative `//evil`, and every casing and
 * entity trick against them are rejected by not matching, rather than by
 * appearing on a blocklist someone has to keep current.
 *
 * A rejected href does not produce a link with a stripped `href` — it makes the
 * whole `[text](href)` construct fall through as literal text, so the operator
 * SEES the thing that was refused instead of a dead control.
 */
const SAFE_HREF = /^(?:https?:\/\/[^\s"'<>`]+|#[^\s"'<>`]*)$/i;

/** Returns the href if it is on the allowlist, else `null`. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0) return null;
  // A control character inside a URL is never legitimate here, and embedding
  // one is the classic way a scheme check is smuggled past a blocklist. The
  // positive allowlist below would already refuse it; this refuses it twice.
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  return SAFE_HREF.test(href) ? href : null;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

/** Characters a backslash may escape. Anything else keeps its backslash. */
const ESCAPABLE = new Set([
  "\\", "`", "*", "_", "[", "]", "(", ")", "#", "|", "-", "+", ".", "!", ">",
]);

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** A closing run of exactly `n` backticks, or `-1`. */
function findCodeClose(src: string, from: number, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < src.length && src[i + run] === "`") run += 1;
    if (run === n) return i;
    i += run;
  }
  return -1;
}

/**
 * An inline code span.
 *
 * Its content is NEVER re-parsed — that is what makes documentation of this
 * very syntax renderable, and it also means a backticked `<script>` stays a
 * backticked `<script>`.
 */
function readCode(
  src: string,
  at: number,
): { node: InlineNode; next: number } | null {
  let n = 0;
  while (at + n < src.length && src[at + n] === "`") n += 1;
  const close = findCodeClose(src, at + n, n);
  if (close === -1) return null;
  let value = src.slice(at + n, close);
  // CommonMark's one-space strip, so `` ` `` renders as a lone backtick.
  if (value.length > 2 && value.startsWith(" ") && value.endsWith(" ")) {
    value = value.slice(1, -1);
  }
  return { node: { kind: "code", value }, next: close + n };
}

/** `**strong**` / `__strong__` / `*em*` / `_em_`. */
function readEmphasis(
  src: string,
  at: number,
  allowLink: boolean,
): { node: InlineNode; next: number } | null {
  const marker = src[at];
  if (marker === undefined) return null;
  const strong = src[at + 1] === marker;
  const delim = strong ? marker + marker : marker;

  // Intraword `_` is a legitimate character in `brief_files`, `access_count`
  // and every other identifier this lens renders. Underscore emphasis
  // therefore requires a non-word character before the opener; asterisk does
  // not, matching CommonMark's own asymmetry.
  if (marker === "_" && isWordChar(src[at - 1])) return null;

  const from = at + delim.length;
  if (src[from] === undefined || src[from] === " ") return null;

  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(delim, i) && i > from) {
      // For `_`, the closer must also sit at a word boundary.
      if (marker === "_" && isWordChar(src[i + delim.length])) {
        i += 1;
        continue;
      }
      // A closing RUN longer than the delimiter closes the OUTER emphasis with
      // its last two characters, leaving the rest to the recursive call. That
      // is what makes `***both***` resolve to strong-wrapping-em instead of
      // strong followed by a stray asterisk — the one delimiter-run rule from
      // CommonMark worth having here, because `***` is common in briefs.
      let run = 0;
      while (src[i + run] === marker) run += 1;
      const closer = strong && run > 2 ? i + run - 2 : i;
      const inner = src.slice(from, closer);
      if (inner.length === 0) {
        i += 1;
        continue;
      }
      return {
        node: {
          kind: strong ? "strong" : "em",
          children: parseInline(inner, allowLink),
        },
        next: closer + delim.length,
      };
    }
    i += 1;
  }
  return null;
}

/** `[text](href)` with the href on the allowlist, else `null` (→ literal). */
function readLink(
  src: string,
  at: number,
): { node: InlineNode; next: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || src[close + 1] !== "(") return null;

  const end = src.indexOf(")", close + 2);
  if (end === -1) return null;

  const target = src.slice(close + 2, end);
  // `[t](url "title")` — the title is dropped, not rendered.
  const href = safeHref(target.split(/\s+/)[0] ?? "");
  if (href === null) return null;

  return {
    node: {
      kind: "link",
      href,
      // `allowLink: false` — a link inside a link is invalid HTML and React
      // would happily nest the two anchors. One level only.
      children: parseInline(src.slice(at + 1, close), false),
    },
    next: end + 1,
  };
}

/**
 * Tokenise one block's text into spans.
 *
 * The loop is deliberately shaped so that **every branch either consumes a
 * recognised construct or appends exactly one character to the literal
 * buffer.** There is no third outcome, which is the structural reason unknown
 * syntax cannot become anything but text.
 */
export function parseInline(src: string, allowLink = true): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === "\\") {
      const next = src[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    if (ch === "`") {
      const code = readCode(src, i);
      if (code !== null) {
        flush();
        out.push(code.node);
        i = code.next;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const emph = readEmphasis(src, i, allowLink);
      if (emph !== null) {
        flush();
        out.push(emph.node);
        i = emph.next;
        continue;
      }
    }

    if (ch === "[" && allowLink) {
      const link = readLink(src, i);
      if (link !== null) {
        flush();
        out.push(link.node);
        i = link.next;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const RE_RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RE_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/;
const RE_TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

/** True when this line opens a block that must interrupt a paragraph. */
function opensBlock(line: string | undefined): boolean {
  if (line === undefined) return false;
  return (
    RE_HEADING.test(line) ||
    RE_FENCE.test(line) ||
    RE_RULE.test(line) ||
    RE_QUOTE.test(line) ||
    RE_ITEM.test(line)
  );
}

/** Split a table row on unescaped pipes, dropping the edge padding cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  if (cells.length > 0 && cells[0]?.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]?.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Leading-whitespace width, tabs already expanded by `parseMarkdown`. */
function indentOf(line: string): number {
  const m = /^[ ]*/.exec(line);
  return m === null ? 0 : m[0].length;
}

/**
 * Parse a markdown document into blocks.
 *
 * `depth` is internal (blockquote / nested-list recursion) and bounded by
 * `MAX_DEPTH`.
 */
export function parseMarkdown(source: string, depth = 0): BlockNode[] {
  let src = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  let truncated = false;
  if (src.length > MAX_SOURCE_CHARS) {
    src = src.slice(0, MAX_SOURCE_CHARS);
    truncated = true;
  }

  const lines = src.split("\n");
  const out: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // ---- fenced code (checked FIRST: everything inside it is literal) ----
    const fence = RE_FENCE.exec(line);
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string;
      const lang = (fence[2] ?? "").trim();
      const body: string[] = [];
      i += 1;
      // The close must be a bare fence line of the SAME character. An
      // unterminated fence runs to EOF, which is what makes a truncated brief
      // body render as code rather than as a wall of unparsed markup.
      const isClose = (cur: string): boolean => {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(cur);
        return m !== null && (m[1] as string)[0] === marker;
      };
      while (i < lines.length) {
        const cur = lines[i] as string;
        if (isClose(cur)) {
          i += 1;
          break;
        }
        body.push(cur);
        i += 1;
      }
      out.push({
        kind: "fence",
        lang: lang.length > 0 ? lang : null,
        value: body.join("\n"),
      });
      continue;
    }

    // ---- thematic rule (before heading: `---` is not a heading) ----
    if (RE_RULE.test(line)) {
      out.push({ kind: "rule" });
      i += 1;
      continue;
    }

    // ---- ATX heading ----
    const heading = RE_HEADING.exec(line);
    if (heading !== null) {
      out.push({
        kind: "heading",
        level: (heading[1] as string).length,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    // ---- blockquote ----
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = RE_QUOTE.exec(lines[i] as string);
        if (m === null) break;
        inner.push(m[1] ?? "");
        i += 1;
      }
      out.push({
        kind: "quote",
        blocks:
          depth >= MAX_DEPTH
            ? [{ kind: "paragraph", children: parseInline(inner.join("\n")) }]
            : parseMarkdown(inner.join("\n"), depth + 1),
      });
      continue;
    }

    // ---- table ----
    if (line.includes("|") && RE_TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      const head = splitRow(line).map((c) => parseInline(c));
      i += 2;
      const rows: Cell[][] = [];
      while (i < lines.length) {
        const cur = lines[i] as string;
        if (isBlank(cur) || !cur.includes("|")) break;
        rows.push(splitRow(cur).map((c) => parseInline(c)));
        i += 1;
      }
      out.push({ kind: "table", head, rows });
      continue;
    }

    // ---- list ----
    const item = RE_ITEM.exec(line);
    if (item !== null) {
      const base = indentOf(line);
      const ordered = item[3] !== undefined;
      const start = ordered ? Number(item[3]) : 1;
      /** Raw lines per item, dedented on the way in. */
      const chunks: string[][] = [];
      let current: string[] | null = null;

      while (i < lines.length) {
        const cur = lines[i] as string;
        if (isBlank(cur)) {
          // A blank line ends the list unless the NEXT line continues it.
          const next = lines[i + 1];
          const continues =
            next !== undefined &&
            !isBlank(next) &&
            (indentOf(next) > base ||
              (RE_ITEM.test(next) && indentOf(next) === base));
          if (!continues) {
            i += 1;
            break;
          }
          current?.push("");
          i += 1;
          continue;
        }
        const m = RE_ITEM.exec(cur);
        if (m !== null && indentOf(cur) <= base) {
          current = [m[4] ?? ""];
          chunks.push(current);
          i += 1;
          continue;
        }
        if (indentOf(cur) > base && current !== null) {
          // Dedent by the base indent so a nested list parses as a list rather
          // than as an indented paragraph.
          current.push(cur.slice(Math.min(indentOf(cur), base + 2)));
          i += 1;
          continue;
        }
        break;
      }

      const items: ListItemNode[] = chunks.map((chunk) => {
        // The item's own inline text is its first line plus any immediately
        // following plain continuation lines (a wrapped sentence).
        const lead: string[] = [chunk[0] ?? ""];
        let k = 1;
        while (k < chunk.length && !isBlank(chunk[k]) && !opensBlock(chunk[k])) {
          lead.push(chunk[k] as string);
          k += 1;
        }
        const rest = chunk.slice(k).join("\n").trim();
        let text = lead.join("\n");
        let checked: boolean | null = null;
        const task = RE_TASK.exec(text);
        if (task !== null) {
          checked = (task[1] ?? " ").toLowerCase() === "x";
          text = task[2] ?? "";
        }
        return {
          checked,
          children: parseInline(text),
          blocks:
            rest.length === 0 || depth >= MAX_DEPTH
              ? []
              : parseMarkdown(rest, depth + 1),
        };
      });

      out.push({ kind: "list", ordered, start, items });
      continue;
    }

    // ---- paragraph ----
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const cur = lines[i] as string;
      if (isBlank(cur) || opensBlock(cur)) break;
      if (cur.includes("|") && RE_TABLE_DIVIDER.test(lines[i + 1] ?? "")) break;
      para.push(cur);
      i += 1;
    }
    out.push({ kind: "paragraph", children: parseInline(para.join("\n")) });
  }

  if (truncated) {
    out.push({
      kind: "paragraph",
      children: [
        {
          kind: "text",
          value: `… document truncated at ${MAX_SOURCE_CHARS} characters for rendering.`,
        },
      ],
    });
  }

  return out;
}

/**
 * Flatten an inline tree to its literal text.
 *
 * Used for row previews and `title` attributes — places that need the words
 * without the structure. Exported because a second implementation of "what
 * does this AST say" is exactly the kind of drift D4 removes.
 */
export function inlineText(nodes: readonly InlineNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text" || n.kind === "code") out += n.value;
    else out += inlineText(n.children);
  }
  return out;
}
