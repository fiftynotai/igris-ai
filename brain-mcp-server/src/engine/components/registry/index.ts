/**
 * Brain Engine v5.0 — Registry Component
 *
 * Wraps the registry tool handlers as a BrainComponent.
 * Provides: igris_registry_add, igris_registry_search, igris_registry_get,
 *           igris_registry_list, igris_registry_remove, igris_registry_update
 *
 * @module engine/components/registry
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
  handleRegistryAdd,
  handleRegistrySearch,
  handleRegistryGet,
  handleRegistryList,
  handleRegistryRemove,
  handleRegistryUpdate,
} from '../../../tools/registry.js';
import type {
  RegistryAddInput,
  RegistrySearchInput,
  RegistryGetInput,
  RegistryListInput,
  RegistryRemoveInput,
  RegistryUpdateInput,
} from '../../../tools/registry.js';

export function createRegistryComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'registry',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      // Migrations handled by legacy db.ts migrateSchema()
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_registry_add',
          description: 'Register a reusable template or module in the Igris registry. Templates are full project scaffolds; modules are standalone cherry-pickable components. Uses GitHub URLs as primary paths.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'string',
                description: 'Unique ID for the entry (auto-generated UUID if omitted)',
              },
              name: {
                type: 'string',
                description: 'Human-readable name (e.g., "brand-website-flutter", "hero_scroll_module")',
              },
              type: {
                type: 'string',
                enum: ['template', 'module'],
                description: 'Entry type: "template" for full project scaffolds, "module" for standalone components',
              },
              archetype: {
                type: 'string',
                description: 'Project archetype this belongs to (e.g., "brand-website", "enterprise-mvvm-mobile")',
              },
              framework: {
                type: 'string',
                description: 'Framework/technology (e.g., "flutter", "next.js", "typescript")',
              },
              github_repo: {
                type: 'string',
                description: 'GitHub repository URL (e.g., "github.com/org/repo")',
              },
              github_path: {
                type: 'string',
                description: 'Path within the repo (e.g., "packages/hero_scroll")',
              },
              github_branch: {
                type: 'string',
                description: 'Git branch (default: "main")',
              },
              description: {
                type: 'string',
                description: 'Description of what this template/module provides',
              },
              install_command: {
                type: 'string',
                description: 'Command to install or scaffold (e.g., "flutter create --template=...")',
              },
              standalone: {
                type: 'boolean',
                description: 'Whether this module can be used independently (default: true)',
              },
              parent_template: {
                type: 'string',
                description: 'ID of the parent template (for modules that belong to a template)',
              },
              tags: {
                type: 'string',
                description: 'JSON array of tags (e.g., \'["ui", "animation", "scroll"]\')',
              },
              rebrand_checklist: {
                type: 'string',
                description: 'Markdown checklist for white-label rebranding',
              },
              source_project: {
                type: 'string',
                description: 'Project slug where this was originally created',
              },
              status: {
                type: 'string',
                enum: ['available', 'deprecated', 'draft'],
                description: 'Entry status (default: "available")',
              },
            },
            required: ['name', 'type', 'github_repo'],
          },
          handler: (args) => {
            const result = handleRegistryAdd(args as unknown as RegistryAddInput);
            const text = result.content[0]?.text ?? '';
            if (!text.startsWith('Error:')) {
              _ctx?.bus.emit('registry.added', { id: (args as Record<string, unknown>).id, name: (args as Record<string, unknown>).name });
            }
            return result;
          },
        },
        {
          name: 'igris_registry_search',
          description: 'Search the Igris registry for templates and modules by keyword. Supports filtering by type, framework, and archetype. Uses FTS5 for relevance-ranked results.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: 'Search query — matches against name, description, tags, and framework',
              },
              type: {
                type: 'string',
                enum: ['template', 'module'],
                description: 'Filter by entry type (optional)',
              },
              framework: {
                type: 'string',
                description: 'Filter by framework (e.g., "flutter", "typescript")',
              },
              archetype: {
                type: 'string',
                description: 'Filter by archetype (e.g., "brand-website")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
            },
            required: ['query'],
          },
          handler: (args) => handleRegistrySearch(args as unknown as RegistrySearchInput),
        },
        {
          name: 'igris_registry_get',
          description: 'Get full details of a single registry entry by ID. Returns all fields including rebrand_checklist.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'string',
                description: 'Registry entry ID',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleRegistryGet(args as unknown as RegistryGetInput),
        },
        {
          name: 'igris_registry_list',
          description: 'List registry entries with optional filters. Defaults to showing only "available" entries.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              type: {
                type: 'string',
                enum: ['template', 'module'],
                description: 'Filter by entry type (optional)',
              },
              archetype: {
                type: 'string',
                description: 'Filter by archetype (optional)',
              },
              framework: {
                type: 'string',
                description: 'Filter by framework (optional)',
              },
              status: {
                type: 'string',
                enum: ['available', 'deprecated', 'draft'],
                description: 'Filter by status (default: "available")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 25)',
              },
            },
          },
          handler: (args) => handleRegistryList(args as unknown as RegistryListInput),
        },
        {
          name: 'igris_registry_remove',
          description: 'Remove a registry entry. Default is soft-delete (sets status to "deprecated"). Pass hard_delete=true to permanently remove.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'string',
                description: 'Registry entry ID to remove',
              },
              hard_delete: {
                type: 'boolean',
                description: 'If true, permanently deletes the entry. Default: false (soft-delete to deprecated).',
              },
            },
            required: ['id'],
          },
          handler: (args) => {
            const result = handleRegistryRemove(args as unknown as RegistryRemoveInput);
            _ctx?.bus.emit('registry.removed', { id: (args as Record<string, unknown>).id });
            return result;
          },
        },
        {
          name: 'igris_registry_update',
          description: 'Update an existing registry entry. Only provided fields are modified; others are preserved. Use this to update descriptions, tags, install commands, rebrand checklists, etc.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'string',
                description: 'Registry entry ID to update',
              },
              name: {
                type: 'string',
                description: 'Updated name',
              },
              type: {
                type: 'string',
                enum: ['template', 'module'],
                description: 'Updated type',
              },
              archetype: {
                type: 'string',
                description: 'Updated archetype',
              },
              framework: {
                type: 'string',
                description: 'Updated framework',
              },
              github_repo: {
                type: 'string',
                description: 'Updated GitHub repo URL',
              },
              github_path: {
                type: 'string',
                description: 'Updated path within repo',
              },
              github_branch: {
                type: 'string',
                description: 'Updated branch',
              },
              description: {
                type: 'string',
                description: 'Updated description',
              },
              install_command: {
                type: 'string',
                description: 'Updated install command',
              },
              standalone: {
                type: 'boolean',
                description: 'Updated standalone flag',
              },
              parent_template: {
                type: 'string',
                description: 'Updated parent template ID',
              },
              tags: {
                type: 'string',
                description: 'Updated tags (JSON array)',
              },
              rebrand_checklist: {
                type: 'string',
                description: 'Updated rebrand checklist (markdown)',
              },
              source_project: {
                type: 'string',
                description: 'Updated source project slug',
              },
              status: {
                type: 'string',
                enum: ['available', 'deprecated', 'draft'],
                description: 'Updated status',
              },
            },
            required: ['id'],
          },
          handler: (args) => {
            const result = handleRegistryUpdate(args as unknown as RegistryUpdateInput);
            const text = result.content[0]?.text ?? '';
            if (!text.startsWith('Error:') && text !== 'No fields to update.') {
              _ctx?.bus.emit('registry.updated', { id: (args as Record<string, unknown>).id });
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'registry.added', description: 'A new template or module was registered' },
          { name: 'registry.removed', description: 'A registry entry was removed or deprecated' },
          { name: 'registry.updated', description: 'A registry entry was updated' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Registry component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
