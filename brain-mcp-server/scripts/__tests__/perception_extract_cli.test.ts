/**
 * TD-066 — perception_extract_cli unit + integration tests.
 *
 * Covers:
 *   - parseCliArgs() flag handling + error paths
 *   - readTranscriptFile() empty / oversize handling
 *   - truncateFileAtomic() inbox truncation
 *   - runPerceptionFromTranscript() against an in-memory DB:
 *     * empty transcript -> 0 inserts, no DB writes
 *     * runs with stub LLM extractor and persists rows
 *     * source_extractor + provenance correctly tagged on inserts
 *   - main() end-to-end: full pipeline against a temp DB + transcript
 *
 * Mirrors the in-memory DB pattern used in
 * `src/engine/components/perception/__tests__/runner.test.ts`.
 *
 * @module scripts/__tests__/perception_extract_cli.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// Mock embeddings + vector-search before importing the CLI module — the
// runner reaches into both per insert.
vi.mock('../../src/utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) => Buffer.from(e.buffer, e.byteOffset, e.byteLength)),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));
vi.mock('../../src/utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
}));

// Mock db.js so getDb() returns whatever we wire in via mockedGetDb.
vi.mock('../../src/db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../src/db.js';
import {
  parseCliArgs,
  readTranscriptFile,
  truncateFileAtomic,
  defaultInboxPath,
  runPerceptionFromTranscript,
  main,
  type CliArgs,
} from '../perception_extract_cli.js';
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionCandidate } from '../../src/engine/components/perception/types.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Test DB setup — minimal schema needed by runPerception
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  return db;
}

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses required flags', () => {
    const args = parseCliArgs([
      'node',
      'script.ts',
      '--project',
      'igris-ai',
      '--transcript-path',
      '/tmp/t.jsonl',
    ]);
    expect(args.project).toBe('igris-ai');
    expect(args.transcriptPath).toBe('/tmp/t.jsonl');
    expect(args.briefId).toBeUndefined();
    expect(args.source).toBe('detached');
  });

  it('parses optional flags', () => {
    const args = parseCliArgs([
      'node',
      'script.ts',
      '--project',
      'p',
      '--transcript-path',
      '/x',
      '--brief-id',
      'TD-066',
      '--inbox-path',
      '/inbox',
      '--db',
      '/tmp/test.db',
      '--source',
      'session_end',
    ]);
    expect(args.briefId).toBe('TD-066');
    expect(args.inboxPath).toBe('/inbox');
    expect(args.dbPathOverride).toBe('/tmp/test.db');
    expect(args.source).toBe('session_end');
  });

  it('throws when --project is missing', () => {
    expect(() => parseCliArgs(['node', 's', '--transcript-path', '/x'])).toThrow(/--project/);
  });

  it('throws when --transcript-path is missing', () => {
    expect(() => parseCliArgs(['node', 's', '--project', 'p'])).toThrow(/--transcript-path/);
  });

  it('throws when a flag value is another flag', () => {
    expect(() =>
      parseCliArgs(['node', 's', '--project', '--transcript-path', '/x']),
    ).toThrow(/--project/);
  });
});

// ---------------------------------------------------------------------------
// readTranscriptFile
// ---------------------------------------------------------------------------

describe('readTranscriptFile', () => {
  it('returns empty string when file is absent', () => {
    expect(readTranscriptFile(tempPath('absent'))).toBe('');
  });

  it('returns empty string when file is empty', () => {
    const p = tempPath('empty');
    fs.writeFileSync(p, '');
    try {
      expect(readTranscriptFile(p)).toBe('');
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('reads small file in full', () => {
    const p = tempPath('small');
    fs.writeFileSync(p, 'hello world');
    try {
      expect(readTranscriptFile(p)).toBe('hello world');
    } finally {
      fs.unlinkSync(p);
    }
  });
});

// ---------------------------------------------------------------------------
// truncateFileAtomic
// ---------------------------------------------------------------------------

describe('truncateFileAtomic', () => {
  it('no-ops when the file is absent', () => {
    expect(() => truncateFileAtomic(tempPath('absent'))).not.toThrow();
  });

  it('truncates an existing file to zero bytes', () => {
    const p = tempPath('truncate');
    fs.writeFileSync(p, 'some content');
    try {
      truncateFileAtomic(p);
      expect(fs.readFileSync(p, 'utf-8')).toBe('');
      expect(fs.statSync(p).size).toBe(0);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

// ---------------------------------------------------------------------------
// defaultInboxPath
// ---------------------------------------------------------------------------

describe('defaultInboxPath', () => {
  it('builds the canonical inbox path', () => {
    const p = defaultInboxPath('igris-ai');
    expect(p).toContain('.igris');
    expect(p).toContain('projects/igris-ai/session/perception_inbox.jsonl');
  });
});

// ---------------------------------------------------------------------------
// runPerceptionFromTranscript
// ---------------------------------------------------------------------------

describe('runPerceptionFromTranscript', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns zero inserts on empty transcript', async () => {
    const result = await runPerceptionFromTranscript(db, {
      project: 'p',
      transcriptText: '',
      briefId: undefined,
      source: 'detached',
      config: DEFAULT_PERCEPTION_CONFIG,
      llmExtractor: async () => [],
    });
    expect(result.inserted).toBe(0);
    expect(result.llmStatus).toBe('skipped:empty');
    const rows = db.prepare('SELECT count(*) AS n FROM learnings').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('persists candidates returned by the stub LLM extractor', async () => {
    const transcript = JSON.stringify({
      role: 'user',
      content: 'X'.repeat(2000),
      timestamp: '',
    });
    const stubLlm = vi.fn(async (): Promise<PerceptionCandidate[]> => [
      {
        category: 'pattern',
        title: 'CLI integration finding',
        content: 'Detached-process pattern works end-to-end.',
        tags: ['cli'],
        confidence: 0.7,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'X' },
      },
    ]);

    const result = await runPerceptionFromTranscript(db, {
      project: 'p',
      transcriptText: transcript,
      briefId: 'TD-066',
      source: 'detached',
      config: { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
      llmExtractor: stubLlm,
    });

    expect(stubLlm).toHaveBeenCalledTimes(1);
    expect(result.inserted).toBe(1);
    expect(result.llmExtracted).toBe(1);

    const row = db.prepare('SELECT review_status, provenance, source_extractor FROM learnings').get() as {
      review_status: string;
      provenance: string;
      source_extractor: string;
    };
    expect(row.review_status).toBe('pending_review');
    expect(row.provenance).toBe('inferred');
    expect(row.source_extractor).toBe('llm');
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end pipeline (mocking getDb so we don't touch real brain)
// ---------------------------------------------------------------------------

describe('main', () => {
  let db: Database.Database;
  let originalIgrisDbPath: string | undefined;
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    originalIgrisDbPath = process.env.IGRIS_DB_PATH;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (originalIgrisDbPath === undefined) {
      delete process.env.IGRIS_DB_PATH;
    } else {
      process.env.IGRIS_DB_PATH = originalIgrisDbPath;
    }
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  it('returns 1 on malformed args', async () => {
    const exitCode = await main(['node', 'script.ts']);
    expect(exitCode).toBe(1);
  });

  it('returns 0 when transcript file is absent', async () => {
    const exitCode = await main([
      'node',
      'script.ts',
      '--project',
      'p',
      '--transcript-path',
      tempPath('absent'),
    ]);
    expect(exitCode).toBe(0);
  });

  it('returns 0 when transcript file is empty', async () => {
    const tp = tempPath('empty-transcript');
    fs.writeFileSync(tp, '');
    cleanupFiles.push(tp);
    const exitCode = await main([
      'node',
      'script.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);
    expect(exitCode).toBe(0);
  });

  it('processes a non-empty transcript and truncates the inbox on success', async () => {
    // Plain-text transcript (parseTranscript falls back to single user event).
    // Note: the default config has extractor_llm_enabled=true (Phase 2 flips
    // the default), but the LLM extractor selected by selectLlmExtractor()
    // resolves to noopLlmExtractor when claude CLI is not on PATH OR when the
    // env disables it. To exercise the full path independent of CLI presence,
    // we set IGRIS_PERCEPTION_LLM_ENABLED=0 which forces the noop extractor.
    const tp = tempPath('content-transcript');
    fs.writeFileSync(tp, 'just a plain blob — no LEARNED markers');
    cleanupFiles.push(tp);

    const inbox = tempPath('inbox');
    fs.writeFileSync(inbox, 'old inbox content\n');
    cleanupFiles.push(inbox);

    const prevEnv = process.env.IGRIS_PERCEPTION_LLM_ENABLED;
    process.env.IGRIS_PERCEPTION_LLM_ENABLED = '0';
    try {
      const exitCode = await main([
        'node',
        'script.ts',
        '--project',
        'p',
        '--transcript-path',
        tp,
        '--inbox-path',
        inbox,
      ]);
      expect(exitCode).toBe(0);
      // Inbox truncated on success regardless of inserted count.
      expect(fs.readFileSync(inbox, 'utf-8')).toBe('');
    } finally {
      if (prevEnv === undefined) {
        delete process.env.IGRIS_PERCEPTION_LLM_ENABLED;
      } else {
        process.env.IGRIS_PERCEPTION_LLM_ENABLED = prevEnv;
      }
    }
  });

  it('returns 1 when learnings table is missing (brain not booted)', async () => {
    const emptyDb = new Database(':memory:');
    mockedGetDb.mockReturnValue(emptyDb);
    try {
      const tp = tempPath('any-transcript');
      fs.writeFileSync(tp, 'content');
      cleanupFiles.push(tp);

      const exitCode = await main([
        'node',
        'script.ts',
        '--project',
        'p',
        '--transcript-path',
        tp,
      ]);
      expect(exitCode).toBe(1);
    } finally {
      emptyDb.close();
    }
  });
});

// Suppress unused warning for the imported type CliArgs (used implicitly by parseCliArgs return value)
const _typeCheck: CliArgs = {
  project: 'p',
  transcriptPath: '/x',
  briefId: undefined,
  inboxPath: undefined,
  dbPathOverride: undefined,
  source: 'detached',
};
void _typeCheck;
