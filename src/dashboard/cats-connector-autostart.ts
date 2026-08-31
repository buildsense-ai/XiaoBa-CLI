import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { PathResolver } from '../utils/path-resolver';

export type CatsConnectorBootstrapStage =
  | 'idle'
  | 'waiting_for_login'
  | 'connecting'
  | 'connected'
  | 'disabled'
  | 'error';

export interface CatsConnectorBootstrapSnapshot {
  stage: CatsConnectorBootstrapStage;
  trigger: string;
  attempt: number;
  message: string;
  error?: string;
  startedAt?: string;
  updatedAt: string;
}

export interface CatsConnectorAutoStartOptions {
  port: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  runtimeRoot?: string;
}

interface CatsStatusPayload {
  connected?: boolean;
  bodyConfigured?: boolean;
  configured?: boolean;
  service?: { status?: string };
  authStatus?: string;
  authError?: string;
}

/**
 * Owns the Dashboard-side connector bootstrap lifecycle.
 *
 * The coordinator deliberately drives the same loopback API used by the UI so
 * startup, login and manual retry all share one setup contract. It also keeps
 * the setup work independent from whether a Dashboard page remains open.
 */
export class CatsConnectorAutoStart {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeRoot: string;
  private inFlight?: Promise<CatsConnectorBootstrapSnapshot>;
  private active?: { trigger: string; force: boolean };
  private scheduled?: NodeJS.Timeout;
  private pending?: { trigger: string; force: boolean };
  private generation = 0;
  private snapshot: CatsConnectorBootstrapSnapshot = {
    stage: 'idle',
    trigger: 'startup',
    attempt: 0,
    message: '等待检查 CatsCo 连接',
    updatedAt: new Date().toISOString(),
  };

  constructor(options: CatsConnectorAutoStartOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}/api`;
    this.apiKey = String(options.apiKey || '').trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runtimeRoot = options.runtimeRoot || PathResolver.getRuntimeDataRoot();
  }

  getSnapshot(): CatsConnectorBootstrapSnapshot {
    return { ...this.snapshot };
  }

  schedule(
    trigger: string,
    delayMs = 0,
    options: { force?: boolean } = {},
  ): CatsConnectorBootstrapSnapshot {
    this.pending = { trigger, force: options.force === true };
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.drainPending();
    }, Math.max(0, delayMs));
    return this.getSnapshot();
  }

  invalidateAndSchedule(
    trigger: string,
    delayMs = 0,
    options: { force?: boolean } = {},
  ): CatsConnectorBootstrapSnapshot {
    this.generation += 1;
    if (trigger !== 'logout') {
      this.setSnapshot({
        stage: 'connecting',
        trigger,
        message: '正在应用新的账号或 Agent 并重新连接',
        error: undefined,
        startedAt: new Date().toISOString(),
      });
    }
    return this.schedule(trigger, delayMs, options);
  }

  async run(trigger: string, options: { force?: boolean } = {}): Promise<CatsConnectorBootstrapSnapshot> {
    const force = options.force === true;
    if (this.inFlight) {
      if (this.active?.trigger !== trigger || this.active.force !== force) {
        this.pending = { trigger, force };
      }
      return this.inFlight;
    }
    const generation = this.generation;
    this.active = { trigger, force };
    const run = this.runOnce(trigger, options, generation);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
      this.active = undefined;
      if (this.pending && !this.scheduled) this.schedule(this.pending.trigger, 0, { force: this.pending.force });
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = undefined;
    }
    this.pending = undefined;
  }

  private async drainPending(): Promise<void> {
    const next = this.pending;
    this.pending = undefined;
    if (!next) return;
    await this.run(next.trigger, { force: next.force });
  }

  private async runOnce(
    trigger: string,
    options: { force?: boolean },
    generation: number,
  ): Promise<CatsConnectorBootstrapSnapshot> {
    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot });
    const config = localConfig.load();
    const autoConnect = config.preferences?.autoConnect ?? true;
    if (!autoConnect && !options.force) {
      return this.setSnapshot({
        stage: 'disabled',
        trigger,
        message: '自动连接已关闭',
        error: undefined,
      });
    }

    const auth = localConfig.getAuthState();
    if (!auth.token || !auth.uid) {
      if (trigger === 'logout') {
        try {
          await this.request('/cats/connector/stop', { method: 'POST', body: '{}' });
        } catch {
          // Logout already stopped the service directly. This is a final
          // best-effort fence for a setup that completed concurrently.
        }
      }
      return this.setSnapshot({
        stage: 'waiting_for_login',
        trigger,
        message: '登录 CatsCo 后将自动连接这台电脑',
        error: undefined,
      });
    }

    const startedAt = new Date().toISOString();
    this.setSnapshot({
      stage: 'connecting',
      trigger,
      attempt: this.snapshot.attempt + 1,
      message: '正在准备本机 Agent 并启动 Connector',
      error: undefined,
      startedAt,
    });

    try {
      const status = await this.request<CatsStatusPayload>('/cats/status');
      if (generation !== this.generation) return this.getSnapshot();
      if (status.authStatus === 'invalid' || !status.connected) {
        return this.setSnapshot({
          stage: 'waiting_for_login',
          trigger,
          message: status.authError || 'CatsCo 登录已失效，请重新登录',
          error: status.authError || undefined,
          startedAt,
        });
      }

      if (status.configured && status.service?.status === 'running') {
        return this.setSnapshot({
          stage: 'connected',
          trigger,
          message: '这台电脑已连接 CatsCo',
          error: undefined,
          startedAt,
        });
      }

      if (status.bodyConfigured) {
        await this.request('/cats/connector/start', { method: 'POST', body: '{}' });
      } else {
        // Model, prompt and skill choices are cloud-authoritative. Automatic
        // provisioning must not rotate legacy relay credentials as a side effect.
        await this.request('/cats/setup', {
          method: 'POST',
          body: JSON.stringify({ setupRelayModel: false }),
        });
      }

      if (generation !== this.generation) return this.getSnapshot();

      return this.setSnapshot({
        stage: 'connected',
        trigger,
        message: '这台电脑已连接 CatsCo',
        error: undefined,
        startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.setSnapshot({
        stage: 'error',
        trigger,
        message: '自动连接未完成',
        error: message,
        startedAt,
      });
    }
  }

  private setSnapshot(
    patch: Partial<CatsConnectorBootstrapSnapshot> & Pick<CatsConnectorBootstrapSnapshot, 'stage' | 'trigger' | 'message'>,
  ): CatsConnectorBootstrapSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return this.getSnapshot();
  }

  private async request<T = Record<string, unknown>>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (init.body != null) headers.set('Content-Type', 'application/json');
    if (this.apiKey) headers.set('X-API-Key', this.apiKey);
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const nested = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : undefined;
      const message = String(data.error || nested?.error || `HTTP ${response.status}`);
      throw new Error(message);
    }
    return data as T;
  }
}
