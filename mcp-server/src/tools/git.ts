/**
 * Igris Git Operations Tools
 *
 * Handles git commands: status, diff, commit, log
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.env.IGRIS_PROJECT_PATH || process.cwd();

/**
 * Get git status
 */
async function gitStatus(_args: any) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], {
      cwd: PROJECT_ROOT,
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
    const gitArgs = ['diff'];
    if (staged) {
      gitArgs.push('--staged');
    } else if (file) {
      gitArgs.push(file);
    }

    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: PROJECT_ROOT,
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
    const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${limit}`], {
      cwd: PROJECT_ROOT,
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
      await execFileAsync('git', ['add', ...files], {
        cwd: PROJECT_ROOT,
      });
    }

    // Create commit
    const { stdout } = await execFileAsync('git', ['commit', '-m', message], {
      cwd: PROJECT_ROOT,
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
