import { execSync } from 'child_process';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * Bash 工具 - 执行 shell 命令
 */
export class BashTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_bash',
    description: '执行 shell 命令。可以运行任何命令行工具，如 git、npm、ls 等。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令'
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 30000ms'
        }
      },
      required: ['command']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { command, timeout = 30000 } = args;

    try {
      const output = execSync(command, {
        cwd: context.workingDirectory,
        encoding: 'utf-8',
        timeout: timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ['pipe', 'pipe', 'pipe']
      });

      return `命令执行成功:\n$ ${command}\n\n${output}`;
    } catch (error: any) {
      const errorOutput = error.stderr || error.stdout || error.message;
      return `命令执行失败:\n$ ${command}\n\n错误信息:\n${errorOutput}`;
    }
  }
}
