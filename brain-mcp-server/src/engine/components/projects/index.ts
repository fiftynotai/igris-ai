/**
 * Brain Engine v7.0 — Projects Component
 *
 * Wraps the existing project tool handlers as a BrainComponent.
 * Provides: igris_project_register, igris_project_list, igris_project_status,
 *           igris_project_update (TD-171 M3),
 *           igris_project_dashboard (TD-171 M3 — operator override 2026-05-15)
 *
 * @module engine/components/projects
 * @author fifty.dev
 */

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
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_project_register',
          description: 'Register a project in the Igris brain. Creates or updates the project record. Call this when Igris is installed in a new project.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'Unique project slug (e.g., "igris-ai", "my-flutter-app")',
              },
              name: {
                type: 'string',
                description: 'Human-readable project name',
              },
              path: {
                type: 'string',
                description: 'Absolute path to the project directory',
              },
              tech_stack: {
                type: 'string',
                description: 'Comma-separated technologies (e.g., "dart,flutter,firebase")',
              },
              archetype: {
                type: 'string',
                description: 'Project archetype (e.g., "brand-website", "enterprise-mvvm-mobile", "ai-agent-system", "design-kit")',
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
          description: 'Get a detailed status dashboard for a specific project, including learning count, error count, and recent agent metrics.',
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
          description: 'Partial UPDATE of an existing project record. Only the explicitly provided fields are written; omitted fields retain their existing values. Rejects on missing slug — for new projects use igris_project_register.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              slug: {
                type: 'string',
                description: 'Slug of the project to update (required)',
              },
              name: { type: 'string', description: 'New human-readable name' },
              path: { type: 'string', description: 'New absolute path' },
              tech_stack: {
                type: 'string',
                description: 'New comma-separated tech stack',
              },
              archetype: {
                type: 'string',
                description: 'New archetype label (e.g., "ai-agent-system")',
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
          // Orphan: sync auto-push extension point — will be consumed when sync auto-push is implemented
          { name: 'project.registered', description: 'A project was registered or updated' },
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
