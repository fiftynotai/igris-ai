/**
 * Brain Engine v5.0 -- Cache Component
 *
 * Filesystem cache layer that regenerates markdown files from the brain
 * DB into ~/.igris/projects/{project}/. Listens to event bus events from
 * briefs and sessions components to auto-update the cache on writes.
 *
 * Provides: igris_cache_rebuild, igris_cache_clean
 *
 * Emits: cache.rebuilt, cache.cleaned
 * Listens: brief.created, brief.synced, session.file.updated
 *
 * @module engine/components/cache
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
  EventPayload,
} from '../../types.js';
import { errMsg } from '../../helpers.js';
import {
  cacheBrief,
  cacheSessionFile,
  handleCacheRebuild,
  handleCacheClean,
} from './handlers.js';

export function createCacheComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  /** Handle brief.created and brief.synced — cache the affected brief */
  function onBriefChanged(payload: EventPayload): void {
    if (!_ctx) return;
    const { project, brief_id } = payload.data;
    if (!project || !brief_id) return;

    try {
      cacheBrief(project as string, brief_id as string);
      _ctx.log.info(`Cached brief ${brief_id} for project ${project}`);
    } catch (err) {
      _ctx.log.error(`Failed to cache brief ${brief_id} for ${project}: ${errMsg(err)}`);
    }
  }

  /** Handle session.file.updated — cache the affected session file */
  function onSessionChanged(payload: EventPayload): void {
    if (!_ctx) return;
    const { project, filename } = payload.data;
    if (!project || !filename) return;

    try {
      cacheSessionFile(project as string, filename as string);
      _ctx.log.info(`Cached session file ${filename} for project ${project}`);
    } catch (err) {
      _ctx.log.error(`Failed to cache session file ${filename} for ${project}: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------
  // Component definition
  // -------------------------------------------------------------------

  return {
    name: 'cache',
    version: '1.0.0',
    depends: ['briefs', 'sessions'],

    schema(): Migration[] {
      // Cache component owns the definition_files table and reads from briefs/sessions
      return [
        {
          version: 1,
          description: 'Create definition_files table (idempotent with legacy v8)',
          sql: `
            CREATE TABLE IF NOT EXISTS definition_files (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL CHECK (type IN ('agent', 'skill', 'rule', 'prompt')),
              name TEXT NOT NULL,
              filename TEXT NOT NULL,
              content TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              version TEXT,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(type, name)
            );
            CREATE INDEX IF NOT EXISTS idx_definition_files_type ON definition_files(type);
          `,
        },
      ];
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_cache_rebuild
        // -----------------------------------------------------------------
        {
          name: 'igris_cache_rebuild',
          description: 'Rebuild filesystem cache for a project. Regenerates markdown files from brain DB into ~/.igris/projects/{project}/.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              scope: {
                type: 'string',
                enum: ['briefs', 'sessions', 'all'],
                description: 'Which files to rebuild (default: all)',
              },
            },
            required: ['project'],
          },
          handler: (args) => {
            const result = handleCacheRebuild(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('cache.rebuilt', {
                project: args.project as string,
                scope: (args.scope as string) ?? 'all',
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_cache_clean
        // -----------------------------------------------------------------
        {
          name: 'igris_cache_clean',
          description: 'Remove filesystem cache for a project.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
            },
            required: ['project'],
          },
          handler: (args) => {
            const result = handleCacheClean(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('cache.cleaned', {
                project: args.project as string,
              });
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // Orphan: monitoring/observability extension point — for future dashboard/notification systems
          { name: 'cache.rebuilt', description: 'Filesystem cache was rebuilt for a project' },
          // Orphan: monitoring/observability extension point — for future dashboard/notification systems
          { name: 'cache.cleaned', description: 'Filesystem cache was removed for a project' },
        ],
        listens: [
          { name: 'brief.created', description: 'Auto-cache brief when a new brief is created' },
          { name: 'brief.synced', description: 'Auto-cache brief when a brief is synced/updated' },
          { name: 'session.file.updated', description: 'Auto-cache session file when updated' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;

      // Wire event listeners
      ctx.bus.on('brief.created', onBriefChanged);
      ctx.bus.on('brief.synced', onBriefChanged);
      ctx.bus.on('session.file.updated', onSessionChanged);

      ctx.log.info('Cache component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('brief.created', onBriefChanged);
        _ctx.bus.off('brief.synced', onBriefChanged);
        _ctx.bus.off('session.file.updated', onSessionChanged);
      }
      _ctx = null;
    },
  };
}
