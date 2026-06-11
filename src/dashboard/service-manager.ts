import { ChildProcess, spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { EventEmitter } from 'events';
import { resolveRuntimeEnvironment } from '../utils/runtime-environment';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { weixinBindingEnvOverlay } from './weixin-channel-binding';

const isWindows = process.platform === 'win32';

export interface ServiceInfo {
  name: string;
  label: string;
  command: string;
  args: string[];
  status: 'stopped' | 'running' | 'error';
  pid?: number;
  startedAt?: number;
  uptime?: number;
  lastError?: string;
}

interface ManagedService {
  info: ServiceInfo;
  process?: ChildProcess;
  logs: string[];  // 最近的日志
  expectedExit?: 'stop' | 'restart';
}

const MAX_LOG_LINES = 500;
const MAX_LAST_ERROR_LENGTH = 500;

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function sanitizeServiceLogLine(value: string): string {
  const sanitized = stripAnsi(value)
    .replace(/cats_svc_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\bAuthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?[^\s,;'"`<>]+/gi, 'Authorization: [redacted-token]')
    .replace(/\b(?:Bearer|ApiKey|Token)\s+[A-Za-z0-9._~+/=-]+/gi, match => `${match.split(/\s+/)[0]} [redacted-token]`)
    .replace(/(["']?)([A-Za-z0-9_.-]*(?:token|api[_-]?key|secret|password)[A-Za-z0-9_.-]*)\1\s*[:=]\s*["']?[^&\s,'"`<>}]+["']?/gi, '$1$2$1=[redacted-token]')
    .trim();
  if (sanitized.length <= MAX_LAST_ERROR_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`;
}

function pickLastErrorLine(logs: string[]): string | undefined {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = sanitizeServiceLogLine(logs[i] || '');
    if (/\[ERROR\]|\berror\b|错误|失败|过期/i.test(line)) {
      return line;
    }
  }
  return undefined;
}

function readEnvFile(root: string): Record<string, string> {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

export class ServiceManager extends EventEmitter {
  private services: Map<string, ManagedService> = new Map();
  private projectRoot: string;

  constructor(projectRoot: string) {
    super();
    this.projectRoot = projectRoot;
    this.registerBuiltinServices();
  }

  private isPackaged(): boolean {
    // Electron 打包版会设置 XIAOBA_APP_ROOT
    if (process.env.XIAOBA_IS_PACKAGED !== undefined) {
      return /^(1|true|yes)$/i.test(process.env.XIAOBA_IS_PACKAGED);
    }
    return !!process.env.XIAOBA_APP_ROOT;
  }

  private getAppRoot(): string {
    // 打包版：asar 路径；开发版：projectRoot 就是项目根目录
    return process.env.XIAOBA_APP_ROOT || this.projectRoot;
  }

  private resolveNodeExecutable(runtimeEnvironment: ReturnType<typeof resolveRuntimeEnvironment>): string {
    const candidates = [
      process.env.XIAOBA_NODE_EXECUTABLE,
      process.env.npm_node_execpath,
      runtimeEnvironment.binaries.node.executable,
      path.basename(process.execPath).toLowerCase().includes('electron') ? undefined : process.execPath,
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }

    return 'node';
  }

  private resolveDevTsxRunner(nodeExecutable: string): { command: string; argsPrefix: string[] } {
    const packageJsonPath = path.join(this.projectRoot, 'node_modules', 'tsx', 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
          bin?: string | Record<string, string>;
        };
        const binEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsx;
        if (binEntry) {
          const cliPath = path.resolve(path.dirname(packageJsonPath), binEntry);
          if (fs.existsSync(cliPath)) {
            return { command: nodeExecutable, argsPrefix: [cliPath] };
          }
        }
      } catch {
        // Fall back to the package-manager shim below.
      }
    }

    const binName = isWindows ? 'tsx.cmd' : 'tsx';
    return {
      command: path.join(this.projectRoot, 'node_modules', '.bin', binName),
      argsPrefix: [],
    };
  }

  private formatSpawnError(info: ServiceInfo, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${message} (runner: ${path.basename(info.command)})`;
  }

  private registerBuiltinServices() {
    const packaged = this.isPackaged();
    const appRoot = this.getAppRoot();
    const runtimeEnvironment = resolveRuntimeEnvironment({
      env: process.env,
      appRoot,
      runtimeRoot: process.env.XIAOBA_RUNTIME_ROOT,
      isPackaged: packaged,
      probeVersion: false,
    });

    let command: string;
    let args: (name: string) => string[];

    if (packaged) {
      // 打包版：优先使用内嵌的 node.exe，否则回退系统 node
      command = runtimeEnvironment.binaries.node.executable || 'node';
      const distEntry = path.join(appRoot, 'dist', 'index.js');
      args = (name) => [distEntry, name];
    } else {
      // 开发版：用 tsx 跑 ts 源码
      const runner = this.resolveDevTsxRunner(this.resolveNodeExecutable(runtimeEnvironment));
      command = runner.command;
      const entry = path.join(this.projectRoot, 'src', 'index.ts');
      args = (name) => [...runner.argsPrefix, entry, name];
    }

    this.services.set('catscompany', {
      info: {
        name: 'catscompany',
        label: 'CatsCo agent',
        command,
        args: args('catscompany'),
        status: 'stopped',
      },
      logs: [],
    });

    this.services.set('feishu', {
      info: {
        name: 'feishu',
        label: '飞书机器人',
        command,
        args: args('feishu'),
        status: 'stopped',
      },
      logs: [],
    });

    this.services.set('weixin', {
      info: {
        name: 'weixin',
        label: '微信机器人',
        command,
        args: args('weixin'),
        status: 'stopped',
      },
      logs: [],
    });
  }

  getAll(): ServiceInfo[] {
    return Array.from(this.services.values()).map(s => {
      const info = { ...s.info };
      if (info.status === 'running' && info.startedAt) {
        info.uptime = (Date.now() - info.startedAt) / 1000;
      }
      return info;
    });
  }

  getService(name: string): ServiceInfo | undefined {
    const svc = this.services.get(name);
    if (!svc) return undefined;
    const info = { ...svc.info };
    if (info.status === 'running' && info.startedAt) {
      info.uptime = (Date.now() - info.startedAt) / 1000;
    }
    return info;
  }

  getLogs(name: string, lines: number = 100): string[] {
    const svc = this.services.get(name);
    if (!svc) return [];
    return svc.logs.slice(-lines);
  }

  start(name: string): ServiceInfo {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service "${name}" not found`);
    if (svc.info.status === 'running') throw new Error(`Service "${name}" is already running`);

    // cwd 统一用 process.cwd()，Electron 主进程已 chdir 到 userData 目录
    // 这样子进程创建的 skill 文件和 Dashboard 读取的在同一个目录
    const spawnCwd = process.cwd();

    // 每次启动时实时读取 .env。开发根目录提供默认值，runtime root 是运行态权威配置。
    let envVars = { ...process.env };
    const envRoots = Array.from(new Set([this.projectRoot, spawnCwd]));
    for (const root of envRoots) {
      envVars = { ...envVars, ...readEnvFile(root) };
    }

    // 打包版：确保子进程能找到 node_modules
    if (this.isPackaged() && process.env.XIAOBA_NODE_MODULES) {
      envVars.NODE_PATH = process.env.XIAOBA_NODE_MODULES;
    }

    if (name === 'catscompany') {
      const catsCoRuntime = resolveCatsCoRuntimeConfig({
        runtimeRoot: spawnCwd,
        env: envVars,
        migrateLegacyEnvBinding: true,
      });
      envVars = {
        ...envVars,
        ...catsCoRuntime.envOverlay,
      };
    }

    if (name === 'weixin') {
      const catsCoRuntime = resolveCatsCoRuntimeConfig({
        runtimeRoot: spawnCwd,
        env: envVars,
        migrateLegacyEnvBinding: true,
      });
      envVars = {
        ...envVars,
        ...catsCoRuntime.envOverlay,
        ...weixinBindingEnvOverlay({ runtimeRoot: spawnCwd, env: envVars }),
      };
    }

    const runtimeEnvironment = resolveRuntimeEnvironment({
      env: envVars,
      appRoot: this.getAppRoot(),
      runtimeRoot: envVars.XIAOBA_RUNTIME_ROOT,
      isPackaged: this.isPackaged(),
      probeVersion: false,
    });
    envVars = runtimeEnvironment.env;

    let child: ChildProcess;
    try {
      child = spawn(svc.info.command, svc.info.args, {
        cwd: spawnCwd,
        env: envVars,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      const message = this.formatSpawnError(svc.info, err);
      svc.info.status = 'error';
      svc.info.lastError = message;
      svc.process = undefined;
      this.emit('service-error', name, err);
      throw new Error(message);
    }

    svc.process = child;
    svc.expectedExit = undefined;
    svc.info.status = 'running';
    svc.info.pid = child.pid;
    svc.info.startedAt = Date.now();
    svc.info.lastError = undefined;
    svc.logs = [];

    const appendLog = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      svc.logs.push(...lines);
      if (svc.logs.length > MAX_LOG_LINES) {
        svc.logs = svc.logs.slice(-MAX_LOG_LINES);
      }
    };

    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    child.on('exit', (code, signal) => {
      const expectedExit = svc.expectedExit;
      svc.expectedExit = undefined;
      svc.info.status = expectedExit || code === 0
        ? 'stopped'
        : 'error';
      svc.info.pid = undefined;
      if (expectedExit || code === 0) {
        svc.info.lastError = undefined;
      } else {
        const lastErrorLine = pickLastErrorLine(svc.logs);
        const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
        svc.info.lastError = lastErrorLine
          ? `${lastErrorLine} (${exitReason})`
          : `Process exited with ${exitReason}`;
      }
      svc.process = undefined;
      this.emit('service-stopped', name, code);
    });

    child.on('error', (err) => {
      svc.info.status = 'error';
      svc.info.lastError = this.formatSpawnError(svc.info, err);
      svc.process = undefined;
      this.emit('service-error', name, err);
    });

    return this.getService(name)!;
  }

  /**
   * 跨平台终止进程：Windows 用 taskkill，其他平台用 SIGTERM/SIGKILL
   */
  private killProcess(proc: ChildProcess, force: boolean = false): void {
    if (!proc.pid) return;

    if (isWindows) {
      try {
        // /T = 终止子进程树, /F = 强制终止
        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // 进程可能已退出，忽略错误
      }
    } else {
      proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }

  stop(name: string): ServiceInfo {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service "${name}" not found`);
    if (svc.info.status !== 'running' || !svc.process) {
      throw new Error(`Service "${name}" is not running`);
    }

    if (isWindows) {
      // Windows: 直接用 taskkill 强制终止进程树
      svc.expectedExit = 'stop';
      this.killProcess(svc.process, true);
    } else {
      svc.expectedExit = 'stop';
      svc.process.kill('SIGTERM');

      // 5秒后强制kill
      const forceKillTimer = setTimeout(() => {
        if (svc.process && !svc.process.killed) {
          svc.process.kill('SIGKILL');
        }
      }, 5000);
      forceKillTimer.unref?.();
    }

    return this.getService(name)!;
  }

  restart(name: string): ServiceInfo {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service "${name}" not found`);

    if (svc.info.status === 'running' && svc.process) {
      // 先停再启，等进程退出后启动
      svc.process.once('exit', () => {
        const restartTimer = setTimeout(() => this.start(name), 500);
        restartTimer.unref?.();
      });
      svc.expectedExit = 'restart';
      this.killProcess(svc.process);
      return this.getService(name)!;
    }

    return this.start(name);
  }

  stopAll() {
    for (const [name, svc] of this.services) {
      if (svc.info.status === 'running' && svc.process) {
        svc.expectedExit = 'stop';
        this.killProcess(svc.process, true);
      }
    }
  }
}
