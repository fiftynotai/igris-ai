/**
 * FR-240 (D4) — the block AST → **React ELEMENTS**.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THERE IS NO `dangerouslySetInnerHTML` IN THIS FILE, AND THERE NEVER MAY BE
 * ─────────────────────────────────────────────────────────────────────────
 * The dashboard is a **no-auth loopback origin whose every `/api/*` endpoint
 * reads the operator's brain**. Script execution in this origin is a read
 * primitive over every brief, learning and context doc on the machine — not a
 * defacement. The bodies rendered here come from `brief_files.content`,
 * `learnings.content` and the context-doc files: data written by agents, over
 * many sessions, from many sources.
 *
 * So the safety property is structural rather than procedural. `parse.ts`
 * produces a closed set of node kinds, none of which carries markup, and this
 * file maps each kind to an element with the text as a CHILD. React escapes
 * text children. There is no string-to-markup step anywhere in the path, which
 * means there is no sanitiser to keep current and no bypass list to audit.
 *
 * Guarded three ways: `parse.test.ts` (the data), `Markdown.test.tsx` (this
 * mapping, through `react-dom/server`), and a whole-tree grep for
 * `dangerouslySetInnerHTML` in `cli/src/__tests__/dashboard-layers-source.test.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HEADING LEVELS ARE OFFSET, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────
 * A brief body opens with `# FR-240 — …`, and it is rendered INSIDE a page that
 * already has an `<h1>` (the shell's) and an `<h2>` (the record title). Emitting
 * the document's own `<h1>` would put two h1s on the page and skip no levels
 * only by luck. Every level is therefore shifted by `HEADING_OFFSET` and
 * clamped at 6, so the document's outline nests under the record's instead of
 * competing with it. The visual weight is CSS's job either way.
 */

import { Fragment } from "react";
import { cn } from "../lib/cn";
import {
  parseMarkdown,
  type BlockNode,
  type Cell,
  type InlineNode,
} from "./parse";

/** Shift applied to every document heading. See the header. */
const HEADING_OFFSET = 2;

export interface MarkdownProps {
  /** Raw markdown. `null` renders nothing — the caller owns the empty state. */
  source: string | null | undefined;
  className?: string;
}

function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case "text":
            // A plain string child. React escapes it. This is the whole
            // security argument, in one line.
            return <Fragment key={i}>{node.value}</Fragment>;
          case "code":
            return (
              <code key={i} className="record-md-code">
                {node.value}
              </code>
            );
          case "strong":
            return (
              <strong key={i}>
                <Inline nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inline nodes={node.children} />
              </em>
            );
          case "link": {
            // The href is already allowlisted to http/https/# by `safeHref`.
            // An in-document `#` link is an app route and must NOT open a tab;
            // an external one gets `noreferrer` so the operator's local URL
            // (which names their port) never leaves the machine in a Referer.
            const external = !node.href.startsWith("#");
            return (
              <a
                key={i}
                href={node.href}
                className="record-md-link"
                {...(external
                  ? { target: "_blank", rel: "noreferrer noopener" }
                  : {})}
              >
                <Inline nodes={node.children} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

function Row({ cells, head }: { cells: readonly Cell[]; head: boolean }) {
  return (
    <tr>
      {cells.map((cell, i) =>
        head ? (
          <th key={i}>
            <Inline nodes={cell} />
          </th>
        ) : (
          <td key={i}>
            <Inline nodes={cell} />
          </td>
        ),
      )}
    </tr>
  );
}

function Blocks({ blocks }: { blocks: readonly BlockNode[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading": {
            const level = Math.min(block.level + HEADING_OFFSET, 6);
            const Tag = `h${level}` as "h3";
            return (
              <Tag key={i} className="record-md-h">
                <Inline nodes={block.children} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                <Inline nodes={block.children} />
              </p>
            );
          case "fence":
            return (
              // `data-lang` is an attribute, never a class name built from
              // untrusted text: a fence's "language" is arbitrary source text
              // and has no business reaching the class attribute.
              <pre key={i} className="record-md-pre" data-lang={block.lang}>
                <code>{block.value}</code>
              </pre>
            );
          case "rule":
            return <hr key={i} className="record-md-rule" />;
          case "quote":
            return (
              <blockquote key={i} className="record-md-quote">
                <Blocks blocks={block.blocks} />
              </blockquote>
            );
          case "list": {
            const items = block.items.map((item, j) => (
              <li
                key={j}
                className={cn(item.checked !== null && "record-md-task")}
              >
                {item.checked !== null && (
                  <input
                    type="checkbox"
                    checked={item.checked}
                    // AC #7: read-only throughout. A brief's AC block is a
                    // VIEW of the brief's text, not a control over it — FR-241
                    // owns every write path. `disabled` rather than
                    // `readOnly`, because a checkbox ignores `readOnly`.
                    disabled
                    aria-label={item.checked ? "done" : "not done"}
                  />
                )}
                <Inline nodes={item.children} />
                {item.blocks.length > 0 && <Blocks blocks={item.blocks} />}
              </li>
            ));
            return block.ordered ? (
              <ol key={i} className="record-md-list" start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={i} className="record-md-list">
                {items}
              </ul>
            );
          }
          case "table":
            return (
              <div key={i} className="record-md-table-wrap">
                <table className="record-md-table">
                  {block.head.length > 0 && (
                    <thead>
                      <Row cells={block.head} head />
                    </thead>
                  )}
                  <tbody>
                    {block.rows.map((row, j) => (
                      <Row key={j} cells={row} head={false} />
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * Render markdown as React elements.
 *
 * Parsing happens on every render. That is deliberate rather than lazy: the
 * bodies are single documents (a brief, a learning, one context doc), the parse
 * is linear, and a memo keyed on the source string would be a cache whose
 * invalidation is another thing to get wrong. If a profile ever says otherwise,
 * memoise at the CALL SITE where the source's lifetime is known.
 */
export function Markdown({ source, className }: MarkdownProps) {
  if (source === null || source === undefined || source.trim().length === 0) {
    return null;
  }
  return (
    <div className={cn("record-md", className)}>
      <Blocks blocks={parseMarkdown(source)} />
    </div>
  );
}
