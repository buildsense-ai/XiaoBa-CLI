import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';

const execAsync = promisify(exec);
const CWD_MARKER_PREFIX = '__XIAOBA_CWD_MARKER__';

interface WrappedCommand {
  command: string;
  marker: string;
  scriptPath?: string;
}

export class ShellTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_shell',
    description: [
      '使用系统默认 shell 执行单条命令。可以运行 git、npm、ls 等命令行工具。',
      '命令会从当前目录启动。每次调用都是新的 shell 进程；只有命令结束时的当前目录会被会话继承，环境变量、alias、函数和虚拟环境激活状态不会跨调用持久化。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令',
        },
        description: {
          type: 'string',
          description: '命令描述（可选），用于说明命令的作用',
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 30000ms',
        },
      },
      required: ['command'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { command, description, timeout = 30000 } = args;

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${toolPermission.reason}` };
    }

    const commandPermission = isBashCommandAllowed(command);
    if (!commandPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${commandPermission.reason}` };
    }

    if (description) {
      Logger.info(`执行命令: ${description}`);
    }
    Logger.info(`$ ${command}`);
    Logger.info(`当前目录: ${context.workingDirectory}`);

    const startTime = Date.now();
    const runtimeEnvironment = resolveRuntimeEnvironment({
      env: process.env,
      probeVersion: false,
    });
    const wrapped = this.wrapCommandWithDirectoryProbe(command);

    try {
      const { stdout, stderr } = await execAsync(wrapped.command, {
        cwd: context.workingDirectory,
        env: runtimeEnvironment.env,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parsedStdout = this.extractDirectoryProbe(stdout || '', wrapped.marker);
      const parsedStderr = this.extractDirectoryProbe(stderr || '', wrapped.marker);
      this.updateCurrentDirectory(parsedStdout.directory || parsedStderr.directory, context);

      const output = parsedStdout.output || '';
      if (parsedStderr.output) {
        Logger.warning(`stderr: ${parsedStderr.output.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputLines = output ? output.split('\n').length : 0;
      const outputSize = Buffer.byteLength(output, 'utf-8');

      Logger.success(`✓ 命令执行成功 (耗时: ${executionTime}ms)`);
      Logger.info(`  输出: ${outputLines} 行 | ${(outputSize / 1024).toFixed(2)} KB`);

      if (outputLines > 20) {
        const previewLines = output.split('\n').slice(0, 10);
        Logger.info('  输出预览（前10行）:');
        previewLines.forEach(line => {
          const displayLine = line.length > 100 ? line.substring(0, 97) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        Logger.info(`    ... (还有 ${outputLines - 10} 行)`);
      }

      return {
        ok: true,
        content: `命令执行成功:\n$ ${command}\n\n执行时间: ${executionTime}ms\n输出行数: ${outputLines}\n\n${output}`,
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const errorOutput = this.stripAnyDirectoryProbe(error.stderr || error.stdout || error.message);

      Logger.error(`✗ 命令执行失败 (耗时: ${executionTime}ms)`);
      Logger.error(`  错误: ${error.message}`);

      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `命令执行失败:\n$ ${command}\n\n执行时间: ${executionTime}ms\n错误信息:\n${errorOutput}`,
      };
    } finally {
      this.cleanupWrappedCommand(wrapped);
    }
  }

  private wrapCommandWithDirectoryProbe(command: string): WrappedCommand {
    const marker = `${CWD_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    if (process.platform === 'win32') {
      // Node exec() uses cmd.exe on Windows. A temp .cmd keeps command lines sequential,
      // so cd/chdir effects are visible to the final `cd` probe instead of being
      // expanded before execution by `cmd /c`.
      const scriptPath = path.join(os.tmpdir(), `xiaoba-shell-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cmd`);
      fs.writeFileSync(scriptPath, [
        '@echo off',
        command,
        'set "__XIAOBA_STATUS__=%ERRORLEVEL%"',
        `if "%__XIAOBA_STATUS__%"=="0" echo ${marker}`,
        'if "%__XIAOBA_STATUS__%"=="0" cd',
        'exit /b %__XIAOBA_STATUS__%',
      ].join('\r\n'), 'utf-8');
      return {
        marker,
        command: `"${scriptPath}"`,
        scriptPath,
      };
    }

    return {
      marker,
      command: [
        command,
        'status=$?',
        // POSIX sh-compatible probe for Linux/macOS. Node exec() uses /bin/sh here.
        `if [ "$status" -eq 0 ]; then printf '\\n${marker}=%s\\n' "$PWD"; fi`,
        'exit "$status"',
      ].join('\n'),
    };
  }

  private cleanupWrappedCommand(wrapped: WrappedCommand): void {
    if (!wrapped.scriptPath) return;
    try {
      if (fs.existsSync(wrapped.scriptPath)) fs.unlinkSync(wrapped.scriptPath);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private extractDirectoryProbe(output: string, marker: string): { output: string; directory?: string } {
    const lines = output.split(/\r?\n/);
    let directory: string | undefined;
    let takeNextLineAsDirectory = false;
    const visibleLines = lines.filter(line => {
      if (takeNextLineAsDirectory) {
        directory = line.trim();
        takeNextLineAsDirectory = false;
        return false;
      }
      if (line.trim() === marker) {
        takeNextLineAsDirectory = true;
        return false;
      }
      if (!line.startsWith(`${marker}=`)) return true;
      directory = line.slice(marker.length + 1).trim();
      return false;
    });
    return {
      output: visibleLines.join('\n').replace(/\n+$/, ''),
      directory,
    };
  }

  private stripAnyDirectoryProbe(output: string): string {
    return String(output || '')
      .split(/\r?\n/)
      .filter(line => !line.startsWith(CWD_MARKER_PREFIX))
      .join('\n')
      .replace(/\n+$/, '');
  }

  private updateCurrentDirectory(directory: string | undefined, context: ToolExecutionContext): void {
    if (!directory) return;
    const resolved = path.resolve(directory);
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
      context.updateCurrentDirectory?.(resolved);
    } catch {
      return;
    }
  }
}
