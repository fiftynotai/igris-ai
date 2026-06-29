/**
 * Sessions Component — session-file handler tests (FR-130)
 *
 * Verifies the FR-130 surface of the session-file handlers:
 *   - igris_session_file_update round-trips instance_id + state.
 *   - update defaults state to 'live' when omitted.
 *   - the COALESCE upsert preserves a previously-set instance_id / state
 *     when a legacy content-only update omits them (regression guard).
 *   - igris_session_file_list returns all states and filters by state.
 *   - igris_session_file_list is safe against an empty project and a
 *     missing session_files table (L-133).
 *
 * Uses an in-memory DB with the sessions migrations applied; getDb() is
 * mocked to resolve to it.
 *
 * @module engine/components/sessions/__tests__/handlers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { sessionMigrations } from '../schema.js';

// Mock db module so handlers resolve getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleSessionFileGet,
  handleSessionFileUpdate,
  handleSessionFileList,
} from '../../../../tools/sessions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh in-memory DB with the sessions migrations applied. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const m of sessionMigrations) db.exec(m.sql);
  return db;
}

/** Parse the JSON text payload out of an MCP response envelope. */
function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

interface FileGetResult {
  project: string;
  filename: string;
  content: string;
  content_hash: string;
  updated_at: string;
  instance_id: string | null;
  state: string;
}

interface FileListResult {
  project: string;
  count: number;
  files: {
    filename: string;
    instance_id: string | null;
    state: string;
    content_hash: string;
    updated_at: string;
  }[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessions file handlers (FR-130)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('group 1 — _file_update round-trips instance_id + state', () => {
    it('persists instance_id and state, returned by _file_get', () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'body',
        instance_id: 'i-1',
        state: 'rested',
      });

      const got = parseResult<FileGetResult>(
        handleSessionFileGet({ project: 'igris-ai', filename: 'CURRENT_SESSION.md' }),
      );
      expect(got.instance_id).toBe('i-1');
      expect(got.state).toBe('rested');
    });
  });

  describe('group 2 — _file_update defaults state', () => {
    it("a new row with no state supplied gets state='live'", () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'SESSION_LOG.md',
        content: 'body',
      });

      const got = parseResult<FileGetResult>(
        handleSessionFileGet({ project: 'igris-ai', filename: 'SESSION_LOG.md' }),
      );
      expect(got.state).toBe('live');
      expect(got.instance_id).toBeNull();
    });
  });

  describe('group 3 — COALESCE preservation (regression guard)', () => {
    it('a content-only update does not null a previously-set instance_id', () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v1',
        instance_id: 'i-1',
      });
      // Legacy 3-arg caller: content only, no instance_id.
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v2',
      });

      const got = parseResult<FileGetResult>(
        handleSessionFileGet({ project: 'igris-ai', filename: 'CURRENT_SESSION.md' }),
      );
      expect(got.content).toBe('v2');
      expect(got.instance_id).toBe('i-1');
    });

    it('a content-only update does not downgrade a previously-set state', () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v1',
        state: 'rested',
      });
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v2',
      });

      const got = parseResult<FileGetResult>(
        handleSessionFileGet({ project: 'igris-ai', filename: 'CURRENT_SESSION.md' }),
      );
      expect(got.state).toBe('rested');
    });

    it('an explicit state on update does change an existing row', () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v1',
        state: 'live',
      });
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        content: 'v2',
        state: 'archived',
      });

      const got = parseResult<FileGetResult>(
        handleSessionFileGet({ project: 'igris-ai', filename: 'CURRENT_SESSION.md' }),
      );
      expect(got.state).toBe('archived');
    });
  });

  describe('group 3b — TD-279 Buffer content coerced to TEXT', () => {
    it('a Buffer content is stored as TEXT (typeof=text), not a BLOB', () => {
      handleSessionFileUpdate({
        project: 'igris-ai',
        filename: 'CURRENT_SESSION.md',
        // A caller handing a Buffer must never land a BLOB in content — that
        // is the bad-row shape that crashes the CLI gather parse on read.
        content: Buffer.from('body from buffer', 'utf8') as unknown as string,
      });

      const row = db
        .prepare(
          "SELECT typeof(content) AS t, content FROM session_files WHERE project = ? AND filename = ?",
        )
        .get('igris-ai', 'CURRENT_SESSION.md') as { t: string; content: string };
      expect(row.t).toBe('text');
      expect(row.content).toBe('body from buffer');
    });
  });

  describe('group 4 — _file_list returns all states', () => {
    it('lists files across live, rested, and archived states', () => {
      handleSessionFileUpdate({ project: 'p', filename: 'a.md', content: 'a', state: 'live' });
      handleSessionFileUpdate({ project: 'p', filename: 'b.md', content: 'b', state: 'rested' });
      handleSessionFileUpdate({ project: 'p', filename: 'c.md', content: 'c', state: 'archived' });

      const listed = parseResult<FileListResult>(handleSessionFileList({ project: 'p' }));
      expect(listed.count).toBe(3);
      expect(listed.files.map((f) => f.filename).sort()).toEqual(['a.md', 'b.md', 'c.md']);
      // content is intentionally omitted from the lightweight list.
      for (const f of listed.files) {
        expect(f).not.toHaveProperty('content');
      }
    });
  });

  describe('group 5 — _file_list filters by state', () => {
    it('returns only the files matching the requested state', () => {
      handleSessionFileUpdate({ project: 'p', filename: 'a.md', content: 'a', state: 'live' });
      handleSessionFileUpdate({ project: 'p', filename: 'b.md', content: 'b', state: 'rested' });
      handleSessionFileUpdate({ project: 'p', filename: 'c.md', content: 'c', state: 'archived' });

      const rested = parseResult<FileListResult>(
        handleSessionFileList({ project: 'p', state: 'rested' }),
      );
      expect(rested.count).toBe(1);
      expect(rested.files[0].filename).toBe('b.md');
      expect(rested.files[0].state).toBe('rested');
    });
  });

  describe('group 6 — _file_list empty / missing-table safety (L-133)', () => {
    it('returns an empty list for a project with no session files', () => {
      const listed = parseResult<FileListResult>(
        handleSessionFileList({ project: 'project-with-nothing' }),
      );
      expect(listed.count).toBe(0);
      expect(listed.files).toEqual([]);
    });

    it('returns an empty list (not a throw) when session_files does not exist', () => {
      const bareDb = new Database(':memory:');
      bareDb.pragma('journal_mode = WAL');
      vi.mocked(getDb).mockReturnValue(bareDb);

      let listed: FileListResult | undefined;
      expect(() => {
        listed = parseResult<FileListResult>(handleSessionFileList({ project: 'p' }));
      }).not.toThrow();
      expect(listed?.count).toBe(0);
      expect(listed?.files).toEqual([]);

      bareDb.close();
    });
  });
});
