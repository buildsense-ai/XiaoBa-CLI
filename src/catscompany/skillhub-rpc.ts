import matter from 'gray-matter';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from './local-config';
import type { CatsThinToolRpcMessage } from './client';
import {
  BotSkillWorkspaceChangingError,
  finalizeCurrentBotPublicSkillNow,
  withCurrentBotSkillWorkspaceWrite,
} from '../bot-skills/runtime';
import {
  BotSkillWorkspaceScanLimitError,
  isEphemeralSkillDirectory,
  scanBotSkillWorkspace,
} from '../bot-skills/local-manifest';
import { trashBotSkill } from '../bot-skills/deleted-skill-trash';
import { readSkillHubLocalMetadata } from '../skillhub/local-skill-metadata';
import {
  shareLocalSkillForCatsCo,
  validateSkillHubShareMetadata,
} from '../skillhub/local-share';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

export const SKILLHUB_THIN_RPC_TOOLS = {
  workspace: 'skillhub.localWorkspace.get',
  share: 'skillhub.localSkill.share',
  finalize: 'skillhub.localSkill.finalize',
  delete: 'skillhub.localSkill.delete',
  switchBot: 'skillhub.localBot.switch',
} as const;

const DEFAULT_WORKSPACE_PAGE_SIZE = 200;
const MAX_WORKSPACE_PAGE_SIZE = 200;
const MAX_WORKSPACE_OFFSET = 1_000_000;
const MAX_WORKSPACE_SKILLS = 10_000;
const MAX_WORKSPACE_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOTS = 4;
const WORKSPACE_SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_REJECTED_FINGERPRINT_FILES = 10_000;
const MAX_REJECTED_FINGERPRINT_BYTES = 32 * 1024 * 1024;
const REJECTED_FINGERPRINT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
const REJECTED_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_RELATIVE_PATH_LENGTH = 500;
const MAX_COMPLETED_REQUESTS = 256;
const BOT_UID_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

interface SkillHubWorkspaceValidationFailure {
  localSkillId: string;
  name: string;
  installName: string;
  path: string;
  error: Error;
}

interface SkillHubWorkspaceSnapshot {
  botUid: string;
  activeBotUid?: string;
  skillsRoot: string;
  skillsPath: string;
  revision: string;
  skills: Array<Record<string, unknown>>;
  createdAtMs: number;
}

interface RejectedFingerprintBudget {
  files: number;
  bytes: number;
}

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
  enabled?: boolean;
  allowBotSwitch?: boolean;
  now?: () => Date;
}

export class SkillHubThinRpcHandler {
  private readonly runtimeRoot: string;
  private readonly scheduleBotSwitch: (botUid: string) => void;
  private readonly finalizeCurrentBotSkill: typeof finalizeCurrentBotPublicSkillNow;
  private readonly isShuttingDown: () => boolean;
  private readonly enabled: boolean;
  private readonly allowBotSwitch: boolean;
  private readonly now: () => Date;
  private readonly completed = new Map<string, {
    fingerprint: string;
    operation: Promise<Record<string, unknown>>;
  }>();
  private readonly workspaceSnapshots = new Map<string, SkillHubWorkspaceSnapshot>();

  constructor(options: SkillHubThinRpcHandlerOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.isShuttingDown = options.isShuttingDown ?? (() => false);
    this.scheduleBotSwitch = options.scheduleBotSwitch
      ?? ((botUid) => scheduleDashboardBotSwitch(botUid, this.isShuttingDown));
    this.finalizeCurrentBotSkill = options.finalizeCurrentBotSkill
      ?? finalizeCurrentBotPublicSkillNow;
    this.enabled = options.enabled !== false;
    this.allowBotSwitch = options.allowBotSwitch !== false;
    this.now = options.now ?? (() => new Date());
  }

  supports(toolName: string): boolean {
    return this.enabled
      && Object.values(SKILLHUB_THIN_RPC_TOOLS).includes(toolName as any)
      && (toolName !== SKILLHUB_THIN_RPC_TOOLS.switchBot || this.allowBotSwitch);
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
    const operation = this.executeOnce(request).catch((error) => {
      if (error instanceof BotSkillWorkspaceChangingError) {
        throw new SkillHubThinRpcError(error.code, error.message);
      }
      throw error;
    });
    this.completed.set(requestID, { fingerprint, operation });
    while (this.completed.size > MAX_COMPLETED_REQUESTS) {
      this.completed.delete(this.completed.keys().next().value as string);
    }
    return operation;
  }

  private async executeOnce(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    this.assertOperational(request);
    if (!this.supports(String(request.tool_name || ''))) {
      throw new SkillHubThinRpcError('TOOL_NOT_FOUND', 'Unsupported SkillHub device operation.');
    }
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
        return this.readWorkspace(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.share:
        return this.shareSkill(botUid, scope.ownerUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.finalize:
        return this.finalizeSkill(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.delete:
        return this.deleteSkill(botUid, payload, request);
      default:
        throw new SkillHubThinRpcError('TOOL_NOT_FOUND', 'Unsupported SkillHub device operation.');
    }
  }

  private async readWorkspace(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const pageOffset = optionalInteger(payload.offset, 'offset', 0, 0, MAX_WORKSPACE_OFFSET);
    const pageLimit = optionalInteger(
      payload.limit,
      'limit',
      DEFAULT_WORKSPACE_PAGE_SIZE,
      1,
      MAX_WORKSPACE_PAGE_SIZE,
    );
    const expectedRevision = optionalContentHash(payload.workspace_revision, 'workspace_revision');
    return withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertOperational(request);
      this.assertRequestScope(request, botUid, true);
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId);
      const nowMs = this.now().getTime();
      this.pruneWorkspaceSnapshots(nowMs);
      const snapshot = expectedRevision
        ? this.readCachedWorkspaceSnapshot(expectedRevision, botUid, context.skillsRoot)
        : this.createWorkspaceSnapshot(botUid, context.activeBotId, context.skillsRoot, nowMs);
      if (pageOffset > snapshot.skills.length) {
        throw new SkillHubThinRpcError('INVALID_REQUEST', 'offset is outside the workspace snapshot.');
      }
      const pageSkills = snapshot.skills.slice(pageOffset, pageOffset + pageLimit);
      const nextOffset = pageOffset + pageSkills.length;
      const hasMore = nextOffset < snapshot.skills.length;
      return {
        schema: 'xiaoba.skillhub.local_workspace.v1',
        bot_uid: botUid,
        active_bot_uid: snapshot.activeBotUid,
        skills_path: snapshot.skillsPath,
        workspace_revision: snapshot.revision,
        total_skills: snapshot.skills.length,
        page_offset: pageOffset,
        page_limit: pageLimit,
        next_offset: hasMore ? nextOffset : null,
        truncated: hasMore,
        skills: pageSkills,
      };
    }, { runtimeRoot: this.runtimeRoot });
  }

  private createWorkspaceSnapshot(
    botUid: string,
    activeBotUid: string | undefined,
    skillsRoot: string,
    nowMs: number,
  ): SkillHubWorkspaceSnapshot {
    const rejected: SkillHubWorkspaceValidationFailure[] = [];
    const entries = scanSkillHubWorkspace(skillsRoot, {
      onValidationFailure: failure => rejected.push(failure),
      maxSkillEntries: MAX_WORKSPACE_SKILLS,
      maxTotalPackageBytes: MAX_WORKSPACE_PACKAGE_BYTES,
      retainPackageContents: false,
    }).filter((entry) => {
      const error = validateSkillHubShareMetadata(entry.path);
      if (!error) return true;
      rejected.push({
        localSkillId: entry.localSkillId,
        name: entry.name,
        installName: entry.installName,
        path: entry.path,
        error,
      });
      return false;
    });
    const listed = [
      ...entries.map(entry => ({ kind: 'valid' as const, entry })),
      ...rejected.map(entry => ({ kind: 'rejected' as const, entry })),
    ].sort((left, right) => compareText(left.entry.localSkillId, right.entry.localSkillId));
    if (listed.length > MAX_WORKSPACE_SKILLS) throw workspaceTooLargeError();
    const rejectedFingerprintBudget: RejectedFingerprintBudget = { files: 0, bytes: 0 };
    const skills = listed.map((item) => {
      if (item.kind === 'valid') {
        const { entry } = item;
        const presentation = readLocalSkillPresentation(entry.path);
        return {
          local_skill_id: limitText(entry.localSkillId, MAX_NAME_LENGTH),
          name: limitText(entry.name, MAX_NAME_LENGTH),
          description: limitText(presentation.description, MAX_DESCRIPTION_LENGTH),
          relative_path: limitText(entry.installName, MAX_RELATIVE_PATH_LENGTH),
          source: 'user',
          can_share: !entry.reference || isPrivateSkillReference(entry.reference.skillId),
          skill_hub: {
            ...(presentation.metadata || {}),
            ...(entry.reference ? { reference: entry.reference } : {}),
          },
        };
      }
      const { entry } = item;
      const presentation = readLocalSkillPresentation(entry.path);
      return {
        local_skill_id: limitText(entry.localSkillId, MAX_NAME_LENGTH),
        name: limitText(entry.name, MAX_NAME_LENGTH),
        description: limitText(presentation.description, MAX_DESCRIPTION_LENGTH),
        relative_path: limitText(entry.installName, MAX_RELATIVE_PATH_LENGTH),
        source: 'user',
        can_share: false,
        share_error: limitText(entry.error.message, MAX_DESCRIPTION_LENGTH),
        skill_hub: presentation.metadata || {},
      };
    });
    if (Buffer.byteLength(stableSerialize(skills), 'utf8') > MAX_WORKSPACE_SNAPSHOT_BYTES) {
      throw workspaceTooLargeError();
    }
    const revision = createHash('sha256')
      .update(stableSerialize(listed.map((item, index) => ({
        skill: skills[index],
        package_content_hash: item.kind === 'valid'
          ? item.entry.contentHash
          : fingerprintRejectedSkillPackage(item.entry.path, rejectedFingerprintBudget),
      }))))
      .digest('hex');
    const snapshot: SkillHubWorkspaceSnapshot = {
      botUid,
      activeBotUid,
      skillsRoot: path.resolve(skillsRoot),
      skillsPath: fs.realpathSync(skillsRoot),
      revision,
      skills,
      createdAtMs: nowMs,
    };
    this.workspaceSnapshots.delete(revision);
    this.workspaceSnapshots.set(revision, snapshot);
    this.pruneWorkspaceSnapshots(nowMs);
    return snapshot;
  }

  private readCachedWorkspaceSnapshot(
    revision: string,
    botUid: string,
    skillsRoot: string,
  ): SkillHubWorkspaceSnapshot {
    const snapshot = this.workspaceSnapshots.get(revision);
    if (
      !snapshot
      || snapshot.botUid !== botUid
      || snapshot.skillsRoot !== path.resolve(skillsRoot)
    ) {
      throw new SkillHubThinRpcError(
        'WORKSPACE_CHANGED',
        'The local Skill workspace snapshot is no longer available. Restart the listing.',
      );
    }
    return snapshot;
  }

  private pruneWorkspaceSnapshots(nowMs: number): void {
    for (const [revision, snapshot] of this.workspaceSnapshots) {
      if (nowMs - snapshot.createdAtMs > WORKSPACE_SNAPSHOT_TTL_MS) {
        this.workspaceSnapshots.delete(revision);
      }
    }
    while (this.workspaceSnapshots.size > MAX_WORKSPACE_SNAPSHOTS) {
      this.workspaceSnapshots.delete(this.workspaceSnapshots.keys().next().value as string);
    }
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
      const rejected: SkillHubWorkspaceValidationFailure[] = [];
      const entry = scanSkillHubWorkspace(context.skillsRoot, {
        onValidationFailure: failure => rejected.push(failure),
      }).find((candidate) => (
        candidate.localSkillId === localSkillId && candidate.name === skillName
      ));
      if (!entry) {
        const invalid = rejected.find(candidate => (
          candidate.localSkillId === localSkillId && candidate.name === skillName
        ));
        if (invalid) {
          throw new SkillHubThinRpcError('LOCAL_SKILL_INVALID', invalid.error.message);
        }
        throw new SkillHubThinRpcError('LOCAL_SKILL_NOT_FOUND', 'The selected local Skill no longer exists.');
      }
      const validationError = validateSkillHubShareMetadata(entry.path);
      if (validationError) {
        throw new SkillHubThinRpcError('LOCAL_SKILL_INVALID', validationError.message);
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

  private async deleteSkill(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const removed = await withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertOperational(request);
      const scope = this.assertRequestScope(request, botUid, true);
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId);

      const rejected: SkillHubWorkspaceValidationFailure[] = [];
      const entries = scanSkillHubWorkspace(context.skillsRoot, {
        onValidationFailure: failure => rejected.push(failure),
      });
      const candidates = [
        ...entries.map(entry => ({
          localSkillId: entry.localSkillId,
          name: entry.name,
          installName: entry.installName,
          path: entry.path,
        })),
        ...rejected.map(entry => ({
          localSkillId: entry.localSkillId,
          name: entry.name,
          installName: entry.installName,
          path: entry.path,
        })),
      ];
      const entry = candidates.find(candidate => candidate.localSkillId === localSkillId);
      if (!entry) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_NOT_FOUND',
          'The selected local Skill no longer exists.',
        );
      }

      const root = fs.realpathSync(context.skillsRoot);
      const entryStat = fs.lstatSync(entry.path);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_UNSAFE',
          'The selected local Skill is not a safe directory.',
        );
      }
      const realEntry = fs.realpathSync(entry.path);
      const relative = path.relative(root, realEntry);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_UNSAFE',
          'The selected local Skill is outside the active Skill workspace.',
        );
      }
      const nested = candidates.find(candidate => (
        candidate.localSkillId !== localSkillId
        && path.resolve(candidate.path).startsWith(`${path.resolve(entry.path)}${path.sep}`)
      ));
      if (nested) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_CONTAINS_SKILLS',
          'The selected local Skill contains another Skill directory and cannot be deleted safely.',
        );
      }

      const backup = trashBotSkill({
        runtimeRoot: this.runtimeRoot,
        botId: botUid,
        sourcePath: realEntry,
        localSkillId,
        name: entry.name,
        installName: entry.installName,
        deletedByOwnerUid: scope.ownerUid,
        now: this.now,
      });
      return {
        localSkillId,
        name: entry.name,
        relativePath: entry.installName,
        ...backup,
      };
    }, { runtimeRoot: this.runtimeRoot });

    return {
      schema: 'xiaoba.skillhub.local_delete.v1',
      bot_uid: botUid,
      local_skill_id: removed.localSkillId,
      name: removed.name,
      relative_path: removed.relativePath,
      deleted: true,
      backup_id: removed.backupId,
      deleted_at: removed.deletedAt,
      backup_expires_at: removed.expiresAt,
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
  dashboardBotSwitchScheduler.schedule(botUid, isShuttingDown);
}

interface PendingDashboardBotSwitch {
  botUid: string;
  isShuttingDown: () => boolean;
}

export class DashboardBotSwitchScheduler {
  private pending?: PendingDashboardBotSwitch;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private runningBotUid = '';

  constructor(
    private readonly requestSwitch: (botUid: string) => Promise<void> = requestDashboardBotSwitch,
    private readonly delayMs = 1_000,
  ) {}

  schedule(botUid: string, isShuttingDown: () => boolean = () => false): void {
    const target = String(botUid || '').trim();
    if (!target || isShuttingDown()) return;
    if (this.running && this.runningBotUid === target) {
      this.pending = undefined;
      return;
    }
    if (this.pending?.botUid === target) {
      // Refresh the connector lifecycle fence without extending the debounce.
      this.pending = { botUid: target, isShuttingDown };
      return;
    }

    this.pending = {
      botUid: target,
      isShuttingDown,
    };
    if (!this.running) this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const next = this.pending;
    this.pending = undefined;
    if (!next) return;
    if (next.isShuttingDown()) {
      if (this.pending) this.arm();
      return;
    }

    this.running = true;
    this.runningBotUid = next.botUid;
    try {
      await this.requestSwitch(next.botUid);
    } catch (error: any) {
      Logger.warning(`SkillHub remote Bot switch failed: ${error?.message || String(error)}`);
    } finally {
      this.running = false;
      this.runningBotUid = '';
      if (this.pending) this.arm();
    }
  }
}

const dashboardBotSwitchScheduler = new DashboardBotSwitchScheduler();

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

function readLocalSkillPresentation(skillDir: string): {
  description: string;
  metadata: ReturnType<typeof readSkillHubLocalMetadata>;
} {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    if (fs.statSync(skillFile).size > REJECTED_FINGERPRINT_LARGE_FILE_BYTES) {
      return { description: '', metadata: null };
    }
    const parsed = matter(fs.readFileSync(skillFile, 'utf8'), {});
    return {
      description: String(parsed.data?.description || ''),
      metadata: readSkillHubLocalMetadata(skillFile),
    };
  } catch {
    return { description: '', metadata: null };
  }
}

function fingerprintRejectedSkillPackage(
  skillDir: string,
  budget: RejectedFingerprintBudget,
): string {
  const root = path.resolve(skillDir);
  const evidence: Array<Record<string, unknown>> = [];
  const visit = (current: string): void => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (
        child.isDirectory()
        && (child.name === '.git' || child.name === 'node_modules' || isEphemeralSkillDirectory(child.name))
      ) continue;
      const fullPath = path.join(current, child.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        evidence.push({ path: relativePath, type: 'symlink' });
        continue;
      }
      if (stat.isDirectory()) {
        evidence.push({ path: relativePath, type: 'directory' });
        if (!fs.existsSync(path.join(fullPath, 'SKILL.md'))) visit(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      budget.files += 1;
      if (budget.files > MAX_REJECTED_FINGERPRINT_FILES) throw workspaceTooLargeError();
      const sampled = readBoundedFingerprintBytes(fullPath, stat.size);
      budget.bytes += sampled.length;
      if (budget.bytes > MAX_REJECTED_FINGERPRINT_BYTES) throw workspaceTooLargeError();
      evidence.push({
        path: relativePath,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        sha256: createHash('sha256').update(sampled).digest('hex'),
        sampled: sampled.length !== stat.size,
      });
    }
  };
  visit(root);
  return createHash('sha256').update(stableSerialize(evidence)).digest('hex');
}

function readBoundedFingerprintBytes(filePath: string, size: number): Buffer {
  if (size <= REJECTED_FINGERPRINT_LARGE_FILE_BYTES) {
    return fs.readFileSync(filePath);
  }
  const handle = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(REJECTED_FINGERPRINT_SAMPLE_BYTES, size));
    fs.readSync(handle, head, 0, head.length, 0);
    const remaining = Math.max(0, size - head.length);
    const tail = Buffer.alloc(Math.min(REJECTED_FINGERPRINT_SAMPLE_BYTES, remaining));
    if (tail.length > 0) fs.readSync(handle, tail, 0, tail.length, size - tail.length);
    return Buffer.concat([head, tail]);
  } finally {
    fs.closeSync(handle);
  }
}

function scanSkillHubWorkspace(
  skillsRoot: string,
  options: Parameters<typeof scanBotSkillWorkspace>[1],
): ReturnType<typeof scanBotSkillWorkspace> {
  try {
    return scanBotSkillWorkspace(skillsRoot, options);
  } catch (error) {
    if (error instanceof BotSkillWorkspaceScanLimitError) throw workspaceTooLargeError();
    throw new SkillHubThinRpcError(
      'LOCAL_SKILL_INVALID',
      'The local Skill workspace could not be validated safely.',
    );
  }
}

function workspaceTooLargeError(): SkillHubThinRpcError {
  return new SkillHubThinRpcError(
    'WORKSPACE_TOO_LARGE',
    'The local Skill workspace is too large to list safely.',
  );
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

function optionalInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return parsed;
}

function optionalContentHash(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(normalized)) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return normalized;
}

function limitText(value: string, maxLength: number): string {
  const text = String(value || '');
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
