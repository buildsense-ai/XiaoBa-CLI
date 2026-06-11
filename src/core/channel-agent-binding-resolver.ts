import type { ChannelAgentRouteBinding } from './session-router';
import type { IdentityTrustLevel } from '../types/session-identity';

export interface ChannelAgentBindingResolverOptions {
  httpBaseUrl?: string;
  token?: string;
  enabled?: boolean;
  required?: boolean;
  timeoutMs?: number;
}

export interface ChannelAgentBindingResolveInput {
  channel: 'feishu' | 'weixin';
  channelAppId?: string;
  channelUserId: string;
  channelConversationId?: string;
  channelConversationType?: 'p2p' | 'group';
}

export interface ChannelAgentBindingResolution extends ChannelAgentRouteBinding {
  bound: boolean;
  agentUid?: number;
  ownerUid?: number;
}

export const CHANNEL_BINDING_REQUIRED_MESSAGE = '请先扫描虚拟员工入口码完成绑定，然后再回来提问。';

export class ChannelAgentBindingResolver {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly misconfiguredRequired: boolean;
  private readonly httpBaseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: ChannelAgentBindingResolverOptions = {}) {
    this.httpBaseUrl = normalizeBaseUrl(options.httpBaseUrl);
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.required = Boolean(options.required);
    this.enabled = Boolean((options.enabled || options.required) && this.httpBaseUrl);
    this.misconfiguredRequired = Boolean(this.required && !this.httpBaseUrl);
  }

  async resolve(input: ChannelAgentBindingResolveInput): Promise<ChannelAgentBindingResolution | undefined> {
    if (this.misconfiguredRequired) {
      throw new Error('channel agent binding is required but CATSCO_CHANNEL_BINDING_HTTP_BASE_URL is missing');
    }
    if (!this.enabled) return undefined;
    const params = new URLSearchParams({
      channel: input.channel,
      channel_user_id: input.channelUserId,
      channel_conversation_type: input.channelConversationType || 'p2p',
    });
    if (input.channelAppId) params.set('channel_app_id', input.channelAppId);
    if (input.channelConversationId) params.set('channel_conversation_id', input.channelConversationId);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.httpBaseUrl}/api/channel-agent-bindings/resolve?${params.toString()}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(stringField(data, 'error') || `binding resolve failed: ${res.status}`);
      }
      if (data.bound !== true) {
        return { bound: false };
      }
      const agentId = stringField(data, 'agent_id') || agentIdFromUid(numberField(data, 'agent_uid'));
      if (!agentId) {
        throw new Error('binding response is missing agent_id');
      }
      return {
        bound: true,
        agentUid: numberField(data, 'agent_uid'),
        ownerUid: numberField(data, 'owner_uid'),
        agentId,
        agentBodyId: stringField(data, 'agent_body_id'),
        identityTrust: trustField(data, 'identity_trust') || 'server_canonical',
        identitySource: stringField(data, 'identity_source') || 'channel_agent_binding',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveChannelAgentBindingOptions(
  env: Record<string, string | undefined> = process.env,
): ChannelAgentBindingResolverOptions {
  return {
    httpBaseUrl: firstNonEmpty(
      env.CATSCO_CHANNEL_BINDING_HTTP_BASE_URL,
      env.CATSCOMPANY_CHANNEL_BINDING_HTTP_BASE_URL,
    ),
    token: firstNonEmpty(env.CATSCO_CHANNEL_BINDING_TOKEN, env.CATSCOMPANY_CHANNEL_BINDING_TOKEN),
    enabled: parseBoolean(firstNonEmpty(
      env.CATSCO_CHANNEL_AGENT_BINDING_ENABLED,
      env.CATSCOMPANY_CHANNEL_AGENT_BINDING_ENABLED,
    )),
    required: parseBoolean(firstNonEmpty(
      env.CATSCO_CHANNEL_AGENT_BINDING_REQUIRED,
      env.CATSCOMPANY_CHANNEL_AGENT_BINDING_REQUIRED,
    )),
    timeoutMs: parsePositiveInteger(firstNonEmpty(
      env.CATSCO_CHANNEL_BINDING_TIMEOUT_MS,
      env.CATSCOMPANY_CHANNEL_BINDING_TIMEOUT_MS,
    )),
  };
}

function normalizeBaseUrl(value?: string): string {
  const text = value?.trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return undefined;
}

function parseBoolean(value?: string): boolean {
  const text = value?.trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'required';
}

function parsePositiveInteger(value?: string): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function normalizeTimeout(value?: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 2500;
  return Math.max(250, Math.min(Math.floor(value), 10000));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function trustField(record: Record<string, unknown>, key: string): IdentityTrustLevel | undefined {
  const value = stringField(record, key);
  if (value === 'server_canonical' || value === 'legacy_context' || value === 'untrusted') {
    return value;
  }
  return undefined;
}

function agentIdFromUid(uid?: number): string | undefined {
  return uid && uid > 0 ? `usr${uid}` : undefined;
}
