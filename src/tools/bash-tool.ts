import { spawn, type ChildProcess } from 'child_process';
import { TextDecoder } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

const CWD_MARKER_PREFIX = '__XIAOBA_CWD_MARKER__';
const SHELL_CONTRACT_VERSION = 'shell/v1';
const SHELL_INLINE_OUTPUT_MAX_CHARS = 30_000;
const SHELL_ARTIFACT_DIR = 'tool-results';

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

type ShellRunStatus = 'succeeded' | 'failed' | 'timed_out' | 'aborted';

interface ShellRunResult {
  command: string;
  description?: string;
  status: ShellRunStatus;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
  cwdBefore: string;
  cwdAfter: string;
  stdout: string;
  stderr: string;
  stdoutLines?: number;
  stderrLines?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  errorMessage?: string;
  truncated: boolean;
  truncatedReason?: string;
  inlineOutputChars?: number;
  originalOutputChars?: number;
  outputArtifact?: string;
  artifactError?: string;
}

interface ShellOutputPresentation {
  stdout: string;
  stderr: string;
  stdoutLines: number;
  stderrLines: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  truncatedReason?: string;
  inlineOutputChars: number;
  originalOutputChars: number;
  outputArtifact?: string;
  artifactError?: string;
}

export class ShellTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_shell',
    description: [
      '执行一条非交互式系统命令，适合运行测试、构建、包管理器、系统诊断或项目脚本。',
      '路径发现、目录概览和候选文件定位优先使用 glob；内容搜索使用 grep；读取已定位文件使用 read_file。',
      'Windows 目标上 command 会作为 PowerShell 脚本执行，可直接写多行 PowerShell，无需再套一层 powershell -Command。',
      '命令从当前目录启动；每次调用都是新的 shell 进程，只有最终当前目录会保留到后续工具调用。',
      '环境变量、alias、函数和已激活虚拟环境不会自动跨调用保留；需要时在同一条 command 中显式设置。',
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
          description: 'Optional command start directory. Supports absolute paths or paths relative to the current working directory.',
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
    let cwdBefore = context.workingDirectory;

    if (context.abortSignal?.aborted) {
      return {
        ok: false,
        errorCode: 'EXECUTION_TIMEOUT',
        message: this.formatShellRunResult({
          command,
          description,
          status: 'aborted',
          timedOut: false,
          timeoutMs: timeout,
          durationMs: 0,
          cwdBefore,
          cwdAfter: cwdBefore,
          stdout: '',
          stderr: '',
          stdoutLines: 0,
          stderrLines: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          errorMessage: 'Command aborted before execution',
          truncated: false,
          inlineOutputChars: 0,
          originalOutputChars: 0,
        }),
      };
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
    cwdBefore = executionDirectory.directory;

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
      const cwdAfter = this.updateCurrentDirectory(
        this.readDirectoryProbe(wrapped) || parsedStdout.directory || parsedStderr.directory,
        context,
      ) || cwdBefore;

      const stdoutOutput = parsedStdout.output || '';
      const stderrOutput = parsedStderr.output || '';
      if (stderrOutput) {
        Logger.warning(`stderr: ${stderrOutput.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputPresentation = this.prepareShellOutputPresentation(stdoutOutput, stderrOutput, context, {
        command,
        description,
        status: 'succeeded',
        cwdBefore,
        cwdAfter,
        durationMs: executionTime,
      });
      const outputLines = outputPresentation.stdoutLines + outputPresentation.stderrLines;
      const outputSize = outputPresentation.stdoutBytes + outputPresentation.stderrBytes;

      Logger.success(`Command succeeded (elapsed: ${executionTime}ms)`);
      Logger.info(`  Output: ${outputLines} lines | ${(outputSize / 1024).toFixed(2)} KB`);

      if (outputLines > 20) {
        const previewLines = [outputPresentation.stdout, outputPresentation.stderr].filter(Boolean).join('\n').split('\n').slice(0, 10);
        Logger.info('  Output preview (first 10 lines):');
        previewLines.forEach(line => {
          const displayLine = line.length > 100 ? line.substring(0, 97) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        Logger.info(`    ... (${outputLines - 10} more lines)`);
      }

      return {
        ok: true,
        content: this.formatShellRunResult({
          command,
          description,
          status: 'succeeded',
          exitCode: 0,
          timedOut: false,
          timeoutMs: timeout,
          durationMs: executionTime,
          cwdBefore,
          cwdAfter,
          stdout: outputPresentation.stdout,
          stderr: outputPresentation.stderr,
          stdoutLines: outputPresentation.stdoutLines,
          stderrLines: outputPresentation.stderrLines,
          stdoutBytes: outputPresentation.stdoutBytes,
          stderrBytes: outputPresentation.stderrBytes,
          truncated: outputPresentation.truncated,
          truncatedReason: outputPresentation.truncatedReason,
          inlineOutputChars: outputPresentation.inlineOutputChars,
          originalOutputChars: outputPresentation.originalOutputChars,
          outputArtifact: outputPresentation.outputArtifact,
          artifactError: outputPresentation.artifactError,
        }),
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const parsedStdout = this.extractDirectoryProbe(error.stdout || '', wrapped.marker);
      const parsedStderr = this.extractDirectoryProbe(error.stderr || '', wrapped.marker);
      const cwdAfter = this.updateCurrentDirectory(
        this.readDirectoryProbe(wrapped) || parsedStdout.directory || parsedStderr.directory,
        context,
      ) || cwdBefore;
      const aborted = context.abortSignal?.aborted || /aborted|abort/i.test(String(error.message || ''));
      const timedOut = !aborted && this.isTimeoutError(error);
      if (aborted || timedOut) {
        const stdoutOutput = parsedStdout.output || '';
        const stderrOutput = parsedStderr.output || '';
        const outputPresentation = this.prepareShellOutputPresentation(stdoutOutput, stderrOutput, context, {
          command,
          description,
          status: aborted ? 'aborted' : 'timed_out',
          cwdBefore,
          cwdAfter,
          durationMs: executionTime,
        });
        return {
          ok: false,
          errorCode: 'EXECUTION_TIMEOUT',
          message: this.formatShellRunResult({
            command,
            description,
            status: aborted ? 'aborted' : 'timed_out',
            signal: typeof error.signal === 'string' ? error.signal : undefined,
            timedOut,
            timeoutMs: timeout,
            durationMs: executionTime,
            cwdBefore,
            cwdAfter,
            stdout: outputPresentation.stdout,
            stderr: outputPresentation.stderr,
            stdoutLines: outputPresentation.stdoutLines,
            stderrLines: outputPresentation.stderrLines,
            stdoutBytes: outputPresentation.stdoutBytes,
            stderrBytes: outputPresentation.stderrBytes,
            errorMessage: this.formatExecutionError(error),
            truncated: outputPresentation.truncated,
            truncatedReason: outputPresentation.truncatedReason,
            inlineOutputChars: outputPresentation.inlineOutputChars,
            originalOutputChars: outputPresentation.originalOutputChars,
            outputArtifact: outputPresentation.outputArtifact,
            artifactError: outputPresentation.artifactError,
          }),
        };
      }
      const stdoutOutput = parsedStdout.output || '';
      const stderrOutput = parsedStderr.output || '';
      const outputPresentation = this.prepareShellOutputPresentation(stdoutOutput, stderrOutput, context, {
        command,
        description,
        status: 'failed',
        cwdBefore,
        cwdAfter,
        durationMs: executionTime,
      });
      const exitCode = typeof error.code === 'number' ? error.code : undefined;
      const signal = typeof error.signal === 'string' ? error.signal : undefined;

      Logger.error(`Command failed (elapsed: ${executionTime}ms)`);
      Logger.error(`  Error: ${error.message}`);

      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: this.formatShellRunResult({
          command,
          description,
          status: 'failed',
          exitCode,
          signal,
          timedOut: false,
          timeoutMs: timeout,
          durationMs: executionTime,
          cwdBefore,
          cwdAfter,
          stdout: outputPresentation.stdout,
          stderr: outputPresentation.stderr,
          stdoutLines: outputPresentation.stdoutLines,
          stderrLines: outputPresentation.stderrLines,
          stdoutBytes: outputPresentation.stdoutBytes,
          stderrBytes: outputPresentation.stderrBytes,
          errorMessage: this.formatExecutionError(error),
          truncated: outputPresentation.truncated,
          truncatedReason: outputPresentation.truncatedReason,
          inlineOutputChars: outputPresentation.inlineOutputChars,
          originalOutputChars: outputPresentation.originalOutputChars,
          outputArtifact: outputPresentation.outputArtifact,
          artifactError: outputPresentation.artifactError,
        }),
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
      return this.executePosixShellScript(wrapped, cwd, env, timeout, signal);
    }

    try {
      return await this.executeWindowsPowerShellScript(wrapped, cwd, env, timeout, signal);
    } catch (error) {
      if (!this.isPowerShellLaunchFailure(error)) throw error;
      return this.executeWindowsCmdFallback(wrapped, cwd, env, timeout, signal);
    }
  }

  private executePosixShellScript(
    wrapped: WrappedCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ShellOutput> {
    if (signal?.aborted) {
      return Promise.reject(this.createShellAbortError());
    }

    const shell = this.resolvePosixShell(env) || '/bin/sh';
    return new Promise((resolve, reject) => {
      const child = spawn(shell, ['-c', wrapped.command], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let pendingFailure: any;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBuffer = 10 * 1024 * 1024;
      let timer: NodeJS.Timeout | undefined;
      let closeWaitTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (closeWaitTimer) clearTimeout(closeWaitTimer);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const rejectWithOutput = (error: any) => {
        settle(() => {
          error.stdout = Buffer.concat(stdoutChunks).toString('utf8');
          error.stderr = Buffer.concat(stderrChunks).toString('utf8');
          reject(error);
        });
      };

      const failAfterClose = (error: any) => {
        if (settled) return;
        if (pendingFailure) return;
        pendingFailure = error;
        this.terminateProcessTree(child);
        closeWaitTimer = setTimeout(() => {
          rejectWithOutput(error);
        }, 5000);
        closeWaitTimer.unref?.();
      };

      timer = setTimeout(() => {
        failAfterClose(this.createShellTimeoutError(timeout));
      }, timeout);
      timer.unref?.();

      abortHandler = () => {
        failAfterClose(this.createShellAbortError());
      };
      if (signal?.aborted) {
        abortHandler();
      } else {
        signal?.addEventListener('abort', abortHandler, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          failAfterClose(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          failAfterClose(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        rejectWithOutput(error);
      });

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        settle(() => {
          if (pendingFailure) {
            if (closeSignal) pendingFailure.signal = closeSignal;
            pendingFailure.stdout = stdout;
            pendingFailure.stderr = stderr;
            reject(pendingFailure);
            return;
          }
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(code !== null
            ? `Command failed with exit code ${code}`
            : `Command terminated by signal ${closeSignal || 'unknown'}`);
          if (code !== null) error.code = code;
          if (closeSignal) error.signal = closeSignal;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
    });
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
      return Promise.reject(this.createShellAbortError());
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
      let pendingFailure: any;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBuffer = 10 * 1024 * 1024;
      let timer: NodeJS.Timeout | undefined;
      let closeWaitTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (closeWaitTimer) clearTimeout(closeWaitTimer);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const rejectWithOutput = (error: any) => {
        settle(() => {
          error.stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
          error.stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
          reject(error);
        });
      };

      const failAfterClose = (error: any) => {
        if (settled) return;
        if (pendingFailure) return;
        pendingFailure = error;
        this.terminateProcessTree(child);
        closeWaitTimer = setTimeout(() => {
          rejectWithOutput(error);
        }, 5000);
        closeWaitTimer.unref?.();
      };

      timer = setTimeout(() => {
        failAfterClose(this.createShellTimeoutError(timeout));
      }, timeout);
      timer.unref?.();

      abortHandler = () => {
        failAfterClose(this.createShellAbortError());
      };
      if (signal?.aborted) {
        abortHandler();
      } else {
        signal?.addEventListener('abort', abortHandler, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          failAfterClose(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          failAfterClose(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        rejectWithOutput(error);
      });

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        const stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
        const stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
        settle(() => {
          if (pendingFailure) {
            if (closeSignal) pendingFailure.signal = closeSignal;
            pendingFailure.stdout = stdout;
            pendingFailure.stderr = stderr;
            reject(pendingFailure);
            return;
          }
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(`Command failed with exit code ${code}`);
          if (code !== null) error.code = code;
          if (closeSignal) error.signal = closeSignal;
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
    signal?: AbortSignal,
  ): Promise<ShellOutput> {
    const cmdScript = wrapped.cmdScript;
    if (!cmdScript) {
      return Promise.reject(new Error('Internal error: missing Windows cmd script'));
    }
    if (signal?.aborted) {
      return Promise.reject(this.createShellAbortError());
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
      let pendingFailure: any;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBuffer = 10 * 1024 * 1024;
      let closeWaitTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        clearTimeout(timer);
        if (closeWaitTimer) clearTimeout(closeWaitTimer);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const rejectWithOutput = (error: any) => {
        settle(() => {
          error.stdout = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stdoutChunks)));
          error.stderr = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stderrChunks)));
          reject(error);
        });
      };

      const failAfterClose = (error: any) => {
        if (settled) return;
        if (pendingFailure) return;
        pendingFailure = error;
        this.terminateProcessTree(child);
        closeWaitTimer = setTimeout(() => {
          rejectWithOutput(error);
        }, 5000);
        closeWaitTimer.unref?.();
      };

      const timer = setTimeout(() => {
        failAfterClose(this.createShellTimeoutError(timeout));
      }, timeout);
      timer.unref?.();

      abortHandler = () => {
        failAfterClose(this.createShellAbortError());
      };
      if (signal?.aborted) {
        abortHandler();
      } else {
        signal?.addEventListener('abort', abortHandler, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          failAfterClose(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          failAfterClose(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`));
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        rejectWithOutput(error);
      });

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        const stdout = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stdoutChunks)));
        const stderr = this.stripCmdSessionNoise(this.decodeWindowsOutput(Buffer.concat(stderrChunks)));
        settle(() => {
          if (pendingFailure) {
            if (closeSignal) pendingFailure.signal = closeSignal;
            pendingFailure.stdout = stdout;
            pendingFailure.stderr = stderr;
            reject(pendingFailure);
            return;
          }
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(`Command failed with exit code ${code}`);
          if (code !== null) error.code = code;
          if (closeSignal) error.signal = closeSignal;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });

      child.stdin.end(cmdScript + '\r\n');
    });
  }

  private createShellTimeoutError(timeout: number): Error {
    const error: any = new Error(`Command timed out after ${timeout}ms`);
    error.code = 'ETIMEDOUT';
    error.timedOut = true;
    return error;
  }

  private createShellAbortError(): Error {
    const error: any = new Error('Command aborted by user');
    error.code = 'ABORT_ERR';
    error.aborted = true;
    return error;
  }

  private terminateProcessTree(child: ChildProcess): void {
    if (!child.pid) {
      try { child.kill(); } catch {}
      return;
    }

    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          try { child.kill(); } catch {}
        });
      } catch {
        try { child.kill(); } catch {}
      }
      return;
    }

    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
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

  private prepareShellOutputPresentation(
    stdout: string,
    stderr: string,
    context: ToolExecutionContext,
    metadata: {
      command: string;
      description?: string;
      status: ShellRunStatus;
      cwdBefore: string;
      cwdAfter: string;
      durationMs: number;
    },
  ): ShellOutputPresentation {
    const stdoutOutput = String(stdout || '');
    const stderrOutput = String(stderr || '');
    const stdoutBytes = Buffer.byteLength(stdoutOutput, 'utf-8');
    const stderrBytes = Buffer.byteLength(stderrOutput, 'utf-8');
    const originalOutputChars = stdoutOutput.length + stderrOutput.length;

    if (originalOutputChars <= SHELL_INLINE_OUTPUT_MAX_CHARS) {
      return {
        stdout: stdoutOutput,
        stderr: stderrOutput,
        stdoutLines: this.countOutputLines(stdoutOutput),
        stderrLines: this.countOutputLines(stderrOutput),
        stdoutBytes,
        stderrBytes,
        truncated: false,
        inlineOutputChars: originalOutputChars,
        originalOutputChars,
      };
    }

    let outputArtifact: string | undefined;
    let artifactError: string | undefined;
    try {
      outputArtifact = this.writeShellOutputArtifact(stdoutOutput, stderrOutput, context, metadata);
    } catch (error: any) {
      artifactError = String(error?.message || error || 'failed to write shell output artifact');
    }

    const budgets = this.allocateInlineOutputBudgets(stdoutOutput.length, stderrOutput.length);
    const previewStdout = this.buildOutputPreview(stdoutOutput, budgets.stdout);
    const previewStderr = this.buildOutputPreview(stderrOutput, budgets.stderr);

    return {
      stdout: previewStdout,
      stderr: previewStderr,
      stdoutLines: this.countOutputLines(stdoutOutput),
      stderrLines: this.countOutputLines(stderrOutput),
      stdoutBytes,
      stderrBytes,
      truncated: true,
      truncatedReason: 'output_exceeded_inline_limit',
      inlineOutputChars: previewStdout.length + previewStderr.length,
      originalOutputChars,
      outputArtifact,
      artifactError,
    };
  }

  private writeShellOutputArtifact(
    stdout: string,
    stderr: string,
    context: ToolExecutionContext,
    metadata: {
      command: string;
      description?: string;
      status: ShellRunStatus;
      cwdBefore: string;
      cwdAfter: string;
      durationMs: number;
    },
  ): string {
    const root = path.resolve(context.workspaceRoot || context.workingDirectory || process.cwd());
    const dir = path.join(root, SHELL_ARTIFACT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.log`);
    const content = [
      'Shell output artifact',
      `contract_version: ${SHELL_CONTRACT_VERSION}`,
      `status: ${metadata.status}`,
      `command: ${this.formatHeaderValue(metadata.command)}`,
      metadata.description ? `description: ${this.formatHeaderValue(metadata.description)}` : '',
      `duration_ms: ${metadata.durationMs}`,
      `cwd_before: ${metadata.cwdBefore}`,
      `cwd_after: ${metadata.cwdAfter}`,
      `stdout_bytes: ${Buffer.byteLength(stdout, 'utf-8')}`,
      `stderr_bytes: ${Buffer.byteLength(stderr, 'utf-8')}`,
      '',
      'stdout:',
      stdout || '(empty)',
      '',
      'stderr:',
      stderr || '(empty)',
    ].filter(line => line !== '').join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  private allocateInlineOutputBudgets(stdoutChars: number, stderrChars: number): { stdout: number; stderr: number } {
    const total = stdoutChars + stderrChars;
    if (total <= SHELL_INLINE_OUTPUT_MAX_CHARS) {
      return { stdout: stdoutChars, stderr: stderrChars };
    }
    if (stdoutChars <= 0) return { stdout: 0, stderr: SHELL_INLINE_OUTPUT_MAX_CHARS };
    if (stderrChars <= 0) return { stdout: SHELL_INLINE_OUTPUT_MAX_CHARS, stderr: 0 };

    const minimumStreamBudget = Math.min(4000, Math.floor(SHELL_INLINE_OUTPUT_MAX_CHARS / 4));
    let stdoutBudget = Math.floor(SHELL_INLINE_OUTPUT_MAX_CHARS * (stdoutChars / total));
    stdoutBudget = Math.max(minimumStreamBudget, Math.min(stdoutChars, stdoutBudget));
    let stderrBudget = SHELL_INLINE_OUTPUT_MAX_CHARS - stdoutBudget;

    if (stderrBudget < minimumStreamBudget) {
      stderrBudget = Math.min(stderrChars, minimumStreamBudget);
      stdoutBudget = SHELL_INLINE_OUTPUT_MAX_CHARS - stderrBudget;
    }
    if (stdoutBudget > stdoutChars) {
      stderrBudget = Math.min(stderrChars, stderrBudget + (stdoutBudget - stdoutChars));
      stdoutBudget = stdoutChars;
    }
    if (stderrBudget > stderrChars) {
      stdoutBudget = Math.min(stdoutChars, stdoutBudget + (stderrBudget - stderrChars));
      stderrBudget = stderrChars;
    }

    return { stdout: Math.max(0, stdoutBudget), stderr: Math.max(0, stderrBudget) };
  }

  private buildOutputPreview(output: string, maxChars: number): string {
    if (!output || maxChars <= 0) return '';
    if (output.length <= maxChars) return output;

    const lines = output.split(/\r?\n/);
    const omittedLines = Math.max(0, lines.length - 120);
    const lineMarker = `\n\n... [${omittedLines} lines omitted, ${lines.length} lines total, ${output.length} chars total; full output saved as artifact] ...\n\n`;
    const linePreview = [
      ...lines.slice(0, 80),
      lineMarker.trim(),
      ...lines.slice(-40),
    ].join('\n');
    if (linePreview.length <= maxChars) return linePreview;

    const charMarker = `\n\n... [truncated, ${lines.length} lines total, ${output.length} chars total; full output saved as artifact] ...\n\n`;
    const available = maxChars - charMarker.length;
    if (available <= 0) return charMarker.trim().slice(0, maxChars);

    const headChars = Math.max(0, Math.floor(available * 0.7));
    const tailChars = Math.max(0, available - headChars);
    return `${output.slice(0, headChars)}${charMarker}${tailChars > 0 ? output.slice(-tailChars) : ''}`;
  }

  private formatShellRunResult(result: ShellRunResult): string {
    const stdoutLines = result.stdoutLines ?? this.countOutputLines(result.stdout);
    const stderrLines = result.stderrLines ?? this.countOutputLines(result.stderr);
    const stdoutBytes = result.stdoutBytes ?? Buffer.byteLength(result.stdout, 'utf-8');
    const stderrBytes = result.stderrBytes ?? Buffer.byteLength(result.stderr, 'utf-8');
    const header = [
      'Command completed',
      `contract_version: ${SHELL_CONTRACT_VERSION}`,
      `status: ${result.status}`,
      `command: ${this.formatHeaderValue(result.command)}`,
      result.description ? `description: ${this.formatHeaderValue(result.description)}` : '',
      result.exitCode !== undefined ? `exit_code: ${result.exitCode}` : 'exit_code:',
      result.signal ? `signal: ${result.signal}` : 'signal:',
      `timed_out: ${result.timedOut}`,
      `timeout_ms: ${result.timeoutMs}`,
      `duration_ms: ${result.durationMs}`,
      `cwd_before: ${result.cwdBefore}`,
      `cwd_after: ${result.cwdAfter}`,
      `stdout_lines: ${stdoutLines}`,
      `stderr_lines: ${stderrLines}`,
      `stdout_bytes: ${stdoutBytes}`,
      `stderr_bytes: ${stderrBytes}`,
      `truncated: ${result.truncated}`,
      result.truncatedReason ? `truncated_reason: ${result.truncatedReason}` : '',
      result.inlineOutputChars !== undefined ? `inline_output_chars: ${result.inlineOutputChars}` : '',
      result.originalOutputChars !== undefined ? `original_output_chars: ${result.originalOutputChars}` : '',
      result.outputArtifact ? `output_artifact: ${result.outputArtifact}` : '',
      result.artifactError ? `artifact_error: ${this.formatHeaderValue(result.artifactError)}` : '',
      result.errorMessage ? `error_message: ${this.formatHeaderValue(result.errorMessage)}` : '',
    ].filter(line => line !== '');

    return [
      ...header,
      '',
      'stdout:',
      result.stdout || '(empty)',
      '',
      'stderr:',
      result.stderr || '(empty)',
    ].join('\n');
  }

  private formatHeaderValue(value: string): string {
    return String(value || '').replace(/\r?\n/g, ' ; ');
  }

  private countOutputLines(output: string): number {
    return output ? output.split('\n').length : 0;
  }

  private resolvePosixShell(env: NodeJS.ProcessEnv): string | undefined {
    const candidates = [
      env.SHELL && path.basename(env.SHELL) === 'bash' ? env.SHELL : undefined,
      '/bin/bash',
      '/usr/bin/bash',
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      try {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
      } catch {
        // Fall through to the next candidate.
      }
    }
    return undefined;
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
        message: 'execute_shell.cwd must be a string path.',
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
          message: `execute_shell.cwd does not exist: ${directory}`,
        };
      }
      if (!fs.statSync(directory).isDirectory()) {
        return {
          ok: false,
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          message: `execute_shell.cwd is not a directory: ${directory}`,
        };
      }
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: `execute_shell.cwd is not accessible: ${error?.message || error}`,
      };
    }
    return { ok: true, directory };
  }

  private isTimeoutError(error: any): boolean {
    if (error?.timedOut === true) return true;
    const text = String(error?.message || error?.code || '').toLowerCase();
    return text.includes('timed out') || text.includes('timeout') || text === 'etimedout';
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

  private updateCurrentDirectory(directory: string | undefined, context: ToolExecutionContext): string | undefined {
    if (!directory) return undefined;
    const resolved = path.resolve(directory);
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
      context.updateCurrentDirectory?.(resolved);
      return resolved;
    } catch {
      return undefined;
    }
  }
}
