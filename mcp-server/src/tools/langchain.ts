/**
 * Igris LangChain Integration Tools
 *
 * Wraps LangChain hooks as MCP tools via subprocess
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);
const LANGCHAIN_DIR = path.join(process.cwd(), 'ai', 'langchain');
const VENV_PYTHON = path.join(LANGCHAIN_DIR, 'venv', 'bin', 'python3');

/**
 * Generate brief using LangChain
 */
async function generateBrief(args: any) {
  const { description, type = 'BR' } = args;

  try {
    const cmd = `${VENV_PYTHON} -c "
import sys
sys.path.insert(0, '${LANGCHAIN_DIR}')
from hooks.generate_brief import generate_brief
result = generate_brief('${description}', '${type}')
print(result)
"`;

    const { stdout } = await execAsync(cmd, {
      cwd: LANGCHAIN_DIR,
      timeout: 30000, // 30 second timeout
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
    throw new Error(`LangChain brief generation failed: ${error}`);
  }
}

/**
 * Analyze code with LangChain
 */
async function analyzeCode(args: any) {
  const { file_path, question } = args;

  try {
    const cmd = `${VENV_PYTHON} -c "
import sys
sys.path.insert(0, '${LANGCHAIN_DIR}')
from chains.code_analyzer import analyze_code
result = analyze_code('${file_path}', '${question}')
print(result)
"`;

    const { stdout } = await execAsync(cmd, {
      cwd: LANGCHAIN_DIR,
      timeout: 60000, // 60 second timeout for analysis
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
    throw new Error(`LangChain code analysis failed: ${error}`);
  }
}

/**
 * Register LangChain tool handlers
 */
export function registerLangChainTools() {
  return {
    generateBrief,
    analyzeCode,
  };
}
