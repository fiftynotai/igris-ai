/**
 * Igris Brief Management Tools
 *
 * Handles brief operations: list, read, create, update, archive
 */

import { promises as fs } from 'fs';
import * as path from 'path';

// Use IGRIS_PROJECT_PATH env var if set, otherwise fallback to process.cwd()
// This allows Desktop/Mobile clients to specify which project to manage
const PROJECT_ROOT = process.env.IGRIS_PROJECT_PATH || process.cwd();
const BRIEFS_DIR = path.join(PROJECT_ROOT, 'ai', 'briefs');

interface BriefMetadata {
  id: string;
  type: string;
  title: string;
  priority: string;
  status: string;
  effort?: string;
  created?: string;
  completed?: string;
}

/**
 * Parse brief metadata from markdown file
 */
async function parseBriefMetadata(filePath: string): Promise<BriefMetadata | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Extract ID from filename (e.g., BR-001-title.md -> BR-001)
    const filename = path.basename(filePath);
    const idMatch = filename.match(/^([A-Z]{2,3}-\d{3})/);
    if (!idMatch) return null;

    const id = idMatch[1];

    // Parse metadata from content
    const metadata: BriefMetadata = {
      id,
      type: '',
      title: '',
      priority: '',
      status: '',
    };

    // Extract title from first line (# BR-001: Title)
    const titleMatch = lines[0]?.match(/^#\s+[A-Z]{2,3}-\d{3}:\s+(.+)/);
    if (titleMatch) {
      metadata.title = titleMatch[1];
    }

    // Extract fields from metadata section
    for (const line of lines.slice(1, 15)) {
      if (line.startsWith('**Type:**')) {
        metadata.type = line.replace('**Type:**', '').trim();
      } else if (line.startsWith('**Priority:**')) {
        metadata.priority = line.replace('**Priority:**', '').trim();
      } else if (line.startsWith('**Status:**')) {
        metadata.status = line.replace('**Status:**', '').trim();
      } else if (line.startsWith('**Effort:**')) {
        metadata.effort = line.replace('**Effort:**', '').trim();
      } else if (line.startsWith('**Created:**')) {
        metadata.created = line.replace('**Created:**', '').trim();
      } else if (line.startsWith('**Completed:**')) {
        metadata.completed = line.replace('**Completed:**', '').trim();
      }
    }

    return metadata;
  } catch (error) {
    console.error(`Error parsing brief ${filePath}:`, error);
    return null;
  }
}

/**
 * List briefs with optional filters
 */
async function listBriefs(args: any) {
  const { type, status, priority } = args;

  try {
    // Read all files in briefs directory
    const files = await fs.readdir(BRIEFS_DIR);
    const briefFiles = files.filter(
      (f) => f.match(/^[A-Z]{2,3}-\d{3}.*\.md$/) && !f.includes('TEMPLATE')
    );

    // Parse metadata from each brief
    const briefs: BriefMetadata[] = [];
    for (const file of briefFiles) {
      const metadata = await parseBriefMetadata(path.join(BRIEFS_DIR, file));
      if (metadata) {
        // Apply filters
        if (type && !metadata.type.includes(type)) continue;
        if (status && metadata.status !== status) continue;
        if (priority && !metadata.priority.includes(priority)) continue;

        briefs.push(metadata);
      }
    }

    // Sort by ID
    briefs.sort((a, b) => a.id.localeCompare(b.id));

    // Format as table
    const table = briefs
      .map(
        (b) =>
          `| ${b.id} | ${b.title} | ${b.priority} | ${b.status} | ${b.effort || 'N/A'} |`
      )
      .join('\n');

    const header = `| ID | Title | Priority | Status | Effort |\n|-----|-------|----------|--------|--------|`;

    return {
      content: [
        {
          type: 'text',
          text: `# Igris Briefs\n\nFound ${briefs.length} brief(s)\n\n${header}\n${table}`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to list briefs: ${error}`);
  }
}

/**
 * Read a specific brief
 */
async function readBrief(args: any) {
  const { brief_id } = args;

  try {
    // Find brief file
    const files = await fs.readdir(BRIEFS_DIR);
    const briefFile = files.find((f) => f.startsWith(brief_id));

    if (!briefFile) {
      throw new Error(`Brief ${brief_id} not found`);
    }

    // Read content
    const content = await fs.readFile(path.join(BRIEFS_DIR, briefFile), 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read brief ${brief_id}: ${error}`);
  }
}

/**
 * Create a new brief
 */
async function createBrief(args: any) {
  const { type, title, priority, problem, goal } = args;

  try {
    // Find next available number for this type
    const files = await fs.readdir(BRIEFS_DIR);
    const existingBriefs = files.filter((f) => f.startsWith(type));
    const numbers = existingBriefs
      .map((f) => {
        const match = f.match(new RegExp(`${type}-(\\d{3})`));
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);

    const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    const briefId = `${type}-${String(nextNumber).padStart(3, '0')}`;
    const filename = `${briefId}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;

    // Create brief content (simplified template)
    const content = `# ${briefId}: ${title}

**Type:** ${type}
**Priority:** ${priority}
**Effort:** TBD
**Status:** Ready
**Created:** ${new Date().toISOString().split('T')[0]}
**Completed:** _TBD_

---

## Problem

${problem}

---

## Goal

${goal}

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** ${new Date().toISOString().split('T')[0]}
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** ${new Date().toISOString().split('T')[0]}
**Last Updated:** ${new Date().toISOString().split('T')[0]}
`;

    // Write file
    await fs.writeFile(path.join(BRIEFS_DIR, filename), content, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: `✅ Brief created: ${briefId}\n\nFile: ai/briefs/${filename}\nType: ${type}\nPriority: ${priority}\nStatus: Ready\n\nTo implement: "Implement ${briefId}"`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to create brief: ${error}`);
  }
}

/**
 * Update an existing brief (status, priority, etc.)
 */
async function updateBrief(args: any) {
  const { brief_id, status, priority } = args;

  try {
    // Find brief file
    const files = await fs.readdir(BRIEFS_DIR);
    const briefFile = files.find((f) => f.startsWith(brief_id));

    if (!briefFile) {
      throw new Error(`Brief ${brief_id} not found`);
    }

    const filePath = path.join(BRIEFS_DIR, briefFile);
    let content = await fs.readFile(filePath, 'utf-8');

    // Update status if provided
    if (status) {
      content = content.replace(
        /^\*\*Status:\*\*.*$/m,
        `**Status:** ${status}`
      );

      // If marking as Done, add completion date
      if (status === 'Done' && !content.includes('**Completed:** 202')) {
        content = content.replace(
          /^\*\*Completed:\*\*.*$/m,
          `**Completed:** ${new Date().toISOString().split('T')[0]}`
        );
      }
    }

    // Update priority if provided
    if (priority) {
      content = content.replace(
        /^\*\*Priority:\*\*.*$/m,
        `**Priority:** ${priority}`
      );
    }

    // Write updated content
    await fs.writeFile(filePath, content, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: `✅ Brief updated: ${brief_id}\n${status ? `\nStatus: ${status}` : ''}${priority ? `\nPriority: ${priority}` : ''}`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to update brief ${brief_id}: ${error}`);
  }
}

/**
 * Archive a completed brief
 */
async function archiveBrief(args: any) {
  const { brief_id } = args;

  try {
    // Find brief file
    const files = await fs.readdir(BRIEFS_DIR);
    const briefFile = files.find((f) => f.startsWith(brief_id));

    if (!briefFile) {
      throw new Error(`Brief ${brief_id} not found`);
    }

    // Check if status is Done
    const filePath = path.join(BRIEFS_DIR, briefFile);
    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes('**Status:** Done')) {
      throw new Error(`Cannot archive ${brief_id}: Status must be "Done"`);
    }

    // Create archive directory if needed
    const archiveDir = path.join(process.cwd(), 'ai', 'session', 'archive', 'briefs');
    await fs.mkdir(archiveDir, { recursive: true });

    // Move file to archive
    const archivePath = path.join(archiveDir, briefFile);
    await fs.rename(filePath, archivePath);

    return {
      content: [
        {
          type: 'text',
          text: `✅ Archived: ${brief_id}\n\nMoved from: ai/briefs/${briefFile}\nMoved to: ai/session/archive/briefs/${briefFile}\n\nStatus: Done`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to archive brief ${brief_id}: ${error}`);
  }
}

/**
 * Register brief tool handlers
 */
export function registerBriefTools() {
  return {
    list: listBriefs,
    read: readBrief,
    create: createBrief,
    update: updateBrief,
    archive: archiveBrief,
  };
}
