/**
 * Brain Engine v5.0 -- Context Component
 *
 * Manages project context files (coding guidelines, architecture maps, etc.)
 * in the brain DB. Provides registration, retrieval by key, and access to
 * the global context routing tree from ~/.igris/core/igris_tree.json.
 *
 * Provides: igris_context_register, igris_context_get, igris_context_tree
 *
 * @module engine/components/context
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import { errorResult, successResult, errMsg } from '../../helpers.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function createContextComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'context',
    version: '1.0.0',
    depends: ['projects'],

    schema(): Migration[] {
      return [
        {
          version: 1,
          description: 'Create context_files table for project context storage',
          sql: `
            CREATE TABLE IF NOT EXISTS context_files (
              id INTEGER PRIMARY KEY,
              project_slug TEXT NOT NULL,
              key TEXT NOT NULL,
              file_path TEXT,
              content TEXT,
              content_hash TEXT,
              updated_at TEXT DEFAULT (datetime('now')),
              UNIQUE(project_slug, key)
            );
          `,
        },
      ];
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_context_register
        // -----------------------------------------------------------------
        {
          name: 'igris_context_register',
          description: 'Register or update a project context file in the brain. Use this to store coding guidelines, architecture maps, API patterns, and other context documents.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug (e.g., "igris-ai", "my-flutter-app")',
              },
              key: {
                type: 'string',
                description: 'Context key (e.g., "coding_guidelines", "architecture_map", "api_pattern")',
              },
              content: {
                type: 'string',
                description: 'Full file content to store',
              },
              file_path: {
                type: 'string',
                description: 'Original filesystem path of the context file (optional)',
              },
            },
            required: ['project', 'key', 'content'],
          },
          handler: (args) => {
            try {
              const project = args.project as string;
              const key = args.key as string;
              const content = args.content as string;
              const filePath = (args.file_path as string | undefined) ?? null;

              const contentHash = createHash('sha256')
                .update(content)
                .digest('hex')
                .slice(0, 16);

              _ctx!.storage.prepare(
                `INSERT OR REPLACE INTO context_files (project_slug, key, file_path, content, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`
              ).run(project, key, filePath, content, contentHash);

              _ctx!.bus.emit('context.registered', { project, key });
              _ctx!.log.info(`Registered context "${key}" for project "${project}"`);

              return successResult(
                `Context registered: key="${key}", project="${project}", size=${content.length} bytes, hash=${contentHash}`
              );
            } catch (err) {
              return errorResult(`Failed to register context: ${errMsg(err)}`);
            }
          },
        },

        // -----------------------------------------------------------------
        // igris_context_get
        // -----------------------------------------------------------------
        {
          name: 'igris_context_get',
          description: 'Retrieve one or more context files by key for a project. Returns content, file path, and update timestamp for each found key, plus a list of any missing keys.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Context keys to retrieve (e.g., ["coding_guidelines", "architecture_map"])',
              },
            },
            required: ['project', 'keys'],
          },
          handler: (args) => {
            try {
              const project = args.project as string;
              const keys = args.keys as string[];

              const placeholders = keys.map(() => '?').join(', ');
              const rows = _ctx!.storage.prepare(
                `SELECT key, content, file_path, updated_at FROM context_files
                 WHERE project_slug = ? AND key IN (${placeholders})`
              ).all(project, ...keys) as Array<{
                key: string;
                content: string;
                file_path: string | null;
                updated_at: string;
              }>;

              const foundKeys = new Set(rows.map((r) => r.key));
              const missing = keys.filter((k) => !foundKeys.has(k));

              const result = {
                project,
                found: rows.map((r) => ({
                  key: r.key,
                  content: r.content,
                  file_path: r.file_path,
                  updated_at: r.updated_at,
                })),
                missing,
              };

              return successResult(JSON.stringify(result, null, 2));
            } catch (err) {
              return errorResult(`Failed to get context: ${errMsg(err)}`);
            }
          },
        },

        // -----------------------------------------------------------------
        // igris_context_tree
        // -----------------------------------------------------------------
        {
          name: 'igris_context_tree',
          description: 'Get the global Igris context routing tree from ~/.igris/core/igris_tree.json. Returns the full tree structure that defines how context files are resolved and routed.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
          handler: () => {
            try {
              const treePath = join(homedir(), '.igris', 'core', 'igris_tree.json');
              const content = readFileSync(treePath, 'utf-8');
              return successResult(content);
            } catch (err) {
              return errorResult(
                `Failed to read igris_tree.json: ${errMsg(err)}. Ensure ~/.igris/core/igris_tree.json exists.`
              );
            }
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'context.registered', description: 'A context file was registered or updated for a project' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Context component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
