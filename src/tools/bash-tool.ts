import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';

const execAsync = promisify(exec);

/**
 * Shell 工具 - 执行 shell 命令
 */
export class ShellTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_shell',
    description: '使用系统默认 shell 执行命令。可以运行 git、npm、ls 等命令行工具。',
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

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { command, description, timeout = 30000 } = args;

    const requiredReaderSkill = this.detectReaderSkillCommand(command);
    if (requiredReaderSkill && context.activeSkillName !== requiredReaderSkill) {
      return {
        ok: false,
        errorCode: 'SKILL_NOT_ACTIVATED',
        retryable: false,
        message: [
          `Reader script "${requiredReaderSkill}" must be activated through the native skill tool before execute_shell can run it.`,
          'Call the `skill` tool first, for example:',
          JSON.stringify({ skill: requiredReaderSkill, args: '<current image path> <current user question>' }),
          'After the skill tool returns that the skill is activated, retry the reader command from the activated skill context.',
        ].join('\n'),
      };
    }

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${toolPermission.reason}` };
    }

    const commandPermission = isBashCommandAllowed(command);
    if (!commandPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${commandPermission.reason}` };
    }

    // 显示命令信息
    if (description) {
      Logger.info(`执行命令: ${description}`);
    }
    Logger.info(`$ ${command}`);
    Logger.info(`工作目录: ${context.workingDirectory}`);

    const startTime = Date.now();
    const runtimeEnvironment = resolveRuntimeEnvironment({
      env: process.env,
      probeVersion: false,
    });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workingDirectory,
        env: {
          ...runtimeEnvironment.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
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

      return { ok: true, content: `命令执行成功:\n$ ${command}\n\n执行时间: ${executionTime}ms\n输出行数: ${outputLines}\n\n${output}` };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const errorOutput = error.stderr || error.stdout || error.message;

      Logger.error(`✗ 命令执行失败 (耗时: ${executionTime}ms)`);
      Logger.error(`  错误: ${error.message}`);

      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `命令执行失败:\n$ ${command}\n\n执行时间: ${executionTime}ms\n错误信息:\n${errorOutput}` };
    }
  }

  private detectReaderSkillCommand(command?: string): 'advanced-reader' | 'vision-analysis' | null {
    if (!command) return null;

    const normalized = command.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/skills/vision-analysis/scripts/invoke_reader_api.py')) {
      return 'vision-analysis';
    }
    if (normalized.includes('/skills/advanced-reader/scripts/invoke_reader_api.py')) {
      return 'advanced-reader';
    }
    return null;
  }

}
