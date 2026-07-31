/**
 * FR-241 Phase 1 — `igris_suggestion_list` WIRE-OUTPUT parity golden.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * FR-241 lifts the SELECT out of `handleSuggestionList` into the pure
 * `db`-param reader `tools/suggestions-read.ts#listSuggestions`, leaving the
 * handler a thin wrapper (the FR-237/FR-240 pure-layer/wrapper seam). The
 * handler `JSON.stringify(…, null, 2)`s its payload DIRECTLY, so key order,
 * indentation and field set are part of the wire format its callers parse.
 *
 * The snapshots below were recorded with `vitest run -u` against the code as it
 * stood **BEFORE** the lift. They are a record of the pre-lift wire format, not
 * a description of the post-lift one. **Re-recording them (`-u`) to make this
 * file pass is the one move that defeats its purpose.**
 *
 * CONSUMERS — derived by grep, not from the plan (L-449 / the FR-240 lesson
 * where a plan named `/awaken` and `/distill`, both wrong):
 *
 *     grep -rl igris_suggestion_list ~/.igris/core/skills/
 *
 * WHAT THIS GATE PROVES
 * ---------------------
 * That `handleSuggestionList` emits byte-identical text across the extraction,
 * for the ordering rule (the `CASE priority` collation), every filter, the
 * pagination window, the `total`-vs-`count` distinction, the `evidence`
 * JSON-parse mapping, and each validation-error message.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That the new `facets` block is correct — that is a NEW field the wrapper
 *    deliberately does NOT emit (adding it would break this very golden), so it
 *    is covered by `tools/__tests__/suggestions-read.test.ts` instead.
 *  - That the reader is pure. **Sibling:** `tools/__tests__/pure-read-purity.test.ts`.
 *  - That the dashboard's `/api/suggestions` shape is right — different wire,
 *    different consumer. **Sibling:** `cli/src/__tests__/dashboard-*`.
 *
 * @module engine/components/subconscious/__tests__/suggestion-list-wire-parity.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

import { getDb } from '../../../../db.js';
import { handleSuggestionList } from '../handlers.js';
import { subconsciousMigrations } from '../schema.js';
import { applyMinimalSchema } from './fixtures/minimal-schema.js';

let db: Database.Database;

/**
 * A fixture with FIXED `created_at` values.
 *
 * Load-bearing: `created_at` is in the emitted text, so a `datetime('now')`
 * default would make every snapshot a fresh mismatch. It also makes the
 * ordering rule observable — `high` before `medium` before `low`, then
 * `created_at DESC` inside a band — rather than incidental.
 */
const ROWS: {
  source_module: string;
  project_slug: string | null;
  title: string;
  evidence: string;
  priority: string;
  status: string;
  created_at: string;
}[] = [
  {
    source_module: 'gap',
    project_slug: 'igris-ai',
    title: 'low but newest',
    evidence: '{"kind":"gap","n":1}',
    priority: 'low',
    status: 'pending',
    created_at: '2026-07-30 12:00:00',
  },
  {
    source_module: 'gap',
    project_slug: 'igris-ai',
    title: 'high but oldest',
    evidence: '{"kind":"gap","n":2}',
    priority: 'high',
    status: 'pending',
    created_at: '2026-07-01 09:00:00',
  },
  {
    source_module: 'missing_followup',
    project_slug: 'igris-ai',
    title: 'medium middle',
    // Deliberately MALFORMED — `rowToSuggestion` must degrade it to `{}`
    // rather than throw, and that degradation is part of the wire format.
    evidence: 'not json at all',
    priority: 'medium',
    status: 'pending',
    created_at: '2026-07-15 09:00:00',
  },
  {
    source_module: 'janitor',
    project_slug: 'other-project',
    title: 'another project',
    evidence: '{"kind":"janitor"}',
    priority: 'high',
    status: 'pending',
    created_at: '2026-07-20 09:00:00',
  },
  {
    source_module: 'gap',
    project_slug: 'igris-ai',
    title: 'already dismissed',
    evidence: '{"kind":"gap","n":3}',
    priority: 'high',
    status: 'dismissed',
    created_at: '2026-07-10 09:00:00',
  },
];

beforeEach(() => {
  db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  const stmt = db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of ROWS) {
    stmt.run(
      r.source_module,
      r.project_slug,
      r.title,
      r.evidence,
      r.priority,
      r.status,
      r.created_at,
    );
  }
  vi.mocked(getDb).mockReturnValue(db);
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

/** The raw emitted text — NOT a re-parse. The bytes are the contract. */
function wire(args: Record<string, unknown>): string {
  const r = handleSuggestionList(args) as { content: { text: string }[] };
  return r.content[0]!.text;
}

describe('FR-241 — igris_suggestion_list wire output is unchanged by the lift', () => {
  it('no filters — the CASE priority ordering and the evidence mapping', () => {
    expect(wire({})).toMatchSnapshot();
  });

  it('status filter', () => {
    expect(wire({ status: 'pending' })).toMatchSnapshot();
  });

  it('project_slug filter', () => {
    expect(wire({ project_slug: 'igris-ai' })).toMatchSnapshot();
  });

  it('source_module filter (OPEN vocabulary since FR-118 M2)', () => {
    expect(wire({ source_module: 'gap' })).toMatchSnapshot();
  });

  it('priority filter', () => {
    expect(wire({ priority: 'high' })).toMatchSnapshot();
  });

  it('all four filters at once', () => {
    expect(
      wire({
        status: 'pending',
        project_slug: 'igris-ai',
        source_module: 'gap',
        priority: 'high',
      }),
    ).toMatchSnapshot();
  });

  it('pagination — count differs from total', () => {
    expect(wire({ limit: 2, offset: 1 })).toMatchSnapshot();
  });

  it('an offset past the end returns an empty page with a real total', () => {
    expect(wire({ limit: 5, offset: 99 })).toMatchSnapshot();
  });

  it('the limit is capped at 1000', () => {
    expect(wire({ limit: 99999 })).toMatchSnapshot();
  });

  it('a filter that matches nothing', () => {
    expect(wire({ source_module: 'no-such-module' })).toMatchSnapshot();
  });
});

describe('FR-241 — the VALIDATION messages are wire contracts too', () => {
  /**
   * These stay in the WRAPPER, not the reader (the FR-240 split rule:
   * "argument validation and every validation MESSAGE" is wrapper-side). A
   * reader that validated would be a reader with a second error vocabulary.
   */
  it('invalid status', () => {
    expect(wire({ status: 'bogus' })).toMatchSnapshot();
  });

  it('non-string source_module', () => {
    expect(wire({ source_module: 42 })).toMatchSnapshot();
  });

  it('empty source_module', () => {
    expect(wire({ source_module: '' })).toMatchSnapshot();
  });

  it('invalid priority', () => {
    expect(wire({ priority: 'urgent' })).toMatchSnapshot();
  });

  it('non-numeric limit', () => {
    expect(wire({ limit: 'many' })).toMatchSnapshot();
  });

  it('zero limit', () => {
    expect(wire({ limit: 0 })).toMatchSnapshot();
  });

  it('negative offset', () => {
    expect(wire({ offset: -1 })).toMatchSnapshot();
  });
});

describe('the ONE deliberate behaviour change the lift makes', () => {
  /**
   * PRE-LIFT: a brain without a `suggestions` table made the handler throw the
   * raw `SqliteError: no such table: suggestions` out to the gateway, which
   * wrapped it as `{isError: true}`.
   * POST-LIFT: the pure reader preflights (L-133) and returns `degraded`, and
   * the wrapper turns that into the SAME error-envelope CLASS with a message
   * that names the cause instead of leaking SQLite's text.
   *
   * This is recorded here rather than snapshotted silently because it is the
   * one place the lift is NOT byte-for-byte, and a reviewer should see it
   * stated rather than discover it.
   */
  it('a brain with no suggestions table still ERRORS, with a better message', () => {
    const bare = new Database(':memory:');
    try {
      vi.mocked(getDb).mockReturnValue(bare);
      const r = handleSuggestionList({}) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('Error: brain table absent: suggestions');
      // ...and it is still an ERROR, not a convincing empty list — the failure
      // mode that would have an /awaken step report "no suggestions" on a brain
      // whose migration never ran.
      expect(r.content[0]!.text).not.toContain('"suggestions": []');
    } finally {
      bare.close();
    }
  });
});

describe('the golden can actually fail (self-negative-control)', () => {
  /**
   * Every assertion above observes "matches the recorded snapshot". That is
   * also what a `wire()` returning a constant, or a fixture that seeded
   * nothing, would report. So: assert the fixture is really behind these
   * snapshots, and that a MUTATION of the underlying data changes the bytes.
   *
   * Without this, "the lift changed nothing" is satisfiable by a golden that
   * was recorded against an empty table.
   */
  it('the snapshots are over a NON-EMPTY, correctly-ordered result', () => {
    const text = wire({});
    const parsed = JSON.parse(text) as {
      suggestions: { title: string; priority: string; evidence: unknown }[];
      count: number;
      total: number;
    };
    expect(parsed.total).toBe(ROWS.length);
    expect(parsed.count).toBe(ROWS.length);
    // The ordering rule, asserted rather than merely snapshotted.
    expect(parsed.suggestions.map((s) => s.priority)).toEqual([
      'high',
      'high',
      'high',
      'medium',
      'low',
    ]);
    // The malformed-evidence degradation, asserted rather than merely recorded.
    const malformed = parsed.suggestions.find((s) => s.title === 'medium middle');
    expect(malformed?.evidence).toEqual({});
  });

  it('mutating a row CHANGES the bytes — the golden is not a constant', () => {
    const before = wire({ source_module: 'janitor' });
    db.prepare("UPDATE suggestions SET title = 'renamed' WHERE title = 'another project'").run();
    const after = wire({ source_module: 'janitor' });
    expect(after).not.toBe(before);
    expect(after).toContain('renamed');
  });
});
