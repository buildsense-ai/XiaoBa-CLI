import matter from 'gray-matter';
import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from './local-config';
import type { CatsThinToolRpcMessage } from './client';
import {
  finalizeCurrentBotPublicSkillNow,
  withCurrentBotSkillWorkspaceWrite,
} from '../bot-skills/runtime';
import { scanBotSkillWorkspace } from '../bot-skills/local-manifest';
import { readSkillHubLocalMetadata } from '../skillhub/local-skill-metadata';
import { shareLocalSkillForCatsCo } from '../skillhub/local-share';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

export const SKILLHUB_THIN_RPC_TOOLS = {
  workspace: 'skillhub.localWorkspace.get',
  share: 'skillhub.localSkill.share',
  finalize: 'skillhub.localSkill.finalize',
  switchBot: 'skillhub.localBot.switch',
} as const;

const MAX_SKILLS = 200;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_RELATIVE_PATH_LENGTH = 500;
const MAX_COMPLETED_REQUESTS = 256;
const BOT_UID_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class SkillHubThinRpcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SkillHubThinRpcError';
  }
}

export interface SkillHubThinRpcHandlerOptions {
  runtimeRoot?: string;
  scheduleBotSwitch?: (botUid: string) => void;
  finalizeCurrentBotSkill?: typeof finalizeCurrentBotPublicSkillNow;
  isShuttingDown?: () => boolean;
}

export class SkillHubThinRpcHandler {
  private readonly runtimeRoot: string;
  private readonly scheduleBotSwitch: (botUid: string) => void;
  private readonly finalizeCurrentBotSkill: typeof finalizeCurrentBotPublicSkillNow;
  private readonly isShuttingDown: () => boolean;
  private readonly completed = new Map<string, {
    fingerprint: string;
    operation: Promise<Record<string, unknown>>;
  }>();

  constructor(options: SkillHubThinRpcHandlerOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.isShuttingDown = options.isShuttingDown ?? (() => false);
    this.scheduleBotSwitch = options.scheduleBotSwitch
      ?? ((botUid) => scheduleDashboardBotSwitch(botUid, this.isShuttingDown));
    this.finalizeCurrentBotSkill = options.finalizeCurrentBotSkill
      ?? finalizeCurrentBotPublicSkillNow;
  }

  supports(toolName: string): boolean {
    return Object.values(SKILLHUB_THIN_RPC_TOOLS).includes(toolName as any);
  }

  async execute(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    this.assertOperational(request);
    const requestID = String(request.request_id || '').trim();
    if (!requestID) throw new SkillHubThinRpcError('INVALID_REQUEST', 'request_id is required.');
    const fingerprint = requestFingerprint(request);
    const existing = this.completed.get(requestID);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SkillHubThinRpcError(
          'REQUEST_ID_CONFLICT',
          'request_id was already used for a different SkillHub operation.',
        );
      }
      const payload = recordValue(request.payload);
      const botUid = requiredText(payload.bot_uid, 'bot_uid', 160);
      if (!BOT_UID_PATTERN.test(botUid)) {
        throw new SkillHubThinRpcError('INVALID_BOT_UID', 'bot_uid is invalid.');
      }
      this.assertRequestScope(
        request,
        botUid,
        request.tool_name !== SKILLHUB_THIN_RPC_TOOLS.switchBot,
      );
      return existing.operation;
    }
    const operation = this.executeOnce(request);
    this.completed.set(requestID, { fingerprint, operation });
    while (this.completed.size > MAX_COMPLETED_REQUESTS) {
      this.completed.delete(this.completed.keys().next().value as string);
    }
    return operation;
  }

  private async executeOnce(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    this.assertOperational(request);
    const payload = recordValue(request.payload);
    const botUid = requiredText(payload.bot_uid, 'bot_uid', 160);
    if (!BOT_UID_PATTERN.test(botUid)) {
      throw new SkillHubThinRpcError('INVALID_BOT_UID', 'bot_uid is invalid.');
    }
    const scope = this.assertRequestScope(request, botUid, request.tool_name !== SKILLHUB_THIN_RPC_TOOLS.switchBot);

    if (request.tool_name === SKILLHUB_THIN_RPC_TOOLS.switchBot) {
      this.scheduleBotSwitch(botUid);
      return {
        schema: 'xiaoba.skillhub.bot_switch.v1',
        bot_uid: botUid,
        switching: true,
      };
    }

    switch (request.tool_name) {
      case SKILLHUB_THIN_RPC_TOOLS.workspace:
        return this.readWorkspace(botUid, request);
      case SKILLHUB_THIN_RPC_TOOLS.share:
        return this.shareSkill(botUid, scope.ownerUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.finalize:
        return this.finalizeSkill(botUid, payload, request);
      default:
        throw new SkillHubThinRpcError('TOOL_NOT_FOUND', 'Unsupported SkillHub device operation.');
    }
  }

  private async readWorkspace(
    botUid: string,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    return withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertOperational(request);
      this.assertRequestScope(request, botUid, true);
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId);
      const entries = scanBotSkillWorkspace(context.skillsRoot).slice(0, MAX_SKILLS);
      const skills = entries.map((entry) => {
        const parsed = matter(fs.readFileSync(path.join(entry.path, 'SKILL.md'), 'utf8'));
        const metadata = readSkillHubLocalMetadata(path.join(entry.path, 'SKILL.md'));
        return {
          local_skill_id: limitText(entry.localSkillId, MAX_NAME_LENGTH),
          name: limitText(entry.name, MAX_NAME_LENGTH),
          description: limitText(String(parsed.data?.description || ''), MAX_DESCRIPTION_LENGTH),
          relative_path: limitText(entry.installName, MAX_RELATIVE_PATH_LENGTH),
          source: 'user',
          can_share: !entry.reference || isPrivateSkillReference(entry.reference.skillId),
          skill_hub: {
            ...(metadata || {}),
            ...(entry.reference ? { reference: entry.reference } : {}),
          },
        };
      });
      return {
        schema: 'xiaoba.skillhub.local_workspace.v1',
        bot_uid: botUid,
        active_bot_uid: context.activeBotId,
        skills_path: fs.realpathSync(context.skillsRoot),
        skills,
      };
    }, { runtimeRoot: this.runtimeRoot });
  }

  private async shareSkill(
    botUid: string,
    ownerUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const skillName = requiredText(payload.skill_name, 'skill_name', MAX_NAME_LENGTH);
    await withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId);
      const entry = scanBotSkillWorkspace(context.skillsRoot).find((candidate) => (
        candidate.localSkillId === localSkillId && candidate.name === skillName
      ));
      if (!entry) {
        throw new SkillHubThinRpcError('LOCAL_SKILL_NOT_FOUND', 'The selected local Skill no longer exists.');
      }
    }, { runtimeRoot: this.runtimeRoot });

    const configService = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot });
    const result = await shareLocalSkillForCatsCo({
      skillName,
      expectedLocalSkillId: localSkillId,
      expectedBotUid: botUid,
      expectedUserUid: ownerUid,
      confirmVersionPublish: payload.confirm_publish === true,
    }, {
      writeLocalMetadata: false,
      runtimeRoot: this.runtimeRoot,
      getCatsCoAuth: () => {
        const auth = configService.getAuthState();
        return {
          token: String(auth.token || ''),
          baseUrl: auth.httpBaseUrl,
          user: {
            uid: auth.uid,
            username: auth.username,
            displayName: auth.displayName,
          },
        };
      },
      validateScope: (context) => {
        this.assertOperational(request);
        this.assertRequestScope(request, botUid, true);
        this.assertActiveWorkspace(botUid, context.botId, context.activeBotId);
      },
    });
    return {
      schema: 'xiaoba.skillhub.local_share.v1',
      bot_uid: botUid,
      skill: {
        id: String(result?.skill?.id || ''),
        name: skillName,
      },
      latest_version: String(result?.latestVersion || ''),
      content_hash: String(result?.contentHash || '').toLowerCase(),
      skill_hub: result?.skillHub ? {
        author: String(result.skillHub.author || ''),
        version: String(result.skillHub.version || ''),
        uploaded_at: String(result.skillHub.uploadedAt || ''),
      } : {},
      requires_confirmation: Boolean(result?.requiresConfirmation),
    };
  }

  private async finalizeSkill(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const skillName = requiredText(payload.skill_name, 'skill_name', MAX_NAME_LENGTH);
    const skillId = requiredText(payload.skill_id, 'skill_id', MAX_RELATIVE_PATH_LENGTH);
    const version = requiredText(payload.version, 'version', MAX_NAME_LENGTH);
    const contentHash = requiredText(payload.content_hash, 'content_hash', 64).toLowerCase();
    if (!CONTENT_HASH_PATTERN.test(contentHash)) {
      throw new SkillHubThinRpcError('INVALID_CONTENT_HASH', 'content_hash is invalid.');
    }
    let result;
    try {
      result = await this.finalizeCurrentBotSkill(botUid, {
        localSkillId,
        skillName,
        reference: {
          source: 'skillhub',
          skillId,
          version,
          contentHash,
        },
      }, {
        runtimeRoot: this.runtimeRoot,
        publicationWaitMs: Math.max(
          0,
          Math.min(45_000, Number(request.expires_at || 0) - Date.now() - 1_000),
        ),
        validateScope: () => {
          this.assertOperational(request);
          this.assertRequestScope(request, botUid, true);
        },
      });
    } catch (error: any) {
      if (error instanceof SkillHubThinRpcError) throw error;
      throw new SkillHubThinRpcError(
        String(error?.code || 'SKILLHUB_FINALIZE_FAILED'),
        error?.message || 'The public Skill could not be finalized.',
      );
    }
    if (result.botId !== botUid) {
      throw new SkillHubThinRpcError(
        'BOT_NOT_ACTIVE',
        'The selected Bot workspace changed before finalization completed.',
      );
    }
    const matched = result?.skills?.some((reference) => (
      reference.skillId === skillId
      && reference.version === version
      && reference.contentHash === contentHash
    ));
    if (!matched) {
      throw new SkillHubThinRpcError(
        'BOT_DEFINITION_NOT_READY',
        'The public Skill reference is not present in the current BotDefinition yet.',
      );
    }
    return {
      schema: 'xiaoba.skillhub.local_finalize.v1',
      bot_uid: botUid,
      skill_id: skillId,
      version,
      content_hash: contentHash,
      direction: result?.direction || 'none',
    };
  }

  private assertOperational(request: CatsThinToolRpcMessage): void {
    if (this.isShuttingDown()) {
      throw new SkillHubThinRpcError(
        'SHUTTING_DOWN',
        'The XiaoBa device is shutting down. Retry the SkillHub operation after it reconnects.',
      );
    }
    this.assertFreshRequest(request);
  }

  private assertFreshRequest(request: CatsThinToolRpcMessage): void {
    const expiresAt = Number(request.expires_at || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SkillHubThinRpcError('REQUEST_EXPIRED', 'The SkillHub device request has expired.');
    }
  }

  private assertRequestScope(
    request: CatsThinToolRpcMessage,
    botUid: string,
    requireActiveBot: boolean,
  ): { ownerUid: string; deviceId: string } {
    const config = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot }).load();
    const ownerUid = String(config.currentBot?.boundByUserUid || config.account?.uid || '').trim();
    if (!ownerUid || normalizeUid(request.target_owner_user_id) !== normalizeUid(ownerUid)) {
      throw new SkillHubThinRpcError('OWNER_MISMATCH', 'The local CatsCo account does not match this request.');
    }
    const deviceId = String(config.device?.deviceId || config.device?.installationId || '').trim();
    const requestDeviceId = String(request.target_device_id || request.device_id || '').trim();
    if (!deviceId || requestDeviceId !== deviceId) {
      throw new SkillHubThinRpcError('DEVICE_MISMATCH', 'The request targets a different XiaoBa device.');
    }
    if (requireActiveBot && String(config.currentBot?.uid || '').trim() !== botUid) {
      throw new SkillHubThinRpcError('BOT_NOT_ACTIVE', 'The selected Bot is not active on this XiaoBa device.');
    }
    return { ownerUid, deviceId };
  }

  private assertActiveWorkspace(botUid: string, configuredBotUid?: string, activeBotUid?: string): void {
    if (configuredBotUid !== botUid || activeBotUid !== botUid) {
      throw new SkillHubThinRpcError('BOT_NOT_ACTIVE', 'The selected Bot workspace is not active on this device.');
    }
  }
}

export function scheduleDashboardBotSwitch(
  botUid: string,
  isShuttingDown: () => boolean = () => false,
): void {
  const timer = setTimeout(() => {
    if (isShuttingDown()) return;
    void requestDashboardBotSwitch(botUid).catch((error) => {
      Logger.warning(`SkillHub remote Bot switch failed: ${error?.message || String(error)}`);
    });
  }, 1_000);
  timer.unref?.();
}

export async function requestDashboardBotSwitch(
  botUid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const numericPort = Number(process.env.XIAOBA_DASHBOARD_PORT || 3800);
  const port = Number.isSafeInteger(numericPort) && numericPort > 0 && numericPort <= 65535
    ? numericPort
    : 3800;
  const apiKey = String(process.env.DASHBOARD_API_KEY || '').trim();
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/cats/switch-bot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ botUid }),
  });
  if (!response.ok) {
    throw new Error(`Dashboard rejected the Bot switch (HTTP ${response.status}).`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || text.includes('\0')) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return text;
}

function limitText(value: string, maxLength: number): string {
  const text = String(value || '');
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function normalizeUid(value: unknown): string {
  return String(value || '').trim().replace(/^usr/i, '');
}

function isPrivateSkillReference(skillId: string): boolean {
  const value = String(skillId || '');
  return value.startsWith('priv_') || value.startsWith('private/');
}

function requestFingerprint(request: CatsThinToolRpcMessage): string {
  return stableSerialize({
    target_owner_user_id: normalizeUid(request.target_owner_user_id),
    target_device_id: String(request.target_device_id || request.device_id || '').trim(),
    tool_name: String(request.tool_name || '').trim(),
    payload: recordValue(request.payload),
    expires_at: Number(request.expires_at || 0),
  });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
