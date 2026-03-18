/**
 * Context Component Unit Tests
 *
 * Tests the igris_context_load tool and its supporting functions:
 * 1. extractSections: marker-based section extraction from igris_os.md
 * 2. resolveContextPath: tilde and {project} placeholder expansion
 * 3. igris_context_load handler: task resolution, agent resolution, errors, missing files
 * 4. Component metadata: name, version, tools count, events
 *
 * @module engine/components/context/__tests__/context.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks -- must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock node:fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock node:os to control homedir
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/mock-home'),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { extractSections, resolveContextPath, createContextComponent } from '../index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_IGRIS_OS = `# Igris AI Operating System

---

<!-- SECTION: identity -->

## System Identity

You ARE Igris AI.

<!-- /SECTION: identity -->

---

<!-- SECTION: agent_delegation -->

## Multi-Agent Architecture

Lots of agent delegation content here.
Another line of delegation content.

<!-- /SECTION: agent_delegation -->

---

<!-- SECTION: operating_rules -->

## Operating Rules

Rule 1: Always follow the plan.
Rule 2: Test everything.

<!-- /SECTION: operating_rules -->
`;

const SAMPLE_TREE = {
  version: '6.0.0',
  context_files: {
    igris_os: {
      path: '~/.igris/core/prompts/igris_os.md',
      brain_key: 'igris_os',
      size_kb: 45.4,
      scope: 'core',
      sections: {
        identity: { lines: '7-50', kb: 1.2, tier: 'boot' },
        agent_delegation: { lines: '54-525', kb: 18.0, tier: 'task' },
        operating_rules: { lines: '709-745', kb: 1.2, tier: 'boot' },
      },
    },
    coding_guidelines: {
      path: '~/.igris/projects/{project}/context/coding_guidelines.md',
      brain_key: 'coding_guidelines',
      scope: 'project',
      tier: 'task',
    },
    soul: {
      path: '~/.igris/core/SOUL.md',
      brain_key: 'soul',
      scope: 'core',
      tier: 'boot',
    },
    architecture_map: {
      path: '~/.igris/projects/{project}/context/architecture_map.md',
      brain_key: 'architecture_map',
      scope: 'project',
      tier: 'task',
      optional: true,
    },
  },
  tasks: {
    '/awaken': {
      load: ['igris_os', 'soul'],
      sections: { igris_os: ['identity', 'operating_rules'] },
      note: 'Boot-tier only.',
    },
    '/hunt': {
      load: ['coding_guidelines'],
      sections: { igris_os: ['identity', 'agent_delegation'] },
    },
  },
  agents: {
    forger: {
      load: ['coding_guidelines', 'architecture_map'],
      note: 'Implementation agent',
    },
    architect: {
      load: ['coding_guidelines', 'architecture_map'],
      note: 'Planning agent',
    },
  },
};

const SAMPLE_SOUL = `# SOUL\n\nI am Igris.\n`;
const SAMPLE_GUIDELINES = `# Coding Guidelines\n\nFollow the standards.\n`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTreeMocks(): void {
  const treePath = join('/mock-home', '.igris', 'core', 'igris_tree.json');
  const igrisOsPath = join('/mock-home', '.igris', 'core', 'prompts', 'igris_os.md');
  const soulPath = join('/mock-home', '.igris', 'core', 'SOUL.md');
  const guidelinesPath = join('/mock-home', '.igris', 'projects', 'my-project', 'context', 'coding_guidelines.md');
  const archMapPath = join('/mock-home', '.igris', 'projects', 'my-project', 'context', 'architecture_map.md');

  vi.mocked(existsSync).mockImplementation((p: unknown) => {
    const pathStr = String(p);
    const existingPaths = [treePath, igrisOsPath, soulPath, guidelinesPath];
    return existingPaths.includes(pathStr);
  });

  vi.mocked(readFileSync).mockImplementation((p: unknown, _encoding?: unknown) => {
    const pathStr = String(p);
    if (pathStr === treePath) return JSON.stringify(SAMPLE_TREE);
    if (pathStr === igrisOsPath) return SAMPLE_IGRIS_OS;
    if (pathStr === soulPath) return SAMPLE_SOUL;
    if (pathStr === guidelinesPath) return SAMPLE_GUIDELINES;
    if (pathStr === archMapPath) throw new Error(`ENOENT: no such file: ${pathStr}`);
    throw new Error(`ENOENT: no such file: ${pathStr}`);
  });
}

function getContextLoadHandler(): (args: Record<string, unknown>) => { content: { type: string; text: string }[]; isError?: boolean } {
  const component = createContextComponent();
  const tools = component.tools();
  const loadTool = tools.find((t) => t.name === 'igris_context_load');
  if (!loadTool) throw new Error('igris_context_load tool not found');
  return loadTool.handler as (args: Record<string, unknown>) => { content: { type: string; text: string }[]; isError?: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Context Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. extractSections
  // -------------------------------------------------------------------------

  describe('extractSections', () => {
    it('extracts a single section by name', () => {
      const result = extractSections(SAMPLE_IGRIS_OS, ['identity']);
      expect(result).toContain('<!-- SECTION: identity -->');
      expect(result).toContain('You ARE Igris AI.');
      expect(result).toContain('<!-- /SECTION: identity -->');
      expect(result).not.toContain('Multi-Agent Architecture');
      expect(result).not.toContain('Operating Rules');
    });

    it('extracts multiple sections', () => {
      const result = extractSections(SAMPLE_IGRIS_OS, ['identity', 'operating_rules']);
      expect(result).toContain('<!-- SECTION: identity -->');
      expect(result).toContain('You ARE Igris AI.');
      expect(result).toContain('<!-- SECTION: operating_rules -->');
      expect(result).toContain('Rule 1: Always follow the plan.');
      expect(result).not.toContain('Multi-Agent Architecture');
    });

    it('returns empty string when no sections match', () => {
      const result = extractSections(SAMPLE_IGRIS_OS, ['nonexistent_section']);
      expect(result).toBe('');
    });

    it('returns empty string for empty section names array', () => {
      const result = extractSections(SAMPLE_IGRIS_OS, []);
      expect(result).toBe('');
    });

    it('ignores sections not in the wanted list', () => {
      const result = extractSections(SAMPLE_IGRIS_OS, ['identity']);
      expect(result).not.toContain('agent_delegation');
      expect(result).not.toContain('operating_rules');
    });

    it('handles content with no section markers', () => {
      const noMarkers = '# Just a plain file\n\nNo sections here.';
      const result = extractSections(noMarkers, ['identity']);
      expect(result).toBe('');
    });

    it('section extraction is smaller than full file', () => {
      const identityOnly = extractSections(SAMPLE_IGRIS_OS, ['identity']);
      expect(identityOnly.length).toBeLessThan(SAMPLE_IGRIS_OS.length);
    });
  });

  // -------------------------------------------------------------------------
  // 2. resolveContextPath
  // -------------------------------------------------------------------------

  describe('resolveContextPath', () => {
    it('replaces ~ with homedir', () => {
      const result = resolveContextPath('~/.igris/core/SOUL.md', 'test');
      expect(result).toBe(`${homedir()}/.igris/core/SOUL.md`);
    });

    it('replaces {project} with project slug', () => {
      const result = resolveContextPath('~/.igris/projects/{project}/context/file.md', 'my-app');
      expect(result).toBe(`${homedir()}/.igris/projects/my-app/context/file.md`);
    });

    it('replaces multiple {project} occurrences', () => {
      const result = resolveContextPath('{project}/a/{project}/b', 'slug');
      expect(result).toBe('slug/a/slug/b');
    });

    it('handles paths without tilde', () => {
      const result = resolveContextPath('/absolute/path/file.md', 'test');
      expect(result).toBe('/absolute/path/file.md');
    });

    it('handles paths without {project}', () => {
      const result = resolveContextPath('~/.igris/core/SOUL.md', 'ignored');
      expect(result).toBe(`${homedir()}/.igris/core/SOUL.md`);
    });

    it('rejects project slugs containing ".."', () => {
      expect(() => resolveContextPath('~/.igris/projects/{project}/file.md', '../../etc'))
        .toThrow('Invalid project slug');
    });

    it('rejects project slugs containing "/"', () => {
      expect(() => resolveContextPath('~/.igris/projects/{project}/file.md', 'foo/bar'))
        .toThrow('Invalid project slug');
    });

    it('rejects project slugs containing "\\"', () => {
      expect(() => resolveContextPath('~/.igris/projects/{project}/file.md', 'foo\\bar'))
        .toThrow('Invalid project slug');
    });

    it('rejects project slugs with embedded traversal like "foo/../bar"', () => {
      expect(() => resolveContextPath('~/.igris/projects/{project}/file.md', 'foo/../bar'))
        .toThrow('Invalid project slug');
    });
  });

  // -------------------------------------------------------------------------
  // 3. igris_context_load handler
  // -------------------------------------------------------------------------

  describe('igris_context_load', () => {
    it('resolves a task actor with section extraction', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/awaken', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.actor).toBe('/awaken');
      expect(parsed.actor_type).toBe('task');
      expect(parsed.project).toBe('my-project');
      expect(parsed.files).toHaveLength(2); // igris_os + soul
      expect(parsed.sections_loaded).toEqual({ igris_os: ['identity', 'operating_rules'] });

      // igris_os should be section-extracted (smaller than full file)
      const igrisOsFile = parsed.files.find((f: { key: string }) => f.key === 'igris_os');
      expect(igrisOsFile).toBeDefined();
      expect(igrisOsFile.content).toContain('You ARE Igris AI.');
      expect(igrisOsFile.content).not.toContain('Multi-Agent Architecture');

      // soul should be full content
      const soulFile = parsed.files.find((f: { key: string }) => f.key === 'soul');
      expect(soulFile).toBeDefined();
      expect(soulFile.content).toContain('I am Igris.');

      expect(parsed.total_kb).toBeGreaterThan(0);
    });

    it('resolves an agent actor', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: 'forger', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.actor).toBe('forger');
      expect(parsed.actor_type).toBe('agent');
      expect(parsed.project).toBe('my-project');

      // forger loads coding_guidelines + architecture_map
      // coding_guidelines exists, architecture_map does not
      const foundKeys = parsed.files.map((f: { key: string }) => f.key);
      expect(foundKeys).toContain('coding_guidelines');
      expect(parsed.missing).toContain('architecture_map');
    });

    it('returns error when actor not found', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: 'nonexistent', project: 'my-project' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found in igris_tree.json');
      expect(result.content[0].text).toContain('Available tasks:');
      expect(result.content[0].text).toContain('Available agents:');
    });

    it('returns error when tree file is missing', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/hunt', project: 'my-project' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('igris_tree.json not found');
      expect(result.content[0].text).toContain('igris_os.md');
    });

    it('gracefully handles missing context files', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      // forger loads coding_guidelines (exists) and architecture_map (does not exist)
      const result = handler({ actor: 'forger', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.missing).toContain('architecture_map');
      expect(parsed.files.length).toBeGreaterThanOrEqual(1);
    });

    it('loads section-only keys not in the load array (/hunt loads igris_os sections)', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/hunt', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);

      // /hunt has load: ["coding_guidelines"] but sections: { igris_os: [...] }
      // igris_os should still be loaded with section extraction
      const igrisOsFile = parsed.files.find((f: { key: string }) => f.key === 'igris_os');
      expect(igrisOsFile).toBeDefined();
      expect(igrisOsFile.content).toContain('You ARE Igris AI.');
      expect(igrisOsFile.content).toContain('Multi-Agent Architecture');
      expect(igrisOsFile.content).not.toContain('Operating Rules');

      // sections_loaded should record the igris_os sections
      expect(parsed.sections_loaded).toBeDefined();
      expect(parsed.sections_loaded.igris_os).toEqual(['identity', 'agent_delegation']);
    });

    it('sections_loaded is a map accumulating all section-restricted keys', () => {
      // Create a tree where a task has sections for multiple keys
      const multiSectionTree = {
        ...SAMPLE_TREE,
        context_files: {
          ...SAMPLE_TREE.context_files,
          another_doc: {
            path: '~/.igris/core/another.md',
            brain_key: 'another_doc',
            scope: 'core',
            sections: {
              part_a: { lines: '1-10', kb: 0.5, tier: 'boot' },
            },
          },
        },
        tasks: {
          ...SAMPLE_TREE.tasks,
          '/multi': {
            load: [],
            sections: {
              igris_os: ['identity'],
              another_doc: ['part_a'],
            },
          },
        },
      };

      const treePath = join('/mock-home', '.igris', 'core', 'igris_tree.json');
      const igrisOsPath = join('/mock-home', '.igris', 'core', 'prompts', 'igris_os.md');
      const anotherPath = join('/mock-home', '.igris', 'core', 'another.md');
      const anotherContent = '<!-- SECTION: part_a -->\nPart A content\n<!-- /SECTION: part_a -->\n';

      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        return [treePath, igrisOsPath, anotherPath].includes(String(p));
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown, _encoding?: unknown) => {
        const pathStr = String(p);
        if (pathStr === treePath) return JSON.stringify(multiSectionTree);
        if (pathStr === igrisOsPath) return SAMPLE_IGRIS_OS;
        if (pathStr === anotherPath) return anotherContent;
        throw new Error(`ENOENT: no such file: ${pathStr}`);
      });

      const handler = getContextLoadHandler();
      const result = handler({ actor: '/multi', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sections_loaded).toEqual({
        igris_os: ['identity'],
        another_doc: ['part_a'],
      });
    });

    it('task with no sections config returns full file content', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      // /hunt loads coding_guidelines with no sections for that key
      const result = handler({ actor: '/hunt', project: 'my-project' });
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      const guidelinesFile = parsed.files.find((f: { key: string }) => f.key === 'coding_guidelines');
      expect(guidelinesFile).toBeDefined();
      expect(guidelinesFile.content).toContain('Coding Guidelines');
    });

    it('reports total_kb as a number', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/awaken', project: 'my-project' });
      const parsed = JSON.parse(result.content[0].text);

      expect(typeof parsed.total_kb).toBe('number');
      expect(parsed.total_kb).toBeGreaterThan(0);
    });

    it('includes resolved file paths in output', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/awaken', project: 'my-project' });
      const parsed = JSON.parse(result.content[0].text);

      for (const file of parsed.files) {
        expect(file.path).toBeDefined();
        expect(file.path).toContain('/mock-home/.igris/');
        expect(file.path).not.toContain('~');
        expect(file.path).not.toContain('{project}');
      }
    });

    it('each file entry has key, path, content, and size_bytes', () => {
      setupTreeMocks();
      const handler = getContextLoadHandler();

      const result = handler({ actor: '/awaken', project: 'my-project' });
      const parsed = JSON.parse(result.content[0].text);

      for (const file of parsed.files) {
        expect(file).toHaveProperty('key');
        expect(file).toHaveProperty('path');
        expect(file).toHaveProperty('content');
        expect(file).toHaveProperty('size_bytes');
        expect(typeof file.size_bytes).toBe('number');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Component metadata
  // -------------------------------------------------------------------------

  describe('component metadata', () => {
    it('component name is "context"', () => {
      const comp = createContextComponent();
      expect(comp.name).toBe('context');
    });

    it('component version is "1.0.0"', () => {
      const comp = createContextComponent();
      expect(comp.version).toBe('1.0.0');
    });

    it('tools() returns 4 tools', () => {
      const comp = createContextComponent();
      const tools = comp.tools();
      expect(tools).toHaveLength(4);
      const names = tools.map((t) => t.name);
      expect(names).toContain('igris_context_register');
      expect(names).toContain('igris_context_get');
      expect(names).toContain('igris_context_tree');
      expect(names).toContain('igris_context_load');
    });

    it('events() declares 1 emit (context.registered)', () => {
      const comp = createContextComponent();
      const { emits } = comp.events();
      expect(emits).toHaveLength(1);
      expect(emits[0].name).toBe('context.registered');
    });

    it('events() declares 0 listens', () => {
      const comp = createContextComponent();
      const { listens } = comp.events();
      expect(listens).toHaveLength(0);
    });

    it('schema() returns 1 migration', () => {
      const comp = createContextComponent();
      const migrations = comp.schema();
      expect(migrations).toHaveLength(1);
      expect(migrations[0].version).toBe(1);
    });

    it('depends on projects component', () => {
      const comp = createContextComponent();
      expect(comp.depends).toContain('projects');
    });
  });
});
