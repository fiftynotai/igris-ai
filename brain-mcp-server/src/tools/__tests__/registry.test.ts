/**
 * Registry Tool Handler Tests (FR-099)
 *
 * Tests the 6 registry CRUD tools:
 * 1. igris_registry_add — register a template or module
 * 2. igris_registry_search — full-text + filter search
 * 3. igris_registry_get — get single entry by ID
 * 4. igris_registry_list — list with filters
 * 5. igris_registry_remove — soft-delete and hard-delete
 * 6. igris_registry_update — partial update of an existing entry
 *
 * @module tools/__tests__/registry.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleRegistryAdd,
  handleRegistrySearch,
  handleRegistryGet,
  handleRegistryList,
  handleRegistryRemove,
  handleRegistryUpdate,
} from '../registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

/** Create an in-memory database with the registry tables and FTS5. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('template', 'module')),
      archetype TEXT,
      framework TEXT,
      github_repo TEXT NOT NULL,
      github_path TEXT,
      github_branch TEXT DEFAULT 'main',
      description TEXT,
      install_command TEXT,
      standalone INTEGER DEFAULT 1,
      parent_template TEXT,
      tags TEXT DEFAULT '[]',
      rebrand_checklist TEXT,
      source_project TEXT,
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'deprecated', 'draft')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE registry_fts USING fts5(
      name, description, tags, framework,
      content=registry,
      content_rowid=rowid
    );

    CREATE TRIGGER registry_ai AFTER INSERT ON registry BEGIN
      INSERT INTO registry_fts(rowid, name, description, tags, framework)
      VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
    END;

    CREATE TRIGGER registry_au AFTER UPDATE ON registry BEGIN
      INSERT INTO registry_fts(registry_fts, rowid, name, description, tags, framework)
      VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
      INSERT INTO registry_fts(rowid, name, description, tags, framework)
      VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
    END;

    CREATE TRIGGER registry_ad AFTER DELETE ON registry BEGIN
      INSERT INTO registry_fts(registry_fts, rowid, name, description, tags, framework)
      VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
    END;
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Registry Tools (FR-099)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. handleRegistryAdd
  // -------------------------------------------------------------------------

  describe('handleRegistryAdd', () => {
    it('should add a template entry with all fields', () => {
      const result = handleRegistryAdd({
        id: 'tmpl-brand-flutter',
        name: 'brand-website-flutter',
        type: 'template',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/fiftynotai/brand-flutter',
        github_path: 'packages/template',
        github_branch: 'main',
        description: 'Full Flutter brand website template with hero scroll and product showcase',
        install_command: 'flutter create --template=brand_website',
        standalone: true,
        tags: '["brand", "website", "flutter", "scroll"]',
        rebrand_checklist: '- [ ] Update brand colors\n- [ ] Replace logo\n- [ ] Update copy',
        source_project: 'lomi-website',
      });

      const text = result.content[0].text;
      expect(text).toContain('Registry entry added successfully');
      expect(text).toContain('brand-website-flutter');
      expect(text).toContain('template');
      expect(text).toContain('brand-website');
      expect(text).toContain('flutter');
      expect(text).toContain('github.com/fiftynotai/brand-flutter');
    });

    it('should add a module entry', () => {
      const result = handleRegistryAdd({
        name: 'hero_scroll_module',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/fiftynotai/brand-flutter',
        github_path: 'packages/hero_scroll',
        description: 'Standalone hero scroll animation module for Flutter',
        standalone: true,
        parent_template: 'tmpl-brand-flutter',
      });

      const text = result.content[0].text;
      expect(text).toContain('Registry entry added successfully');
      expect(text).toContain('hero_scroll_module');
      expect(text).toContain('module');
    });

    it('should auto-generate UUID when id is not provided', () => {
      const result = handleRegistryAdd({
        name: 'auto-id-module',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const text = result.content[0].text;
      expect(text).toContain('Registry entry added successfully');
      expect(text).toContain('ID:');
    });

    it('should reject duplicate ID', () => {
      handleRegistryAdd({
        id: 'duplicate-id',
        name: 'First Entry',
        type: 'template',
        github_repo: 'github.com/org/repo',
      });

      const result = handleRegistryAdd({
        id: 'duplicate-id',
        name: 'Second Entry',
        type: 'module',
        github_repo: 'github.com/org/other-repo',
      });

      const text = result.content[0].text;
      expect(text).toContain('already exists');
    });

    it('should default standalone to true (1)', () => {
      handleRegistryAdd({
        id: 'standalone-test',
        name: 'Standalone Module',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const row = db.prepare('SELECT standalone FROM registry WHERE id = ?').get('standalone-test') as { standalone: number };
      expect(row.standalone).toBe(1);
    });

    it('should set standalone to false (0) when explicitly false', () => {
      handleRegistryAdd({
        id: 'not-standalone',
        name: 'Dependent Module',
        type: 'module',
        github_repo: 'github.com/org/repo',
        standalone: false,
      });

      const row = db.prepare('SELECT standalone FROM registry WHERE id = ?').get('not-standalone') as { standalone: number };
      expect(row.standalone).toBe(0);
    });

    it('should default status to available', () => {
      handleRegistryAdd({
        id: 'status-default',
        name: 'Default Status',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const row = db.prepare('SELECT status FROM registry WHERE id = ?').get('status-default') as { status: string };
      expect(row.status).toBe('available');
    });
  });

  // -------------------------------------------------------------------------
  // 2. handleRegistrySearch
  // -------------------------------------------------------------------------

  describe('handleRegistrySearch', () => {
    beforeEach(() => {
      // Seed with test data
      handleRegistryAdd({
        id: 'tmpl-brand-flutter',
        name: 'brand-website-flutter',
        type: 'template',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/brand',
        description: 'Flutter brand website template',
        tags: '["brand", "website", "flutter"]',
      });
      handleRegistryAdd({
        id: 'mod-hero-scroll',
        name: 'hero_scroll_module',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/brand',
        github_path: 'packages/hero_scroll',
        description: 'Hero scroll animation module for brand websites',
        tags: '["animation", "scroll", "hero"]',
      });
      handleRegistryAdd({
        id: 'tmpl-saas-react',
        name: 'saas-dashboard-react',
        type: 'template',
        archetype: 'saas-dashboard',
        framework: 'react',
        github_repo: 'github.com/org/saas',
        description: 'React SaaS dashboard template with sidebar navigation',
        tags: '["saas", "dashboard", "react"]',
      });
    });

    it('should find entries by keyword', () => {
      const result = handleRegistrySearch({ query: 'hero scroll' });
      const text = result.content[0].text;
      expect(text).toContain('hero_scroll_module');
    });

    it('should filter by type=module', () => {
      const result = handleRegistrySearch({ query: 'brand', type: 'module' });
      const text = result.content[0].text;
      expect(text).toContain('hero_scroll_module');
      expect(text).not.toContain('brand-website-flutter');
    });

    it('should filter by framework', () => {
      const result = handleRegistrySearch({ query: 'template', framework: 'react' });
      const text = result.content[0].text;
      expect(text).toContain('saas-dashboard-react');
      expect(text).not.toContain('brand-website-flutter');
    });

    it('should filter by archetype', () => {
      const result = handleRegistrySearch({ query: 'template', archetype: 'brand-website' });
      const text = result.content[0].text;
      expect(text).toContain('brand-website-flutter');
      expect(text).not.toContain('saas-dashboard-react');
    });

    it('should return no results for non-matching query', () => {
      const result = handleRegistrySearch({ query: 'nonexistent-xyz-query' });
      const text = result.content[0].text;
      expect(text).toContain('No registry entries found');
    });

    it('should respect limit parameter', () => {
      const result = handleRegistrySearch({ query: 'brand', limit: 1 });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
    });
  });

  // -------------------------------------------------------------------------
  // 3. handleRegistryGet
  // -------------------------------------------------------------------------

  describe('handleRegistryGet', () => {
    it('should return full entry details', () => {
      handleRegistryAdd({
        id: 'get-test',
        name: 'Get Test Module',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo',
        description: 'Module for testing get',
        rebrand_checklist: '- [ ] Replace colors\n- [ ] Update fonts',
      });

      const result = handleRegistryGet({ id: 'get-test' });
      const text = result.content[0].text;
      expect(text).toContain('Get Test Module');
      expect(text).toContain('brand-website');
      expect(text).toContain('flutter');
      expect(text).toContain('Replace colors');
    });

    it('should return not found for missing ID', () => {
      const result = handleRegistryGet({ id: 'nonexistent' });
      const text = result.content[0].text;
      expect(text).toContain('not found');
    });
  });

  // -------------------------------------------------------------------------
  // 4. handleRegistryList
  // -------------------------------------------------------------------------

  describe('handleRegistryList', () => {
    beforeEach(() => {
      handleRegistryAdd({
        id: 'list-tmpl-1',
        name: 'Template 1',
        type: 'template',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo1',
      });
      handleRegistryAdd({
        id: 'list-mod-1',
        name: 'Module 1',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo2',
      });
      handleRegistryAdd({
        id: 'list-tmpl-2',
        name: 'Template 2',
        type: 'template',
        archetype: 'saas-dashboard',
        framework: 'react',
        github_repo: 'github.com/org/repo3',
      });
    });

    it('should list all available entries', () => {
      const result = handleRegistryList({});
      const text = result.content[0].text;
      expect(text).toContain('Found 3 entries');
    });

    it('should filter by type=template', () => {
      const result = handleRegistryList({ type: 'template' });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
      expect(text).toContain('Template 1');
      expect(text).toContain('Template 2');
    });

    it('should filter by type=module', () => {
      const result = handleRegistryList({ type: 'module' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Module 1');
    });

    it('should filter by archetype', () => {
      const result = handleRegistryList({ archetype: 'brand-website' });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
    });

    it('should filter by framework', () => {
      const result = handleRegistryList({ framework: 'react' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Template 2');
    });

    it('should show empty message when no entries match', () => {
      const result = handleRegistryList({ framework: 'python' });
      const text = result.content[0].text;
      expect(text).toContain('No registry entries found');
    });

    it('should respect limit parameter', () => {
      const result = handleRegistryList({ limit: 2 });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
    });

    it('should filter by status=deprecated', () => {
      // Deprecate one entry
      handleRegistryRemove({ id: 'list-tmpl-1' });

      const result = handleRegistryList({ status: 'deprecated' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Template 1');
    });

    it('should default to status=available (excludes deprecated)', () => {
      handleRegistryRemove({ id: 'list-tmpl-1' });

      const result = handleRegistryList({});
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
      expect(text).not.toContain('Template 1');
    });
  });

  // -------------------------------------------------------------------------
  // 5. handleRegistryRemove
  // -------------------------------------------------------------------------

  describe('handleRegistryRemove', () => {
    beforeEach(() => {
      handleRegistryAdd({
        id: 'remove-test',
        name: 'Remove Test',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });
    });

    it('should soft-delete by default (set status to deprecated)', () => {
      const result = handleRegistryRemove({ id: 'remove-test' });
      const text = result.content[0].text;
      expect(text).toContain('deprecated');

      const row = db.prepare('SELECT status FROM registry WHERE id = ?').get('remove-test') as { status: string };
      expect(row.status).toBe('deprecated');
    });

    it('should hard-delete when hard_delete=true', () => {
      const result = handleRegistryRemove({ id: 'remove-test', hard_delete: true });
      const text = result.content[0].text;
      expect(text).toContain('permanently deleted');

      const row = db.prepare('SELECT id FROM registry WHERE id = ?').get('remove-test');
      expect(row).toBeUndefined();
    });

    it('should return not found for missing ID', () => {
      const result = handleRegistryRemove({ id: 'nonexistent' });
      const text = result.content[0].text;
      expect(text).toContain('not found');
    });
  });

  // -------------------------------------------------------------------------
  // 6. handleRegistryUpdate
  // -------------------------------------------------------------------------

  describe('handleRegistryUpdate', () => {
    beforeEach(() => {
      handleRegistryAdd({
        id: 'update-test',
        name: 'Update Test Module',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo',
        description: 'Original description',
        tags: '["original"]',
        standalone: true,
      });
    });

    it('should update a single field and preserve others', () => {
      const result = handleRegistryUpdate({
        id: 'update-test',
        description: 'Updated description',
      });

      const text = result.content[0].text;
      expect(text).toContain('Registry entry updated successfully');
      expect(text).toContain('Updated description');
      // Name should be preserved
      expect(text).toContain('Update Test Module');
    });

    it('should update multiple fields at once', () => {
      const result = handleRegistryUpdate({
        id: 'update-test',
        name: 'Renamed Module',
        tags: '["updated", "new-tag"]',
        description: 'Multi-field update',
      });

      const text = result.content[0].text;
      expect(text).toContain('Registry entry updated successfully');
      expect(text).toContain('Renamed Module');
      expect(text).toContain('updated');
      expect(text).toContain('Multi-field update');
    });

    it('should reject non-existent ID', () => {
      const result = handleRegistryUpdate({
        id: 'nonexistent-id',
        name: 'Ghost Entry',
      });

      const text = result.content[0].text;
      expect(text).toContain('not found');
    });

    it('should return message when no fields provided', () => {
      const result = handleRegistryUpdate({
        id: 'update-test',
      });

      const text = result.content[0].text;
      expect(text).toContain('No fields to update');
    });

    it('should update FTS5 index after update', () => {
      handleRegistryUpdate({
        id: 'update-test',
        description: 'Completely unique searchable phrase xyz123',
      });

      const result = handleRegistrySearch({ query: 'xyz123' });
      const text = result.content[0].text;
      expect(text).toContain('Update Test Module');
    });

    it('should map standalone boolean to integer correctly', () => {
      handleRegistryUpdate({
        id: 'update-test',
        standalone: false,
      });

      const row = db.prepare('SELECT standalone FROM registry WHERE id = ?').get('update-test') as { standalone: number };
      expect(row.standalone).toBe(0);
    });
  });
});
