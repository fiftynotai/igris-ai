/**
 * Brain Engine v7.0 — Catalog Component
 *
 * Wraps the catalog tool handlers as a BrainComponent.
 * Provides: igris_catalog_add, igris_catalog_search, igris_catalog_get,
 *           igris_catalog_list, igris_catalog_remove, igris_catalog_update
 *
 * @module engine/components/catalog
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
  handleCatalogAdd,
  handleCatalogSearch,
  handleCatalogGet,
  handleCatalogList,
  handleCatalogRemove,
  handleCatalogUpdate,
} from '../../../tools/catalog.js';
import type {
  CatalogAddInput,
  CatalogSearchInput,
  CatalogGetInput,
  CatalogListInput,
  CatalogRemoveInput,
  CatalogUpdateInput,
} from '../../../tools/catalog.js';

export function createCatalogComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'catalog',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      // Migrations handled by legacy db.ts migrateSchema()
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_catalog_add',
          description: 'Register a reusable asset in the Igris reusable-assets catalog (the "lego" store): a template (full project scaffold) or module (standalone cherry-pickable component, incl. pub.dev/npm packages). Records what it is, where it lives (github_repo/path or source/source_ref), and when to reach for it (when_to_use) so future work reuses instead of rebuilding.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
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
              when_to_use: {
                type: 'string',
                description: 'When to reach for this asset — the reuse-fit cue (e.g., "needs a Flutter scroll-driven hero header"). Makes "grab a lego block if one fits" actionable.',
              },
              source: {
                type: 'string',
                description: 'Where the asset lives, when not a github repo: "pub.dev", "npm", "github", etc. fifty_flutter_kit packages live on pub.dev.',
              },
              source_ref: {
                type: 'string',
                description: 'Source-specific locator paired with `source` (e.g., the pub.dev package name, the npm spec).',
              },
            },
            required: ['name', 'type', 'github_repo'],
          },
          handler: (args) => {
            const result = handleCatalogAdd(args as unknown as CatalogAddInput);
            const text = result.content[0]?.text ?? '';
            if (!text.startsWith('Error:')) {
              _ctx?.bus.emit('catalog.added', { id: (args as Record<string, unknown>).id, name: (args as Record<string, unknown>).name });
            }
            return result;
          },
        },
        {
          name: 'igris_catalog_search',
          description: 'Search the Igris reusable-assets catalog for templates and modules by keyword. Supports filtering by type, framework, and archetype. Uses FTS5 for relevance-ranked results.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
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
          handler: (args) => handleCatalogSearch(args as unknown as CatalogSearchInput),
        },
        {
          name: 'igris_catalog_get',
          description: 'Get full details of a single catalog entry by ID. Returns all fields including rebrand_checklist.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description: 'Catalog entry ID',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleCatalogGet(args as unknown as CatalogGetInput),
        },
        {
          name: 'igris_catalog_list',
          description: 'List catalog entries with optional filters. Defaults to showing only "available" entries.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
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
          handler: (args) => handleCatalogList(args as unknown as CatalogListInput),
        },
        {
          name: 'igris_catalog_remove',
          description: 'Remove a catalog entry. Default is soft-delete (sets status to "deprecated"). Pass hard_delete=true to permanently remove.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description: 'Catalog entry ID to remove',
              },
              hard_delete: {
                type: 'boolean',
                description: 'If true, permanently deletes the entry. Default: false (soft-delete to deprecated).',
              },
            },
            required: ['id'],
          },
          handler: (args) => {
            const result = handleCatalogRemove(args as unknown as CatalogRemoveInput);
            _ctx?.bus.emit('catalog.removed', { id: (args as Record<string, unknown>).id });
            return result;
          },
        },
        {
          name: 'igris_catalog_update',
          description: 'Update an existing catalog entry. Only provided fields are modified; others are preserved. Use this to update descriptions, tags, install commands, rebrand checklists, etc.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description: 'Catalog entry ID to update',
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
              when_to_use: {
                type: 'string',
                description: 'Updated reuse-fit cue (when to reach for this asset)',
              },
              source: {
                type: 'string',
                description: 'Updated source ("pub.dev", "npm", "github", etc.)',
              },
              source_ref: {
                type: 'string',
                description: 'Updated source-specific locator (package name, npm spec, etc.)',
              },
            },
            required: ['id'],
          },
          handler: (args) => {
            const result = handleCatalogUpdate(args as unknown as CatalogUpdateInput);
            const text = result.content[0]?.text ?? '';
            if (!text.startsWith('Error:') && text !== 'No fields to update.') {
              _ctx?.bus.emit('catalog.updated', { id: (args as Record<string, unknown>).id });
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'catalog.added', description: 'A new template or module was registered' },
          { name: 'catalog.removed', description: 'A catalog entry was removed or deprecated' },
          { name: 'catalog.updated', description: 'A catalog entry was updated' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Catalog component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
