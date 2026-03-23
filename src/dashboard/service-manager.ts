import { ChildProcess, spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { EventEmitter } from 'events';

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
}

const MAX_LOG_LINES = 500;

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
    return !!process.env.XIAOBA_APP_ROOT;
  }

  private getAppRoot(): string {
    // 打包版：asar 路径；开发版：projectRoot 就是项目根目录
    return process.env.XIAOBA_APP_ROOT || this.projectRoot;
  }

  private registerBuiltinServices() {
    const packaged = this.isPackaged();
    const appRoot = this.getAppRoot();

    let command: string;
    let args: (name: string) => string[];

    if (packaged) {
      // 打包版：优先使用内嵌的 node.exe，否则回退系统 node
      command = process.env.XIAOBA_NODE_EXE || 'node';
      const distEntry = path.join(appRoot, 'dist', 'index.js');
      args = (name) => [distEntry, name];
    } else {
      // 开发版：用 tsx 跑 ts 源码
      command = path.join(this.projectRoot, 'node_modules', '.bin', 'tsx');
      const entry = path.join(this.projectRoot, 'src', 'index.ts');
      args = (name) => [entry, name];
    }

    this.services.set('catscompany', {
      info: {
        name: 'catscompany',
        label: 'Cats Company 机器人',
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

    // 每次启动时实时读取.env，确保用最新配置
    const envPath = path.join(this.projectRoot, '.env');
    let envVars = { ...process.env };
    if (fs.existsSync(envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
      envVars = { ...envVars, ...parsed };
    }

    // cwd 统一用 process.cwd()，Electron 主进程已 chdir 到 userData 目录
    // 这样子进程创建的 skill 文件和 Dashboard 读取的在同一个目录
    const spawnCwd = process.cwd();

    // 打包版：确保子进程能找到 node_modules
    if (this.isPackaged() && process.env.XIAOBA_NODE_MODULES) {
      envVars.NODE_PATH = process.env.XIAOBA_NODE_MODULES;
    }

    const child = spawn(svc.info.command, svc.info.args, {
      cwd: spawnCwd,
      env: envVars,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    svc.process = child;
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

    child.on('exit', (code) => {
      svc.info.status = code === 0 ? 'stopped' : 'error';
      svc.info.pid = undefined;
      if (code !== 0) {
        svc.info.lastError = `Process exited with code ${code}`;
      }
      svc.process = undefined;
      this.emit('service-stopped', name, code);
    });

    child.on('error', (err) => {
      svc.info.status = 'error';
      svc.info.lastError = err.message;
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
      this.killProcess(svc.process, true);
    } else {
      svc.process.kill('SIGTERM');

      // 5秒后强制kill
      setTimeout(() => {
        if (svc.process && !svc.process.killed) {
          svc.process.kill('SIGKILL');
        }
      }, 5000);
    }

    return this.getService(name)!;
  }

  restart(name: string): ServiceInfo {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service "${name}" not found`);

    if (svc.info.status === 'running' && svc.process) {
      // 先停再启，等进程退出后启动
      svc.process.once('exit', () => {
        setTimeout(() => this.start(name), 500);
      });
      this.killProcess(svc.process);
      return this.getService(name)!;
    }

    return this.start(name);
  }

  stopAll() {
    for (const [name, svc] of this.services) {
      if (svc.info.status === 'running' && svc.process) {
        this.killProcess(svc.process, true);
      }
    }
  }
}
