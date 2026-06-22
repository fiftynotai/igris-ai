/**
 * Catalog Tool Handler Tests (FR-099)
 *
 * Tests the 6 catalog CRUD tools:
 * 1. igris_catalog_add — register a template or module
 * 2. igris_catalog_search — full-text + filter search
 * 3. igris_catalog_get — get single entry by ID
 * 4. igris_catalog_list — list with filters
 * 5. igris_catalog_remove — soft-delete and hard-delete
 * 6. igris_catalog_update — partial update of an existing entry
 *
 * @module tools/__tests__/catalog.test
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
  handleCatalogAdd,
  handleCatalogSearch,
  handleCatalogGet,
  handleCatalogList,
  handleCatalogRemove,
  handleCatalogUpdate,
} from '../catalog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

/** Create an in-memory database with the catalog tables and FTS5. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE catalog (
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
      when_to_use TEXT,
      source TEXT,
      source_ref TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE catalog_fts USING fts5(
      name, description, tags, framework,
      content=catalog,
      content_rowid=rowid
    );

    CREATE TRIGGER catalog_ai AFTER INSERT ON catalog BEGIN
      INSERT INTO catalog_fts(rowid, name, description, tags, framework)
      VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
    END;

    CREATE TRIGGER catalog_au AFTER UPDATE ON catalog BEGIN
      INSERT INTO catalog_fts(catalog_fts, rowid, name, description, tags, framework)
      VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
      INSERT INTO catalog_fts(rowid, name, description, tags, framework)
      VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
    END;

    CREATE TRIGGER catalog_ad AFTER DELETE ON catalog BEGIN
      INSERT INTO catalog_fts(catalog_fts, rowid, name, description, tags, framework)
      VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
    END;
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Catalog Tools (FR-099)', () => {
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
  // 1. handleCatalogAdd
  // -------------------------------------------------------------------------

  describe('handleCatalogAdd', () => {
    it('should add a template entry with all fields', () => {
      const result = handleCatalogAdd({
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
      expect(text).toContain('Catalog entry added successfully');
      expect(text).toContain('brand-website-flutter');
      expect(text).toContain('template');
      expect(text).toContain('brand-website');
      expect(text).toContain('flutter');
      expect(text).toContain('github.com/fiftynotai/brand-flutter');
    });

    it('should add a module entry', () => {
      const result = handleCatalogAdd({
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
      expect(text).toContain('Catalog entry added successfully');
      expect(text).toContain('hero_scroll_module');
      expect(text).toContain('module');
    });

    it('should auto-generate UUID when id is not provided', () => {
      const result = handleCatalogAdd({
        name: 'auto-id-module',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const text = result.content[0].text;
      expect(text).toContain('Catalog entry added successfully');
      expect(text).toContain('ID:');
    });

    it('should reject duplicate ID', () => {
      handleCatalogAdd({
        id: 'duplicate-id',
        name: 'First Entry',
        type: 'template',
        github_repo: 'github.com/org/repo',
      });

      const result = handleCatalogAdd({
        id: 'duplicate-id',
        name: 'Second Entry',
        type: 'module',
        github_repo: 'github.com/org/other-repo',
      });

      const text = result.content[0].text;
      expect(text).toContain('already exists');
    });

    it('should default standalone to true (1)', () => {
      handleCatalogAdd({
        id: 'standalone-test',
        name: 'Standalone Module',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const row = db.prepare('SELECT standalone FROM catalog WHERE id = ?').get('standalone-test') as { standalone: number };
      expect(row.standalone).toBe(1);
    });

    it('should set standalone to false (0) when explicitly false', () => {
      handleCatalogAdd({
        id: 'not-standalone',
        name: 'Dependent Module',
        type: 'module',
        github_repo: 'github.com/org/repo',
        standalone: false,
      });

      const row = db.prepare('SELECT standalone FROM catalog WHERE id = ?').get('not-standalone') as { standalone: number };
      expect(row.standalone).toBe(0);
    });

    it('should default status to available', () => {
      handleCatalogAdd({
        id: 'status-default',
        name: 'Default Status',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });

      const row = db.prepare('SELECT status FROM catalog WHERE id = ?').get('status-default') as { status: string };
      expect(row.status).toBe('available');
    });
  });

  // -------------------------------------------------------------------------
  // 2. handleCatalogSearch
  // -------------------------------------------------------------------------

  describe('handleCatalogSearch', () => {
    beforeEach(() => {
      // Seed with test data
      handleCatalogAdd({
        id: 'tmpl-brand-flutter',
        name: 'brand-website-flutter',
        type: 'template',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/brand',
        description: 'Flutter brand website template',
        tags: '["brand", "website", "flutter"]',
      });
      handleCatalogAdd({
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
      handleCatalogAdd({
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
      const result = handleCatalogSearch({ query: 'hero scroll' });
      const text = result.content[0].text;
      expect(text).toContain('hero_scroll_module');
    });

    it('should filter by type=module', () => {
      const result = handleCatalogSearch({ query: 'brand', type: 'module' });
      const text = result.content[0].text;
      expect(text).toContain('hero_scroll_module');
      expect(text).not.toContain('brand-website-flutter');
    });

    it('should filter by framework', () => {
      const result = handleCatalogSearch({ query: 'template', framework: 'react' });
      const text = result.content[0].text;
      expect(text).toContain('saas-dashboard-react');
      expect(text).not.toContain('brand-website-flutter');
    });

    it('should filter by archetype', () => {
      const result = handleCatalogSearch({ query: 'template', archetype: 'brand-website' });
      const text = result.content[0].text;
      expect(text).toContain('brand-website-flutter');
      expect(text).not.toContain('saas-dashboard-react');
    });

    it('should return no results for non-matching query', () => {
      const result = handleCatalogSearch({ query: 'nonexistent-xyz-query' });
      const text = result.content[0].text;
      expect(text).toContain('No catalog entries found');
    });

    it('should respect limit parameter', () => {
      const result = handleCatalogSearch({ query: 'brand', limit: 1 });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
    });
  });

  // -------------------------------------------------------------------------
  // 3. handleCatalogGet
  // -------------------------------------------------------------------------

  describe('handleCatalogGet', () => {
    it('should return full entry details', () => {
      handleCatalogAdd({
        id: 'get-test',
        name: 'Get Test Module',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo',
        description: 'Module for testing get',
        rebrand_checklist: '- [ ] Replace colors\n- [ ] Update fonts',
      });

      const result = handleCatalogGet({ id: 'get-test' });
      const text = result.content[0].text;
      expect(text).toContain('Get Test Module');
      expect(text).toContain('brand-website');
      expect(text).toContain('flutter');
      expect(text).toContain('Replace colors');
    });

    it('should return not found for missing ID', () => {
      const result = handleCatalogGet({ id: 'nonexistent' });
      const text = result.content[0].text;
      expect(text).toContain('not found');
    });
  });

  // -------------------------------------------------------------------------
  // 4. handleCatalogList
  // -------------------------------------------------------------------------

  describe('handleCatalogList', () => {
    beforeEach(() => {
      handleCatalogAdd({
        id: 'list-tmpl-1',
        name: 'Template 1',
        type: 'template',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo1',
      });
      handleCatalogAdd({
        id: 'list-mod-1',
        name: 'Module 1',
        type: 'module',
        archetype: 'brand-website',
        framework: 'flutter',
        github_repo: 'github.com/org/repo2',
      });
      handleCatalogAdd({
        id: 'list-tmpl-2',
        name: 'Template 2',
        type: 'template',
        archetype: 'saas-dashboard',
        framework: 'react',
        github_repo: 'github.com/org/repo3',
      });
    });

    it('should list all available entries', () => {
      const result = handleCatalogList({});
      const text = result.content[0].text;
      expect(text).toContain('Found 3 entries');
    });

    it('should filter by type=template', () => {
      const result = handleCatalogList({ type: 'template' });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
      expect(text).toContain('Template 1');
      expect(text).toContain('Template 2');
    });

    it('should filter by type=module', () => {
      const result = handleCatalogList({ type: 'module' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Module 1');
    });

    it('should filter by archetype', () => {
      const result = handleCatalogList({ archetype: 'brand-website' });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
    });

    it('should filter by framework', () => {
      const result = handleCatalogList({ framework: 'react' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Template 2');
    });

    it('should show empty message when no entries match', () => {
      const result = handleCatalogList({ framework: 'python' });
      const text = result.content[0].text;
      expect(text).toContain('No catalog entries found');
    });

    it('should respect limit parameter', () => {
      const result = handleCatalogList({ limit: 2 });
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
    });

    it('should filter by status=deprecated', () => {
      // Deprecate one entry
      handleCatalogRemove({ id: 'list-tmpl-1' });

      const result = handleCatalogList({ status: 'deprecated' });
      const text = result.content[0].text;
      expect(text).toContain('Found 1 entries');
      expect(text).toContain('Template 1');
    });

    it('should default to status=available (excludes deprecated)', () => {
      handleCatalogRemove({ id: 'list-tmpl-1' });

      const result = handleCatalogList({});
      const text = result.content[0].text;
      expect(text).toContain('Found 2 entries');
      expect(text).not.toContain('Template 1');
    });
  });

  // -------------------------------------------------------------------------
  // 5. handleCatalogRemove
  // -------------------------------------------------------------------------

  describe('handleCatalogRemove', () => {
    beforeEach(() => {
      handleCatalogAdd({
        id: 'remove-test',
        name: 'Remove Test',
        type: 'module',
        github_repo: 'github.com/org/repo',
      });
    });

    it('should soft-delete by default (set status to deprecated)', () => {
      const result = handleCatalogRemove({ id: 'remove-test' });
      const text = result.content[0].text;
      expect(text).toContain('deprecated');

      const row = db.prepare('SELECT status FROM catalog WHERE id = ?').get('remove-test') as { status: string };
      expect(row.status).toBe('deprecated');
    });

    it('should hard-delete when hard_delete=true', () => {
      const result = handleCatalogRemove({ id: 'remove-test', hard_delete: true });
      const text = result.content[0].text;
      expect(text).toContain('permanently deleted');

      const row = db.prepare('SELECT id FROM catalog WHERE id = ?').get('remove-test');
      expect(row).toBeUndefined();
    });

    it('should return not found for missing ID', () => {
      const result = handleCatalogRemove({ id: 'nonexistent' });
      const text = result.content[0].text;
      expect(text).toContain('not found');
    });
  });

  // -------------------------------------------------------------------------
  // 6. handleCatalogUpdate
  // -------------------------------------------------------------------------

  describe('handleCatalogUpdate', () => {
    beforeEach(() => {
      handleCatalogAdd({
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
      const result = handleCatalogUpdate({
        id: 'update-test',
        description: 'Updated description',
      });

      const text = result.content[0].text;
      expect(text).toContain('Catalog entry updated successfully');
      expect(text).toContain('Updated description');
      // Name should be preserved
      expect(text).toContain('Update Test Module');
    });

    it('should update multiple fields at once', () => {
      const result = handleCatalogUpdate({
        id: 'update-test',
        name: 'Renamed Module',
        tags: '["updated", "new-tag"]',
        description: 'Multi-field update',
      });

      const text = result.content[0].text;
      expect(text).toContain('Catalog entry updated successfully');
      expect(text).toContain('Renamed Module');
      expect(text).toContain('updated');
      expect(text).toContain('Multi-field update');
    });

    it('should reject non-existent ID', () => {
      const result = handleCatalogUpdate({
        id: 'nonexistent-id',
        name: 'Ghost Entry',
      });

      const text = result.content[0].text;
      expect(text).toContain('not found');
    });

    it('should return message when no fields provided', () => {
      const result = handleCatalogUpdate({
        id: 'update-test',
      });

      const text = result.content[0].text;
      expect(text).toContain('No fields to update');
    });

    it('should update FTS5 index after update', () => {
      handleCatalogUpdate({
        id: 'update-test',
        description: 'Completely unique searchable phrase xyz123',
      });

      const result = handleCatalogSearch({ query: 'xyz123' });
      const text = result.content[0].text;
      expect(text).toContain('Update Test Module');
    });

    it('should map standalone boolean to integer correctly', () => {
      handleCatalogUpdate({
        id: 'update-test',
        standalone: false,
      });

      const row = db.prepare('SELECT standalone FROM catalog WHERE id = ?').get('update-test') as { standalone: number };
      expect(row.standalone).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. FR-198 asset-reference columns (when_to_use, source, source_ref)
  // -------------------------------------------------------------------------

  describe('FR-198 asset-reference columns', () => {
    it('should round-trip when_to_use / source / source_ref through add → get', () => {
      handleCatalogAdd({
        id: 'fr198-pkg',
        name: 'fifty_buttons',
        type: 'module',
        framework: 'flutter',
        github_repo: 'github.com/fiftynotai/fifty_flutter_kit',
        description: 'Branded button component set',
        when_to_use: 'when a Flutter project needs the fifty.dev branded button system',
        source: 'pub.dev',
        source_ref: 'fifty_buttons',
      });

      // DB-level round-trip (the columns actually persisted)
      const row = db
        .prepare('SELECT when_to_use, source, source_ref FROM catalog WHERE id = ?')
        .get('fr198-pkg') as { when_to_use: string; source: string; source_ref: string };
      expect(row.when_to_use).toBe('when a Flutter project needs the fifty.dev branded button system');
      expect(row.source).toBe('pub.dev');
      expect(row.source_ref).toBe('fifty_buttons');

      // formatEntry renders them
      const result = handleCatalogGet({ id: 'fr198-pkg' });
      const text = result.content[0].text;
      expect(text).toContain('When to use: when a Flutter project needs the fifty.dev branded button system');
      expect(text).toContain('Source: pub.dev (fifty_buttons)');
    });

    it('should update only when_to_use and preserve other fields', () => {
      handleCatalogAdd({
        id: 'fr198-update',
        name: 'auth_module',
        type: 'module',
        github_repo: 'github.com/org/repo',
        source: 'github',
        when_to_use: 'original cue',
      });

      handleCatalogUpdate({
        id: 'fr198-update',
        when_to_use: 'updated cue — reach for this when you need OAuth',
      });

      const row = db
        .prepare('SELECT when_to_use, source FROM catalog WHERE id = ?')
        .get('fr198-update') as { when_to_use: string; source: string };
      expect(row.when_to_use).toBe('updated cue — reach for this when you need OAuth');
      // source preserved (partial-update invariant)
      expect(row.source).toBe('github');
    });

    it('should leave new columns NULL for back-compat adds (old required fields only)', () => {
      handleCatalogAdd({
        name: 'legacy-module',
        type: 'module',
        github_repo: 'github.com/org/legacy',
      });

      const row = db
        .prepare("SELECT when_to_use, source, source_ref FROM catalog WHERE name = 'legacy-module'")
        .get() as { when_to_use: string | null; source: string | null; source_ref: string | null };
      expect(row.when_to_use).toBeNull();
      expect(row.source).toBeNull();
      expect(row.source_ref).toBeNull();
    });

    it('formatEntry shows (none) for unset asset-reference fields', () => {
      handleCatalogAdd({
        id: 'fr198-none',
        name: 'bare-module',
        type: 'module',
        github_repo: 'github.com/org/bare',
      });

      const result = handleCatalogGet({ id: 'fr198-none' });
      const text = result.content[0].text;
      expect(text).toContain('When to use: (none)');
      expect(text).toContain('Source: (none)');
    });
  });
});
