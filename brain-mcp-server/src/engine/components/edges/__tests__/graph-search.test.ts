/**
 * TD-171 M2 — igris_graph_search handler tests.
 *
 * Coverage:
 *   - happy path: substring match against label and node_external_id
 *   - node_type filter narrows results
 *   - limit honoured (default 20, capped at 100)
 *   - LIKE wildcards in user input are escaped (passing `_` doesn't match
 *     every single-character node)
 *   - score heuristic: full-string match scores higher than partial
 *   - results sorted by score desc then id asc
 *   - rejects empty query
 *   - rejects negative/non-numeric limit
 *   - gateway strict-input contract (TD-128)
 *
 * @module engine/components/edges/__tests__/graph-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleGraphSearch, handleGraphNodeCreate } from '../nodes-handlers.js';
import { edgeMigrations } from '../schema.js';
import { createGateway } from '../../../gateway.js';
import { createEdgesComponent } from '../index.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

interface SearchHit {
  id: number;
  node_type: string;
  node_external_id: string;
  label: string;
  score: number;
}

interface SearchResult {
  query: string;
  node_type: string | null;
  limit: number;
  count: number;
  results: SearchHit[];
}

function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

function seedNode(
  type: string,
  externalId: string,
  label: string,
): void {
  handleGraphNodeCreate({
    node_type: type,
    node_external_id: externalId,
    label,
  });
}

describe('handleGraphSearch (TD-171 M2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns matches against label substring', () => {
    seedNode('concept', 'concept:vector-search', 'Vector search');
    seedNode('concept', 'concept:fts5', 'Full-text search (FTS5)');
    seedNode('concept', 'concept:auth', 'Authentication');

    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'search' }));
    expect(r.count).toBe(2);
    const labels = r.results.map((h) => h.label).sort();
    expect(labels).toEqual(['Full-text search (FTS5)', 'Vector search']);
  });

  it('matches against node_external_id substring', () => {
    seedNode('decision', 'decision:swap-libsql', 'Swap to libsql');
    seedNode('decision', 'decision:keep-postgres', 'Keep Postgres');

    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'libsql' }));
    expect(r.count).toBe(1);
    expect(r.results[0].node_external_id).toBe('decision:swap-libsql');
  });

  it('narrows by node_type filter', () => {
    seedNode('concept', 'concept:cache', 'Cache layer');
    seedNode('decision', 'decision:cache-eviction', 'Cache eviction policy');

    const r = parseResult<SearchResult>(
      handleGraphSearch({ query: 'cache', node_type: 'decision' }),
    );
    expect(r.count).toBe(1);
    expect(r.results[0].node_type).toBe('decision');
    expect(r.results[0].node_external_id).toBe('decision:cache-eviction');
  });

  it('honours the limit parameter', () => {
    for (let i = 0; i < 30; i++) {
      seedNode('concept', `concept:item-${i}`, `Item ${i}`);
    }
    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'Item', limit: 5 }));
    expect(r.count).toBe(5);
    expect(r.limit).toBe(5);
  });

  it('caps limit at 100', () => {
    seedNode('concept', 'concept:a', 'A');
    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'A', limit: 99999 }));
    expect(r.limit).toBe(100);
  });

  it('escapes LIKE wildcards in the user input', () => {
    // `_` is a single-char wildcard in SQL LIKE — without escaping, it would
    // match every node where label/external_id has any character at that
    // position. We seed nodes with NO literal underscore in the label so the
    // matcher MUST treat `_` as a literal to return 0 results.
    seedNode('concept', 'concept:abc', 'abc');
    seedNode('concept', 'concept:abd', 'abd');
    seedNode('concept', 'concept:xyz', 'xyz');

    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'a_c' }));
    // No node label contains literal "a_c" — all 3 labels lack an underscore.
    expect(r.count).toBe(0);
  });

  it('escapes LIKE % wildcards in the user input', () => {
    seedNode('concept', 'concept:hello', 'hello');
    seedNode('concept', 'concept:world', 'world');

    const r = parseResult<SearchResult>(handleGraphSearch({ query: '%' }));
    // Without escaping, `%` matches everything. With escaping, no node label
    // contains a literal `%`.
    expect(r.count).toBe(0);
  });

  it('scores full-string matches higher than partial', () => {
    seedNode('concept', 'concept:auth', 'auth'); // 4-char label exact match
    seedNode('concept', 'concept:authentication', 'authentication'); // partial

    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'auth' }));
    expect(r.count).toBe(2);
    // The exact match should sort first.
    expect(r.results[0].label).toBe('auth');
    expect(r.results[0].score).toBeGreaterThan(r.results[1].score);
  });

  it('applies default limit of 20 when omitted', () => {
    for (let i = 0; i < 30; i++) {
      seedNode('concept', `concept:n${i}`, `Node ${i}`);
    }
    const r = parseResult<SearchResult>(handleGraphSearch({ query: 'Node' }));
    expect(r.limit).toBe(20);
    expect(r.count).toBe(20);
  });

  it('rejects empty query', () => {
    const r = handleGraphSearch({ query: '' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Missing required field: query');
  });

  it('rejects missing query', () => {
    const r = handleGraphSearch({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Missing required field: query');
  });

  it('rejects negative limit', () => {
    const r = handleGraphSearch({ query: 'foo', limit: -1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('limit must be a positive integer');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128)
  // -------------------------------------------------------------------------

  it('rejects unknown args via gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createEdgesComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_graph_search', { query: 'x', bogus: true }),
    ).rejects.toThrowError(/igris_graph_search: unknown argument 'bogus'/);
  });
});
