const DEFAULT_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cn';
const DEFAULT_TIMEOUT_MS = 2_500;

export type CatsCoBotSwitchGuardCode =
  | 'BOT_BINDING_UNVERIFIED'
  | 'BOT_BOUND_TO_OTHER_RUNTIME';

export class CatsCoBotSwitchGuardError extends Error {
  constructor(
    public readonly code: CatsCoBotSwitchGuardCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatsCoBotSwitchGuardError';
  }
}

export interface VerifyCatsCoBotSwitchBindingOptions {
  httpBaseUrl?: string;
  token?: string;
  botUid?: string;
  localBodyId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VerifiedCatsCoBotSwitchBinding {
  botUid: string;
  localBodyId: string;
  platformBodyId?: string;
  bound: boolean;
}

export async function verifyCatsCoBotSwitchBinding(
  options: VerifyCatsCoBotSwitchBindingOptions,
): Promise<VerifiedCatsCoBotSwitchBinding> {
  const token = String(options.token || '').trim();
  const botUid = String(options.botUid || '').trim();
  const localBodyId = String(options.localBodyId || '').trim();
  const httpBaseUrl = String(options.httpBaseUrl || DEFAULT_CATSCO_HTTP_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  if (!token || !/^\d+$/.test(botUid) || Number(botUid) <= 0 || !localBodyId || !httpBaseUrl) {
    throw unverified('无法确认目标 Agent 的运行环境绑定，已停止切换。');
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(
      `${httpBaseUrl}/api/bots/body-status?uid=${encodeURIComponent(botUid)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw unverified('CatsCo 暂时无法确认目标 Agent 的运行环境绑定，已停止切换。');
  }
  if (!response.ok) {
    throw unverified(`CatsCo 无法确认目标 Agent 的运行环境绑定（HTTP ${response.status}），已停止切换。`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw unverified('CatsCo 返回了无法识别的运行环境状态，已停止切换。');
  }
  const responseBotUid = String(payload.bot_uid || payload.botUid || '').trim();
  const bound = payload.bound;
  const platformBodyId = String(payload.body_id || payload.bodyId || '').trim();
  if (
    responseBotUid !== botUid
    || typeof bound !== 'boolean'
    || (bound === true && !platformBodyId)
    || (bound === false && Boolean(platformBodyId))
  ) {
    throw unverified('CatsCo 返回了不完整的运行环境绑定状态，已停止切换。');
  }
  if (bound && platformBodyId !== localBodyId) {
    throw new CatsCoBotSwitchGuardError(
      'BOT_BOUND_TO_OTHER_RUNTIME',
      '目标 Agent 已绑定另一台 XiaoBa Runtime，已停止切换。',
    );
  }
  return {
    botUid,
    localBodyId,
    platformBodyId: platformBodyId || undefined,
    bound,
  };
}

function unverified(message: string): CatsCoBotSwitchGuardError {
  return new CatsCoBotSwitchGuardError('BOT_BINDING_UNVERIFIED', message);
}
