/**
 * Brain Engine v5.0 -- Context Component
 *
 * Manages project context files (coding guidelines, architecture maps, etc.)
 * in the brain DB. Provides registration, retrieval by key, and access to
 * the global context routing tree from ~/.igris/core/igris_tree.json.
 *
 * Provides: igris_context_register, igris_context_get, igris_context_tree, igris_context_load
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Section extraction helpers (marker-based, not line-number-based)
// ---------------------------------------------------------------------------

/** Regex to match `<!-- SECTION: name -->` ... `<!-- /SECTION: name -->` blocks */
const SECTION_OPEN_RE = /^<!--\s*SECTION:\s*(\S+)\s*-->/;
const SECTION_CLOSE_PREFIX = '<!-- /SECTION:';

/**
 * Extract named sections from a file that uses `<!-- SECTION: name -->` markers.
 *
 * Returns the concatenated content of only the requested sections.
 * Sections not found in the file are silently skipped.
 */
export function extractSections(fileContent: string, sectionNames: string[]): string {
  const wanted = new Set(sectionNames);
  const lines = fileContent.split('\n');
  const parts: string[] = [];
  let capturing = false;
  let currentSection = '';

  for (const line of lines) {
    const openMatch = SECTION_OPEN_RE.exec(line);
    if (openMatch) {
      const name = openMatch[1];
      if (wanted.has(name)) {
        capturing = true;
        currentSection = name;
        parts.push(line);
      }
      continue;
    }

    if (capturing && line.trimStart().startsWith(SECTION_CLOSE_PREFIX) && line.includes(currentSection)) {
      parts.push(line);
      capturing = false;
      currentSection = '';
      continue;
    }

    if (capturing) {
      parts.push(line);
    }
  }

  return parts.join('\n');
}

/**
 * Resolve a context file path, replacing `~` with homedir
 * and `{project}` with the project slug.
 */
export function resolveContextPath(rawPath: string, project: string): string {
  if (/[\/\\]|\.\./.test(project)) {
    throw new Error(`Invalid project slug: "${project}" contains path traversal characters`);
  }
  return rawPath
    .replace(/^~/, homedir())
    .replace(/\{project\}/g, project);
}

// ---------------------------------------------------------------------------
// Tree types (minimal, for internal use only)
// ---------------------------------------------------------------------------

interface TreeContextFile {
  path: string;
  sections?: Record<string, { lines: string; kb: number; tier: string }>;
  optional?: boolean;
}

interface TreeActorConfig {
  load: string[];
  sections?: Record<string, string | string[]>;
  load_if?: Record<string, string[]>;
  note?: string;
}

interface ContextTree {
  version: string;
  context_files: Record<string, TreeContextFile>;
  tasks: Record<string, TreeActorConfig>;
  agents: Record<string, TreeActorConfig>;
}

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

        // -----------------------------------------------------------------
        // igris_context_load
        // -----------------------------------------------------------------
        {
          name: 'igris_context_load',
          description:
            'One-call context resolver. Given an actor (task name like "/hunt" or agent name like "forger") ' +
            'and a project slug, reads igris_tree.json, resolves all context file paths, reads their contents ' +
            '(extracting specific sections from igris_os.md when configured), and returns the concatenated result. ' +
            'Use this instead of manually reading the tree + resolving paths + reading files.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              actor: {
                type: 'string',
                description:
                  'Actor identifier. A task name (e.g., "/hunt", "/awaken", "/register") ' +
                  'or an agent name (e.g., "forger", "architect", "sentinel").',
              },
              project: {
                type: 'string',
                description: 'Project slug for path resolution (e.g., "igris-ai").',
              },
            },
            required: ['actor', 'project'],
          },
          handler: (args) => {
            try {
              const actor = args.actor as string;
              const project = args.project as string;

              // 1. Read the tree
              const treePath = join(homedir(), '.igris', 'core', 'igris_tree.json');
              if (!existsSync(treePath)) {
                return errorResult(
                  'igris_tree.json not found at ~/.igris/core/igris_tree.json. ' +
                  'Fallback: read the full igris_os.md at ~/.igris/core/prompts/igris_os.md instead.'
                );
              }

              const tree: ContextTree = JSON.parse(readFileSync(treePath, 'utf-8'));

              // 2. Resolve actor config — try tasks first, then agents
              let actorConfig: TreeActorConfig | undefined;
              let actorType: 'task' | 'agent';

              if (tree.tasks[actor]) {
                actorConfig = tree.tasks[actor];
                actorType = 'task';
              } else if (tree.agents[actor]) {
                actorConfig = tree.agents[actor];
                actorType = 'agent';
              } else {
                const availableTasks = Object.keys(tree.tasks).join(', ');
                const availableAgents = Object.keys(tree.agents).join(', ');
                return errorResult(
                  `Actor "${actor}" not found in igris_tree.json. ` +
                  `Available tasks: ${availableTasks}. ` +
                  `Available agents: ${availableAgents}.`
                );
              }

              // 3. Resolve and read each context file
              const files: Array<{ key: string; path: string; content: string; size_bytes: number }> = [];
              const missing: string[] = [];
              const sectionsLoaded: Record<string, string[]> = {};

              const keysToLoad = new Set(actorConfig.load || []);
              if (actorConfig.sections) {
                for (const key of Object.keys(actorConfig.sections)) {
                  keysToLoad.add(key);
                }
              }

              for (const key of keysToLoad) {
                const fileEntry = tree.context_files[key];
                if (!fileEntry) {
                  missing.push(key);
                  continue;
                }

                const resolvedPath = resolveContextPath(fileEntry.path, project);

                if (!existsSync(resolvedPath)) {
                  // Optional files are expected to be absent sometimes
                  missing.push(key);
                  continue;
                }

                let content = readFileSync(resolvedPath, 'utf-8');

                // If this key has section restrictions in the actor config, extract only those sections
                const sectionSpec = actorConfig.sections?.[key];
                if (sectionSpec && fileEntry.sections) {
                  if (Array.isArray(sectionSpec)) {
                    content = extractSections(content, sectionSpec);
                    sectionsLoaded[key] = sectionSpec;
                  }
                  // "ALL" means use the full file content — no extraction needed
                }

                files.push({
                  key,
                  path: resolvedPath,
                  content,
                  size_bytes: Buffer.byteLength(content, 'utf-8'),
                });
              }

              const totalBytes = files.reduce((sum, f) => sum + f.size_bytes, 0);
              const totalKb = +(totalBytes / 1024).toFixed(1);

              const result: Record<string, unknown> = {
                actor,
                actor_type: actorType,
                project,
                files,
                total_kb: totalKb,
              };

              if (Object.keys(sectionsLoaded).length > 0) {
                result.sections_loaded = sectionsLoaded;
              }
              if (missing.length > 0) {
                result.missing = missing;
              }

              return successResult(JSON.stringify(result, null, 2));
            } catch (err) {
              return errorResult(`Failed to load context: ${errMsg(err)}`);
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
