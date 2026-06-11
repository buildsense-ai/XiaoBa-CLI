import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CatsCoRuntimeConfigResolution, resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { writeDashboardEnvUpdates } from './settings';

export interface WeixinAgentChannelBinding {
  channel: 'weixin';
  agentUid: string;
  agentName?: string;
  agentUsername?: string;
  bodyId?: string;
  boundByUserUid?: string;
  boundByUsername?: string;
  tokenHash: string;
  tokenLast4?: string;
  legacyEnvKey: 'WEIXIN_TOKEN';
  createdAt: string;
  updatedAt: string;
}

export interface ChannelBindingsFile {
  version: 1;
  weixin?: WeixinAgentChannelBinding;
  updatedAt?: string;
}

export interface WeixinChannelStatus {
  configured: boolean;
  currentAgent?: WeixinCurrentAgentSnapshot;
  binding?: WeixinAgentChannelBinding;
  mismatch?: boolean;
  reason?: string;
}

export interface WeixinCurrentAgentSnapshot {
  uid: string;
  name?: string;
  username?: string;
  bodyId?: string;
  ownerUid?: string;
  ownerUsername?: string;
}

export interface BindWeixinChannelResult {
  binding: WeixinAgentChannelBinding;
  updatedEnv: string[];
  bindingPath: string;
}

export function resolveChannelBindingsPath(runtimeRoot = process.cwd()): string {
  return path.join(runtimeRoot, '.xiaoba', 'channel-bindings.json');
}

export function loadChannelBindings(runtimeRoot = process.cwd()): ChannelBindingsFile {
  const bindingPath = resolveChannelBindingsPath(runtimeRoot);
  if (!fs.existsSync(bindingPath)) return { version: 1 };
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    if (parsed && parsed.version === 1) return parsed as ChannelBindingsFile;
  } catch {
    // Fall through to an empty file; callers can bind again.
  }
  return { version: 1 };
}

export function saveChannelBindings(runtimeRoot: string, data: ChannelBindingsFile): void {
  const bindingPath = resolveChannelBindingsPath(runtimeRoot);
  const dir = path.dirname(bindingPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodPrivateDirectory(dir);
  const next: ChannelBindingsFile = {
    ...data,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${bindingPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodOwnerOnly(tempPath);
  fs.renameSync(tempPath, bindingPath);
  chmodOwnerOnly(bindingPath);
}

export function currentWeixinAgent(runtime: CatsCoRuntimeConfigResolution): WeixinCurrentAgentSnapshot | undefined {
  const bot = runtime.localConfig.currentBot;
  if (!runtime.bodyConfigured || !bot?.uid) return undefined;
  return {
    uid: bot.uid,
    name: bot.name,
    username: bot.username,
    bodyId: runtime.localConfig.device?.bodyId,
    ownerUid: runtime.localConfig.account?.uid,
    ownerUsername: runtime.localConfig.account?.username,
  };
}

export function getWeixinChannelStatus(options: {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): WeixinChannelStatus {
  const runtimeRoot = options.runtimeRoot || process.cwd();
  const fileEnv = readEnvFile(runtimeRoot);
  const effectiveEnv = {
    ...fileEnv,
    ...(options.env || process.env),
  };
  const runtime = resolveCatsCoRuntimeConfig({ runtimeRoot, env: effectiveEnv });
  const currentAgent = currentWeixinAgent(runtime);
  const binding = loadChannelBindings(runtimeRoot).weixin;
  if (!currentAgent) {
    return {
      configured: false,
      binding,
      reason: '请先登录 CatsCo，并选择/绑定当前 agent body。',
    };
  }
  if (!binding) {
    return {
      configured: false,
      currentAgent,
      reason: '当前 agent 尚未绑定微信通道。',
    };
  }
  const mismatch = binding.agentUid !== currentAgent.uid;
  const tokenConfigured = Boolean(firstNonEmpty(effectiveEnv.WEIXIN_TOKEN));
  const reason = mismatch
    ? `微信通道绑定在 agent ${binding.agentUid}，当前 agent 是 ${currentAgent.uid}。`
    : tokenConfigured
      ? undefined
      : '微信通道绑定元数据存在，但 WEIXIN_TOKEN 缺失，请重新扫码。';
  return {
    configured: !mismatch && tokenConfigured,
    currentAgent,
    binding,
    mismatch,
    reason,
  };
}

export function bindWeixinChannelToCurrentAgent(options: {
  token: string;
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  expectedAgentUid?: string;
}): BindWeixinChannelResult {
  const runtimeRoot = options.runtimeRoot || process.cwd();
  const env = options.env || process.env;
  const token = String(options.token || '').trim();
  if (!token) throw new Error('微信授权未返回 token');

  const runtime = resolveCatsCoRuntimeConfig({ runtimeRoot, env });
  const agent = currentWeixinAgent(runtime);
  if (!agent) {
    throw new Error('请先在 CatsCo Chat 里选择并绑定当前 agent，再绑定微信通道');
  }
  if (options.expectedAgentUid && options.expectedAgentUid !== agent.uid) {
    throw new Error(`扫码开始时的 agent 是 ${options.expectedAgentUid}，当前 agent 是 ${agent.uid}，请重新扫码`);
  }

  const existing = loadChannelBindings(runtimeRoot);
  const previous = existing.weixin;
  const now = new Date().toISOString();
  const binding: WeixinAgentChannelBinding = {
    channel: 'weixin',
    agentUid: agent.uid,
    agentName: agent.name,
    agentUsername: agent.username,
    bodyId: agent.bodyId,
    boundByUserUid: agent.ownerUid,
    boundByUsername: agent.ownerUsername,
    tokenHash: hashToken(token),
    tokenLast4: last4(token),
    legacyEnvKey: 'WEIXIN_TOKEN',
    createdAt: previous?.agentUid === agent.uid ? previous.createdAt : now,
    updatedAt: now,
  };

  saveChannelBindings(runtimeRoot, {
    ...existing,
    weixin: binding,
  });

  const envResult = writeDashboardEnvUpdates(runtimeRoot, {
    WEIXIN_TOKEN: token,
    WEIXIN_BOUND_AGENT_UID: agent.uid,
    WEIXIN_BOUND_AGENT_NAME: agent.name || agent.username || '',
    WEIXIN_BOUND_BODY_ID: agent.bodyId || '',
    WEIXIN_BOUND_BY_USER_UID: agent.ownerUid || '',
  });

  env.WEIXIN_TOKEN = token;
  env.WEIXIN_BOUND_AGENT_UID = agent.uid;
  env.WEIXIN_BOUND_AGENT_NAME = agent.name || agent.username || '';
  process.env.WEIXIN_TOKEN = token;
  process.env.WEIXIN_BOUND_AGENT_UID = agent.uid;
  process.env.WEIXIN_BOUND_AGENT_NAME = agent.name || agent.username || '';
  if (agent.bodyId) {
    env.WEIXIN_BOUND_BODY_ID = agent.bodyId;
    process.env.WEIXIN_BOUND_BODY_ID = agent.bodyId;
  }
  if (agent.ownerUid) {
    env.WEIXIN_BOUND_BY_USER_UID = agent.ownerUid;
    process.env.WEIXIN_BOUND_BY_USER_UID = agent.ownerUid;
  }

  return {
    binding,
    updatedEnv: envResult.updated,
    bindingPath: resolveChannelBindingsPath(runtimeRoot),
  };
}

export function weixinBindingEnvOverlay(options: {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Record<string, string> {
  const status = getWeixinChannelStatus(options);
  if (!status.configured || !status.binding) return {};
  const agentName = status.binding.agentName || status.binding.agentUsername || '';
  const overlay: Record<string, string> = {
    WEIXIN_BOUND_AGENT_UID: status.binding.agentUid,
    WEIXIN_BOUND_AGENT_NAME: agentName,
  };
  if (status.binding.bodyId) overlay.WEIXIN_BOUND_BODY_ID = status.binding.bodyId;
  if (status.binding.boundByUserUid) overlay.WEIXIN_BOUND_BY_USER_UID = status.binding.boundByUserUid;
  if (agentName) overlay.CURRENT_AGENT_DISPLAY_NAME = agentName;
  return overlay;
}

function readEnvFile(runtimeRoot: string): Record<string, string> {
  const envPath = path.join(runtimeRoot, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function last4(token: string): string | undefined {
  return token.length >= 4 ? token.slice(-4) : undefined;
}

function chmodOwnerOnly(filePath: string, mode = 0o600): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best-effort permission hardening.
  }
}

function chmodPrivateDirectory(dirPath: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort permission hardening.
  }
}
