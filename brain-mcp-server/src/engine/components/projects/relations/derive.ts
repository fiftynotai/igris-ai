// FR-273 D6 — manifest derivation: a git/path dependency matching a registered
// project becomes a PENDING suggestion (`add_project_relation`), never an edge;
// the operator applies it. Contract: MAINTAINING row "project relations store".

import type Database from 'better-sqlite3';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expandHome } from '../../../../tools/projects.js';
import type { CoreOutcome } from './kinds.js';
import { parsePackageJsonDeps, parsePubspecDeps, parsePyprojectDeps, type ManifestScan } from './manifest-parse.js';
import { normaliseRepoUrl } from './url-normalise.js';
import { validateDetail } from './write.js';

export const DERIVE_LIMITATION =
  "Derivation reads the working tree's manifests only: a dependency that exists only on another branch is invisible here — declare it with igris_project_relate.";

export const DERIVE_SOURCE = 'project_relation';

export interface DeriveData {
  // `reopened`: an applied suggestion whose edge was since removed (F3).
  proposed: { suggestion_id: number; title: string; reopened?: true }[];
  skipped: { dependency: string; reason: string }[];
  unparsed: { manifest: string; name: string; reason: string }[];
  limitation: string;
  note?: string;
}

const MANIFESTS: [string, (t: string) => ManifestScan][] = [
  ['pubspec.yaml', parsePubspecDeps],
  ['package.json', parsePackageJsonDeps],
  ['pyproject.toml', parsePyprojectDeps],
];

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

interface Row { slug: string; path: string; repo_url: string | null }

// THE one gate for a manifest-sourced string that is persisted (evidence,
// detail): the FULL value against `validateDetail` (length cap, URL userinfo,
// absolute/~/file:/drive/UNC path); a failing value is dropped, never cut into
// passing (TD-253). Rows are built only from values that pass.
export function persistableManifestValue(key: string, v: string | null | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  return validateDetail({ [key]: v }) === null ? v : undefined;
}

export function deriveRelationSuggestions(db: Database.Database, slug: string): CoreOutcome<DeriveData> {
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[]).map((c) => c.name));
  const repo = cols.has('repo_url') ? 'repo_url' : 'NULL AS repo_url';
  const self = db.prepare(`SELECT slug, path, ${repo} FROM projects WHERE slug = ?`).get(slug) as Row | undefined;
  if (self === undefined) {
    return { ok: false, refused: { code: 'unregistered_endpoint', message: `'${slug}' is not a registered project slug.`, existing: slug } };
  }
  const data: DeriveData = { proposed: [], skipped: [], unparsed: [], limitation: DERIVE_LIMITATION };
  const dir = expandHome(self.path);
  if (!existsSync(dir)) {
    data.note = 'path not on disk';
    return { ok: true, data };
  }
  const others = db.prepare(`SELECT slug, path, ${repo} FROM projects WHERE slug != ?`).all(slug) as Row[];
  const liveEdge = db.prepare("SELECT 1 FROM project_relations WHERE from_slug = ? AND kind = 'uses_package' AND to_slug = ? AND removed_at IS NULL");
  const existing = db.prepare('SELECT id, status FROM suggestions WHERE source_module = ? AND project_slug = ? AND title = ?');
  // One row per sync key (source_module, project_slug, title): re-open, never re-insert.
  const reopen = db.prepare(
    "UPDATE suggestions SET status = 'pending', acted_at = NULL, created_at = datetime('now'), evidence = ?, suggested_action = ? WHERE id = ?",
  );
  // TD-440/TD-458: literal source_module (in MODULE_VOCABULARY); a writer under
  // components/projects stamps source_instance 'projects'.
  const insert = db.prepare(
    `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status, created_at, suggested_action, type_inferred, source_instance)
     VALUES ('project_relation', ?, ?, ?, 'low', 'pending', datetime('now'), ?, 0, 'projects')`,
  );
  const seen = new Set<string>();

  for (const [manifest, parse] of MANIFESTS) {
    const file = join(dir, manifest);
    if (!existsSync(file)) continue;
    let scan: ManifestScan;
    try {
      scan = parse(readFileSync(file, 'utf-8'));
    } catch {
      data.unparsed.push({ manifest, name: manifest, reason: 'unreadable' });
      continue;
    }
    for (const u of scan.unparsed) data.unparsed.push({ manifest, ...u });
    for (const dep of scan.deps) {
      let matches: Row[];
      let normalised: string | null = null;
      if (dep.git !== undefined) {
        normalised = normaliseRepoUrl(dep.git.url);
        if (normalised === null) {
          data.skipped.push({ dependency: dep.name, reason: 'unrecognised git url' });
          continue;
        }
        matches = others.filter((o) => o.repo_url !== null && o.repo_url !== '' && normaliseRepoUrl(o.repo_url) === normalised);
      } else {
        const target = real(resolve(dir, dep.path!));
        matches = others.filter((o) => real(expandHome(o.path)) === target);
      }
      if (matches.length === 0) {
        data.skipped.push({ dependency: dep.name, reason: dep.git ? 'no registered project has this repo_url' : 'no registered project at this path' });
        continue;
      }
      if (matches.length > 1) {
        data.skipped.push({ dependency: dep.name, reason: `ambiguous: ${matches.map((m) => m.slug).join(', ')}` });
        continue;
      }
      const to = matches[0].slug;
      if (seen.has(to)) {
        data.skipped.push({ dependency: dep.name, reason: 'duplicate within this run' });
        continue;
      }
      seen.add(to);
      if (liveEdge.get(slug, to) !== undefined) {
        data.skipped.push({ dependency: dep.name, reason: `edge already declared (${slug} uses_package ${to})` });
        continue;
      }
      const title = `Derived relation: ${slug} uses_package ${to}`;
      const prior = existing.get(DERIVE_SOURCE, slug, title) as { id: number; status: string } | undefined;
      // An applied suggestion blocks only while its edge is live (checked above).
      if (prior !== undefined && prior.status !== 'acted') {
        data.skipped.push({ dependency: dep.name, reason: `suggestion ${prior.status} (id ${prior.id})` });
        continue;
      }
      // Never the raw URL; every other manifest string through the one gate.
      const safe: Record<string, string | undefined> = {
        package: persistableManifestValue('package', dep.name),
        ref: persistableManifestValue('ref', dep.git?.ref),
        path: persistableManifestValue('path', dep.git?.path ?? dep.path),
        normalised: persistableManifestValue('normalised', normalised),
      };
      const detail: Record<string, string> = {};
      for (const k of ['package', 'ref', 'path'] as const) if (safe[k] !== undefined) detail[k] = safe[k]!;
      detail.source = manifest;
      const evidence: Record<string, string> = { manifest };
      if (safe.package !== undefined) evidence.dependency = safe.package;
      for (const k of ['normalised', 'ref', 'path'] as const) if (safe[k] !== undefined) evidence[k] = safe[k]!;
      const action = { kind: 'add_project_relation', from: slug, relation_kind: 'uses_package', to, detail };
      if (prior !== undefined) {
        reopen.run(JSON.stringify(evidence), JSON.stringify(action), prior.id);
        data.proposed.push({ suggestion_id: prior.id, title, reopened: true });
        continue;
      }
      const info = insert.run(slug, title, JSON.stringify(evidence), JSON.stringify(action));
      data.proposed.push({ suggestion_id: Number(info.lastInsertRowid), title });
    }
  }
  return { ok: true, data };
}
