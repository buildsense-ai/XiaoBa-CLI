/**
 * 内嵌 service worker 的进程级装配（单例）。
 *
 * 为什么是进程级单例：认领是「谁在线谁接单」，同一个进程起两个认领会互相抢租约，
 * 只会让 run 反复被退回。所以全进程只允许一个，用 `ensureCatsCoServiceWorker()` 拿。
 *
 * 什么时候启动：客户端已经有账号登录态之后。没登录时 start() 只是空转（不发请求），
 * 登录完成后下一轮就会自动开始认领 —— 用户不需要重启，也不需要任何手动步骤。
 */
import * as path from 'path';
import { createCatsCoLocalConfigService } from './local-config';
import {
  createServiceWorkerSupervisor,
  type ServiceWorkerSupervisor,
} from './service-worker-supervisor';
import { Logger } from '../utils/logger';

/** 桌面端/CLI 通过它关掉内嵌 worker（排查与隔离测试用）。 */
const DISABLE_ENV = 'CATSCO_SERVICE_WORKER';
const INSTANCE_ENV = 'CATSCO_SERVICE_WORKER_INSTANCE';
const AGENTS_ENV = 'CATSCO_SERVICE_WORKER_AGENTS';
const COMMAND_ENV = 'CATSCO_SERVICE_WORKER_CMD';

let supervisor: ServiceWorkerSupervisor | null = null;
let started = false;

export interface EnsureServiceWorkerOptions {
  /** 运行时数据根（与本地配置一致）。 */
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
}

const splitSlugs = (raw: string | undefined): string[] =>
  String(raw ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);

/**
 * 取（必要时创建并启动）进程级内嵌 worker。
 * 环境变量 `CATSCO_SERVICE_WORKER=0` 时返回 null（完全关闭，不创建）。
 */
export function ensureCatsCoServiceWorker(
  options: EnsureServiceWorkerOptions = {},
): ServiceWorkerSupervisor | null {
  const env = options.env ?? process.env;
  if (String(env[DISABLE_ENV] ?? '').trim() === '0') return null;

  const runtimeRoot = options.runtimeRoot
    ?? path.resolve(env.CATSCO_RUNTIME_DATA_ROOT ?? env.CATSCOMPANY_RUNTIME_DATA_ROOT ?? process.cwd(), '.catsco');
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot, env });

  if (!supervisor) {
    supervisor = createServiceWorkerSupervisor({
      // 账号态就是用户登录后的 token / 平台地址，客户端本来就有；用户不需要抄任何密钥。
      resolveAuth: () => {
        try {
          const auth = localConfig.getAuthState();
          const token = String(auth.token ?? '').trim();
          const httpBaseUrl = String(auth.httpBaseUrl ?? '').trim();
          if (!token || !httpBaseUrl) return null;
          return { token, httpBaseUrl, uid: auth.uid };
        } catch (error: any) {
          Logger.warning(`CatsCo 内嵌 worker：读取账号态失败 ${error?.message ?? error}`);
          return null;
        }
      },
      ...(String(env[INSTANCE_ENV] ?? '').trim()
        ? { instanceId: String(env[INSTANCE_ENV]).trim() }
        : {}),
      agentSlugs: splitSlugs(env[AGENTS_ENV]),
      ...(String(env[COMMAND_ENV] ?? '').trim()
        ? { fallbackCommand: String(env[COMMAND_ENV]).trim() }
        : {}),
    });
  }

  if (!started) {
    started = true;
    supervisor.start();
  }
  return supervisor;
}

/** 仅供测试与进程退出时复位。 */
export function resetCatsCoServiceWorkerForTests(): void {
  supervisor?.stop();
  supervisor = null;
  started = false;
}
