/**
 * Igris Session Management Tools
 *
 * Handles session state operations: get, update
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const SESSION_FILE = path.join(process.cwd(), 'ai', 'session', 'CURRENT_SESSION.md');

/**
 * Get current session state
 */
async function getSession(_args: any) {
  try {
    const content = await fs.readFile(SESSION_FILE, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read session: ${error}`);
  }
}

/**
 * Update session state
 */
async function updateSession(args: any) {
  const { status, next_steps } = args;

  try {
    let content = await fs.readFile(SESSION_FILE, 'utf-8');

    // Update status if provided
    if (status) {
      content = content.replace(
        /^## Status:.*$/m,
        `## Status: ${status}`
      );
    }

    // Update next steps if provided
    if (next_steps) {
      // Find and update the "Next Steps When Resuming" section
      const regex = /\*\*Next Steps When Resuming:\*\*[^\n]*\n\n([\s\S]*?)(?=\n\n##|$)/;
      const replacement = `**Next Steps When Resuming:**\n\n${next_steps}`;

      if (regex.test(content)) {
        content = content.replace(regex, replacement);
      }
    }

    // Write updated content
    await fs.writeFile(SESSION_FILE, content, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: `✅ Session updated\n${status ? `\nStatus: ${status}` : ''}${next_steps ? `\nNext steps updated` : ''}`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to update session: ${error}`);
  }
}

/**
 * Register session tool handlers
 */
export function registerSessionTools() {
  return {
    get: getSession,
    update: updateSession,
  };
}
