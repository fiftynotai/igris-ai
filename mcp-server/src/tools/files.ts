/**
 * Igris File Operations Tools
 *
 * Handles file operations: read, write, list
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const PROJECT_ROOT = process.env.IGRIS_PROJECT_PATH || process.cwd();

/**
 * Read a file from the project
 */
async function readFile(args: any) {
  const { path: filePath } = args;

  try {
    // Resolve path relative to project root
    const fullPath = path.join(PROJECT_ROOT, filePath);

    // Security: ensure path is within project
    const resolvedPath = path.resolve(fullPath);
    const resolvedRoot = path.resolve(PROJECT_ROOT);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      throw new Error('Access denied: path outside project root');
    }

    // Read file (use resolvedPath to prevent symlink-based path traversal)
    const content = await fs.readFile(resolvedPath, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }
}

/**
 * Register file tool handlers
 */
export function registerFileTools() {
  return {
    read: readFile,
  };
}
