/**
 * Brain Engine v7.0 -- Context Component
 *
 * Manages project context files (coding guidelines, architecture maps, etc.)
 * in the brain DB. Provides registration, retrieval by key, and access to
 * the generated OS module roster at ~/.igris/core/os/INDEX.md.
 *
 * FR-187 cutover: the legacy ~/.igris/core/igris_tree.json + the
 * ~/.igris/core/prompts/igris_os.md monolith are retired. The os/ INDEX is a
 * generated markdown manifest produced by core/scripts/gen_os_index.sh; its
 * boot-tier modules are self-contained files (no `<!-- SECTION: -->` slicing).
 * The two roster-reading tools below are re-pointed onto the INDEX.
 *
 * Provides: igris_context_register, igris_context_get, igris_context_tree, igris_context_load
 *
 * @module engine/components/context
 * @author fifty.dev
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
// OS INDEX parsing (FR-187 cutover)
// ---------------------------------------------------------------------------
//
// The os/ INDEX is a generated markdown manifest (core/scripts/gen_os_index.sh).
// Its module roster is the first markdown table after the `# Igris OS` heading:
//
//   | module | layer | tier | scope | summary | consult_when |
//   |---|---|---|---|---|---|
//   | conduct | conduct | boot | orchestrator | ... | — |
//   | SOUL    | identity | boot | orchestrator | ... | — |
//
// A module name resolves to a file: `SOUL` -> ~/.igris/core/SOUL.md; every
// other name -> ~/.igris/core/os/<name>.md (mirrors gen_os_index.sh's
// module_name()).

/** Absolute path to the generated OS module index. */
export function osIndexPath(): string {
  return join(homedir(), '.igris', 'core', 'os', 'INDEX.md');
}

/** A single module-roster row parsed from the INDEX. */
export interface IndexModule {
  module: string;
  layer: string;
  tier: string;
  scope: string;
  summary: string;
  consult_when: string;
}

/**
 * Parse the module-roster table out of the generated os/ INDEX markdown.
 *
 * Only the leading roster table (header `| module | layer | tier | ... |`) is
 * read; the later Agent / Harness rosters use different headers and are
 * ignored. Returns one entry per data row, in INDEX order.
 */
export function parseIndexModules(indexContent: string): IndexModule[] {
  const lines = indexContent.split('\n');
  const modules: IndexModule[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      // A non-pipe line ends the current table; stop after the first table.
      if (inTable) break;
      continue;
    }

    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

    // Header row: starts the module roster (must lead with "module").
    if (!inTable) {
      if (cells[0]?.toLowerCase() === 'module') {
        inTable = true;
      }
      continue;
    }

    // Separator row (e.g. `|---|---|...|`) — skip.
    if (cells.every((c) => /^-+$/.test(c) || c === '')) {
      continue;
    }

    if (cells.length >= 4 && cells[0]) {
      modules.push({
        module: cells[0],
        layer: cells[1] ?? '',
        tier: cells[2] ?? '',
        scope: cells[3] ?? '',
        summary: cells[4] ?? '',
        consult_when: cells[5] ?? '',
      });
    }
  }

  return modules;
}

/**
 * Resolve an INDEX module display name to its absolute source file path.
 * Mirrors gen_os_index.sh: `SOUL` lives at core/SOUL.md; everything else
 * under core/os/<name>.md.
 */
export function moduleFilePath(moduleName: string): string {
  const coreDir = join(homedir(), '.igris', 'core');
  if (moduleName === 'SOUL') {
    return join(coreDir, 'SOUL.md');
  }
  return join(coreDir, 'os', `${moduleName}.md`);
}

/**
 * Resolve a context file path, replacing `~` with homedir,
 * `{project}` with the project slug, and `{repo_root}` with the project's
 * absolute repo path from the registry (when provided).
 *
 * `repoRoot` is the project's `path` column from the projects registry. When
 * it is absent (project not registered, or path empty), a `{repo_root}` token
 * is left unresolved — the caller's existsSync() then treats the file as
 * missing rather than crashing (FR-186: graceful degradation).
 */
export function resolveContextPath(rawPath: string, project: string, repoRoot?: string): string {
  if (/[\/\\]|\.\./.test(project)) {
    throw new Error(`Invalid project slug: "${project}" contains path traversal characters`);
  }
  let resolved = rawPath
    .replace(/^~/, homedir())
    .replace(/\{project\}/g, project);
  if (repoRoot) {
    resolved = resolved.replace(/\{repo_root\}/g, repoRoot.replace(/\/+$/, ''));
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Actor scope model (FR-187 cutover)
// ---------------------------------------------------------------------------
//
// The legacy per-actor `sections` routing (tree.tasks / tree.agents) is gone.
// The INDEX exposes a `scope` per module: `orchestrator` or `universal`.
// - A task actor (e.g. "/hunt", "/awaken") IS the orchestrator -> it loads the
//   boot-tier modules scoped `orchestrator` OR `universal`.
// - An agent actor (e.g. "forger", "architect") is a subagent -> it loads only
//   the boot-tier modules scoped `universal`.

/** Returns the INDEX `scope` values a given actor is entitled to load. */
function scopesForActor(actorType: 'task' | 'agent'): Set<string> {
  return actorType === 'task'
    ? new Set(['orchestrator', 'universal'])
    : new Set(['universal']);
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
            additionalProperties: false,
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
            additionalProperties: false,
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
          description:
            'Get the generated Igris OS module index from ~/.igris/core/os/INDEX.md. ' +
            'Returns the os/ INDEX markdown — the generated roster of OS context modules ' +
            '(with tier/scope), agents, and harness-specific files. This replaces the ' +
            'retired igris_tree.json routing tree.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {},
          },
          handler: () => {
            try {
              const indexPath = osIndexPath();
              const content = readFileSync(indexPath, 'utf-8');
              return successResult(content);
            } catch (err) {
              return errorResult(
                `Failed to read os/ INDEX: ${errMsg(err)}. Ensure ~/.igris/core/os/INDEX.md exists ` +
                `(generated by core/scripts/gen_os_index.sh).`
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
            'One-call OS boot-context resolver. Given an actor (task name like "/hunt" or ' +
            'agent name like "forger") and a project slug, reads ~/.igris/core/os/INDEX.md, ' +
            'selects the boot-tier OS modules the actor is scoped to load (a task is the ' +
            'orchestrator -> orchestrator + universal modules; an agent is a subagent -> ' +
            'universal modules only), reads each self-contained module file, and returns the ' +
            'concatenated result. Modules are whole files — there is no section slicing.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              actor: {
                type: 'string',
                description:
                  'Actor identifier. A task name (e.g., "/hunt", "/awaken", "/register") ' +
                  'or an agent name (e.g., "forger", "architect", "sentinel").',
              },
              project: {
                type: 'string',
                description: 'Project slug (recorded on the result; reserved for future use).',
              },
            },
            required: ['actor', 'project'],
          },
          handler: (args) => {
            try {
              const actor = args.actor as string;
              const project = args.project as string;

              // 1. Read the generated os/ INDEX (replaces igris_tree.json).
              const indexPath = osIndexPath();
              if (!existsSync(indexPath)) {
                return errorResult(
                  'os/ INDEX not found at ~/.igris/core/os/INDEX.md. ' +
                  'Generate it with core/scripts/gen_os_index.sh.'
                );
              }

              const indexContent = readFileSync(indexPath, 'utf-8');
              const modules = parseIndexModules(indexContent);

              // 2. Classify the actor. A leading "/" marks a task (the
              //    orchestrator); anything else is an agent (a subagent).
              const actorType: 'task' | 'agent' = actor.startsWith('/') ? 'task' : 'agent';
              const allowedScopes = scopesForActor(actorType);

              // 3. Select the boot-tier modules this actor is scoped to load.
              const selected = modules.filter(
                (m) => m.tier === 'boot' && allowedScopes.has(m.scope)
              );

              // 4. Resolve each module name to its file and read it whole.
              const files: Array<{ key: string; path: string; content: string; size_bytes: number }> = [];
              const missing: string[] = [];

              for (const mod of selected) {
                const resolvedPath = moduleFilePath(mod.module);
                if (!existsSync(resolvedPath)) {
                  missing.push(mod.module);
                  continue;
                }
                const content = readFileSync(resolvedPath, 'utf-8');
                files.push({
                  key: mod.module,
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
