/**
 * CatsCo 内嵌 service worker（桌面端自带，用户不需要任何「凭证」概念）。
 *
 * 背景：平台侧的应用有两种执行位置。选了「我的电脑」时，任务要由用户机器上的一个
 * 常驻进程认领并执行。之前的做法是让用户自己在终端跑 `service-run-worker`，还得
 * 先复制一把 `cwk_...` 连接密钥 —— 用户既看不懂，也容易贴错/泄露。
 *
 * 这里做一个**原生实现**（不依赖额外的 Go 二进制），由客户端用自己已有的账号登录态
 * 换一张短期 worker 券（`POST /api/service-worker/session`），然后在后台认领并执行本
 * 账号名下应用的 run。用户界面上完全看不到密钥：
 *
 *   - 券只在内存里，不落盘、不进命令行历史；
 *   - 券到期前自动续（用账号态重新换），账号态失效则停手等重新登录；
 *   - 权限与 `cwk_` 相同：只能认领自己名下应用的 run（服务端按凭证 uid 过滤）。
 *
 * 协议与 `cmd/service-run-worker` 完全一致（五个接口），所以两端可以混用。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';

export const SERVICE_WORKER_API_PREFIX = '/api/service-worker';
export const SERVICE_RUN_RESULT_CONTRACT = 'catsco.service-run-result.v1';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_INSTANCE_HEARTBEAT_MS = 20000;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ERROR_BACKOFF_MS = 5000;
/** 券在「有效期的一半」时刻续期：既不过于频繁，也不会卡在边界上。 */
const TICKET_REFRESH_RATIO = 0.5;

export interface ServiceWorkerAuthSnapshot {
  /** 账号登录 token（用户登录后客户端已有，不需要用户抄任何东西）。 */
  token?: string;
  /** 平台 HTTP 地址，如 https://app.catsco.cn。 */
  httpBaseUrl?: string;
  uid?: string;
}

export interface ServiceWorkerAuthState {
  token: string;
  baseUrl: string;
  uid: string;
}

export interface ClaimedRun {
  run_id: string;
  session_id: string;
  agent_slug: string;
  input?: unknown;
  service_token?: string;
  threshold_seconds?: number;
  /** 应用定义；`runner.command` 决定这台机器上跑什么。 */
  definition?: { runner?: { command?: string; type?: string } };
}

export interface ServiceWorkerSupervisorOptions {
  /** 读当前账号态；返回 null 表示还没登录（此时不认领，等下一次轮询）。 */
  resolveAuth: () => ServiceWorkerAuthSnapshot | null;
  /** 实例 id；同一实例 id 重启会接管上次的租约。默认 xiaoba-<host>-<pid>。 */
  instanceId?: string;
  /** 只认领这些 slug；空 = 认领本账号名下所有应用。 */
  agentSlugs?: string[];
  /** 兜底命令（应用自己没声明 runner.command 时用）。 */
  fallbackCommand?: string;
  pollIntervalMs?: number;
  instanceHeartbeatMs?: number;
  runTimeoutMs?: number;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 注入命令执行器（测试用）。 */
  execImpl?: ExecCommand;
  logger?: Pick<typeof Logger, 'info' | 'warning'>;
}

export interface ExecCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecCommand = (command: string, options: ExecCommandOptions) => Promise<ExecCommandResult>;

export interface ExecCommandOptions {
  inputJson: string;
  inputFile: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ServiceWorkerSupervisor {
  start: () => void;
  stop: () => void;
  /** 认领并执行一轮（测试与 ⌘-once 语义用）。返回执行过的 run 数。 */
  runOnce: () => Promise<number>;
}

/** 把 stdout 变成 run 结果；与 Go 版 worker 的 buildResult 保持一致。 */
export function buildServiceRunResult(
  run: Pick<ClaimedRun, 'run_id' | 'session_id'>,
  stdout: string,
): { envelope: Record<string, unknown>; usage?: unknown } {
  const trimmed = stdout.trim();
  let output: unknown;
  let usage: unknown;
  let files: string[] = [];

  if (trimmed.startsWith('{')) {
    try {
      const structured = JSON.parse(trimmed) as {
        output?: unknown;
        files?: string[];
        usage?: unknown;
      };
      if (structured && structured.output !== undefined) {
        output = structured.output;
        usage = structured.usage;
        files = Array.isArray(structured.files) ? structured.files : [];
      }
    } catch {
      // 不是合法 JSON：按纯文本处理。
    }
  }
  if (output === undefined) output = { text: trimmed };

  const envelope: Record<string, unknown> = {
    contract_version: SERVICE_RUN_RESULT_CONTRACT,
    run_id: run.run_id,
    session_id: run.session_id,
    status: 'completed',
    output,
    files,
  };
  if (usage !== undefined) envelope.usage = usage;
  return { envelope, usage };
}

/** 展开命令模板里的占位符（与 Go 版一致）。 */
export function expandServiceRunCommand(
  template: string,
  run: Pick<ClaimedRun, 'agent_slug' | 'run_id' | 'session_id'>,
  inputFile: string,
): string {
  return template
    .split('{slug}').join(run.agent_slug)
    .split('{run_id}').join(run.run_id)
    .split('{session_id}').join(run.session_id)
    .split('{input_file}').join(inputFile);
}

/** 应用自己声明的命令优先，其次兜底命令；都没有返回空串（调用方按配置错误失败）。 */
export function serviceRunCommandFor(
  run: Pick<ClaimedRun, 'definition'>,
  fallbackCommand: string | undefined,
): string {
  const declared = run.definition?.runner?.command;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return (fallbackCommand ?? '').trim();
}

export function defaultServiceWorkerInstanceId(): string {
  const host = (os.hostname() || 'host').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 32);
  return `xiaoba-${host}-${process.pid}`.slice(0, 64);
}

/**
 * 杀掉「整条命令」的进程树。
 *
 * 只 kill 那个 shell 不够：Windows 上 shell:true 之后真正干活的是 cmd.exe 的孙进程，
 * 只杀 cmd.exe 会留下孤儿继续跑（实测：超时后 4 秒它还能写文件）；POSIX 上
 * sh -c 一旦是管道或带收尾操作也不会 exec 成单进程。所以：
 *   - Windows：taskkill /t /f 整棵树；
 *   - POSIX：spawn 时 detached 建新进程组，kill(-pid) 打整组。
 * 两条都失败时退化为单进程 kill。
 */
const killCommandTree = (child: import('node:child_process').ChildProcess): void => {
  const pid = child.pid;
  if (!pid) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      killer.on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      });
      return;
    } catch {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      return;
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
};

const execWithShell: ExecCommand = (command, options) =>
  new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    // Windows 分支必须用「整条命令 + shell:true」，不能写 spawn('cmd', ['/c', command])。
    // 后者会把命令再丢给 cmd.exe 重新分词，命令里内嵌的双引号就此被吃掉：
    //   node -e "console.log('x')"  → SyntaxError: Unterminated string constant
    //   node -e "console.log(process.env.CATSCO_AGENT)" → 静默空输出、exit 0
    // 用户写的 claude -p "总结一下" 会直接失效，且失败得毫无痕迹。
    // shell:true 时 Node 用 windowsVerbatimArguments 传 /d /s /c "<command>"，引号原样保留。
    // POSIX 上 detached 是为了建进程组，让超时能打掉整个组（见 killCommandTree）。
    const spawnOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      ...(isWindows ? {} : { detached: true }),
    };
    const child = isWindows
      ? spawn(command, { ...spawnOptions, shell: true })
      : spawn('sh', ['-c', command], spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      });
    };
    const timer = setTimeout(() => {
      killCommandTree(child);
      finish(-1);
    }, options.timeoutMs);
    const onAbort = () => {
      killCommandTree(child);
      finish(-1);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr.push(Buffer.from(String(error?.message ?? error)));
      finish(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      finish(typeof code === 'number' ? code : -1);
    });
    child.stdin?.end(options.inputJson);
  });

interface TicketState {
  token: string;
  refreshAt: number;
}

/**
 * 创建内嵌 worker。默认不启动；由调用方在合适时机 start()（客户端登录完成之后）。
 */
export function createServiceWorkerSupervisor(
  options: ServiceWorkerSupervisorOptions,
): ServiceWorkerSupervisor {
  const instanceId = (options.instanceId ?? defaultServiceWorkerInstanceId()).slice(0, 64);
  const agentSlugs = (options.agentSlugs ?? []).map((slug) => String(slug).trim()).filter(Boolean);
  const pollIntervalMs = Math.max(200, options.pollIntervalMs ?? DEFAULT_POLL_MS);
  const instanceHeartbeatMs = Math.max(1000, options.instanceHeartbeatMs ?? DEFAULT_INSTANCE_HEARTBEAT_MS);
  const runTimeoutMs = Math.max(1000, options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const doFetch = options.fetchImpl ?? fetch;
  const exec = options.execImpl ?? execWithShell;
  const logger = options.logger ?? Logger;

  let ticket: TicketState | null = null;
  let running = false;
  // stopped 只在显式 stop() 之后为 true：runOnce() 是「手动跑一轮」，不需要先 start()。
  let stopped = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const inflight = new Set<string>();

  const readAuthState = (): ServiceWorkerAuthState | null => {
    const snapshot = options.resolveAuth();
    if (!snapshot) return null;
    const token = String(snapshot.token ?? '').trim();
    const baseUrl = String(snapshot.httpBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!token || !baseUrl) return null;
    return { token, baseUrl, uid: String(snapshot.uid ?? '').trim() };
  };

  const postJson = async (
    auth: ServiceWorkerAuthState,
    token: string,
    pathName: string,
    body: unknown,
  ): Promise<any> => {
    const response = await doFetch(`${auth.baseUrl}${SERVICE_WORKER_API_PREFIX}${pathName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    if (!response.ok) {
      const error: any = new Error(`${pathName}: ${response.status} ${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  /**
   * 拿一张可用券：没有或快过期就用账号态换一张。
   * 账号态失效（401/403）时返回 null —— 停止认领，等用户重新登录。
   */
  const ensureTicket = async (auth: ServiceWorkerAuthState): Promise<string | null> => {
    if (ticket && Date.now() < ticket.refreshAt) return ticket.token;
    let payload: any;
    try {
      payload = await postJson(auth, auth.token, '/session', {});
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        logger.warning('CatsCo 内嵌 worker：账号态不可用，暂停认领（重新登录后自动恢复）');
        ticket = null;
        return null;
      }
      throw error;
    }
    const token = String(payload?.token ?? '').trim();
    if (!token) throw new Error('worker session: 平台没有返回券');
    const expiresAt = Date.parse(String(payload?.expires_at ?? ''));
    const lifetime = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 0;
    const refreshIn = lifetime > 0 ? lifetime * TICKET_REFRESH_RATIO : 5 * 60 * 1000;
    ticket = { token, refreshAt: Date.now() + Math.max(30_000, refreshIn) };
    return token;
  };

  const sendInstanceHeartbeat = async (activeRuns: number): Promise<void> => {
    const auth = readAuthState();
    if (!auth) return;
    let token: string | null;
    try {
      token = await ensureTicket(auth);
    } catch (error: any) {
      logger.warning(`CatsCo 内嵌 worker：换券失败 ${error?.message ?? error}`);
      return;
    }
    if (!token) return;
    // agents / serve_all 让平台知道这台机器能接哪些应用：调用方点工具时平台先看有没有
    // 在线 worker 能接单，没有就直接说清楚（worker_offline），不必让人干等。
    const metrics: Record<string, unknown> = {
      worker: 'xiaoba-embedded-worker',
      os: process.platform,
      arch: process.arch,
      pid: process.pid,
    };
    if (agentSlugs.length > 0) {
      metrics.agents = agentSlugs;
      metrics.serve_all = false;
    } else {
      metrics.agents = [];
      metrics.serve_all = true;
    }
    try {
      await postJson(auth, token, `/instances/${encodeURIComponent(instanceId)}/heartbeat`, {
        active_runs: activeRuns,
        metrics,
      });
    } catch (error: any) {
      logger.warning(`CatsCo 内嵌 worker：实例心跳失败 ${error?.message ?? error}`);
    }
  };

  const failRun = async (
    auth: ServiceWorkerAuthState,
    token: string,
    runId: string,
    message: string,
    retryable: boolean,
  ): Promise<void> => {
    try {
      await postJson(auth, token, `/runs/${encodeURIComponent(runId)}/fail`, {
        error_text: message.slice(0, 2000),
        retryable,
      });
    } catch (error: any) {
      logger.warning(`CatsCo 内嵌 worker：run=${runId} 失败上报失败 ${error?.message ?? error}`);
    }
  };

  /** 执行单个 run：先续租确认自己还持有，再跑命令，最后回填。 */
  const executeRun = async (auth: ServiceWorkerAuthState, token: string, run: ClaimedRun): Promise<void> => {
    const command = serviceRunCommandFor(run, options.fallbackCommand);
    if (!command) {
      await failRun(auth, token, run.run_id, 'no_command: 该应用没有声明本机执行命令', false);
      return;
    }
    let dir: string;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-run-'));
    } catch (error: any) {
      await failRun(auth, token, run.run_id, `temp_dir_failed: ${error?.message ?? error}`, true);
      return;
    }
    try {
      const inputJson = run.input === undefined ? '{}' : JSON.stringify(run.input);
      const inputFile = path.join(dir, 'input.json');
      fs.writeFileSync(inputFile, inputJson, { mode: 0o600 });
      const expanded = expandServiceRunCommand(command, run, inputFile);
      const result = await exec(expanded, {
        inputJson,
        inputFile,
        cwd: dir,
        timeoutMs: runTimeoutMs,
        env: {
          CATSCO_RUN_ID: run.run_id,
          CATSCO_SESSION_ID: run.session_id,
          CATSCO_AGENT: run.agent_slug,
          CATSCO_INPUT_FILE: inputFile,
          ...(run.service_token ? { CATSCO_SERVICE_TOKEN: run.service_token } : {}),
          ...(run.threshold_seconds ? { CATSCO_THRESHOLD_SECONDS: String(run.threshold_seconds) } : {}),
        },
      });

      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().slice(0, 400);
        // 超时（exitCode=-1 且我们杀的）按可重试，其他非零退出是确定性失败。
        await failRun(
          auth,
          token,
          run.run_id,
          result.exitCode === -1 ? `timeout: ${detail}` : `exit_${result.exitCode}: ${detail}`,
          result.exitCode === -1,
        );
        return;
      }

      const { envelope, usage } = buildServiceRunResult(run, result.stdout);
      try {
        await postJson(auth, token, `/runs/${encodeURIComponent(run.run_id)}/complete`, {
          result_id: `res_${run.run_id}`,
          result: envelope,
          ...(usage !== undefined ? { usage } : {}),
        });
        logger.info(`CatsCo 内嵌 worker：run=${run.run_id} agent=${run.agent_slug} 完成`);
      } catch (error: any) {
        // 回填失败按可重试：租约到期后会被重新认领（对端命令应保证幂等）。
        await failRun(auth, token, run.run_id, `complete_failed: ${error?.message ?? error}`, true);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    }
  };

  const claimOnce = async (auth: ServiceWorkerAuthState, token: string): Promise<ClaimedRun[]> => {
    const payload: Record<string, unknown> = { limit: 1, instance_id: instanceId };
    if (agentSlugs.length > 0) payload.agent_slugs = agentSlugs;
    const response = await postJson(auth, token, '/claim', payload);
    const runs = Array.isArray(response?.runs) ? (response.runs as ClaimedRun[]) : [];
    if (agentSlugs.length === 0) return runs;
    // 防御：存储层不支持按 slug 过滤时，把不属于自己的 run 立刻退回（可重试）。
    const kept: ClaimedRun[] = [];
    for (const run of runs) {
      if (agentSlugs.includes(run.agent_slug)) {
        kept.push(run);
        continue;
      }
      await failRun(auth, token, run.run_id, 'not_served_by_this_worker', true);
    }
    return kept;
  };

  const runOnce = async (): Promise<number> => {
    if (stopped) return 0;
    const auth = readAuthState();
    if (!auth) return 0;
    const token = await ensureTicket(auth);
    if (!token) return 0;
    const runs = await claimOnce(auth, token);
    let executed = 0;
    for (const run of runs) {
      if (stopped) break;
      if (inflight.has(run.run_id)) continue;
      inflight.add(run.run_id);
      try {
        await executeRun(auth, token, run);
        executed += 1;
      } finally {
        inflight.delete(run.run_id);
      }
    }
    return executed;
  };

  const scheduleNext = (delay: number) => {
    if (!running || stopped) return;
    loopTimer = setTimeout(() => { void tick(); }, delay);
    loopTimer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (!running || stopped) return;
    try {
      const executed = await runOnce();
      scheduleNext(executed > 0 ? 0 : pollIntervalMs);
    } catch (error: any) {
      logger.warning(`CatsCo 内嵌 worker：认领失败 ${error?.message ?? error}`);
      scheduleNext(DEFAULT_ERROR_BACKOFF_MS);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      logger.info(`CatsCo 内嵌 worker 启动 instance=${instanceId}`);
      void sendInstanceHeartbeat(0);
      heartbeatTimer = setInterval(() => {
        void sendInstanceHeartbeat(inflight.size);
      }, instanceHeartbeatMs);
      heartbeatTimer.unref?.();
      void tick();
    },
    stop() {
      stopped = true;
      running = false;
      inflight.clear();
      if (loopTimer) clearTimeout(loopTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      loopTimer = null;
      heartbeatTimer = null;
    },
    runOnce,
  };
}
