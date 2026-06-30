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
const SHELL_INLINE_OUTPUT_DECODE_MAX_BYTES = SHELL_INLINE_OUTPUT_MAX_CHARS * 4;
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
  stdoutFilePath?: string;
  stderrFilePath?: string;
  decoder?: ShellOutputDecoder;
  stripCmdNoise?: boolean;
}

type ShellOutputDecoder = 'utf8' | 'windows';

interface ShellTempOutputFiles {
  stdoutPath: string;
  stderrPath: string;
  stdoutFd: number;
  stderrFd: number;
}

interface FileBackedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
  stdin?: string;
  detached?: boolean;
  windowsHide?: boolean;
  decoder?: ShellOutputDecoder;
  stripCmdNoise?: boolean;
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

interface ShellOutputMetadata {
  command: string;
  description?: string;
  status: ShellRunStatus;
  cwdBefore: string;
  cwdAfter: string;
  durationMs: number;
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
      const shellOutput = await this.executeWrappedCommand(
        wrapped,
        executionDirectory.directory,
        runtimeEnvironment.env,
        timeout,
        context.abortSignal,
      );

      const parsedStdout = this.extractDirectoryProbe(shellOutput.stdout || '', wrapped.marker);
      const parsedStderr = this.extractDirectoryProbe(shellOutput.stderr || '', wrapped.marker);
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
      const outputPresentation = this.prepareShellOutputPresentationForShellOutput(shellOutput, stdoutOutput, stderrOutput, context, {
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
        const outputPresentation = this.prepareShellOutputPresentationForShellOutput(error, stdoutOutput, stderrOutput, context, {
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
      const outputPresentation = this.prepareShellOutputPresentationForShellOutput(error, stdoutOutput, stderrOutput, context, {
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

    const cwdFilePath = path.join(os.tmpdir(), `xiaoba-shell-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    return {
      command: [
        command,
        'status=$?',
        `printf '%s\\n' "$PWD" > ${this.quotePosixShellString(cwdFilePath)}`,
        'exit "$status"',
      ].join('\n'),
      marker,
      cwdFilePath,
    };
  }

  private quotePosixShellString(value: string): string {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
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
    const shell = this.resolvePosixShell(env) || '/bin/sh';
    return this.executeFileBackedProcess({
      command: shell,
      args: ['-c', wrapped.command],
      cwd,
      env,
      timeout,
      signal,
      detached: true,
      decoder: 'utf8',
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
    return this.executeFileBackedProcess({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(powershellScript, 'utf16le').toString('base64'),
      ],
      cwd,
      env,
      timeout,
      signal,
      windowsHide: true,
      decoder: 'windows',
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

    return this.executeFileBackedProcess({
      command: 'cmd.exe',
      args: ['/d', '/q'],
      cwd,
      env,
      timeout,
      signal,
      stdin: cmdScript + '\r\n',
      windowsHide: true,
      decoder: 'windows',
      stripCmdNoise: true,
    });
  }

  private executeFileBackedProcess(options: FileBackedProcessOptions): Promise<ShellOutput> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createShellAbortError());
    }

    const outputFiles = this.createShellTempOutputFiles();
    return new Promise((resolve, reject) => {
      const stdinMode = options.stdin !== undefined ? 'pipe' : 'ignore';
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          detached: options.detached,
          windowsHide: options.windowsHide,
          stdio: [stdinMode, outputFiles.stdoutFd, outputFiles.stderrFd] as any,
        });
      } catch (error) {
        this.closeShellTempOutputFiles(outputFiles);
        this.cleanupShellOutputFiles({
          stdoutFilePath: outputFiles.stdoutPath,
          stderrFilePath: outputFiles.stderrPath,
        });
        reject(error);
        return;
      }

      let settled = false;
      let pendingFailure: any;
      let timer: NodeJS.Timeout | undefined;
      let closeWaitTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (closeWaitTimer) clearTimeout(closeWaitTimer);
        if (options.signal && abortHandler) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        this.closeShellTempOutputFiles(outputFiles);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const outputResult = (): ShellOutput => ({
        stdout: '',
        stderr: '',
        stdoutFilePath: outputFiles.stdoutPath,
        stderrFilePath: outputFiles.stderrPath,
        decoder: options.decoder || 'utf8',
        stripCmdNoise: options.stripCmdNoise,
      });

      const attachOutput = (target: any) => {
        const output = outputResult();
        target.stdout = output.stdout;
        target.stderr = output.stderr;
        target.stdoutFilePath = output.stdoutFilePath;
        target.stderrFilePath = output.stderrFilePath;
        target.decoder = output.decoder;
        target.stripCmdNoise = output.stripCmdNoise;
      };

      const rejectWithoutOutput = (error: any) => {
        settle(() => {
          error.stdout = '';
          error.stderr = '';
          this.cleanupShellOutputFiles(outputResult());
          reject(error);
        });
      };

      const rejectWithOutput = (error: any) => {
        settle(() => {
          attachOutput(error);
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
        failAfterClose(this.createShellTimeoutError(options.timeout));
      }, options.timeout);
      timer.unref?.();

      abortHandler = () => {
        failAfterClose(this.createShellAbortError());
      };
      if (options.signal?.aborted) {
        abortHandler();
      } else {
        options.signal?.addEventListener('abort', abortHandler, { once: true });
      }

      child.on('error', (error: Error) => {
        rejectWithoutOutput(error);
      });

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        settle(() => {
          if (pendingFailure) {
            if (closeSignal) pendingFailure.signal = closeSignal;
            attachOutput(pendingFailure);
            reject(pendingFailure);
            return;
          }
          if (code === 0) {
            resolve(outputResult());
            return;
          }
          const error: any = new Error(code !== null
            ? `Command failed with exit code ${code}`
            : `Command terminated by signal ${closeSignal || 'unknown'}`);
          if (code !== null) error.code = code;
          if (closeSignal) error.signal = closeSignal;
          attachOutput(error);
          reject(error);
        });
      });

      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }
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

  private createShellTempOutputFiles(): ShellTempOutputFiles {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stdoutPath = path.join(os.tmpdir(), `xiaoba-shell-stdout-${suffix}.log`);
    const stderrPath = path.join(os.tmpdir(), `xiaoba-shell-stderr-${suffix}.log`);
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;

    try {
      stdoutFd = fs.openSync(stdoutPath, 'w');
      stderrFd = fs.openSync(stderrPath, 'w');
      return { stdoutPath, stderrPath, stdoutFd, stderrFd };
    } catch (error) {
      if (stdoutFd !== undefined) {
        try { fs.closeSync(stdoutFd); } catch {}
      }
      if (stderrFd !== undefined) {
        try { fs.closeSync(stderrFd); } catch {}
      }
      for (const filePath of [stdoutPath, stderrPath]) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }
      throw error;
    }
  }

  private closeShellTempOutputFiles(files: ShellTempOutputFiles): void {
    for (const fd of [files.stdoutFd, files.stderrFd]) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  private cleanupShellOutputFiles(output: Partial<ShellOutput> | undefined): void {
    if (!output) return;
    for (const filePath of [output.stdoutFilePath, output.stderrFilePath]) {
      if (!filePath) continue;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup only; Windows can keep files busy briefly after process exit.
      }
    }
  }

  private prepareShellOutputPresentationForShellOutput(
    output: Partial<ShellOutput> | undefined,
    stdout: string,
    stderr: string,
    context: ToolExecutionContext,
    metadata: ShellOutputMetadata,
  ): ShellOutputPresentation {
    if (output?.stdoutFilePath || output?.stderrFilePath) {
      return this.prepareShellOutputPresentationFromFiles(output, context, metadata);
    }
    return this.prepareShellOutputPresentation(stdout, stderr, context, metadata);
  }

  private prepareShellOutputPresentationFromFiles(
    output: Partial<ShellOutput>,
    context: ToolExecutionContext,
    metadata: ShellOutputMetadata,
  ): ShellOutputPresentation {
    const decoder = output.decoder || 'utf8';
    const stripCmdNoise = output.stripCmdNoise === true;

    try {
      const stdoutBytes = this.getOutputFileSize(output.stdoutFilePath);
      const stderrBytes = this.getOutputFileSize(output.stderrFilePath);
      const totalBytes = stdoutBytes + stderrBytes;

      if (totalBytes <= SHELL_INLINE_OUTPUT_DECODE_MAX_BYTES) {
        const stdoutOutput = this.readDecodedOutputFile(output.stdoutFilePath, decoder, stripCmdNoise);
        const stderrOutput = this.readDecodedOutputFile(output.stderrFilePath, decoder, stripCmdNoise);
        return this.prepareShellOutputPresentation(stdoutOutput, stderrOutput, context, metadata);
      }

      let outputArtifact: string | undefined;
      let artifactError: string | undefined;
      try {
        outputArtifact = this.writeShellOutputArtifactFromFiles(output, context, metadata, stdoutBytes, stderrBytes);
      } catch (error: any) {
        artifactError = String(error?.message || error || 'failed to write shell output artifact');
      }

      const budgets = this.allocateInlineOutputBudgets(stdoutBytes, stderrBytes);
      const previewStdout = this.buildOutputPreviewFromFile(output.stdoutFilePath, budgets.stdout, decoder, stripCmdNoise);
      const previewStderr = this.buildOutputPreviewFromFile(output.stderrFilePath, budgets.stderr, decoder, stripCmdNoise);

      return {
        stdout: previewStdout,
        stderr: previewStderr,
        stdoutLines: this.countFileLines(output.stdoutFilePath),
        stderrLines: this.countFileLines(output.stderrFilePath),
        stdoutBytes,
        stderrBytes,
        truncated: true,
        truncatedReason: 'output_exceeded_inline_limit',
        inlineOutputChars: previewStdout.length + previewStderr.length,
        originalOutputChars: totalBytes,
        outputArtifact,
        artifactError,
      };
    } finally {
      this.cleanupShellOutputFiles(output);
    }
  }

  private prepareShellOutputPresentation(
    stdout: string,
    stderr: string,
    context: ToolExecutionContext,
    metadata: ShellOutputMetadata,
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
    metadata: ShellOutputMetadata,
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

  private writeShellOutputArtifactFromFiles(
    output: Partial<ShellOutput>,
    context: ToolExecutionContext,
    metadata: ShellOutputMetadata,
    stdoutBytes: number,
    stderrBytes: number,
  ): string {
    const root = path.resolve(context.workspaceRoot || context.workingDirectory || process.cwd());
    const dir = path.join(root, SHELL_ARTIFACT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.log`);
    const fd = fs.openSync(filePath, 'w');

    try {
      this.writeArtifactText(fd, [
        'Shell output artifact',
        `contract_version: ${SHELL_CONTRACT_VERSION}`,
        `status: ${metadata.status}`,
        `command: ${this.formatHeaderValue(metadata.command)}`,
        metadata.description ? `description: ${this.formatHeaderValue(metadata.description)}` : '',
        `duration_ms: ${metadata.durationMs}`,
        `cwd_before: ${metadata.cwdBefore}`,
        `cwd_after: ${metadata.cwdAfter}`,
        `stdout_bytes: ${stdoutBytes}`,
        `stderr_bytes: ${stderrBytes}`,
        '',
        'stdout:',
      ].filter(line => line !== '').join('\n') + '\n');

      if (output.stdoutFilePath && stdoutBytes > 0) {
        this.appendFileToArtifact(fd, output.stdoutFilePath);
      } else {
        this.writeArtifactText(fd, '(empty)');
      }

      this.writeArtifactText(fd, '\n\nstderr:\n');
      if (output.stderrFilePath && stderrBytes > 0) {
        this.appendFileToArtifact(fd, output.stderrFilePath);
      } else {
        this.writeArtifactText(fd, '(empty)');
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }

    return filePath;
  }

  private writeArtifactText(fd: number, text: string): void {
    fs.writeSync(fd, Buffer.from(text, 'utf8'));
  }

  private appendFileToArtifact(fd: number, filePath: string): void {
    const inputFd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const bytesRead = fs.readSync(inputFd, buffer, 0, buffer.length, null);
        if (bytesRead <= 0) break;
        fs.writeSync(fd, buffer, 0, bytesRead);
      }
    } finally {
      try { fs.closeSync(inputFd); } catch {}
    }
  }

  private readDecodedOutputFile(filePath: string | undefined, decoder: ShellOutputDecoder, stripCmdNoise: boolean): string {
    if (!filePath || !fs.existsSync(filePath)) return '';
    let output = this.decodeShellOutputBuffer(fs.readFileSync(filePath), decoder);
    if (stripCmdNoise) output = this.stripCmdSessionNoise(output);
    return this.normalizeVisibleShellOutput(output);
  }

  private decodeShellOutputBuffer(buffer: Buffer, decoder: ShellOutputDecoder): string {
    return decoder === 'windows' ? this.decodeWindowsOutput(buffer) : buffer.toString('utf8');
  }

  private normalizeVisibleShellOutput(output: string): string {
    return this.stripAnyDirectoryProbe(output)
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }

  private getOutputFileSize(filePath: string | undefined): number {
    if (!filePath) return 0;
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private countFileLines(filePath: string | undefined): number {
    const size = this.getOutputFileSize(filePath);
    if (!filePath || size <= 0) return 0;

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let newlines = 0;
    try {
      while (position < size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
        if (bytesRead <= 0) break;
        for (let index = 0; index < bytesRead; index += 1) {
          if (buffer[index] === 10) newlines += 1;
        }
        position += bytesRead;
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }

    return newlines + 1;
  }

  private buildOutputPreviewFromFile(
    filePath: string | undefined,
    maxChars: number,
    decoder: ShellOutputDecoder,
    stripCmdNoise: boolean,
  ): string {
    if (!filePath || maxChars <= 0) return '';

    const size = this.getOutputFileSize(filePath);
    if (size <= 0) return '';
    if (size <= maxChars * 4) {
      return this.buildOutputPreview(this.readDecodedOutputFile(filePath, decoder, stripCmdNoise), maxChars);
    }

    const marker = `\n\n... [truncated, ${size} bytes total; full output saved as artifact] ...\n\n`;
    const available = maxChars - marker.length;
    if (available <= 0) return marker.trim().slice(0, maxChars);

    const headBytes = Math.max(0, Math.floor(available * 0.7));
    const tailBytes = Math.max(0, available - headBytes);
    const head = this.decodeShellOutputBuffer(this.readFileRange(filePath, 0, headBytes), decoder);
    const tailStart = Math.max(0, size - tailBytes);
    const tail = tailBytes > 0 ? this.decodeShellOutputBuffer(this.readFileRange(filePath, tailStart, tailBytes), decoder) : '';
    let preview = `${head}${marker}${tail}`;
    if (stripCmdNoise) preview = this.stripCmdSessionNoise(preview);
    return preview.length > maxChars ? preview.slice(0, maxChars) : preview;
  }

  private readFileRange(filePath: string, start: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(length);
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
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
