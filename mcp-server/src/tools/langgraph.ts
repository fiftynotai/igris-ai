/**
 * Igris LangGraph Integration Tools
 *
 * Wraps LangGraph agents as MCP tools via subprocess
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);
const LANGGRAPH_DIR = path.join(process.cwd(), 'ai', 'langgraph');
const VENV_PYTHON = path.join(LANGGRAPH_DIR, 'venv', 'bin', 'python3');

/**
 * Run code review agent
 */
async function runCodeReview(args: any) {
  const { files, guidelines_path } = args;

  try {
    const filesArg = Array.isArray(files) ? files.join(',') : files;
    const cmd = `${VENV_PYTHON} -c "
import sys
sys.path.insert(0, '${LANGGRAPH_DIR}')
from agents.code_reviewer import run_review
result = run_review('${filesArg}', '${guidelines_path}')
print(result)
"`;

    const { stdout } = await execAsync(cmd, {
      cwd: LANGGRAPH_DIR,
      timeout: 120000, // 2 minute timeout for review
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
    throw new Error(`LangGraph code review failed: ${error}`);
  }
}

/**
 * Run implementation agent
 */
async function runImplementation(args: any) {
  const { brief_id, instructions } = args;

  try {
    const cmd = `${VENV_PYTHON} -c "
import sys
sys.path.insert(0, '${LANGGRAPH_DIR}')
from agents.implementer import run_implementation
result = run_implementation('${brief_id}', '${instructions}')
print(result)
"`;

    const { stdout } = await execAsync(cmd, {
      cwd: LANGGRAPH_DIR,
      timeout: 300000, // 5 minute timeout for implementation
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
    throw new Error(`LangGraph implementation failed: ${error}`);
  }
}

/**
 * Run planning agent
 */
async function runPlanning(args: any) {
  const { goal, context } = args;

  try {
    const cmd = `${VENV_PYTHON} -c "
import sys
sys.path.insert(0, '${LANGGRAPH_DIR}')
from agents.planner import run_planning
result = run_planning('${goal}', '${context}')
print(result)
"`;

    const { stdout } = await execAsync(cmd, {
      cwd: LANGGRAPH_DIR,
      timeout: 120000, // 2 minute timeout
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
    throw new Error(`LangGraph planning failed: ${error}`);
  }
}

/**
 * Register LangGraph tool handlers
 */
export function registerLangGraphTools() {
  return {
    codeReview: runCodeReview,
    implementation: runImplementation,
    planning: runPlanning,
  };
}
