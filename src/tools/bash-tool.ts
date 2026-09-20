import { spawn } from 'child_process';
import { TextDecoder } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { withArtifactContextRefEnvironment } from '../utils/artifact-context-ref';
import { withArtifactTaskRefEnvironment } from '../utils/artifact-task-ref';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';
import { withTrustedBotSkillConnectorEnvironment } from '../bot-skills/trusted-script-execution';
import { registerActiveCommand, unregisterActiveCommand } from '../utils/active-commands';
import { buildCommandResourceNote, readPosixProcessStartTime, sampleProcessGroupRssBytes } from '../utils/machine-resources';

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
  /** Peak RSS of the command's process group, sampled while it ran (POSIX). */
  peakRssBytes?: number;
}

type ShellRunStatus = 'succeeded' | 'failed' | 'timed_out' | 'aborted';

interface ShellRunResult {
  command: string;
  description?: string;
  status: ShellRunStatus;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  cwdBefore: string;
  cwdAfter: string;
  stdout: string;
  stderr: string;
  errorMessage?: string;
  resourceNote?: string;
  truncated: boolean;
}

export function isShellCommandTimeoutError(error: any): boolean {
  const text = [error?.message, error?.code, error?.name]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).toLowerCase())
    .join(' ');
  if (text.includes('timed out') || text.includes('timeout') || text.includes('etimedout')) {
    return true;
  }

  // child_process.exec reports POSIX timeouts as a killed child with a signal,
  // while its message may only say "Command failed" and omit timeout wording.
  return error?.killed === true && typeof error?.signal === 'string' && error.signal.length > 0;
}

export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
// setTimeout silently overflows past 2^31-1 ms (firing immediately); keep a
// deliberate ceiling well below that so absurd values can never misfire.
export const MAX_SHELL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Guards against hostile timeout arguments (NaN, 0, negative, booleans, astronomic). */
export function normalizeShellTimeout(value: unknown, fallbackMs: number = DEFAULT_SHELL_TIMEOUT_MS): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.min(MAX_SHELL_TIMEOUT_MS, Math.floor(parsed));
}

/**
 * The OS-side watchdog script, with three guard branches for the leader:
 *  - leader alive and start time matches: the group is ours, signal it;
 *  - leader alive but start time differs: the pid was recycled, skip;
 *  - leader gone: the pgid number stays reserved while any member lives, so a
 *    still-existing group can only be ours — signal it;
 *  - unverifiable leader (no recorded start time): skip to avoid a wrong kill.
 * On platforms without /proc (macOS) the guard cannot run at all and the
 * deadline kill stays blind — accepted for dev machines.
 */
export function buildTimeoutWatchdogScript(processGroupId: number, seconds: number, expectedStartTime?: number): string {
  const expected = Number.isInteger(expectedStartTime) ? String(expectedStartTime) : '';
  return [
    `sleep ${seconds}`,
    `expected='${expected}'`,
    `statfile=/proc/${processGroupId}/stat`,
    'if [ -r "$statfile" ]; then',
    '  current=$(sed "s/.*) //" "$statfile" 2>/dev/null | cut -d" " -f20)',
    '  if [ -z "$expected" ] || [ "$current" != "$expected" ]; then exit 0; fi',
    'fi',
    `if kill -0 -${processGroupId} 2>/dev/null; then`,
    `  kill -TERM -${processGroupId} 2>/dev/null`,
    '  sleep 5',
    `  kill -KILL -${processGroupId} 2>/dev/null`,
    'fi',
  ].join('\n');
}

/**
 * OS-side SIGKILL escalation for a group that may ignore SIGTERM. It shares
 * the watchdog's guard semantics and the same reason to exist: it can outlive
 * the runtime, so a runtime crash inside the node-side TERM->KILL window (an
 * OOM kill is exactly that) still gets the group reaped. Fires once and exits.
 */
export function buildKillEscalationScript(processGroupId: number, seconds: number, expectedStartTime?: number): string {
  const expected = Number.isInteger(expectedStartTime) ? String(expectedStartTime) : '';
  return [
    `sleep ${seconds}`,
    `expected='${expected}'`,
    `statfile=/proc/${processGroupId}/stat`,
    'if [ -r "$statfile" ]; then',
    '  current=$(sed "s/.*) //" "$statfile" 2>/dev/null | cut -d" " -f20)',
    '  if [ -z "$expected" ] || [ "$current" != "$expected" ]; then exit 0; fi',
    'fi',
    `kill -KILL -${processGroupId} 2>/dev/null`,
  ].join('\n');
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
      '命令超时或被中止时，命令及其子进程会被一并终止（Linux/macOS 按进程组整体终止）；不要用 execute_shell 保活常驻服务。',
      '当前 Bot 已启用且完整性校验通过的 SkillHub Node 脚本会优先以 shell=false 直接执行；其他命令继续走普通 execute_shell 路径，并遵守既有设备授权和危险命令策略。',
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
    const { command, description, confirm_dangerous = false, cwd } = args;
    const timeout = normalizeShellTimeout(args.timeout);
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
          durationMs: 0,
          cwdBefore,
          cwdAfter: cwdBefore,
          stdout: '',
          stderr: '',
          errorMessage: 'Command aborted before execution',
          truncated: false,
        }),
      };
    }

    const route = resolveExecutionRoute(context, {
      toolName: this.definition.name,
      operation: 'execute_shell',
      target: args.target,
      command,
      cwd,
    });
    if (!route.ok) {
      return { ok: false, errorCode: route.errorCode, message: route.message };
    }
    const trustedSkillScript = route.mode === 'local' ? route.trustedSkillScript : undefined;

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Execution blocked: ${toolPermission.reason}` };
    }

    const commandPermission = isBashCommandAllowed(command, {
      confirmed: confirm_dangerous === true,
      env: process.env,
    });
    if (!commandPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `Execution blocked: ${commandPermission.reason}` };
    }

    const remoteResult = await executeRouteIfRemote(context, route, 'execute_shell', 'execute_shell', args);
    if (remoteResult) return remoteResult;

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
    const isolatedEnvironment = withTrustedBotSkillConnectorEnvironment(
      trustedSkillScript,
      context,
      runtimeEnvironment.env,
    );
    const commandEnvironment = withArtifactTaskRefEnvironment(
      withArtifactContextRefEnvironment(
        isolatedEnvironment,
        context.artifactContextRef,
      ),
      context.artifactTaskRef,
    );
    const scopedRuntimeEnvironment = {
      ...runtimeEnvironment,
      env: commandEnvironment,
    };
    const wrapped = trustedSkillScript ? undefined : this.wrapCommandWithDirectoryProbe(command);

    try {
      const shellOutput = trustedSkillScript
        ? await this.executeTrustedSkillScript(
          trustedSkillScript.args,
          executionDirectory.directory,
          scopedRuntimeEnvironment,
          timeout,
          context.abortSignal,
          description,
        )
        : await this.executeWrappedCommand(
          wrapped!,
          executionDirectory.directory,
          commandEnvironment,
          timeout,
          context.abortSignal,
          description,
        );
      const { stdout, stderr } = shellOutput;

      const parsedStdout = wrapped
        ? this.extractDirectoryProbe(stdout || '', wrapped.marker)
        : { output: stdout || '' };
      const parsedStderr = wrapped
        ? this.extractDirectoryProbe(stderr || '', wrapped.marker)
        : { output: stderr || '' };
      const cwdAfter = this.updateCurrentDirectory(
        (wrapped ? this.readDirectoryProbe(wrapped) : undefined) || parsedStdout.directory || parsedStderr.directory,
        context,
        cwdBefore,
      ) || cwdBefore;

      const stdoutOutput = parsedStdout.output || '';
      const stderrOutput = parsedStderr.output || '';
      if (stderrOutput) {
        Logger.warning(`stderr: ${stderrOutput.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputLines = this.countOutputLines(stdoutOutput) + this.countOutputLines(stderrOutput);
      const outputSize = Buffer.byteLength(stdoutOutput, 'utf-8') + Buffer.byteLength(stderrOutput, 'utf-8');

      Logger.success(`Command succeeded (elapsed: ${executionTime}ms)`);
      Logger.info(`  Output: ${outputLines} lines | ${(outputSize / 1024).toFixed(2)} KB`);

      if (outputLines > 20) {
        const previewLines = [stdoutOutput, stderrOutput].filter(Boolean).join('\n').split('\n').slice(0, 10);
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
          durationMs: executionTime,
          cwdBefore,
          cwdAfter,
          stdout: stdoutOutput,
          stderr: stderrOutput,
          resourceNote: this.safeResourceNote(executionTime, shellOutput.peakRssBytes),
          truncated: false,
        }),
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const peakRssBytes = typeof error?.peakRssBytes === 'number' ? error.peakRssBytes : undefined;
      const parsedStdout = wrapped
        ? this.extractDirectoryProbe(error.stdout || '', wrapped.marker)
        : { output: String(error.stdout || '') };
      const parsedStderr = wrapped
        ? this.extractDirectoryProbe(error.stderr || '', wrapped.marker)
        : { output: String(error.stderr || '') };
      const cwdAfter = this.updateCurrentDirectory(
        (wrapped ? this.readDirectoryProbe(wrapped) : undefined) || parsedStdout.directory || parsedStderr.directory,
        context,
        cwdBefore,
      ) || cwdBefore;
      const aborted = context.abortSignal?.aborted || /aborted|abort/i.test(String(error.message || ''));
      const timedOut = !aborted && isShellCommandTimeoutError(error);
      if (aborted || timedOut) {
        return {
          ok: false,
          errorCode: 'EXECUTION_TIMEOUT',
          message: this.formatShellRunResult({
            command,
            description,
            status: aborted ? 'aborted' : 'timed_out',
            signal: typeof error.signal === 'string' ? error.signal : undefined,
            timedOut,
            durationMs: executionTime,
            cwdBefore,
            cwdAfter,
            stdout: parsedStdout.output || '',
            stderr: parsedStderr.output || '',
            errorMessage: this.formatExecutionError(error),
            resourceNote: this.safeResourceNote(executionTime, peakRssBytes),
            truncated: false,
          }),
        };
      }
      const stdoutOutput = parsedStdout.output || '';
      const stderrOutput = parsedStderr.output || '';
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
          durationMs: executionTime,
          cwdBefore,
          cwdAfter,
          stdout: stdoutOutput,
          stderr: stderrOutput,
          errorMessage: this.formatExecutionError(error),
          resourceNote: this.safeResourceNote(executionTime, peakRssBytes),
          truncated: false,
        }),
      };
    } finally {
      if (wrapped) this.cleanupWrappedCommand(wrapped);
    }
  }

  private executeTrustedSkillScript(
    args: string[],
    cwd: string,
    runtimeEnvironment: ReturnType<typeof resolveRuntimeEnvironment>,
    timeout: number,
    signal?: AbortSignal,
    label?: string,
  ): Promise<ShellOutput> {
    const executable = runtimeEnvironment.binaries.node.executable;
    if (!executable) {
      return Promise.reject(new Error('The verified Skill requires Node.js, but no trusted Node.js runtime is available.'));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Command aborted by user'));
    }

    return this.executeManagedCommand({
      file: executable,
      args,
      cwd,
      env: runtimeEnvironment.env,
      timeoutMs: timeout,
      signal,
      label: this.describeCommandLabel(label ? `${label} · ${args.join(' ')}` : args.join(' ')),
    });
  }

  private describeCommandLabel(command: string): string {
    const oneLine = String(command || '').split(/\r?\n/)[0].trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
  }

  private safeResourceNote(durationMs: number, peakRssBytes?: number): string | undefined {
    try {
      return buildCommandResourceNote({ durationMs, peakRssBytes });
    } catch {
      return undefined;
    }
  }

  /**
   * Spawn an OS-side watchdog that enforces the deadline even when the Node
   * event loop is starved (the failure mode observed in production), and even
   * when the runtime itself has died — the detached, unref'd process survives
   * both long enough to clean the command up.
   *
   * Because it can outlive the runtime it must never fire blind: the script it
   * runs verifies the group leader's spawn-time identity before signalling, so
   * a recycled pgid (an unrelated group that inherited the number) is left
   * alone instead of being killed by mistake. On normal completion `cleanup()`
   * kills the whole watchdog group — including its inner `sleep` child — via
   * the live child handle, so nothing is orphaned.
   */
  private spawnTimeoutWatchdog(
    processGroupId: number,
    timeoutMs: number,
    expectedStartTime?: number,
  ): ReturnType<typeof spawn> | undefined {
    if (process.platform === 'win32') return undefined;
    try {
      const seconds = Math.max(1, Math.ceil((timeoutMs + 1200) / 1000));
      const watchdog = spawn('/bin/sh', ['-c', buildTimeoutWatchdogScript(processGroupId, seconds, expectedStartTime)], {
        detached: true,
        stdio: 'ignore',
      });
      // Spawn failures arrive as an async 'error' event (ENOENT/EMFILE/EAGAIN —
      // exactly the resource-pressure cases this helper exists for); an
      // unhandled one would take the whole runtime down.
      watchdog.on('error', () => { /* best effort: node-side timers still cover */ });
      watchdog.unref();
      return watchdog;
    } catch {
      return undefined;
    }
  }

  /**
   * Death-proof escalation: even if this runtime dies before its own timer
   * fires, the detached helper still delivers SIGKILL to the group; it
   * verifies the group is still ours first and self-exits after firing.
   */
  private spawnKillEscalation(processGroupId: number, delayMs: number, expectedStartTime?: number): void {
    if (process.platform === 'win32') return;
    try {
      const seconds = Math.max(1, Math.ceil(delayMs / 1000));
      const killer = spawn('/bin/sh', ['-c', buildKillEscalationScript(processGroupId, seconds, expectedStartTime)], {
        detached: true,
        stdio: 'ignore',
      });
      // Same async spawn-failure handling as the watchdog.
      killer.on('error', () => { /* best effort */ });
      killer.unref();
    } catch {
      // Best effort: the node-side timer still covers the running-runtime case.
    }
  }

  /**
   * Sends a signal to a process group, refusing to touch it when a live group
   * leader proves the numeric pgid now belongs to an unrelated group (start
   * time mismatch — a recycled pid). A missing leader is still fine: while any
   * member lives the number stays reserved, so the group can only be ours.
   * Signals sent while the original child is still running pass the check
   * trivially.
   */
  private killProcessGroup(processGroupId: number, signal: NodeJS.Signals, expectedStartTime?: number): void {
    if (process.platform === 'linux' && expectedStartTime !== undefined) {
      const currentStartTime = readPosixProcessStartTime(processGroupId);
      if (currentStartTime !== undefined && currentStartTime !== expectedStartTime) {
        return;
      }
    }
    try {
      process.kill(-processGroupId, signal);
    } catch {
      // Group already gone.
    }
  }

  private executeManagedCommand(params: {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
  }): Promise<ShellOutput> {
    const { file, args, cwd, env, timeoutMs, signal, label } = params;

    if (process.platform === 'win32') {
      return this.executeManagedWindowsCommand(params);
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Command aborted by user'));
    }

    const maxBuffer = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          // New process group: the command and all its children can be killed together.
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const processGroupId = typeof child.pid === 'number' && child.pid > 0 ? child.pid : undefined;
      // Spawn-time identity of the group leader: a recycled pid can never
      // match this start time, which is what every later kill verifies.
      const groupStartTime = processGroupId !== undefined ? readPosixProcessStartTime(processGroupId) : undefined;
      const startedAt = Date.now();
      let peakRssBytes: number | undefined;
      let settled = false;
      let timedOut = false;
      let killEscalationTimer: NodeJS.Timeout | undefined;

      if (processGroupId) {
        registerActiveCommand({ pid: processGroupId, label, startedAt, platform: process.platform });
      }

      const sampleRss = () => {
        if (!processGroupId) return;
        const rss = sampleProcessGroupRssBytes(processGroupId);
        if (rss !== undefined && (peakRssBytes === undefined || rss > peakRssBytes)) {
          peakRssBytes = rss;
        }
      };
      // Memory bombs can rise in seconds (the production OOM pattern was a
      // 1.5 GB spike inside ~2 s). Sample at 1.5 s, then once per second for
      // the first 10 s so spikes anywhere in the 2-5 s window still reach the
      // result note, and fall back to a 5 s cadence afterwards.
      let samplerTimer: NodeJS.Timeout | undefined;
      const scheduleSample = () => {
        sampleRss();
        samplerTimer = setTimeout(scheduleSample, Date.now() - startedAt < 10_000 ? 1000 : 5000);
        samplerTimer.unref?.();
      };
      samplerTimer = setTimeout(scheduleSample, 1500);
      samplerTimer.unref?.();

      const watchdog = processGroupId
        ? this.spawnTimeoutWatchdog(processGroupId, timeoutMs, groupStartTime)
        : undefined;

      // Node-side fallback timer: fires slightly after the watchdog in case it
      // could not be spawned. Primary enforcement stays OS-side.
      const fallbackTimer = setTimeout(() => {
        timedOut = true;
        if (processGroupId) {
          this.killProcessGroup(processGroupId, 'SIGTERM', groupStartTime);
          // Same OS-side escalation as the abort/terminate paths: if node and
          // the watchdog both die before cleanup, TERM-immunized members would
          // otherwise linger forever.
          this.spawnKillEscalation(processGroupId, 5000, groupStartTime);
          killEscalationTimer = setTimeout(() => this.killProcessGroup(processGroupId, 'SIGKILL', groupStartTime), 5000);
          killEscalationTimer.unref?.();
        } else {
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
      }, timeoutMs + 1500);
      fallbackTimer.unref?.();

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const cleanup = () => {
        if (samplerTimer) clearTimeout(samplerTimer);
        clearTimeout(fallbackTimer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        if (watchdog && typeof watchdog.pid === 'number'
          && watchdog.exitCode === null && watchdog.signalCode === null) {
          // The watchdog shell holds a long-lived `sleep` child; kill the whole
          // group — but only while the handle proves the watchdog is still
          // alive (a dead watchdog's pid may already have been recycled).
          try {
            process.kill(-watchdog.pid, 'SIGKILL');
          } catch {
            try { watchdog.kill('SIGKILL'); } catch { /* already done */ }
          }
        }
        unregisterActiveCommand(processGroupId);
      };

      const fail = (error: any, terminate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        signal?.removeEventListener('abort', abortHandler);
        if (terminate && processGroupId) {
          // The command failed after spawning (e.g. maxBuffer overflow) but its
          // process group may still be running; take it down with the same
          // TERM-then-KILL escalation used for aborts. The KILL also runs
          // OS-side so a runtime crash inside the window cannot leave the
          // group behind; both kills verify the group is still ours first.
          this.killProcessGroup(processGroupId, 'SIGTERM', groupStartTime);
          this.spawnKillEscalation(processGroupId, 5000, groupStartTime);
          setTimeout(() => this.killProcessGroup(processGroupId, 'SIGKILL', groupStartTime), 5000).unref?.();
        }
        error.stdout = Buffer.concat(stdoutChunks).toString('utf8');
        error.stderr = Buffer.concat(stderrChunks).toString('utf8');
        error.peakRssBytes = peakRssBytes;
        reject(error);
      };

      const abortHandler = () => {
        if (processGroupId) {
          this.killProcessGroup(processGroupId, 'SIGTERM', groupStartTime);
          // The OS-side helper fires within 3s even if this runtime dies first;
          // the node-side timer below is an untracked, unref'd duplicate.
          // Both verify the group is still ours before signalling.
          this.spawnKillEscalation(processGroupId, 3000, groupStartTime);
          setTimeout(() => this.killProcessGroup(processGroupId, 'SIGKILL', groupStartTime), 3000).unref?.();
        } else {
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
        const error: any = new Error('Command aborted by user');
        error.signal = 'SIGTERM';
        fail(error);
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxBuffer) {
          fail(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`), true);
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const buffer = Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxBuffer) {
          fail(new Error(`stderr maxBuffer exceeded (${maxBuffer} bytes)`), true);
          return;
        }
        stderrChunks.push(buffer);
      });

      child.on('error', (error: Error) => {
        fail(error);
      });

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        const elapsed = Date.now() - startedAt;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        // The OS-side watchdog kills the process group at the deadline; map
        // that back to the timed_out contract even when the node-side fallback
        // never fired (event loop starvation). Deadline kills land at or after
        // the timeout (the watchdog sleeps ceil((timeout+1200)/1000) seconds),
        // so an earlier signal is an unrelated external kill and stays a plain
        // failure; the 1 s floor keeps tiny timeouts usable. An external kill
        // landing in the ~1.2 s before the watchdog's first TERM is still
        // attributed as a deadline kill — accepted, narrow window.
        const killedByDeadline = !timedOut
          && (closeSignal === 'SIGTERM' || closeSignal === 'SIGKILL')
          && elapsed >= Math.max(1000, timeoutMs);

        settled = true;
        if ((timedOut || killedByDeadline) && processGroupId) {
          // Finish the TERM->KILL cycle OS-side: the watchdog may have died
          // between its TERM and its KILL (or be released by cleanup below),
          // and this runtime could die before any node-side escalation fires.
          this.spawnKillEscalation(processGroupId, 5000, groupStartTime);
        }
        cleanup();
        signal?.removeEventListener('abort', abortHandler);

        if (timedOut || killedByDeadline) {
          const error: any = new Error(`Command timed out after ${timeoutMs}ms`);
          error.killed = true;
          // Keep the real close signal: an OOM SIGKILL must stay visible
          // instead of being flattened into SIGTERM.
          error.signal = closeSignal ?? 'SIGTERM';
          error.stdout = stdout;
          error.stderr = stderr;
          error.peakRssBytes = peakRssBytes;
          reject(error);
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr, peakRssBytes });
          return;
        }
        const error: any = new Error(`Command failed with exit code ${code}`);
        error.code = code ?? undefined;
        error.signal = closeSignal ?? undefined;
        error.stdout = stdout;
        error.stderr = stderr;
        error.peakRssBytes = peakRssBytes;
        reject(error);
      });
    });
  }

  private executeManagedWindowsCommand(params: {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
  }): Promise<ShellOutput> {
    const { file, args, cwd, env, timeoutMs, signal, label } = params;
    if (signal?.aborted) {
      return Promise.reject(new Error('Command aborted by user'));
    }

    const maxBuffer = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pid = typeof child.pid === 'number' ? child.pid : undefined;
      if (pid) {
        registerActiveCommand({ pid, label, startedAt: Date.now(), platform: process.platform });
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        unregisterActiveCommand(pid);
        fn();
      };

      const fail = (error: any) => {
        finish(() => {
          try { child.kill(); } catch { /* already gone */ }
          error.stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
          error.stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
          reject(error);
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        const error: any = new Error(`Command timed out after ${timeoutMs}ms`);
        error.killed = true;
        error.signal = 'SIGTERM';
        fail(error);
      }, timeoutMs);
      const abortHandler = () => fail(new Error('Command aborted by user'));
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

      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled || timedOut) return;
        const stdout = this.decodeWindowsOutput(Buffer.concat(stdoutChunks));
        const stderr = this.decodeWindowsOutput(Buffer.concat(stderrChunks));
        finish(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error: any = new Error(`Command failed with exit code ${code}`);
          error.code = code ?? undefined;
          error.signal = closeSignal ?? undefined;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
    });
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
    label?: string,
  ): Promise<ShellOutput> {
    if (process.platform !== 'win32') {
      return this.executeManagedCommand({
        file: this.resolvePosixShell(env) || '/bin/sh',
        args: ['-c', wrapped.command],
        cwd,
        env,
        timeoutMs: timeout,
        signal,
        // The label ends up in every session's runtime context on this machine:
        // keep it single-line and bounded, and keep both the description and
        // the actual command so other sessions can still tell what is running.
        label: this.describeCommandLabel(label ? `${label} · ${wrapped.command}` : wrapped.command),
      });
    }

    try {
      return await this.executeWindowsPowerShellScript(wrapped, cwd, env, timeout, signal, label);
    } catch (error) {
      if (!this.isPowerShellLaunchFailure(error)) throw error;
      return this.executeWindowsCmdFallback(wrapped, cwd, env, timeout, label);
    }
  }

  private executeWindowsPowerShellScript(
    wrapped: WrappedCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
    signal?: AbortSignal,
    label?: string,
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

      const childPid = typeof child.pid === 'number' ? child.pid : undefined;
      if (childPid) {
        registerActiveCommand({
          pid: childPid,
          label: this.describeCommandLabel(label ? `${label} · ${wrapped.command}` : wrapped.command),
          startedAt: Date.now(),
          platform: process.platform,
        });
      }

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
        unregisterActiveCommand(childPid);
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
    label?: string,
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

      const childPid = typeof child.pid === 'number' ? child.pid : undefined;
      if (childPid) {
        registerActiveCommand({
          pid: childPid,
          label: this.describeCommandLabel(label ? `${label} · ${wrapped.command}` : wrapped.command),
          startedAt: Date.now(),
          platform: process.platform,
        });
      }

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
        unregisterActiveCommand(childPid);
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

  private formatShellRunResult(result: ShellRunResult): string {
    const stdoutLines = this.countOutputLines(result.stdout);
    const stderrLines = this.countOutputLines(result.stderr);
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf-8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf-8');
    const header = [
      'Command completed',
      `status: ${result.status}`,
      `command: ${this.formatHeaderValue(result.command)}`,
      result.description ? `description: ${this.formatHeaderValue(result.description)}` : '',
      result.exitCode !== undefined ? `exit_code: ${result.exitCode}` : 'exit_code:',
      result.signal ? `signal: ${result.signal}` : 'signal:',
      `timed_out: ${result.timedOut}`,
      `duration_ms: ${result.durationMs}`,
      `cwd_before: ${result.cwdBefore}`,
      `cwd_after: ${result.cwdAfter}`,
      `stdout_lines: ${stdoutLines}`,
      `stderr_lines: ${stderrLines}`,
      `stdout_bytes: ${stdoutBytes}`,
      `stderr_bytes: ${stderrBytes}`,
      `truncated: ${result.truncated}`,
      result.errorMessage ? `error_message: ${this.formatHeaderValue(result.errorMessage)}` : '',
      result.resourceNote ? `resource_note: ${result.resourceNote}` : '',
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

  private updateCurrentDirectory(
    directory: string | undefined,
    context: ToolExecutionContext,
    preferredDirectory?: string,
  ): string | undefined {
    if (!directory) return undefined;
    const resolved = path.resolve(directory);
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
      // macOS commonly reports /private/var from $PWD for a command that was
      // launched through the equivalent /var path. Keep the caller's spelling
      // when the command did not actually change directories.
      const stableDirectory = preferredDirectory && this.isSameDirectory(resolved, preferredDirectory)
        ? path.resolve(preferredDirectory)
        : resolved;
      context.updateCurrentDirectory?.(stableDirectory);
      return stableDirectory;
    } catch {
      return undefined;
    }
  }

  private isSameDirectory(left: string, right: string): boolean {
    try {
      const leftReal = fs.realpathSync(path.resolve(left));
      const rightReal = fs.realpathSync(path.resolve(right));
      return process.platform === 'win32'
        ? leftReal.toLowerCase() === rightReal.toLowerCase()
        : leftReal === rightReal;
    } catch {
      return false;
    }
  }
}
