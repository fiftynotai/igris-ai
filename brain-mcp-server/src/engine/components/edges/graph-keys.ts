/**
 * Brain Engine v7.0 — Composite graph-node keys (FR-237)
 *
 * A standalone, dependency-free serialiser for the three-part node key
 * `type | project | id` used by the whole-brain graph data layer.
 *
 * WHY THREE SEGMENTS
 * ------------------
 * The pre-existing two-part form `${type}|${id}` (the `traversal.ts` visited-set
 * key and `visualization.ts`'s `GraphNode.id`) cannot express the project axis.
 * `brief_id` is UNIQUE only per `(project, brief_id)` — `BR-001` exists in 25
 * projects on the live brain — so a two-part key fuses all 25 into one node and
 * silently invents edges between unrelated projects. Inserting the project in
 * the MIDDLE keeps the familiar `type|…|id` reading order.
 *
 * WHY ESCAPED
 * -----------
 * `graph_nodes.node_external_id` is free-form operator input (`concept:vector-search`
 * today, anything tomorrow). A single `|` inside an id would mis-parse into a
 * wrong project under a naive `split('|')`. The backslash escape costs six
 * characters and makes `parseNodeKey` a total function.
 *
 * THE STRUCTURED TRIPLE IS THE TRUTH
 * ----------------------------------
 * Every node object carries `{ type, project, id }` as real fields; `key` is a
 * DERIVED join token for graph libraries (vis-network / d3-force want a scalar
 * node id). Consumers should read the structured fields and treat `key` as an
 * opaque handle — `parseNodeKey` exists for round-trip verification and for
 * consumers that only ever see the token (e.g. an edge's `from`/`to`).
 *
 * DEPENDENCY-FREE ON PURPOSE
 * --------------------------
 * This module imports NOTHING. `traversal.ts` has the identical collision
 * exposure (2-part visited-set key + a `LABEL_SCHEMA.brief` comment that admits
 * it picks the first project's title). FR-237 deliberately does NOT retrofit it —
 * doing so changes the result set of three shipped tools. When that follow-up is
 * taken, it can `import { encodeNodeKey } from './graph-keys.js'` without moving
 * a single line of this file.
 *
 * @module engine/components/edges/graph-keys
 * @author fifty.dev
 */

/** The structured triple that identifies a node in the whole-brain graph. */
export interface NodeKeyParts {
  /** Entity type (`brief`, `learning`, `goal`, `error`, `concept`, `decision`, `session`). */
  type: string;
  /** Owning project slug, or `null` when the entity genuinely has no owner. */
  project: string | null;
  /** Stable external id, verbatim from the source table. */
  id: string;
}

/** Segment separator in the serialised key. */
const SEP = '|';

/** Escape character for literal `|` and `\` inside a segment. */
const ESC = '\\';

/**
 * Escape one segment so it cannot contain an unescaped separator.
 *
 * Order matters: backslashes are doubled FIRST, otherwise the backslash we
 * introduce when escaping a `|` would itself be doubled on a second pass.
 */
function encodeSeg(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Serialise a `(type, project, id)` triple into the composite node key.
 *
 * `project === null` (or `''`) produces an empty middle segment, which is
 * unambiguous: `projects.slug` is `UNIQUE NOT NULL` and every slug in the store
 * is non-empty, so a zero-length project segment can only mean "no owner".
 *
 * @example encodeNodeKey({ type: 'brief', project: 'igris-ai', id: 'FR-237' })
 *          // => 'brief|igris-ai|FR-237'
 * @example encodeNodeKey({ type: 'goal', project: null, id: 'GL-004' })
 *          // => 'goal||GL-004'
 */
export function encodeNodeKey(parts: NodeKeyParts): string {
  return [parts.type, parts.project ?? '', parts.id].map(encodeSeg).join(SEP);
}

/**
 * Parse a composite node key back into its structured triple.
 *
 * Walks the string character-by-character honouring the backslash escape — a
 * naive `split('|')` is WRONG and would pass every happy-path test while
 * silently mis-parsing any id containing a literal `|`.
 *
 * Total function: a malformed key (wrong segment count, trailing lone escape)
 * never throws. Missing segments come back as empty strings; extra separators
 * beyond the third segment are folded into the id, which is the lossless
 * reading for a key produced by `encodeNodeKey` (they cannot occur there) and
 * the least-surprising reading for hand-written input.
 *
 * @example parseNodeKey('brief|igris-ai|FR-237')
 *          // => { type: 'brief', project: 'igris-ai', id: 'FR-237' }
 */
export function parseNodeKey(key: string): NodeKeyParts {
  const segments: string[] = [];
  let current = '';
  let escaped = false;

  for (const ch of key) {
    if (escaped) {
      // A backslash escapes the NEXT character verbatim, whatever it is.
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === ESC) {
      escaped = true;
      continue;
    }
    if (ch === SEP && segments.length < 2) {
      // Only the first two separators split — everything after the second
      // belongs to the id (defensive; encodeNodeKey never emits a third).
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  // A trailing lone backslash is dropped rather than throwing (total function).
  segments.push(current);

  const type = segments[0] ?? '';
  const project = segments[1] ?? '';
  const id = segments[2] ?? '';

  return { type, project: project === '' ? null : project, id };
}
