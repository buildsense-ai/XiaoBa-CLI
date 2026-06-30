import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { TextDecoder } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

const execAsync = promisify(exec);
const CWD_MARKER_PREFIX = '__XIAOBA_CWD_MARKER__';

interface WrappedCommand {
  command: string;
  marker: string;
  cwdFilePath?: string;
  powershellScript?: string;
  cmdScript?: string;
}

interface ShellOutput {
  stdout: string;
  stderr: string;
}

export class ShellTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_shell',
    description: [
      '执行一条非交互式系统命令。',
      '命令从当前目录或显式 cwd 启动；每次调用都是新的 shell 进程，只有最终当前目录会保留到后续工具调用。',
      '环境变量、alias、函数和已激活虚拟环境不会自动跨调用保留；需要时在同一条 command 中显式设置。',
      '在 CatsCo/远程用户设备场景中，不要用它做普通文件查看或创建；查看文件列表用 glob，创建/覆盖文本文件用 write_file，编辑文件用 edit_file。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的完整命令。避免需要人工交互的命令。',
        },
        description: {
          type: 'string',
          description: '可选。对这条命令用途的一句话说明，用于日志展示。',
        },
        timeout: {
          type: 'number',
          description: '超时时间，单位毫秒。默认 30000。',
        },
        cwd: {
          type: 'string',
          description: '可选。命令启动目录。支持绝对路径或相对当前目录的路径；需要在桌面/下载等目录运行命令时，先用 resolve_common_directory 解析，再把返回的 path 传给 cwd。',
        },
        confirm_dangerous: {
          type: 'boolean',
          description: 'Set true only after the user explicitly requested or confirmed a risky destructive command such as recursive deletion, git reset --hard, git clean, or force push.',
          default: false,
        },
        target: targetParameterDescription(),
      },
      required: ['command'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { command, description, timeout = 30000, confirm_dangerous = false, cwd } = args;

    if (context.abortSignal?.aborted) {
      return { ok: false, errorCode: 'EXECUTION_TIMEOUT', message: `命令已取消，未开始执行:\n$ ${command}` };
    }

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'execute_shell',
      target: args.target,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const remoteResult = await executeRouteIfRemote(context, route, 'execute_shell', 'execute_shell', args);
    if (remoteResult) return remoteResult;

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Execution blocked: ${toolPermission.reason}` };
    }

    const commandPermission = isBashCommandAllowed(command, {
      confirmed: context.deviceRpcReceiver || confirm_dangerous === true,
      env: context.deviceRpcReceiver
        ? { ...process.env, GAUZ_BASH_ALLOW_DANGEROUS: 'true' }
        : process.env,
    });
    if (!commandPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Execution blocked: ${commandPermission.reason}` };
    }

    if (description) {
      Logger.info(`Executing command: ${description}`);
    }
    const executionDirectory = this.resolveExecutionDirectory(cwd, context);
    if (!executionDirectory.ok) return executionDirectory;

    Logger.info(`$ ${command}`);
    Logger.info(`Current directory: ${executionDirectory.directory}`);

    const startTime = Date.now();
    const runtimeEnvironment = resolveRuntimeEnvironment({
      env: process.env,
      probeVersion: false,
    });
    const wrapped = this.wrapCommandWithDirectoryProbe(command);

    try {
      const { stdout, stderr } = await this.executeWrappedCommand(
        wrapped,
        executionDirectory.directory,
        runtimeEnvironment.env,
        timeout,
        context.abortSignal,
      );

      const parsedStdout = this.extractDirectoryProbe(stdout || '', wrapped.marker);
      const parsedStderr = this.extractDirectoryProbe(stderr || '', wrapped.marker);
      const finalDirectory = this.readDirectoryProbe(wrapped) || parsedStdout.directory || parsedStderr.directory;
      this.updateCurrentDirectory(
        finalDirectory,
        context,
      );

      const output = parsedStdout.output || '';
      if (parsedStderr.output) {
        Logger.warning(`stderr: ${parsedStderr.output.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputLines = output ? output.split('\n').length : 0;
      const outputSize = Buffer.byteLength(output, 'utf-8');

      Logger.success(`Command succeeded (elapsed: ${executionTime}ms)`);
      Logger.info(`  Output: ${outputLines} lines | ${(outputSize / 1024).toFixed(2)} KB`);

      if (outputLines > 20) {
        const previewLines = output.split('\n').slice(0, 10);
        Logger.info('  Output preview (first 10 lines):');
        previewLines.forEach(line => {
          const displayLine = line.length > 100 ? line.substring(0, 97) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        Logger.info(`    ... (${outputLines - 10} more lines)`);
      }

      return {
        ok: true,
        content: [
          'Command succeeded:',
          `$ ${command}`,
          '',
          `Working directory: ${executionDirectory.directory}`,
          finalDirectory ? `Final cwd: ${finalDirectory}` : '',
          `Shell: ${this.resolveShellDisplayName()}`,
          `Elapsed: ${executionTime}ms`,
          `Output lines: ${outputLines}`,
          '',
          output,
        ].filter(line => line !== '').join('\n'),
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const parsedStdout = this.extractDirectoryProbe(error.stdout || '', wrapped.marker);
      const parsedStderr = this.extractDirectoryProbe(error.stderr || '', wrapped.marker);
      const finalDirectory = this.readDirectoryProbe(wrapped) || parsedStdout.directory || parsedStderr.directory;
      this.updateCurrentDirectory(
        finalDirectory,
        context,
      );
      if (context.abortSignal?.aborted || /aborted|abort/i.test(String(error.message || ''))) {
        Logger.warning(`命令已取消 (耗时: ${executionTime}ms)`);
        return {
          ok: false,
          errorCode: 'EXECUTION_TIMEOUT',
          message: [
            '命令已取消:',
            `$ ${command}`,
            '',
            `Working directory: ${executionDirectory.directory}`,
            finalDirectory ? `Final cwd: ${finalDirectory}` : '',
            `Shell: ${this.resolveShellDisplayName()}`,
            `执行时间: ${executionTime}ms`,
          ].filter(line => line !== '').join('\n'),
        };
      }
      const errorOutput = [
        parsedStderr.output,
        parsedStdout.output,
        this.formatExecutionError(error),
      ].filter(Boolean).join('\n').trim();

      Logger.error(`Command failed (elapsed: ${executionTime}ms)`);
      Logger.error(`  Error: ${error.message}`);

      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: [
          'Command failed:',
          `$ ${command}`,
          '',
          `Working directory: ${executionDirectory.directory}`,
          finalDirectory ? `Final cwd: ${finalDirectory}` : '',
          `Shell: ${this.resolveShellDisplayName()}`,
          `Elapsed: ${executionTime}ms`,
          'Error:',
          errorOutput,
        ].filter(line => line !== '').join('\n'),
      };
    } finally {
      this.cleanupWrappedCommand(wrapped);
    }
  }

  private wrapCommandWithDirectoryProbe(command: string): WrappedCommand {
    const marker = `${CWD_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    if (process.platform === 'win32') {
      const cwdFilePath = path.join(os.tmpdir(), `xiaoba-shell-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      return {
        command,
        marker,
        cwdFilePath,
        powershellScript: this.buildPowerShellScript(command, cwdFilePath),
        cmdScript: this.buildCmdScript(command, cwdFilePath),
      };
    }

    return {
      command: [
        command,
        'status=$?',
        // POSIX sh-compatible probe for Linux/macOS. Node exec() uses /bin/sh here.
        `printf '\\n${marker}=%s\\n' "$PWD"`,
        'exit "$status"',
      ].join('\n'),
      marker,
    };
  }

  private buildPowerShellScript(command: string, cwdFilePath: string): string {
    const escapedCwdFilePath = cwdFilePath.replace(/'/g, "''");
    return [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '$ErrorActionPreference = "Stop"',
      '$ProgressPreference = "SilentlyContinue"',
      '$env:PYTHONIOENCODING = "utf-8"',
      '$env:PYTHONUTF8 = "1"',
      '$__xiaoba_status = 0',
      'try {',
      command,
      '  if ($global:LASTEXITCODE -is [int]) { $__xiaoba_status = $global:LASTEXITCODE }',
      '} catch {',
      '  [Console]::Error.WriteLine([string]$_)',
      '  $__xiaoba_status = 1',
      '} finally {',
      `  (Get-Location).ProviderPath | Set-Content -LiteralPath '${escapedCwdFilePath}' -Encoding UTF8`,
      '}',
      'exit $__xiaoba_status',
    ].join('\r\n');
  }

  private buildCmdScript(command: string, cwdFilePath: string): string {
    return [
      '@echo off',
      'chcp 65001 >nul',
      command,
      'set "__XIAOBA_STATUS__=%ERRORLEVEL%"',
      `cd > "${cwdFilePath.replace(/"/g, '""')}"`,
      'exit /b %__XIAOBA_STATUS__%',
    ].join('\r\n');
  }

  private async executeWrappedCommand(
    wrapped: WrappedCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ShellOutput> {
    if (process.platform !== 'win32') {
      return execAsync(wrapped.command, {
        cwd,
        env,
        encoding: 'utf-8',
        timeout,
        signal,
        killSignal: 'SIGTERM',
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    try {
      return await this.executeWindowsPowerShellScript(wrapped, cwd, env, timeout, signal);
    } catch (error) {
      if (!this.isPowerShellLaunchFailure(error)) throw error;
      return this.executeWindowsCmdFallback(wrapped, cwd, env, timeout);
    }
  }

  private executeWindowsPowerShellScript(
    wrapped: WrappedCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ShellOutput> {
    const powershellScript = wrapped.powershellScript;
    if (!powershellScript) {
      return Promise.reject(new Error('Internal error: missing Windows PowerShell script'));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Command aborted by user'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(powershellScript, 'utf16le').toString('base64'),
      ], {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ReturnType<typeof spawn>;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBuffer = 10 * 1024 * 1024;
      let timer: NodeJS.Timeout;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        fn();
      };

      const fail = (error: any) => {
        finish(() => {
          try { child.kill(); } catch {}
          error.stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
          error.stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
          reject(error);
        });
      };

      timer = setTimeout(() => {
        timedOut = true;
        fail(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);
      const abortHandler = () => {
        fail(new Error('Command aborted by user'));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          fail(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          fail(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        fail(error);
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        const stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
        const stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
        finish(() => {
          if (timedOut) return;
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(`Command failed with exit code ${code}`);
          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
    });
  }

  private executeWindowsCmdFallback(
    wrapped: WrappedCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
  ): Promise<ShellOutput> {
    const cmdScript = wrapped.cmdScript;
    if (!cmdScript) {
      return Promise.reject(new Error('Internal error: missing Windows cmd script'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/q'], {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBuffer = 10 * 1024 * 1024;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const fail = (error: any) => {
        finish(() => {
          try { child.kill(); } catch {}
          error.stdout = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stdoutChunks)));
          error.stderr = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stderrChunks)));
          reject(error);
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        fail(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          fail(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          fail(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        fail(error);
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        const stdout = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stdoutChunks)));
        const stderr = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stderrChunks)));
        finish(() => {
          if (timedOut) return;
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(`Command failed with exit code ${code}`);
          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });

      child.stdin.end(cmdScript + '\r\n');
    });
  }

  private isPowerShellLaunchFailure(error: any): boolean {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    return code === 'ENOENT' || message.includes('ENOENT') || message.includes('spawn powershell.exe');
  }

  private decodeWindowsOutput(buffer: Buffer): string {
    const utf8 = new TextDecoder('utf-8').decode(buffer);
    if (!utf8.includes('\uFFFD')) return utf8;

    try {
      const gb18030 = new TextDecoder('gb18030').decode(buffer);
      if (this.countReplacementChars(gb18030) < this.countReplacementChars(utf8)) {
        return gb18030;
      }
    } catch {
      return utf8;
    }

    return utf8;
  }

  private countReplacementChars(value: string): number {
    return (value.match(/\uFFFD/g) || []).length;
  }

  private stripCmdSessionNoise(output: string): string {
    return String(output || '')
      .split(/\r?\n/)
      .map(line => line.replace(/^[A-Za-z]:\\[^>\r\n]*>/, ''))
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (/^Microsoft Windows \[/.test(trimmed)) return false;
        if (/Microsoft Corporation/i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .replace(/\n+$/, '');
  }

  private cleanupWrappedCommand(wrapped: WrappedCommand): void {
    if (wrapped.cwdFilePath) {
      try {
        if (fs.existsSync(wrapped.cwdFilePath)) fs.unlinkSync(wrapped.cwdFilePath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private readDirectoryProbe(wrapped: WrappedCommand): string | undefined {
    if (!wrapped.cwdFilePath) return undefined;
    try {
      if (!fs.existsSync(wrapped.cwdFilePath)) return undefined;
      return fs.readFileSync(wrapped.cwdFilePath, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      return undefined;
    }
  }

  private extractDirectoryProbe(output: string, marker: string): { output: string; directory?: string } {
    const lines = output.split(/\r?\n/);
    let directory: string | undefined;
    const visibleLines = lines.filter(line => {
      if (!line.startsWith(`${marker}=`)) return true;
      directory = line.slice(marker.length + 1).trim();
      return false;
    });
    return {
      output: visibleLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
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

  private resolveExecutionDirectory(
    cwd: unknown,
    context: ToolExecutionContext,
  ): { ok: true; directory: string } | { ok: false; errorCode: 'INVALID_TOOL_ARGUMENTS'; message: string } {
    if (cwd === undefined || cwd === null || cwd === '') {
      return { ok: true, directory: context.workingDirectory };
    }
    if (typeof cwd !== 'string') {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'execute_shell.cwd 必须是字符串路径。',
      };
    }
    const directory = path.isAbsolute(cwd)
      ? path.resolve(cwd)
      : path.resolve(context.workingDirectory, cwd);
    try {
      if (!fs.existsSync(directory)) {
        return {
          ok: false,
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          message: `execute_shell.cwd 不存在: ${directory}`,
        };
      }
      if (!fs.statSync(directory).isDirectory()) {
        return {
          ok: false,
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          message: `execute_shell.cwd 不是目录: ${directory}`,
        };
      }
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: `execute_shell.cwd 无法访问: ${error?.message || error}`,
      };
    }
    return { ok: true, directory };
  }

  private resolveShellDisplayName(): string {
    return process.platform === 'win32' ? 'powershell' : 'sh';
  }

  private formatExecutionError(error: any): string {
    if (typeof error?.code === 'number') {
      return `Command failed with exit code ${error.code}`;
    }
    if (error?.code) {
      return `Command failed: ${error.code}`;
    }
    if (error?.signal) {
      return `Command terminated by signal ${error.signal}`;
    }
    return this.stripAnyDirectoryProbe(String(error?.message || error || 'Command failed'));
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
