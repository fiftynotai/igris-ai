/**
 * Igris Git Operations Tools
 *
 * Handles git commands: status, diff, commit, log
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get git status
 */
async function gitStatus(_args: any) {
  try {
    const { stdout } = await execAsync('git status --short', {
      cwd: process.cwd(),
    });

    return {
      content: [
        {
          type: 'text',
          text: stdout || 'Working tree clean',
        },
      ],
    };
  } catch (error) {
    throw new Error(`Git status failed: ${error}`);
  }
}

/**
 * Get git diff
 */
async function gitDiff(args: any) {
  const { file, staged } = args;

  try {
    const cmd = staged
      ? 'git diff --staged'
      : file
      ? `git diff ${file}`
      : 'git diff';

    const { stdout } = await execAsync(cmd, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large diffs
    });

    return {
      content: [
        {
          type: 'text',
          text: stdout || 'No changes',
        },
      ],
    };
  } catch (error) {
    throw new Error(`Git diff failed: ${error}`);
  }
}

/**
 * Get git log
 */
async function gitLog(args: any) {
  const { limit = 10 } = args;

  try {
    const { stdout } = await execAsync(`git log --oneline -${limit}`, {
      cwd: process.cwd(),
    });

    return {
      content: [
        {
          type: 'text',
          text: stdout,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Git log failed: ${error}`);
  }
}

/**
 * Create git commit
 */
async function gitCommit(args: any) {
  const { message, files } = args;

  try {
    // Stage files if provided
    if (files && files.length > 0) {
      await execAsync(`git add ${files.join(' ')}`, {
        cwd: process.cwd(),
      });
    }

    // Create commit
    const { stdout } = await execAsync(`git commit -m "${message}"`, {
      cwd: process.cwd(),
    });

    return {
      content: [
        {
          type: 'text',
          text: `✅ Commit created\n\n${stdout}`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Git commit failed: ${error}`);
  }
}

/**
 * Register git tool handlers
 */
export function registerGitTools() {
  return {
    status: gitStatus,
    diff: gitDiff,
    log: gitLog,
    commit: gitCommit,
  };
}
