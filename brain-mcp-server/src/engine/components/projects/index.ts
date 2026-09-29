/**
 * Brain Engine v7.0 — Projects Component
 *
 * Wraps the existing project tool handlers as a BrainComponent.
 * Provides: igris_project_register, igris_project_list, igris_project_status,
 *           igris_project_update (TD-171 M3),
 *           igris_project_dashboard (TD-171 M3 — operator override 2026-05-15),
 *           igris_project_relations / igris_project_relate /
 *           igris_project_relation_kinds / igris_project_relations_derive (FR-273)
 * Owns projects:1–3 — `projects.repo_url` (FR-265), the knowledge watermark
 * columns (FR-274) and the project-relation tables `project_relation_kinds` +
 * `project_relations` (FR-273); see `schema()`.
 *
 * @module engine/components/projects
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import {
  handleProjectRegister,
  handleProjectList,
  handleProjectStatus,
  handleProjectUpdate,
  handleProjectDashboard,
  KNOWLEDGE_WATERMARK_COLUMNS,
} from '../../../tools/projects.js';
import { relationsMigrationV3 } from './relations/schema.js';
import {
  handleProjectRelate,
  handleProjectRelationKinds,
  handleProjectRelations,
  handleProjectRelationsDerive,
} from './relations/handlers.js';
import type {
  ProjectRegisterInput,
  ProjectListInput,
  ProjectStatusInput,
  ProjectUpdateInput,
  ProjectDashboardInput,
} from '../../../tools/projects.js';

export function createProjectsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'projects',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [
        {
          // FR-265 — `projects.repo_url` (where to clone a project's source).
          //  1. The ALTER is in `pre` and `sql` is a no-op: a pre-flight that
          //     DECLINED on a present column would pin the component at v0 and
          //     skip every later projects migration. `pre` adds the column only
          //     when absent and returns true; `runMigrations` then records v1
          //     (a crash between the two heals on the next boot).
          //  2. ALTER-only (L-53): never in the `db.ts` v1 CREATE.
          //  3. Component registry ON PURPOSE: the legacy schema_version chain
          //     differs between develop and the live brain (GL-012 / TD-433).
          //  4. NOT in SYNC_TABLES (FR-265 D3) — replicating it is a
          //     remote-first deploy (MAINTAINING, the projects.repo_url row).
          // `pre` runs outside the adapter's `trusted_schema = ON` window
          // (BR-089) and an ALTER may re-parse the vec0 triggers, so it scopes
          // the toggle itself.
          version: 1,
          description: 'projects.repo_url (FR-265) — ALTER-only, component registry, not synced',
          pre: (raw) => {
            const db = raw as Database.Database; // `pre` is typed unknown; sqlite.ts passes this
            const hasTable = db
              .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
              .get();
            if (hasTable === undefined) {
              // Fixture-only (migrateSchema creates the table first): a retry, not a stall.
              console.error('[engine] projects@1: no projects table yet — declining; the next boot retries');
              return false;
            }
            const cols = db.pragma('table_info(projects)') as { name: string }[];
            if (cols.some((c) => c.name === 'repo_url')) {
              console.error('[engine] projects@1: repo_url already present — recording projects:1 without ALTER');
              return true;
            }
            db.pragma('trusted_schema = ON');
            try {
              db.exec('ALTER TABLE projects ADD COLUMN repo_url TEXT');
            } finally {
              db.pragma('trusted_schema = OFF');
            }
            return true;
          },
          sql: 'SELECT 1;', // deliberate no-op (point 1): only records the version
        },
        {
          // FR-274 — the knowledge watermark (HEAD SHA, branch — NULL when
          // detached — and the DB-clock time it was recorded). v1's four
          // reasons hold. Each ABSENT column is ALTERed on its own, so a crash
          // between two ALTERs heals on the next boot. One writer: the CLI
          // `igris project watermark` (brain-db.ts#knowledgeWatermarkWrite).
          version: 2,
          description: 'projects.knowledge_sha/knowledge_branch/knowledge_recorded_at (FR-274) — ALTER-only, component registry, not synced',
          pre: (raw) => {
            const db = raw as Database.Database;
            const hasTable = db
              .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
              .get();
            if (hasTable === undefined) {
              console.error('[engine] projects@2: no projects table yet — declining; the next boot retries');
              return false;
            }
            const present = new Set((db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name));
            const missing = KNOWLEDGE_WATERMARK_COLUMNS.filter((c) => !present.has(c));
            if (missing.length === 0) {
              console.error('[engine] projects@2: watermark columns already present — recording projects:2 without ALTER');
              return true;
            }
            db.pragma('trusted_schema = ON');
            try {
              for (const col of missing) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
            } finally {
              db.pragma('trusted_schema = OFF');
            }
            return true;
          },
          sql: 'SELECT 1;', // deliberate no-op: only records the version
        },
        // FR-273 — the relation tables + 5 seeds; no `pre`, never declines; SYNCED.
        relationsMigrationV3,
      ];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_project_register',
          description: 'Register a project in the Igris brain. Creates or updates the project record. Call this when Igris is installed in a new project. One directory gets ONE project row: registering a path that another slug already holds is refused (TD-402).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'Unique project slug — basename(realpath(project_root)) VERBATIM. No case change, no -/_ normalisation, no substituting a package name. A root package name that disagrees with the directory name (pubspec/package.json) goes in `name`, never in `slug`. A monorepo gets ONE row for the repo root; sub-packages are not projects.',
              },
              name: {
                type: 'string',
                description: 'Human-readable project name',
              },
              path: {
                type: 'string',
                description: 'Absolute path to the project directory. Refused if a DIFFERENT slug already holds this directory (compared by resolved realpath, so a symlink and its target are one directory); the SAME slug re-registering its own path still upserts.',
              },
              tech_stack: {
                type: 'string',
                description: 'Comma-separated technologies (e.g., "dart,flutter,firebase")',
              },
              archetype: {
                type: 'string',
                description: 'Project archetype (e.g., "brand-website", "enterprise-mvvm-mobile", "ai-agent-system", "design-kit")',
              },
              repo_url: {
                type: 'string',
                description: 'Optional clone URL (credentials stripped). Omitted: detected from `git remote get-url origin` when `path` is a repo top level; a stored value is never blanked.',
              },
            },
            required: ['slug', 'name', 'path'],
          },
          handler: (args) => {
            const result = handleProjectRegister(args as unknown as ProjectRegisterInput);
            _ctx?.bus.emit('project.registered', { slug: (args as Record<string, unknown>).slug });
            return result;
          },
        },
        {
          name: 'igris_project_list',
          description: 'List all projects registered in the Igris brain, optionally filtered by status.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                enum: ['active', 'archived', 'inactive'],
                description: 'Filter by project status (optional — omit to list all)',
              },
            },
          },
          handler: (args) => handleProjectList(args as unknown as ProjectListInput),
        },
        {
          name: 'igris_project_status',
          description: 'Get a detailed status dashboard for a specific project, including learning count, error count, and recent agent metrics. Also the knowledge watermark (FR-274): the commit the brain\'s knowledge reflects, a copy-pasteable `git log <sha>..origin/<branch>` line, and a local reachability check against the project path (no fetch).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'Project slug to query',
              },
            },
            required: ['slug'],
          },
          handler: (args) => handleProjectStatus(args as unknown as ProjectStatusInput),
        },
        // ---------------------------------------------------------------
        // TD-171 M3 — igris_project_update
        // ---------------------------------------------------------------
        {
          name: 'igris_project_update',
          description: 'Partial UPDATE of an existing project record. Only the explicitly provided fields are written; omitted fields retain their existing values. Rejects on missing slug — for new projects use igris_project_register. One directory gets ONE project row: setting `path` to a directory another slug already holds is refused, and the refusal precedes the UPDATE, so no field in that call is written (TD-402).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'Slug of the project to update (required)',
              },
              name: { type: 'string', description: 'New human-readable name' },
              path: { type: 'string', description: 'New absolute path. Refused if a DIFFERENT slug already holds this directory (compared by resolved realpath, so a symlink and its target are one directory); re-setting this row to its own path is a no-op success. Free the other row first, or correct that row instead.' },
              tech_stack: {
                type: 'string',
                description: 'New comma-separated tech stack',
              },
              archetype: {
                type: 'string',
                description: 'New archetype label (e.g., "ai-agent-system")',
              },
              repo_url: {
                type: 'string',
                description: 'Clone URL (credentials stripped); an empty string clears it. With the directory gone, `igris doctor` reports the project as source-reclaimed, not an orphan.',
              },
              status: {
                type: 'string',
                enum: ['active', 'archived', 'inactive'],
                description: 'New project status',
              },
            },
            required: ['slug'],
          },
          handler: (args) => handleProjectUpdate(args as unknown as ProjectUpdateInput),
        },
        // ---------------------------------------------------------------
        // TD-171 M3 — igris_project_dashboard (operator override 2026-05-15)
        // ---------------------------------------------------------------
        // Single filterable tool: when `slug` is set returns single-project
        // detail (mirrors handleProjectStatus shape + recent block); when
        // omitted returns cross-project view filtered by status / archetype /
        // tech_stack. summary_only: true collapses per-project rows.
        {
          name: 'igris_project_dashboard',
          description: 'Unified per-project / cross-project dashboard. Set `slug` for one-project detail (replaces older _status pattern); omit `slug` and pass `status` / `archetype` / `tech_stack` filters for narrowed cross-project listings (replaces older _list pattern). `summary_only: true` for counts-only during /scan.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'When set, returns single-project detail view (replaces igris_project_status use case)',
              },
              status: {
                type: 'string',
                enum: ['active', 'archived', 'inactive'],
                description: 'Cross-project filter — omit for all statuses',
              },
              archetype: {
                type: 'string',
                description: 'Cross-project filter (e.g., "ai-agent-system", "enterprise-mvvm-mobile")',
              },
              tech_stack: {
                type: 'string',
                description: 'Cross-project filter — substring match on tech_stack column',
              },
              include_briefs: {
                type: 'boolean',
                description: 'Join brief counts per project. Default true.',
              },
              include_last_session: {
                type: 'boolean',
                description: 'Join last_session_at per project. Default true.',
              },
              summary_only: {
                type: 'boolean',
                description: 'Counts only, no per-project rows. Default false.',
              },
              days: {
                type: 'number',
                description: 'Time window for "recent" stats. Default 30.',
              },
            },
          },
          handler: (args) => handleProjectDashboard(args as unknown as ProjectDashboardInput),
        },
        // FR-273 — thin wrappers over ONE action layer the CLI also imports.
        {
          name: 'igris_project_relations',
          description: 'Project relations lookup (FR-273): the neighbours of a registered project in both directions — kind, labels, per-edge detail, repo_url, whether the working copy is on disk, and the FR-274 knowledge watermark (at most 4 local git checks). `depth` follows the chain (max 5); the connected "system" is derived. Call before changing a public API, a package\'s exported surface or a pinned version, and before porting a fix between a variant/white-label and its base.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: { type: 'string', description: 'Registered project slug to look up' },
              depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Hops to follow (default 1, max 5)' },
              direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'out = what this project uses/calls; in = what depends on it; both (default)' },
              kind: { type: 'string', description: 'Only this relation kind (an alias resolves to its canonical kind)' },
              check_watermarks: { type: 'boolean', description: 'Run the local watermark reachability check for neighbours (default true)' },
              include_system: { type: 'boolean', description: 'Include the derived connected component (default true)' },
            },
            required: ['slug'],
          },
          handler: (args) => handleProjectRelations(args),
        },
        {
          name: 'igris_project_relate',
          description: 'Declare or remove one project relation (FR-273). Only a registered kind is accepted (an alias stores the canonical name); both endpoints must be registered slugs and not duplicate-path; `detail` is a flat map of short strings; a value that is an absolute, ~, file:, drive or UNC path, or a URL with credentials, is refused. Remove is a tombstone. Re-declaring an identical edge is a no-op.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['declare', 'remove'], description: 'declare (create/update/revive) or remove (tombstone)' },
              from: { type: 'string', description: 'Source project slug (e.g. the consumer)' },
              kind: { type: 'string', description: 'Relation kind, e.g. uses_package, calls_service, white_label_of, variant_of, supersedes' },
              to: { type: 'string', description: 'Target project slug' },
              detail: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'declare only: per-edge detail, e.g. {"package":"x","ref":"v2.0.0"} (≤ 8 keys, ≤ 200 chars each)',
              },
            },
            required: ['action', 'from', 'kind', 'to'],
          },
          handler: (args) => handleProjectRelate(args, (p) => _ctx?.bus.emit('project.relation_changed', p)),
        },
        {
          name: 'igris_project_relation_kinds',
          description: 'The governed relation-kind registry (FR-273). list; add (refused only when its name or meaning WORDING near-duplicates an existing kind — use that kind or alias onto it; a semantically similar kind worded differently can be accepted, so check list first, and merge is the recovery); alias (add an alias to a kind; aliases converge on the next write of the kind row, so concurrent alias adds on two machines can leave one replica missing the other alias until then); merge (rewrite every edge of `retired` to `survivor`; `retired` becomes an alias). Per-action arguments: add = name, meaning, direction, forward_label, inverse_label, example, aliases?; alias = name, alias; merge = retired, survivor.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['list', 'add', 'alias', 'merge'], description: 'Registry operation' },
              name: { type: 'string', description: 'add/alias: the kind name (lower snake case)' },
              meaning: { type: 'string', description: 'add: what the relation means, with A/B endpoints (e.g. "A calls B at runtime")' },
              direction: { type: 'string', description: 'add: which endpoint plays which role (e.g. "A → B: from = caller")' },
              forward_label: { type: 'string', description: 'add: label read from the source (e.g. "calls")' },
              inverse_label: { type: 'string', description: 'add: label read from the target (e.g. "called by")' },
              example: { type: 'string', description: 'add: one example edge' },
              aliases: { type: 'array', items: { type: 'string' }, description: 'add: optional aliases' },
              alias: { type: 'string', description: 'alias: the alias to add' },
              retired: { type: 'string', description: 'merge: the kind to retire' },
              survivor: { type: 'string', description: 'merge: the kind that survives' },
            },
            required: ['action'],
          },
          handler: (args) => handleProjectRelationKinds(args, (p) => _ctx?.bus.emit('project.relation_changed', p)),
        },
        {
          name: 'igris_project_relations_derive',
          description: 'Derive project relations from a registered project\'s manifests (FR-273): pubspec.yaml / package.json / pyproject.toml git and path dependencies that match another registered project (by normalised repo_url, or by realpath) become PENDING suggestions (add_project_relation) — never an edge. Apply one with igris_suggestion_apply_action. Reads the working tree only: a dependency that exists only on another branch is not seen.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: { type: 'string', description: 'Registered project slug whose manifests to read' },
            },
            required: ['slug'],
          },
          handler: (args) => handleProjectRelationsDerive(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // NOT orphan (an older comment here said it was): two live subscribers
          // consume this — `monitoring`'s onEventReceived and `sync`'s
          // onBatchedEvent.
          //
          // The description says ATTEMPTED, not "was registered", because the
          // emit above is UNCONDITIONAL: TD-402 added a refusal arm that returns
          // before the upsert, and the emit fires on it too. Gating it was
          // considered and DECLINED, with the blast radius measured rather than
          // assumed: `sync`'s onBatchedEvent is TABLE-scoped, not slug-scoped —
          // it ignores the payload, marks `projects` dirty and flushes an
          // idempotent whole-table push (and returns immediately unless auto-push
          // is configured), so a refusal cannot make it push a row that does not
          // exist. The whole residual is therefore ONE spurious `monitoring`
          // event row per refused register. Against that, the only refusal marker
          // on the handler's return today is the `Error:` prefix of its prose, so
          // a gate would couple a bus emit to a message's WORDING — a coupling
          // that breaks silently on a reword. A real gate needs the handler to
          // return a structured verdict alongside its envelope; that is a shape
          // change to a shipped tool's contract, not a rename of this string.
          { name: 'project.registered', description: 'A project registration was ATTEMPTED (register or upsert). Fires even when the call was refused — e.g. TD-402 duplicate-path — so a subscriber must not treat it as proof a row changed.' },
          // FR-273: fires only when a write CHANGED a row; `sync` batch-pushes both tables.
          { name: 'project.relation_changed', description: 'A project relation or relation kind row changed (declare/remove, kinds add/alias/merge). Never fires on a refusal or a no-op.' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Projects component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
