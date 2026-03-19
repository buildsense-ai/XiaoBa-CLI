import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { EventEmitter } from 'events';

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

  private registerBuiltinServices() {
    const tsxBin = path.join(this.projectRoot, 'node_modules', '.bin', 'tsx');
    const entry = path.join(this.projectRoot, 'src', 'index.ts');

    this.services.set('catscompany', {
      info: {
        name: 'catscompany',
        label: 'Cats Company 机器人',
        command: tsxBin,
        args: [entry, 'catscompany'],
        status: 'stopped',
      },
      logs: [],
    });

    this.services.set('feishu', {
      info: {
        name: 'feishu',
        label: '飞书机器人',
        command: tsxBin,
        args: [entry, 'feishu'],
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

    const child = spawn(svc.info.command, svc.info.args, {
      cwd: this.projectRoot,
      env: envVars,
      stdio: ['ignore', 'pipe', 'pipe'],
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

  stop(name: string): ServiceInfo {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service "${name}" not found`);
    if (svc.info.status !== 'running' || !svc.process) {
      throw new Error(`Service "${name}" is not running`);
    }

    svc.process.kill('SIGTERM');

    // 5秒后强制kill
    setTimeout(() => {
      if (svc.process && !svc.process.killed) {
        svc.process.kill('SIGKILL');
      }
    }, 5000);

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
      svc.process.kill('SIGTERM');
      return this.getService(name)!;
    }

    return this.start(name);
  }

  stopAll() {
    for (const [name, svc] of this.services) {
      if (svc.info.status === 'running' && svc.process) {
        svc.process.kill('SIGTERM');
      }
    }
  }
}
