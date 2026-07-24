import * as fs from 'fs';
import * as path from 'path';
import type { BotDefinition, BotSkillReference } from '../bot-definition/types';
import type { BotDefinitionRepository } from '../bot-definition/repository';
import {
  botSkillReferencesEqual,
  normalizeBotSkillReferences,
  cloudSnapshotMatchesBase,
  localSnapshotMatchesBase,
} from './canonical';
import type { FileBotSkillSyncBaseStore } from './base-store';
import {
  BotDefinitionCloudError,
  type BotDefinitionCloudClient,
  type BotDefinitionCloudSnapshot,
} from './definition-cloud';
import type { BotPrivateSkillPackageClient } from './private-package';
import {
  BOT_SKILL_PENDING_COMMIT_SCHEMA,
  type BotSkillPendingCommit,
  type FileBotSkillPendingCommitStore,
} from './pending-commit-store';
import { buildBotSkillSourceSnapshot, BotSkillSourceError } from './source-snapshot';
import {
  BOT_SKILL_SYNC_BASE_SCHEMA,
  type BotLocalSkillSnapshot,
  type BotSkillSyncBase,
  type BotSkillSyncBaseEntry,
  type BotSkillWorkspaceInspection,
} from './types';
import {
  BotSkillWorkspaceService,
  type BotSkillWorkspaceOwner,
} from './workspace';
import { restoreBotSkillWorkspace } from './workspace-restore';
import { withBotSkillWorkspaceLock } from './workspace-lock';

export interface BotSkillSyncServiceOptions {
  workspace: BotSkillWorkspaceService;
  baseStore: Pick<FileBotSkillSyncBaseStore, 'read' | 'write'>;
  cloud: BotDefinitionCloudClient;
  packages: BotPrivateSkillPackageClient;
  definitionCache?: Pick<BotDefinitionRepository, 'writeCache'>
    & Partial<Pick<BotDefinitionRepository, 'readCache' | 'readCanonical' | 'withWriteLock'>>;
  pendingStore?: Pick<FileBotSkillPendingCommitStore, 'read' | 'write' | 'delete'>;
  now?: () => Date;
}

export interface BotSkillSyncRequest {
  owner: BotSkillWorkspaceOwner;
  /**
   * Required only when an owned local workspace must recreate a missing cloud
   * Definition, or an explicit new-Bot flow creates it for the first time.
   */
  definitionForCreate?: BotDefinition;
  allowLegacyClaim?: boolean;
  allowNewWorkspaceCreate?: boolean;
  /** Installs the one-time default Skill for an explicit new Bot flow. */
  initializeNewWorkspace?(): Promise<void>;
}

export type BotSkillSyncRepairStrategy = 'local-wins' | 'cloud-wins';

export interface BotSkillSyncBlockedSkill {
  localSkillId: string;
  name: string;
  code: string;
  relativePaths?: string[];
}

export interface BotSkillSyncResult {
  action:
    | 'noop'
    | 'uploaded'
    | 'downloaded'
    | 'created_cloud'
    | 'migrated'
    | 'degraded_local'
    | 'blocked'
    | 'conflict';
  botId: string;
  workspaceId?: string;
  definitionETag?: string;
  blockedSkills?: BotSkillSyncBlockedSkill[];
  reason?: string;
}

export class BotSkillSyncService {
  private readonly workspace: BotSkillWorkspaceService;
  private readonly baseStore: BotSkillSyncServiceOptions['baseStore'];
  private readonly cloud: BotDefinitionCloudClient;
  private readonly packages: BotPrivateSkillPackageClient;
  private readonly definitionCache?: BotSkillSyncServiceOptions['definitionCache'];
  private readonly pendingStore?: BotSkillSyncServiceOptions['pendingStore'];
  private readonly now: () => Date;

  constructor(options: BotSkillSyncServiceOptions) {
    this.workspace = options.workspace;
    this.baseStore = options.baseStore;
    this.cloud = options.cloud;
    this.packages = options.packages;
    this.definitionCache = options.definitionCache;
    this.pendingStore = options.pendingStore;
    this.now = options.now ?? (() => new Date());
  }

  sync(request: BotSkillSyncRequest): Promise<BotSkillSyncResult> {
    return withBotSkillWorkspaceLock(this.workspace.root, () => this.syncUnlocked(request));
  }

  repair(
    request: BotSkillSyncRequest,
    strategy: BotSkillSyncRepairStrategy,
  ): Promise<BotSkillSyncResult> {
    return withBotSkillWorkspaceLock(
      this.workspace.root,
      () => this.repairUnlocked(request, strategy),
    );
  }

  private async repairUnlocked(
    request: BotSkillSyncRequest,
    strategy: BotSkillSyncRepairStrategy,
  ): Promise<BotSkillSyncResult> {
    const botId = String(request.owner.botId || '').trim();
    if (strategy !== 'local-wins' && strategy !== 'cloud-wins') {
      return blocked(botId, 'SYNC_REPAIR_STRATEGY_INVALID');
    }
    let pending: BotSkillPendingCommit | undefined;
    try {
      pending = this.pendingStore?.read();
    } catch (error: any) {
      return blocked(botId, safeErrorCode(error, 'PENDING_COMMIT_CORRUPT'));
    }
    if (pending) return blocked(botId, 'SYNC_REPAIR_PENDING_COMMIT_EXISTS');

    const inspected = this.workspace.inspect(request.owner);
    if (inspected.kind === 'unreadable') return blocked(botId, 'LOCAL_WORKSPACE_UNREADABLE');
    if (inspected.kind === 'owner_mismatch') return blocked(botId, 'LOCAL_WORKSPACE_OWNER_MISMATCH');
    if (inspected.kind !== 'valid') return blocked(botId, 'SYNC_REPAIR_LOCAL_WORKSPACE_INVALID');

    let cloudRead;
    try {
      cloudRead = await this.cloud.read();
    } catch (error: any) {
      return blocked(botId, safeErrorCode(error, 'CLOUD_UNAVAILABLE'));
    }
    if (cloudRead.kind !== 'found') return blocked(botId, 'SYNC_REPAIR_CLOUD_DEFINITION_MISSING');
    if (cloudRead.definition.skills === undefined) {
      return blocked(botId, 'SYNC_REPAIR_CLOUD_SKILLS_MISSING');
    }

    const baseRead = this.baseStore.read(botId, inspected.identity.workspaceId);
    if (baseRead.kind === 'valid') {
      return {
        action: 'conflict',
        botId,
        workspaceId: inspected.identity.workspaceId,
        definitionETag: cloudRead.etag,
        reason: 'SYNC_REPAIR_NOT_REQUIRED',
      };
    }
    const repaired = strategy === 'local-wins'
      ? await this.uploadSnapshot(request, inspected, cloudRead, undefined, true)
      : await this.download(request, inspected, cloudRead, undefined, true);
    return {
      ...repaired,
      reason: repaired.action === 'uploaded' || repaired.action === 'downloaded'
        ? (strategy === 'local-wins'
          ? 'BASE_REPAIRED_LOCAL_WINS'
          : 'BASE_REPAIRED_CLOUD_WINS')
        : repaired.reason,
    };
  }

  private async syncUnlocked(request: BotSkillSyncRequest): Promise<BotSkillSyncResult> {
    const botId = String(request.owner.botId || '').trim();
    let pending: BotSkillPendingCommit | undefined;
    try {
      pending = this.pendingStore?.read();
    } catch (error: any) {
      return blocked(botId, safeErrorCode(error, 'PENDING_COMMIT_CORRUPT'));
    }
    let inspected = this.workspace.inspect(request.owner);
    const hasPendingRestore = pending?.kind === 'restore' && pending.botId === botId;
    if (inspected.kind === 'unreadable' && !hasPendingRestore) {
      return blocked(botId, 'LOCAL_WORKSPACE_UNREADABLE');
    }
    if (inspected.kind === 'owner_mismatch' && !hasPendingRestore) {
      return blocked(botId, 'LOCAL_WORKSPACE_OWNER_MISMATCH');
    }

    let cloudRead;
    try {
      cloudRead = await this.cloud.read();
    } catch (error: any) {
      if (inspected.kind === 'valid') {
        return {
          action: 'degraded_local',
          botId,
          workspaceId: inspected.identity.workspaceId,
          reason: safeErrorCode(error, 'CLOUD_UNAVAILABLE'),
        };
      }
      return blocked(botId, safeErrorCode(error, 'CLOUD_UNAVAILABLE'));
    }

    if (pending && pending.botId === botId && cloudRead.kind === 'found') {
      let recovered: boolean;
      try {
        recovered = this.recoverPendingCommit(pending, inspected, cloudRead, request.owner.authority);
      } catch (error: any) {
        return blocked(botId, safeErrorCode(error, 'PENDING_RESTORE_RECOVERY_BLOCKED'));
      }
      if (recovered) {
        inspected = this.workspace.inspect(request.owner);
      } else if (pending.kind === 'restore') {
        inspected = this.workspace.inspect(request.owner);
      }
    }
    if (inspected.kind === 'unreadable') {
      return blocked(botId, 'LOCAL_WORKSPACE_UNREADABLE');
    }
    if (inspected.kind === 'owner_mismatch') {
      return blocked(botId, 'LOCAL_WORKSPACE_OWNER_MISMATCH');
    }

    if (inspected.kind === 'missing') {
      if (cloudRead.kind === 'found' && cloudRead.definition.skills !== undefined) {
        return this.download(request, inspected, cloudRead);
      }
      if (
        cloudRead.kind === 'found'
        && cloudRead.definition.skills === undefined
        && request.allowNewWorkspaceCreate
        && request.definitionForCreate
      ) {
        this.workspace.initializeEmpty(request.owner);
        await request.initializeNewWorkspace?.();
        const initialized = this.workspace.inspect(request.owner);
        if (initialized.kind !== 'valid') {
          return blocked(botId, 'NEW_WORKSPACE_INITIALIZATION_FAILED');
        }
        const uploaded = await this.uploadSnapshot(request, initialized, cloudRead, undefined);
        return {
          ...uploaded,
          action: uploaded.action === 'uploaded' ? 'created_cloud' : uploaded.action,
        };
      }
      if (
        cloudRead.kind === 'missing'
        && request.allowNewWorkspaceCreate
        && request.definitionForCreate
      ) {
        const identity = this.workspace.initializeEmpty(request.owner);
        await request.initializeNewWorkspace?.();
        const initialized = this.workspace.inspect(request.owner);
        if (initialized.kind !== 'valid' || initialized.identity.workspaceId !== identity.workspaceId) {
          return blocked(botId, 'NEW_WORKSPACE_INITIALIZATION_FAILED');
        }
        const created = await this.createCloudFromSnapshot(request, initialized);
        return { ...created, action: 'created_cloud' };
      }
      return blocked(
        botId,
        cloudRead.kind === 'found'
          ? 'CLOUD_DEFINITION_REQUIRES_MIGRATION_BUT_LOCAL_IS_MISSING'
          : 'LOCAL_AND_CLOUD_MISSING',
      );
    }

    if (inspected.kind === 'unowned') {
      const mayClaimLegacy = request.allowLegacyClaim
        && cloudRead.kind === 'found'
        && cloudRead.definition.skills === undefined;
      const mayCreateNew = request.allowNewWorkspaceCreate
        && cloudRead.kind === 'missing'
        && request.definitionForCreate;
      if (!mayClaimLegacy && !mayCreateNew) {
        return {
          action: 'conflict',
          botId,
          reason: 'UNOWNED_LOCAL_WORKSPACE',
        };
      }
      const identity = this.workspace.claimExisting(request.owner);
      const claimed = this.workspace.inspect(request.owner);
      if (claimed.kind !== 'valid') return blocked(botId, 'LOCAL_WORKSPACE_CLAIM_FAILED');
      if (mayCreateNew) {
        const created = await this.createCloudFromSnapshot(request, claimed);
        return { ...created, action: 'created_cloud' };
      }
      if (cloudRead.kind !== 'found') return blocked(botId, 'CLOUD_DEFINITION_MISSING');
      const migrated = await this.uploadSnapshot(request, claimed, cloudRead, undefined);
      return { ...migrated, action: migrated.action === 'uploaded' ? 'migrated' : migrated.action };
    }

    const baseRead = this.baseStore.read(botId, inspected.identity.workspaceId);
    if (baseRead.kind === 'corrupt') {
      return {
        action: 'conflict',
        botId,
        workspaceId: inspected.identity.workspaceId,
        reason: 'BASE_CORRUPT',
      };
    }

    if (cloudRead.kind === 'missing') {
      if (!request.definitionForCreate) {
        return blocked(botId, 'CLOUD_DEFINITION_MISSING_WITHOUT_LOCAL_MODEL');
      }
      let localForCreate = inspected;
      if (request.allowNewWorkspaceCreate && request.initializeNewWorkspace) {
        await request.initializeNewWorkspace();
        const initialized = this.workspace.inspect(request.owner);
        if (initialized.kind !== 'valid') {
          return blocked(botId, 'NEW_WORKSPACE_INITIALIZATION_FAILED');
        }
        localForCreate = initialized;
      }
      const created = await this.createCloudFromSnapshot(
        request,
        localForCreate,
        baseRead.kind === 'valid' ? baseRead.base : undefined,
      );
      return { ...created, action: 'created_cloud' };
    }

    if (cloudRead.definition.skills === undefined) {
      if (!request.allowLegacyClaim && !request.allowNewWorkspaceCreate) {
        return {
          action: 'conflict',
          botId,
          workspaceId: inspected.identity.workspaceId,
          reason: 'CLOUD_DEFINITION_LEGACY_UNCONFIRMED',
        };
      }
      let localForMigration = inspected;
      if (request.allowNewWorkspaceCreate && request.initializeNewWorkspace) {
        await request.initializeNewWorkspace();
        const initialized = this.workspace.inspect(request.owner);
        if (initialized.kind !== 'valid') {
          return blocked(botId, 'NEW_WORKSPACE_INITIALIZATION_FAILED');
        }
        localForMigration = initialized;
      }
      const migrated = await this.uploadSnapshot(
        request,
        localForMigration,
        cloudRead,
        baseRead.kind === 'valid' ? baseRead.base : undefined,
      );
      return {
        ...migrated,
        action: migrated.action === 'uploaded'
          ? (request.allowNewWorkspaceCreate ? 'created_cloud' : 'migrated')
          : migrated.action,
      };
    }

    if (baseRead.kind === 'missing') {
      return {
        action: 'conflict',
        botId,
        workspaceId: inspected.identity.workspaceId,
        definitionETag: cloudRead.etag,
        reason: 'BASE_UNKNOWN_CONFLICT',
      };
    }

    const localMatches = localSnapshotMatchesBase(inspected.skills, baseRead.base);
    const cloudMatches = cloudSnapshotMatchesBase(cloudRead.definition.skills, baseRead.base);
    if (localMatches && cloudMatches) {
      this.writeDefinitionCacheBestEffort(cloudRead.definition);
      return {
        action: 'noop',
        botId,
        workspaceId: inspected.identity.workspaceId,
        definitionETag: cloudRead.etag,
      };
    }
    if (localMatches) {
      return this.download(request, inspected, cloudRead, baseRead.base);
    }
    return this.uploadSnapshot(request, inspected, cloudRead, baseRead.base);
  }

  private async uploadSnapshot(
    request: BotSkillSyncRequest,
    local: Extract<BotSkillWorkspaceInspection, { kind: 'valid' }>,
    cloud: BotDefinitionCloudSnapshot,
    base?: BotSkillSyncBase,
    requireComplete = false,
  ): Promise<BotSkillSyncResult> {
    const botId = request.owner.botId;
    const baseByLocalId = new Map((base?.entries ?? []).map(entry => [entry.localSkillId, entry]));
    const nextEntries: BotSkillSyncBaseEntry[] = [];
    const blockedSkills: BotSkillSyncBlockedSkill[] = [];
    for (const skill of local.skills) {
      const previous = baseByLocalId.get(skill.localSkillId);
      if (previous?.localContentHash === skill.contentHash) {
        nextEntries.push(previous);
        continue;
      }
      try {
        nextEntries.push(await this.resolveCloudEntry(skill, previous));
      } catch (error: any) {
        blockedSkills.push({
          localSkillId: skill.localSkillId,
          name: skill.name,
          code: safeErrorCode(error, 'PRIVATE_SKILL_UPLOAD_FAILED'),
          ...(error instanceof BotSkillSourceError && error.relativePaths.length
            ? { relativePaths: error.relativePaths }
            : {}),
        });
        if (previous) nextEntries.push(previous);
      }
    }

    if (requireComplete && blockedSkills.length) {
      return {
        action: 'blocked',
        botId,
        workspaceId: local.identity.workspaceId,
        definitionETag: cloud.etag,
        reason: 'SYNC_REPAIR_LOCAL_SKILLS_BLOCKED',
        blockedSkills,
      };
    }

    try {
      this.assertLocalSnapshotUnchanged(request.owner, local);
    } catch (error: any) {
      return {
        action: 'degraded_local',
        botId,
        workspaceId: local.identity.workspaceId,
        reason: safeErrorCode(error, 'LOCAL_CHANGED_DURING_SYNC'),
        ...(blockedSkills.length ? { blockedSkills } : {}),
      };
    }
    const references = normalizeBotSkillReferences(nextEntries.map(entry => ({
      skillId: entry.cloudSkillId,
      version: entry.cloudVersion,
    })));
    this.writePendingCloudUpdate(
      botId,
      local.identity.workspaceId,
      request.owner.authority,
      references,
      nextEntries,
    );
    let updated: BotDefinitionCloudSnapshot;
    try {
      updated = await this.cloud.patchSkills(references, cloud.etag);
    } catch (error: any) {
      if (error instanceof BotDefinitionCloudError && error.status === 412) {
        try {
          const refreshed = await this.cloud.read();
          if (refreshed.kind === 'missing') {
            this.pendingStore?.delete();
            return {
              action: 'degraded_local',
              botId,
              workspaceId: local.identity.workspaceId,
              reason: 'CLOUD_ETAG_CONFLICT',
              ...(blockedSkills.length ? { blockedSkills } : {}),
            };
          }
          updated = refreshed.definition.skills !== undefined
            && botSkillReferencesEqual(refreshed.definition.skills, references)
            ? refreshed
            : await this.cloud.patchSkills(references, refreshed.etag);
        } catch {
          return {
            action: 'degraded_local',
            botId,
            workspaceId: local.identity.workspaceId,
            reason: 'CLOUD_ETAG_CONFLICT',
            ...(blockedSkills.length ? { blockedSkills } : {}),
          };
        }
      } else {
        const status = Number(error?.status);
        if (status >= 400 && status < 500) this.pendingStore?.delete();
        return {
          action: 'degraded_local',
          botId,
          workspaceId: local.identity.workspaceId,
          reason: safeErrorCode(error, 'CLOUD_UPDATE_FAILED'),
          ...(blockedSkills.length ? { blockedSkills } : {}),
        };
      }
    }
    if (
      updated.definition.botId !== botId
      || updated.definition.skills === undefined
      || !botSkillReferencesEqual(updated.definition.skills, references)
    ) {
      this.pendingStore?.delete();
      return {
        action: 'degraded_local',
        botId,
        workspaceId: local.identity.workspaceId,
        reason: 'CLOUD_UPDATE_RESPONSE_MISMATCH',
        ...(blockedSkills.length ? { blockedSkills } : {}),
      };
    }
    this.writeBase(botId, local.identity.workspaceId, request.owner.authority, updated.etag, nextEntries);
    this.pendingStore?.delete();
    this.writeDefinitionCacheBestEffort(updated.definition);
    return {
      action: 'uploaded',
      botId,
      workspaceId: local.identity.workspaceId,
      definitionETag: updated.etag,
      ...(blockedSkills.length ? { blockedSkills } : {}),
    };
  }

  private async createCloudFromSnapshot(
    request: BotSkillSyncRequest,
    local: Extract<BotSkillWorkspaceInspection, { kind: 'valid' }>,
    base?: BotSkillSyncBase,
  ): Promise<BotSkillSyncResult> {
    const desired = await this.prepareLocalUpload(local, base);
    this.assertLocalSnapshotUnchanged(request.owner, local);
    if (!request.definitionForCreate) return blocked(request.owner.botId, 'LOCAL_MODEL_REQUIRED');
    let created: BotDefinitionCloudSnapshot;
    this.writePendingCloudUpdate(
      request.owner.botId,
      local.identity.workspaceId,
      request.owner.authority,
      desired.references,
      desired.entries,
    );
    try {
      created = await this.cloud.create({
        ...request.definitionForCreate,
        botId: request.owner.botId,
        skills: desired.references,
      });
    } catch (error: any) {
      if (error instanceof BotDefinitionCloudError && error.status === 412) {
        this.pendingStore?.delete();
        return {
          action: 'conflict',
          botId: request.owner.botId,
          workspaceId: local.identity.workspaceId,
          reason: 'CLOUD_CREATE_CONFLICT',
          ...(desired.blockedSkills.length ? { blockedSkills: desired.blockedSkills } : {}),
        };
      }
      const status = Number(error?.status);
      if (status >= 400 && status < 500) this.pendingStore?.delete();
      return {
        action: 'degraded_local',
        botId: request.owner.botId,
        workspaceId: local.identity.workspaceId,
        reason: safeErrorCode(error, 'CLOUD_CREATE_FAILED'),
        ...(desired.blockedSkills.length ? { blockedSkills: desired.blockedSkills } : {}),
      };
    }
    if (
      created.definition.botId !== request.owner.botId
      || created.definition.skills === undefined
      || !botSkillReferencesEqual(created.definition.skills, desired.references)
    ) {
      this.pendingStore?.delete();
      return {
        action: 'degraded_local',
        botId: request.owner.botId,
        workspaceId: local.identity.workspaceId,
        reason: 'CLOUD_CREATE_RESPONSE_MISMATCH',
        ...(desired.blockedSkills.length ? { blockedSkills: desired.blockedSkills } : {}),
      };
    }
    this.writeBase(
      request.owner.botId,
      local.identity.workspaceId,
      request.owner.authority,
      created.etag,
      desired.entries,
    );
    this.pendingStore?.delete();
    this.writeDefinitionCacheBestEffort(created.definition);
    return {
      action: 'created_cloud',
      botId: request.owner.botId,
      workspaceId: local.identity.workspaceId,
      definitionETag: created.etag,
      ...(desired.blockedSkills.length ? { blockedSkills: desired.blockedSkills } : {}),
    };
  }

  private async createCloudFromLocal(
    request: BotSkillSyncRequest,
    workspaceId: string,
    entries: BotSkillSyncBaseEntry[],
  ): Promise<BotSkillSyncResult> {
    if (!request.definitionForCreate) return blocked(request.owner.botId, 'LOCAL_MODEL_REQUIRED');
    try {
      const created = await this.cloud.create({
        ...request.definitionForCreate,
        botId: request.owner.botId,
        skills: entries.map(entry => ({
          skillId: entry.cloudSkillId,
          version: entry.cloudVersion,
        })),
      });
      this.writeBase(
        request.owner.botId,
        workspaceId,
        request.owner.authority,
        created.etag,
        entries,
      );
      this.writeDefinitionCacheBestEffort(created.definition);
      return {
        action: 'created_cloud',
        botId: request.owner.botId,
        workspaceId,
        definitionETag: created.etag,
      };
    } catch (error: any) {
      return {
        action: error instanceof BotDefinitionCloudError && error.status === 412 ? 'conflict' : 'degraded_local',
        botId: request.owner.botId,
        workspaceId,
        reason: safeErrorCode(error, 'CLOUD_CREATE_FAILED'),
      };
    }
  }

  private async prepareLocalUpload(
    local: Extract<BotSkillWorkspaceInspection, { kind: 'valid' }>,
    base?: BotSkillSyncBase,
  ): Promise<{
    entries: BotSkillSyncBaseEntry[];
    references: BotSkillReference[];
    blockedSkills: BotSkillSyncBlockedSkill[];
  }> {
    const baseByLocalId = new Map((base?.entries ?? []).map(entry => [entry.localSkillId, entry]));
    const entries: BotSkillSyncBaseEntry[] = [];
    const blockedSkills: BotSkillSyncBlockedSkill[] = [];
    for (const skill of local.skills) {
      const previous = baseByLocalId.get(skill.localSkillId);
      if (previous?.localContentHash === skill.contentHash) {
        entries.push(previous);
        continue;
      }
      try {
        entries.push(await this.resolveCloudEntry(skill, previous));
      } catch (error: any) {
        blockedSkills.push({
          localSkillId: skill.localSkillId,
          name: skill.name,
          code: safeErrorCode(error, 'PRIVATE_SKILL_UPLOAD_FAILED'),
          ...(error instanceof BotSkillSourceError && error.relativePaths.length
            ? { relativePaths: error.relativePaths }
            : {}),
        });
        if (previous) entries.push(previous);
      }
    }
    return {
      entries,
      references: normalizeBotSkillReferences(entries.map(entry => ({
        skillId: entry.cloudSkillId,
        version: entry.cloudVersion,
      }))),
      blockedSkills,
    };
  }

  private async download(
    request: BotSkillSyncRequest,
    local: Extract<BotSkillWorkspaceInspection, { kind: 'valid' | 'missing' }>,
    cloud: BotDefinitionCloudSnapshot,
    base?: BotSkillSyncBase,
    requireCloudStable = false,
  ): Promise<BotSkillSyncResult> {
    const references = cloud.definition.skills;
    if (references === undefined) return blocked(request.owner.botId, 'CLOUD_DEFINITION_SKILLS_MISSING');
    const initial = local.kind === 'valid' ? local : undefined;
    try {
      const restored = await restoreBotSkillWorkspace({
        skillsRoot: this.workspace.root,
        owner: request.owner,
        references,
        packageClient: this.packages,
        existingWorkspaceId: initial?.identity.workspaceId,
        baseEntries: base?.entries,
        beforeCommit: async () => {
          const latest = this.workspace.inspect(request.owner);
          if (initial) {
            if (
              latest.kind !== 'valid'
              || latest.identity.workspaceId !== initial.identity.workspaceId
              || !sameLocalSnapshot(latest.skills, initial.skills)
            ) {
              throw syncError('Local workspace changed during cloud restore.', 'LOCAL_CHANGED_DURING_DOWNLOAD');
            }
          } else if (latest.kind !== 'missing') {
            throw syncError('Local workspace appeared during cloud restore.', 'LOCAL_CHANGED_DURING_DOWNLOAD');
          }
          if (requireCloudStable) {
            const latestCloud = await this.cloud.read();
            if (
              latestCloud.kind !== 'found'
              || latestCloud.etag !== cloud.etag
              || latestCloud.definition.skills === undefined
              || !botSkillReferencesEqual(latestCloud.definition.skills, references)
            ) {
              throw syncError(
                'Cloud Definition changed during sync repair.',
                'CLOUD_CHANGED_DURING_DOWNLOAD',
              );
            }
          }
        },
        now: this.now,
        onPrepared: (result, paths) => {
          this.pendingStore?.write({
            schema: BOT_SKILL_PENDING_COMMIT_SCHEMA,
            kind: 'restore',
            phase: 'prepared',
            botId: request.owner.botId,
            workspaceId: result.identity.workspaceId,
            ...(String(request.owner.authority || '').trim()
              ? { authority: String(request.owner.authority).trim() }
              : {}),
            definitionETag: cloud.etag,
            cloudReferences: references,
            entries: result.entries,
            createdAt: this.now().toISOString(),
            updatedAt: this.now().toISOString(),
            restore: paths,
          });
        },
        onPhase: (phase, result, paths) => {
          const existing = this.pendingStore?.read();
          if (!existing) return;
          this.pendingStore?.write({
            ...existing,
            phase,
            workspaceId: result.identity.workspaceId,
            entries: result.entries,
            restore: paths,
            updatedAt: this.now().toISOString(),
          });
        },
        afterActivate: result => {
          this.writeBase(
            request.owner.botId,
            result.identity.workspaceId,
            request.owner.authority,
            cloud.etag,
            result.entries,
          );
          const existing = this.pendingStore?.read();
          if (existing?.kind === 'restore' && existing.botId === request.owner.botId) {
            this.pendingStore?.write({
              ...existing,
              phase: 'base_committed',
              updatedAt: this.now().toISOString(),
            });
          }
        },
      });
      this.pendingStore?.delete();
      this.writeDefinitionCacheBestEffort(cloud.definition);
      return {
        action: 'downloaded',
        botId: request.owner.botId,
        workspaceId: restored.identity.workspaceId,
        definitionETag: cloud.etag,
      };
    } catch (error: any) {
      return {
        action: initial ? 'degraded_local' : 'blocked',
        botId: request.owner.botId,
        workspaceId: initial?.identity.workspaceId,
        reason: safeErrorCode(error, 'CLOUD_RESTORE_FAILED'),
      };
    }
  }

  private assertLocalSnapshotUnchanged(
    owner: BotSkillWorkspaceOwner,
    original: Extract<BotSkillWorkspaceInspection, { kind: 'valid' }>,
  ): void {
    const latest = this.workspace.inspect(owner);
    if (
      latest.kind !== 'valid'
      || latest.identity.workspaceId !== original.identity.workspaceId
      || !sameLocalSnapshot(latest.skills, original.skills)
    ) {
      throw syncError('Local workspace changed during upload.', 'LOCAL_CHANGED_DURING_SYNC');
    }
  }

  private writeBase(
    botId: string,
    workspaceId: string,
    authority: string | undefined,
    definitionETag: string | undefined,
    entries: BotSkillSyncBaseEntry[],
  ): void {
    this.baseStore.write({
      schema: BOT_SKILL_SYNC_BASE_SCHEMA,
      botId,
      workspaceId,
      ...(String(authority || '').trim() ? { authority: String(authority).trim() } : {}),
      ...(definitionETag ? { definitionETag } : {}),
      entries,
      updatedAt: this.now().toISOString(),
    });
  }

  private async resolveCloudEntry(
    skill: BotLocalSkillSnapshot,
    previous?: BotSkillSyncBaseEntry,
  ): Promise<BotSkillSyncBaseEntry> {
    if (!previous && skill.cloudOrigin) {
      let originPackage;
      try {
        originPackage = await this.packages.download(skill.cloudOrigin);
      } catch {
        throw syncError(
          'The installed public Skill origin could not be verified.',
          'PUBLIC_SKILL_ORIGIN_VERIFICATION_FAILED',
        );
      }
      if (
        originPackage.reference.skillId !== skill.cloudOrigin.skillId
        || originPackage.reference.version !== skill.cloudOrigin.version
      ) {
        throw syncError('Public Skill origin response is inconsistent.', 'PUBLIC_SKILL_ORIGIN_MISMATCH');
      }
      if (originPackage.contentHash === skill.contentHash) {
        return {
          localSkillId: skill.localSkillId,
          localContentHash: skill.contentHash,
          cloudSkillId: skill.cloudOrigin.skillId,
          cloudVersion: skill.cloudOrigin.version,
        };
      }
    }
    const snapshot = buildBotSkillSourceSnapshot(skill.directoryPath);
    if (snapshot.contentHash !== skill.contentHash) {
      throw syncError('Local Skill changed while its upload snapshot was being created.', 'LOCAL_CHANGED_DURING_SYNC');
    }
    const origin = previous
      ? { skillId: previous.cloudSkillId, version: previous.cloudVersion }
      : skill.cloudOrigin;
    const uploaded = await this.packages.upsert({
      localSkillId: skill.localSkillId,
      name: skill.name,
      snapshot,
      ...(origin ? { origin } : {}),
    });
    assertUploadedVersionMatches(skill, snapshot.contentHash, uploaded);
    return {
      localSkillId: skill.localSkillId,
      localContentHash: skill.contentHash,
      cloudSkillId: uploaded.reference.skillId,
      cloudVersion: uploaded.reference.version,
    };
  }

  private writePendingCloudUpdate(
    botId: string,
    workspaceId: string,
    authority: string | undefined,
    cloudReferences: BotSkillReference[],
    entries: BotSkillSyncBaseEntry[],
  ): void {
    if (!this.pendingStore) return;
    const timestamp = this.now().toISOString();
    this.pendingStore.write({
      schema: BOT_SKILL_PENDING_COMMIT_SCHEMA,
      kind: 'cloud_update',
      phase: 'prepared',
      botId,
      workspaceId,
      ...(String(authority || '').trim() ? { authority: String(authority).trim() } : {}),
      cloudReferences,
      entries,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private recoverPendingCommit(
    pending: BotSkillPendingCommit,
    inspected: BotSkillWorkspaceInspection,
    cloud: BotDefinitionCloudSnapshot,
    authority?: string,
  ): boolean {
    if (
      cloud.definition.skills === undefined
      || !botSkillReferencesEqual(cloud.definition.skills, pending.cloudReferences)
    ) {
      if (
        pending.kind === 'restore'
        && this.preserveActivatedRestore(pending, authority)
      ) {
        return false;
      }
      if (pending.kind === 'restore') this.rollbackPendingRestore(pending);
      this.pendingStore?.delete();
      return false;
    }
    if (pending.kind === 'restore') {
      return this.recoverPendingRestore(pending, cloud, authority);
    }
    if (
      inspected.kind !== 'valid'
      || inspected.identity.workspaceId !== pending.workspaceId
    ) {
      this.pendingStore?.delete();
      return false;
    }
    this.writeBase(pending.botId, pending.workspaceId, authority, cloud.etag, pending.entries);
    if (pending.restore?.backupRoot && fs.existsSync(pending.restore.backupRoot)) {
      fs.rmSync(pending.restore.backupRoot, { recursive: true, force: true });
    }
    this.pendingStore?.delete();
    return true;
  }

  private recoverPendingRestore(
    pending: BotSkillPendingCommit,
    cloud: BotDefinitionCloudSnapshot,
    authority?: string,
  ): boolean {
    const restore = pending.restore;
    if (!restore) {
      this.pendingStore?.delete();
      return false;
    }
    this.assertPendingRestorePaths(restore);
    let active = this.workspace.inspect({
      botId: pending.botId,
      ...(authority ? { authority } : {}),
    });
    if (active.kind !== 'valid' || active.identity.workspaceId !== pending.workspaceId) {
      if (!fs.existsSync(restore.stagingRoot)) {
        this.rollbackPendingRestore(pending);
        this.pendingStore?.delete();
        return false;
      }
      const staged = new BotSkillWorkspaceService({ skillsRoot: restore.stagingRoot }).inspect({
        botId: pending.botId,
        ...(authority ? { authority } : {}),
      });
      if (staged.kind !== 'valid' || staged.identity.workspaceId !== pending.workspaceId) {
        this.rollbackPendingRestore(pending);
        this.pendingStore?.delete();
        return false;
      }
      if (fs.existsSync(restore.activeRoot)) {
        if (!restore.hadActive || fs.existsSync(restore.backupRoot)) {
          this.rollbackPendingRestore(pending);
          this.pendingStore?.delete();
          return false;
        }
        fs.renameSync(restore.activeRoot, restore.backupRoot);
      }
      fs.renameSync(restore.stagingRoot, restore.activeRoot);
      active = this.workspace.inspect({
        botId: pending.botId,
        ...(authority ? { authority } : {}),
      });
      if (active.kind !== 'valid' || active.identity.workspaceId !== pending.workspaceId) {
        this.rollbackPendingRestore(pending);
        this.pendingStore?.delete();
        return false;
      }
    }
    this.writeBase(pending.botId, pending.workspaceId, authority, cloud.etag, pending.entries);
    if (fs.existsSync(restore.backupRoot)) {
      fs.rmSync(restore.backupRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(restore.stagingRoot)) {
      fs.rmSync(restore.stagingRoot, { recursive: true, force: true });
    }
    this.pendingStore?.delete();
    return true;
  }

  private rollbackPendingRestore(pending: BotSkillPendingCommit): void {
    const restore = pending.restore;
    if (!restore) return;
    this.assertPendingRestorePaths(restore);
    if (fs.existsSync(restore.backupRoot)) {
      if (fs.existsSync(restore.activeRoot)) {
        const failed = `${restore.stagingRoot}.recovery`;
        if (fs.existsSync(failed)) fs.rmSync(failed, { recursive: true, force: true });
        fs.renameSync(restore.activeRoot, failed);
        fs.renameSync(restore.backupRoot, restore.activeRoot);
        fs.rmSync(failed, { recursive: true, force: true });
      } else {
        fs.renameSync(restore.backupRoot, restore.activeRoot);
      }
    } else if (!restore.hadActive && fs.existsSync(restore.activeRoot)) {
      const active = this.workspace.inspect({ botId: pending.botId, authority: pending.authority });
      if (active.kind === 'valid' && active.identity.workspaceId === pending.workspaceId) {
        fs.rmSync(restore.activeRoot, { recursive: true, force: true });
      }
    }
    if (fs.existsSync(restore.stagingRoot)) {
      fs.rmSync(restore.stagingRoot, { recursive: true, force: true });
    }
  }

  private preserveActivatedRestore(
    pending: BotSkillPendingCommit,
    authority?: string,
  ): boolean {
    if (!['activated', 'base_committed'].includes(pending.phase) || !pending.restore) return false;
    this.assertPendingRestorePaths(pending.restore);
    const active = this.workspace.inspect({
      botId: pending.botId,
      ...(authority ? { authority } : {}),
    });
    if (
      active.kind !== 'valid'
      || active.identity.workspaceId !== pending.workspaceId
    ) {
      if (active.kind !== 'missing') {
        throw syncError(
          'Activated Bot Skill workspace cannot be safely inspected during recovery.',
          'PENDING_RESTORE_ACTIVE_UNSAFE',
        );
      }
      return false;
    }
    this.writeBase(
      pending.botId,
      pending.workspaceId,
      authority,
      pending.definitionETag,
      pending.entries,
    );
    if (fs.existsSync(pending.restore.backupRoot)) {
      fs.rmSync(pending.restore.backupRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(pending.restore.stagingRoot)) {
      fs.rmSync(pending.restore.stagingRoot, { recursive: true, force: true });
    }
    this.pendingStore?.delete();
    return true;
  }

  private writeDefinitionCacheBestEffort(definition: BotDefinition): void {
    try {
      const merge = () => {
        const cached = this.definitionCache?.readCache?.(definition.botId)
          ?? this.definitionCache?.readCanonical?.(definition.botId);
        this.definitionCache?.writeCache(
          cached
            ? {
              ...cached,
              ...(definition.skills !== undefined ? { skills: definition.skills } : {}),
            }
            : definition,
        );
      };
      if (this.definitionCache?.withWriteLock) {
        this.definitionCache.withWriteLock(definition.botId, merge);
      } else {
        merge();
      }
    } catch {
      // Base and the active workspace remain authoritative. The next cloud
      // read can repair this local convenience cache.
    }
  }

  private assertPendingRestorePaths(restore: NonNullable<BotSkillPendingCommit['restore']>): void {
    const activeRoot = path.resolve(this.workspace.root);
    const parent = path.dirname(activeRoot);
    const stagingRoot = path.resolve(restore.stagingRoot);
    const backupRoot = path.resolve(restore.backupRoot);
    if (
      path.resolve(restore.activeRoot) !== activeRoot
      || path.dirname(stagingRoot) !== parent
      || path.dirname(backupRoot) !== parent
      || !path.basename(stagingRoot).startsWith('.bot-skill-restore-')
      || !path.basename(backupRoot).startsWith('.bot-skill-backup-')
    ) {
      throw syncError('Pending restore paths are outside the Bot Skill workspace.', 'PENDING_RESTORE_PATH_INVALID');
    }
  }
}

function sameLocalSnapshot(
  left: readonly BotLocalSkillSnapshot[],
  right: readonly BotLocalSkillSnapshot[],
): boolean {
  const a = [...left].sort((x, y) => x.localSkillId.localeCompare(y.localSkillId));
  const b = [...right].sort((x, y) => x.localSkillId.localeCompare(y.localSkillId));
  return a.length === b.length && a.every((skill, index) => (
    skill.localSkillId === b[index].localSkillId
    && skill.contentHash === b[index].contentHash
  ));
}

function blocked(botId: string, reason: string, detail?: string): BotSkillSyncResult {
  return {
    action: 'blocked',
    botId,
    reason: detail ? `${reason}: ${detail}` : reason,
  };
}

function safeErrorCode(error: unknown, fallback: string): string {
  const code = String((error as any)?.code || '').trim();
  return code || fallback;
}

function syncError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

function assertUploadedVersionMatches(
  skill: BotLocalSkillSnapshot,
  expectedContentHash: string,
  uploaded: Awaited<ReturnType<BotPrivateSkillPackageClient['upsert']>>,
): void {
  if (
    uploaded.localSkillId !== skill.localSkillId
    || uploaded.contentHash !== expectedContentHash
    || !uploaded.reference
  ) {
    throw syncError('Private Skill upload response does not match the local snapshot.', 'PRIVATE_SKILL_UPLOAD_MISMATCH');
  }
  normalizeBotSkillReferences([uploaded.reference]);
}
