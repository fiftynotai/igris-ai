/**
 * FR-273 D6 — manifest derivation (`relations/derive.ts` via `deriveAction`),
 * plan §4.2 D2–D6, D8–D10. A derived match becomes a PENDING SUGGESTION and
 * never an edge: every case reads `project_relations` back raw.
 *
 *   - D2 (AC10 core) the moca-agent-web-shaped pubspec + an ssh-form client
 *     `repo_url` → exactly ONE pending suggestion with the exact
 *     `suggested_action`, and ZERO relation rows before and after;
 *   - D3 a re-run proposes nothing new (the pending title dedupes);
 *   - D4 a dismissed suggestion is not re-proposed (the operator's "no");
 *   - D5 a live edge already present means no suggestion;
 *   - D6 (AC10 limitation) a moca-app-shaped tree without the dependency
 *     proposes nothing and the response carries the working-tree limitation;
 *   - D8 a `path:` dependency matches by realpath; the detail keeps the
 *     manifest's relative string;
 *   - D9 package.json and pyproject.toml fixtures each produce their candidate;
 *     an unreadable shape lands in `unparsed[]`;
 *   - D10 a project path not on disk → `path not on disk`, zero writes;
 *   - plus the suggestion row's producer columns, and the action's refusals.
 *
 * @module engine/components/projects/__tests__/relations-derive.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bootRelationsStorage,
  cleanupRelationsFixtures,
  insertEdge,
  registerProject,
  tmpRoot,
} from './relations-fixture.js';
import { deriveAction } from '../relations/actions.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { applyAction } from '../../subconscious/actions/index.js';
import { removeRelation } from '../relations/write.js';

afterEach(() => cleanupRelationsFixtures());

const CLIENT_SSH = 'git@github.com:KalvadTech/moca-agent-flutter-client.git';
const TITLE = 'Derived relation: moca-agent-web uses_package moca-agent-flutter-client';

const WEB_PUBSPEC = `name: moca_agent_web
dependencies:
  flutter:
    sdk: flutter
  moca_agent_client_ui:
    git:
      url: https://github.com/KalvadTech/moca-agent-flutter-client
      ref: v2.0.0
      path: moca_agent_client_ui
`;

interface Fx { db: Database.Database; root: string; web: string }

function fixture(pubspec = WEB_PUBSPEC): Fx {
  const storage = bootRelationsStorage();
  storage.runMigrations('subconscious', subconsciousMigrations);
  const db = storage.rawConnection;
  const root = tmpRoot();
  const web = registerProject(db, root, 'moca-agent-web');
  registerProject(db, root, 'moca-agent-flutter-client', { repoUrl: CLIENT_SSH });
  registerProject(db, root, 'moca-app');
  writeFileSync(join(web, 'pubspec.yaml'), pubspec);
  return { db, root, web };
}

function relationCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM project_relations').get() as { n: number }).n;
}

function suggestions(db: Database.Database): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM suggestions WHERE source_module = 'project_relation' ORDER BY id").all() as Record<string, unknown>[];
}

interface DeriveData {
  proposed: { suggestion_id: number; title: string }[];
  skipped: { dependency: string; reason: string }[];
  unparsed: { manifest: string; name: string; reason: string }[];
  limitation: string;
  note?: string;
}

async function derive(db: Database.Database, slug: string): Promise<DeriveData> {
  const r = await deriveAction(db, { slug });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.action).toBe('relations.derive');
  return r.data as DeriveData;
}

describe('deriveAction — manifest derivation, suggestion only', () => {
  it('D2 (AC10): one pending suggestion with the exact suggested_action; zero relation rows before and after', async () => {
    const { db } = fixture();
    expect(relationCount(db)).toBe(0);
    const d = await derive(db, 'moca-agent-web');
    expect(d.proposed).toHaveLength(1);
    expect(d.proposed[0].title).toBe(TITLE);
    expect(relationCount(db)).toBe(0);
    const rows = suggestions(db);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s).toMatchObject({
      id: d.proposed[0].suggestion_id, project_slug: 'moca-agent-web', title: TITLE,
      status: 'pending', priority: 'low', type_inferred: 0, source_instance: 'projects', source_module: 'project_relation',
    });
    expect(JSON.parse(String(s.suggested_action))).toEqual({
      kind: 'add_project_relation', from: 'moca-agent-web', relation_kind: 'uses_package', to: 'moca-agent-flutter-client',
      detail: { package: 'moca_agent_client_ui', ref: 'v2.0.0', path: 'moca_agent_client_ui', source: 'pubspec.yaml' },
    });
    expect(JSON.parse(String(s.evidence))).toEqual({
      manifest: 'pubspec.yaml', dependency: 'moca_agent_client_ui',
      normalised: 'github.com/kalvadtech/moca-agent-flutter-client', ref: 'v2.0.0', path: 'moca_agent_client_ui',
    });
    expect(d.limitation).toMatch(/working tree/);
  });

  it('D3: a re-run creates no duplicate suggestion', async () => {
    const { db } = fixture();
    await derive(db, 'moca-agent-web');
    const again = await derive(db, 'moca-agent-web');
    expect(again.proposed).toEqual([]);
    expect(again.skipped).toEqual([{ dependency: 'moca_agent_client_ui', reason: expect.stringMatching(/suggestion pending/) }]);
    expect(suggestions(db)).toHaveLength(1);
  });

  it('D4: a dismissed suggestion is not re-proposed', async () => {
    const { db } = fixture();
    await derive(db, 'moca-agent-web');
    db.prepare("UPDATE suggestions SET status = 'dismissed', dismissed_at = datetime('now') WHERE source_module = 'project_relation'").run();
    const again = await derive(db, 'moca-agent-web');
    expect(again.proposed).toEqual([]);
    expect(again.skipped[0].reason).toMatch(/dismissed/);
    expect(suggestions(db)).toHaveLength(1);
  });

  it('D5: a live edge already present means no suggestion; a TOMBSTONED one does not block', async () => {
    const { db } = fixture();
    insertEdge(db, { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client', removed_at: '2026-01-01 00:00:00' });
    const d = await derive(db, 'moca-agent-web');
    expect(d.proposed).toHaveLength(1);
    const { db: db2 } = fixture();
    insertEdge(db2, { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client' });
    const d2 = await derive(db2, 'moca-agent-web');
    expect(d2.proposed).toEqual([]);
    expect(d2.skipped[0].reason).toMatch(/edge already declared/);
    expect(suggestions(db2)).toHaveLength(0);
  });

  it('D6 (AC10 limitation): a tree without the dependency proposes nothing and says why', async () => {
    const { db, root } = fixture();
    writeFileSync(join(root, 'repos', 'moca-app', 'pubspec.yaml'), 'name: moca_app\ndependencies:\n  http: ^1.2.0\n');
    const d = await derive(db, 'moca-app');
    expect(d.proposed).toEqual([]);
    expect(d.limitation).toMatch(/another branch/);
    expect(suggestions(db)).toHaveLength(0);
    expect(relationCount(db)).toBe(0);
  });

  it('D8: a path dependency matches by realpath; the detail keeps the relative string', async () => {
    const { db, root, web } = fixture('name: w\ndependencies:\n  shared_ui:\n    path: ../shared-link\n');
    const real = join(root, 'repos', 'shared-ui');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, 'repos', 'shared-link'));
    registerProject(db, root, 'shared-ui', { path: real });
    void web;
    const d = await derive(db, 'moca-agent-web');
    expect(d.proposed.map((p) => p.title)).toEqual(['Derived relation: moca-agent-web uses_package shared-ui']);
    const a = JSON.parse(String(suggestions(db)[0].suggested_action));
    expect(a.detail).toEqual({ package: 'shared_ui', path: '../shared-link', source: 'pubspec.yaml' });
  });

  it('D9: package.json and pyproject.toml each produce their candidate; an unreadable shape is unparsed', async () => {
    const { db, root, web } = fixture('name: w\ndependencies:\n  odd: {git: x}\n');
    registerProject(db, root, 'node-lib', { repoUrl: 'https://github.com/acme/node-lib' });
    registerProject(db, root, 'py-client', { repoUrl: 'https://github.com/acme/py-client.git' });
    writeFileSync(join(web, 'package.json'), JSON.stringify({ dependencies: { 'node-lib': 'github:acme/node-lib#v1' } }));
    writeFileSync(join(web, 'pyproject.toml'), '[project]\ndependencies = ["pyc @ git+https://github.com/acme/py-client.git@v3"]\n');
    const d = await derive(db, 'moca-agent-web');
    expect(d.proposed.map((p) => p.title).sort()).toEqual([
      'Derived relation: moca-agent-web uses_package node-lib',
      'Derived relation: moca-agent-web uses_package py-client',
    ]);
    expect(d.unparsed).toEqual([{ manifest: 'pubspec.yaml', name: 'odd', reason: 'inline map not supported' }]);
    const byTo = Object.fromEntries(suggestions(db).map((s) => {
      const a = JSON.parse(String(s.suggested_action));
      return [a.to, a.detail];
    }));
    expect(byTo['node-lib']).toEqual({ package: 'node-lib', ref: 'v1', source: 'package.json' });
    expect(byTo['py-client']).toEqual({ package: 'pyc', ref: 'v3', source: 'pyproject.toml' });
  });

  it('D10: a project path not on disk → "path not on disk", zero writes', async () => {
    const { db, root } = fixture();
    registerProject(db, root, 'gone-app', { onDisk: false });
    const d = await derive(db, 'gone-app');
    expect(d.note).toBe('path not on disk');
    expect(d.proposed).toEqual([]);
    expect(suggestions(db)).toHaveLength(0);
  });

  it('an unmatched git dependency is skipped with the reason; the action refuses an unregistered slug and a missing suggestions store', async () => {
    const { db } = fixture('name: w\ndependencies:\n  other:\n    git: https://github.com/nobody/other.git\n');
    const d = await derive(db, 'moca-agent-web');
    expect(d.skipped).toEqual([{ dependency: 'other', reason: 'no registered project has this repo_url' }]);
    const unreg = await deriveAction(db, { slug: 'ghost' });
    expect(unreg).toMatchObject({ ok: false, action: 'relations.derive', refused: { code: 'unregistered_endpoint' } });
    const bare = bootRelationsStorage().rawConnection; // no subconscious migrations → no suggestions table
    expect((await deriveAction(bare, { slug: 'x' })).refused).toMatchObject({ code: 'suggestions_unavailable' });
    expect((await deriveAction(db, {})).refused).toMatchObject({ code: 'missing_argument' });
  });

  it('F1 (TD-253 class): a credentialled manifest URL never reaches a stored column — suggestion row or applied edge', async () => {
    const SECRETS = [
      'ci-user', 'ghp_FAKETOKEN0123456789', 'deploy-user', 's3cr3t', 'npm-bot', 'tok_npm_123',
      // R2-F1: credentials in ref / path / an absolute local path, not only the url.
      'refuser', 'REFSECRET', 'pathuser', 'PATHSECRET', 'REF2SECRET', 'REV3SECRET', 'SUB3SECRET', '/Users/someone',
      // Warden M1/M2: file:/drive-path shapes and a credential long enough to be cut past its `@`.
      'fileuser', 'winuser', 'LONGSECRET', 'NAMESECRET', 'UPPERFILEUSER',
    ];
    const { db, root } = fixture(`name: w
dependencies:
  moca_agent_client_ui:
    git:
      url: https://ci-user:ghp_FAKETOKEN0123456789@github.com/KalvadTech/moca-agent-flutter-client.git
      ref: https://refuser:REFSECRET@x.io/y
      path: https://pathuser:PATHSECRET@x.io/sub
`);
    writeFileSync(join(root, 'repos', 'moca-app', 'pubspec.yaml'),
      'name: a\ndependencies:\n  client:\n    git:\n      url: "deploy-user:s3cr3t@github.com:KalvadTech/moca-agent-flutter-client.git"\n      ref: v1\n      path: /Users/someone/secret-checkout\n');
    registerProject(db, root, 'node-app');
    registerProject(db, root, 'node-lib', { repoUrl: 'https://github.com/acme/node-lib' });
    writeFileSync(join(root, 'repos', 'node-app', 'package.json'),
      JSON.stringify({ dependencies: { 'node-lib': 'git+https://npm-bot:tok_npm_123@github.com/acme/node-lib.git#https://x:REF2SECRET@x.io' } }));
    registerProject(db, root, 'py-app');
    registerProject(db, root, 'py-lib', { repoUrl: 'https://github.com/acme/py-lib' });
    writeFileSync(join(root, 'repos', 'py-app', 'pyproject.toml'),
      '[tool.poetry.dependencies]\npylib = { git = "https://github.com/acme/py-lib.git", rev = "https://u:REV3SECRET@x.io", subdirectory = "https://p:SUB3SECRET@x.io" }\n');
    // M1: a file: URL and a drive path; M2/N4: a credential cut past its `@` by a 200-char cap.
    registerProject(db, root, 'win-app');
    registerProject(db, root, 'win-lib', { repoUrl: 'https://github.com/acme/win-lib' });
    writeFileSync(join(root, 'repos', 'win-app', 'pubspec.yaml'),
      `name: w\ndependencies:\n  winlib:\n    git:\n      url: https://github.com/acme/win-lib.git\n      ref: https://longuser:LONGSECRET${'x'.repeat(185)}@x.io/y\n      path: file:///Users/fileuser/pkg\n`);
    registerProject(db, root, 'drive-app');
    registerProject(db, root, 'drive-lib', { repoUrl: 'https://github.com/acme/drive-lib' });
    writeFileSync(join(root, 'repos', 'drive-app', 'pubspec.yaml'),
      'name: d\ndependencies:\n  drivelib:\n    git:\n      url: https://github.com/acme/drive-lib.git\n      ref: C:\\Users\\winuser\\pkg\n      path: FILE:///Users/UPPERFILEUSER/pkg\n');
    // N6: a credentialled dependency NAME (package.json keys are free text).
    registerProject(db, root, 'name-app');
    registerProject(db, root, 'named-lib', { repoUrl: 'https://github.com/acme/named-lib' });
    writeFileSync(join(root, 'repos', 'name-app', 'package.json'),
      JSON.stringify({ dependencies: { 'https://u:NAMESECRET@x.io': 'github:acme/named-lib' } }));
    // N7: an ABSOLUTE path dependency that matches a registered project.
    registerProject(db, root, 'abs-app');
    const absLib = registerProject(db, root, 'abs-lib');
    writeFileSync(join(root, 'repos', 'abs-app', 'pubspec.yaml'), `name: a\ndependencies:\n  abslib:\n    path: ${absLib}\n`);
    for (const slug of ['moca-agent-web', 'moca-app', 'node-app', 'py-app', 'win-app', 'drive-app', 'name-app', 'abs-app']) {
      const d = await derive(db, slug);
      expect(d.proposed, slug).toHaveLength(1);
    }
    const rows = suggestions(db);
    expect(rows).toHaveLength(8);
    const byFrom = (from: string) => {
      const r = rows.find((x) => x.project_slug === from)!;
      return { evidence: JSON.parse(String(r.evidence)), detail: JSON.parse(String(r.suggested_action)).detail };
    };
    // N4 (M2): the over-length credentialled ref is DROPPED, never cut into passing.
    expect(byFrom('win-app').evidence).not.toHaveProperty('ref');
    expect(byFrom('win-app').detail).not.toHaveProperty('ref');
    // M1: a file: URL and a drive path are local paths — dropped.
    expect(byFrom('win-app').evidence).not.toHaveProperty('path');
    expect(byFrom('drive-app').evidence).not.toHaveProperty('ref');
    expect(byFrom('drive-app').evidence).not.toHaveProperty('path'); // F-R4-1: FILE:/// (upper case)
    // N6: evidence.dependency (and detail.package) go through the gate.
    expect(byFrom('name-app').evidence).not.toHaveProperty('dependency');
    expect(byFrom('name-app').detail).not.toHaveProperty('package');
    // N7: detail.path (and evidence.path) go through the gate.
    expect(byFrom('abs-app').detail).not.toHaveProperty('path');
    expect(byFrom('abs-app').evidence).not.toHaveProperty('path');
    for (const row of rows) {
      const stored = JSON.stringify(row);
      for (const secret of SECRETS) expect(stored, `${row.title} leaks ${secret}`).not.toContain(secret);
      expect(stored).not.toMatch(/:\/\/[^/"]*@/); // no userinfo in any URL-shaped value
    }
    for (const row of rows) {
      const r = applyAction(db, row.id as number);
      expect(r.isError, r.content[0].text).toBeFalsy();
    }
    const edges = db.prepare('SELECT * FROM project_relations').all();
    expect(edges).toHaveLength(8);
    for (const secret of SECRETS) expect(JSON.stringify(edges)).not.toContain(secret);
    // Whole-DB sweep: no persisted column of any table carries a secret.
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      for (const secret of SECRETS) expect(dump, `${name} leaks ${secret}`).not.toContain(secret);
    }
    // A clean ref survives validation (control: validation drops only what it must).
    const moca = rows.find((r) => r.project_slug === 'moca-app')!;
    expect(JSON.parse(String(moca.evidence))).toMatchObject({ ref: 'v1' });
  });

  it('F3: re-deriving after the derived edge is REMOVED re-opens the applied suggestion (same row, same sync key) instead of reporting it applied forever', async () => {
    const { db } = fixture();
    const first = await derive(db, 'moca-agent-web');
    const id = first.proposed[0].suggestion_id;
    expect(applyAction(db, id).isError).toBeFalsy();
    // While the edge is live, derive skips it on the edge rule.
    expect((await derive(db, 'moca-agent-web')).skipped[0].reason).toMatch(/edge already declared/);
    expect(removeRelation(db, { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client' }).ok).toBe(true);
    db.prepare("UPDATE suggestions SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    const again = await derive(db, 'moca-agent-web');
    expect(again.proposed).toEqual([{ suggestion_id: id, title: TITLE, reopened: true }]);
    const rows = suggestions(db);
    expect(rows).toHaveLength(1); // one row per (source_module, project_slug, title) — the sync key
    expect(rows[0]).toMatchObject({ id, status: 'pending', acted_at: null });
    expect(rows[0].created_at).not.toBe('2000-01-01 00:00:00'); // bumped, so LWW replicates the re-open
    expect(applyAction(db, id).isError).toBeFalsy();
    expect(db.prepare('SELECT removed_at, provenance FROM project_relations').all()).toEqual([{ removed_at: null, provenance: 'derived' }]);
    // A dismissed suggestion stays respected even after its edge is gone.
    const { db: db2 } = fixture();
    const d2 = await derive(db2, 'moca-agent-web');
    db2.prepare("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").run(d2.proposed[0].suggestion_id);
    expect((await derive(db2, 'moca-agent-web')).proposed).toEqual([]);
  });
});
