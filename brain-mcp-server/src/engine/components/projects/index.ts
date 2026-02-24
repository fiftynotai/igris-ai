/**
 * Brain Engine v5.0 — Projects Component
 *
 * Wraps the existing project tool handlers as a BrainComponent.
 * Provides: igris_project_register, igris_project_list, igris_project_status
 *
 * @module engine/components/projects
 * @author Fifty.ai
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
} from '../../../tools/projects.js';
import type {
  ProjectRegisterInput,
  ProjectListInput,
  ProjectStatusInput,
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
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
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
