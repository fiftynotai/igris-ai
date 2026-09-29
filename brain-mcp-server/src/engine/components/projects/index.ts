/**
 * Brain Engine v7.0 — Projects Component
 *
 * Wraps the existing project tool handlers as a BrainComponent.
 * Provides: igris_project_register, igris_project_list, igris_project_status,
 *           igris_project_update (TD-171 M3),
 *           igris_project_dashboard (TD-171 M3 — operator override 2026-05-15)
 * Owns migration projects:1, projects:2 — `projects.repo_url` (FR-265) and the
 * knowledge watermark columns (FR-274); see `schema()`.
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
