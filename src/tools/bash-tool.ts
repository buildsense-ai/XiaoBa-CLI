import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';
import { ToolPolicyGateway } from '../utils/tool-policy-gateway';

const execAsync = promisify(exec);

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
        description: {
          type: 'string',
          description: '命令描述（可选），用于说明命令的作用'
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
    const { command, description, timeout = 30000 } = args;

    const toolPermission = ToolPolicyGateway.checkTool(this.definition.name, context);
    if (!toolPermission.allowed) {
      return `执行被阻止: ${toolPermission.reason}`;
    }

    const commandPermission = ToolPolicyGateway.checkBashCommand(command);
    if (!commandPermission.allowed) {
      return `执行被阻止: ${commandPermission.reason}`;
    }

    // 显示命令信息
    if (description) {
      Logger.info(`执行命令: ${description}`);
    }
    Logger.info(`$ ${command}`);
    Logger.info(`工作目录: ${context.workingDirectory}`);

    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workingDirectory,
        encoding: 'utf-8',
        timeout: timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const output = stdout || '';
      if (stderr) {
        Logger.warning(`stderr: ${stderr.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputLines = output.split('\n').length;
      const outputSize = Buffer.byteLength(output, 'utf-8');

      Logger.success(`✓ 命令执行成功 (耗时: ${executionTime}ms)`);
      Logger.info(`  输出: ${outputLines} 行 | ${(outputSize / 1024).toFixed(2)} KB`);

      // 如果输出很长，显示预览
      if (outputLines > 20) {
        const previewLines = output.split('\n').slice(0, 10);
        Logger.info(`  输出预览（前10行）:`);
        previewLines.forEach(line => {
          const displayLine = line.length > 100 ? line.substring(0, 97) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        Logger.info(`    ... (还有 ${outputLines - 10} 行)`);
      }

      return `命令执行成功:\n$ ${command}\n\n执行时间: ${executionTime}ms\n输出行数: ${outputLines}\n\n${output}`;
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const errorOutput = error.stderr || error.stdout || error.message;

      Logger.error(`✗ 命令执行失败 (耗时: ${executionTime}ms)`);
      Logger.error(`  错误: ${error.message}`);

      return `命令执行失败:\n$ ${command}\n\n执行时间: ${executionTime}ms\n错误信息:\n${errorOutput}`;
    }
  }
}
