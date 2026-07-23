import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  FileBotDefinitionRepository,
  type BotDefinitionReadResult,
  type BotDefinitionRepository,
} from '../bot-definition/repository';
import {
  createBotDefinitionSyncService,
  type BotDefinitionSyncService,
} from '../bot-definition/service';
import type { BotDefinition, BotSkillRef } from '../bot-definition/types';
import { PathResolver } from '../utils/path-resolver';
import {
  createBotSkillService,
  type BotSkillService,
} from './service';
import {
  FileBotSkillSyncBaseRepository,
  cloudProjectionDigest,
  createBotSkillSyncBase,
  localProjectionDigest,
  projectCloudSkills,
  projectLocalManifest,
  type BotSkillSyncBase,
  type BotSkillSyncBaseReadResult,
  type BotSkillSyncBaseRepository,
  type BotSkillSyncBinding,
  type BotSkillSyncLocalEntry,
} from './sync-base';
import {
  FileSimulatedSkillArtifactStore,
  type SimulatedSkillArtifact,
  type SimulatedSkillArtifactStore,
} from './simulated-artifact-store';
import type { BotSkillArtifactTransport } from './artifact-transport';
import { createSkillHubBotSkillArtifactTransport } from './skillhub-artifact-transport';
import type { LocalSkillManifest, LocalSkillManifestEntry } from './local-manifest';
import {
  createBotSkillWorkspaceService,
  type BotSkillWorkspaceActivationLock,
  type BotSkillWorkspaceService,
} from './workspace-service';
import {
  reconcileBotSkillWorkspace,
  recoverBotSkillWorkspaceReconciles,
  type BotSkillWorkspaceDesiredEntry,
} from './workspace-reconciler';

export type BotSkillSyncDirection = 'none' | 'local_to_cloud' | 'cloud_to_local';

export interface BotSkillSyncResult {
  botId: string;
  workspaceId: string;
  direction: BotSkillSyncDirection;
  reason:
    | 'already_synced'
    | 'local_changed'
    | 'cloud_changed'
    | 'cloud_missing'
    | 'workspace_restore'
    | 'legacy_migration'
    | 'transport_migration'
    | 'base_initialized';
  manifest: LocalSkillManifest;
  base: BotSkillSyncBase;
  definition: BotDefinition;
}

export class BotSkillSyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly safeToUseLocal: boolean,
    public readonly manifest?: LocalSkillManifest,
  ) {
    super(message);
    this.name = 'BotSkillSyncError';
  }
}

export interface BotSkillSyncServiceOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  simulatedCloudRoot?: string;
  expectedBotId?: string;
  workspaceService?: BotSkillWorkspaceService;
  activationLock?: BotSkillWorkspaceActivationLock;
  activationTransactionId?: string;
  definitionRepository?: BotDefinitionRepository;
  definitionService?: BotDefinitionSyncService;
  baseRepository?: BotSkillSyncBaseRepository;
  artifactStore?: SimulatedSkillArtifactStore;
  artifactTransport?: BotSkillArtifactTransport | null;
  onPullPhasePersisted?: Parameters<typeof reconcileBotSkillWorkspace>[0]['onPhasePersisted'];
}

export class BotSkillSyncService {
  readonly runtimeRoot: string;

  private readonly env: NodeJS.ProcessEnv;
  private readonly expectedBotId?: string;
  private readonly workspaceService: BotSkillWorkspaceService;
  private readonly existingActivationLock?: BotSkillWorkspaceActivationLock;
  private readonly activationTransactionId?: string;
  private readonly definitionRepository: BotDefinitionRepository;
  private readonly definitionService: BotDefinitionSyncService;
  private readonly baseRepository: BotSkillSyncBaseRepository;
  private readonly artifactStore: SimulatedSkillArtifactStore;
  private readonly artifactTransport?: BotSkillArtifactTransport;
  private readonly onPullPhasePersisted?: BotSkillSyncServiceOptions['onPullPhasePersisted'];

  constructor(options: BotSkillSyncServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.runtimeRoot = path.resolve(
      options.runtimeRoot ?? PathResolver.getRuntimeDataRoot(this.env),
    );
    this.expectedBotId = optional(options.expectedBotId);
    this.workspaceService = options.workspaceService
      ?? createBotSkillWorkspaceService({ runtimeRoot: this.runtimeRoot, env: this.env });
    this.existingActivationLock = options.activationLock;
    this.activationTransactionId = optional(options.activationTransactionId);
    this.definitionRepository = options.definitionRepository
      ?? new FileBotDefinitionRepository({
        runtimeRoot: this.runtimeRoot,
        simulatedCloudRoot: options.simulatedCloudRoot,
      });
    this.definitionService = options.definitionService
      ?? createBotDefinitionSyncService({
        runtimeRoot: this.runtimeRoot,
        repository: this.definitionRepository,
      });
    this.baseRepository = options.baseRepository
      ?? new FileBotSkillSyncBaseRepository({ runtimeRoot: this.runtimeRoot });
    this.artifactStore = options.artifactStore
      ?? new FileSimulatedSkillArtifactStore({
        runtimeRoot: this.runtimeRoot,
        simulatedCloudRoot: options.simulatedCloudRoot,
        env: this.env,
      });
    this.artifactTransport = options.artifactTransport === undefined
      ? (options.artifactStore || options.simulatedCloudRoot
        ? undefined
        : createSkillHubBotSkillArtifactTransport({
          runtimeRoot: this.runtimeRoot,
          env: this.env,
          artifactStore: this.artifactStore,
        }))
      : options.artifactTransport ?? undefined;
    this.onPullPhasePersisted = options.onPullPhasePersisted;
  }

  syncOnStartup(
    botId: string,
    options: { workspaceWasMissing?: boolean } = {},
  ): Promise<BotSkillSyncResult> {
    return this.sync(botId, { workspaceWasMissing: options.workspaceWasMissing === true });
  }

  syncAfterTurn(
    botId: string,
    _manifest?: LocalSkillManifest,
  ): Promise<BotSkillSyncResult> {
    // Always rescan under the workspace lock so a queued background request
    // cannot publish a stale manifest captured before later edits.
    return this.sync(botId);
  }

  syncBeforeSwitch(botId: string): Promise<BotSkillSyncResult> {
    return this.sync(botId);
  }

  pushToCloud(botId: string): Promise<BotSkillSyncResult> {
    return this.runLocked(botId, (botSkills, context) =>
      this.push(botSkills, context, 'local_changed'));
  }

  pullToLocal(botId: string): Promise<BotSkillSyncResult> {
    return this.runLocked(botId, async (botSkills, context) => {
      const manifest = await botSkills.scanManifest();
      const cloud = this.requireCloud(botId, manifest);
      if (!Array.isArray(cloud.skills)) {
        throw new BotSkillSyncError(
          'Legacy BotDefinition has no Skill state to restore.',
          'BOT_SKILL_CLOUD_NOT_MIGRATED',
          manifest.status === 'complete',
          manifest,
        );
      }
      const baseRead = this.baseRepository.inspect(botId, context.workspaceId);
      return this.pullSafely(botSkills, context, manifest, cloud, baseRead, false);
    });
  }

  private sync(
    botId: string,
    options: {
      workspaceWasMissing?: boolean;
    } = {},
  ): Promise<BotSkillSyncResult> {
    return this.runLocked(botId, async (botSkills, context) => {
      const manifest = await botSkills.scanManifest();
      this.requireCompleteLocal(manifest, botId, context.workspaceId);
      const baseRead = this.baseRepository.inspect(botId, context.workspaceId);
      if (baseRead.status === 'invalid') {
        throw new BotSkillSyncError(
          `Bot Skill sync-base is invalid: ${baseRead.reason}`,
          'BOT_SKILL_SYNC_BASE_INVALID',
          !options.workspaceWasMissing,
          manifest,
        );
      }
      const cloudRead = this.definitionRepository.inspectCanonical(botId);
      if (cloudRead.status === 'invalid') {
        throw new BotSkillSyncError(
          'Canonical BotDefinition is invalid; refusing to overwrite it from Local Skills.',
          'BOT_SKILL_CLOUD_INVALID',
          !options.workspaceWasMissing,
          manifest,
        );
      }

      if (cloudRead.status === 'missing') {
        if (options.workspaceWasMissing && manifest.entries.length === 0) {
          throw new BotSkillSyncError(
            'Canonical BotDefinition is missing; an empty restored workspace cannot recreate it safely.',
            'BOT_SKILL_CLOUD_MISSING',
            false,
            manifest,
          );
        }
        return this.push(botSkills, context, 'cloud_missing', manifest, baseRead);
      }
      const cloud = cloudRead.definition;
      if (!Array.isArray(cloud.skills)) {
        return this.push(botSkills, context, 'legacy_migration', manifest, baseRead);
      }

      if (baseRead.status === 'missing') {
        const cloudSkills = cloud.skills;
        // A failed first restore leaves an intentionally empty claimed workspace behind.
        // Treat that persistent state as restore-pending as long as Cloud still has refs,
        // even if the next process no longer knows that the directory was just created.
        if (
          options.workspaceWasMissing
          || (manifest.entries.length === 0 && cloud.skills.length > 0)
        ) {
          return this.pullSafely(botSkills, context, manifest, cloud, baseRead, false);
        }
        const prepared = await this.preparePush(manifest, context, undefined);
        if (
          cloudProjectionDigest(prepared.cloudSkills)
          === cloudProjectionDigest(cloudSkills)
        ) {
          let base: BotSkillSyncBase | undefined;
          const committedCloud = this.writeCacheFromLatestCanonical(
            botId,
            cloudSkills,
            manifest,
            true,
            () => {
              base = createBotSkillSyncBase({
                botId,
                workspaceId: context.workspaceId,
                localEntries: prepared.localEntries,
                bindings: prepared.bindings,
                cloudSkills,
              });
              this.baseRepository.write(base);
            },
          );
          if (!base) throw new Error('Bot Skill Base was not committed');
          return {
            botId,
            workspaceId: context.workspaceId,
            direction: 'none',
            reason: 'base_initialized',
            manifest,
            base,
            definition: committedCloud,
          };
        }
        return this.push(botSkills, context, 'local_changed', manifest, baseRead, prepared);
      }

      const localDigest = localProjectionDigest(projectLocalManifest(manifest));
      const cloudDigest = cloudProjectionDigest(cloud.skills);
      if (localDigest !== baseRead.base.local.digest) {
        return this.push(botSkills, context, 'local_changed', manifest, baseRead);
      }
      if (cloudDigest !== baseRead.base.cloud.digest) {
        return this.pullSafely(botSkills, context, manifest, cloud, baseRead, false);
      }
      if (
        this.artifactTransport
        && baseRead.base.bindings.some(binding => binding.storage === 'simulated-private')
      ) {
        return this.push(botSkills, context, 'transport_migration', manifest, baseRead);
      }
      const committedCloud = this.writeCacheFromLatestCanonical(
        botId,
        cloud.skills,
        manifest,
        true,
      );
      return {
        botId,
        workspaceId: context.workspaceId,
        direction: 'none',
        reason: 'already_synced',
        manifest,
        base: baseRead.base,
        definition: committedCloud,
      };
    });
  }

  private async runLocked(
    botIdValue: string,
    action: (
      botSkills: BotSkillService,
      context: { botId: string; workspaceId: string },
    ) => Promise<BotSkillSyncResult> | BotSkillSyncResult,
  ): Promise<BotSkillSyncResult> {
    const botId = required(botIdValue, 'botId');
    if (this.expectedBotId && this.expectedBotId !== botId) {
      throw new BotSkillSyncError(
        `Bot Skill sync expected ${this.expectedBotId}, not ${botId}.`,
        'BOT_SKILL_SYNC_BOT_MISMATCH',
        false,
      );
    }
    const activationLock = this.existingActivationLock
      ?? this.workspaceService.acquireActivationLock();
    try {
      recoverBotSkillWorkspaceReconciles({
        runtimeRoot: this.runtimeRoot,
        definitionRepository: this.definitionRepository,
        baseRepository: this.baseRepository,
      });
      const state = this.workspaceService.readState();
      const pending = state?.switchJournal?.to;
      const context = (
        pending
        && pending.botId === botId
        && this.activationTransactionId
      ) ? pending : state && {
        botId: state.workspaceOwnerBotId,
        workspaceId: state.workspaceId,
      };
      if (!context || context.botId !== botId) {
        throw new BotSkillSyncError(
          `Bot Skill workspace is not owned by ${botId}.`,
          'BOT_SKILL_SYNC_WORKSPACE_OWNER_MISMATCH',
          false,
        );
      }
      const botSkills = createBotSkillService({
        runtimeRoot: this.runtimeRoot,
        expectedBotId: botId,
        workspaceService: this.workspaceService,
        activationLock,
        activationTransactionId: this.activationTransactionId,
      });
      return await botSkills.withWorkspaceLock(() => action(botSkills, context));
    } finally {
      if (!this.existingActivationLock) activationLock.release();
    }
  }

  private async push(
    botSkills: BotSkillService,
    context: { botId: string; workspaceId: string },
    reason: PushReason,
    knownManifest?: LocalSkillManifest,
    knownBase?: BotSkillSyncBaseReadResult,
    knownPrepared?: PreparedPush,
  ): Promise<BotSkillSyncResult> {
    try {
      return await this.pushUnsafe(
        botSkills,
        context,
        reason,
        knownManifest,
        knownBase,
        knownPrepared,
      );
    } catch (error) {
      if (error instanceof BotSkillSyncError) throw error;
      const wrapped = new BotSkillSyncError(
        `Local Skill upload did not complete: ${errorMessage(error)}`,
        'BOT_SKILL_PUSH_FAILED',
        true,
        knownManifest,
      );
      (wrapped as any).cause = error;
      throw wrapped;
    }
  }

  private async pushUnsafe(
    botSkills: BotSkillService,
    context: { botId: string; workspaceId: string },
    reason: PushReason,
    knownManifest?: LocalSkillManifest,
    knownBase?: BotSkillSyncBaseReadResult,
    knownPrepared?: PreparedPush,
  ): Promise<BotSkillSyncResult> {
    const manifest = knownManifest ?? await botSkills.scanManifest();
    this.requireCompleteLocal(manifest, context.botId, context.workspaceId);
    const baseRead = knownBase ?? this.baseRepository.inspect(context.botId, context.workspaceId);
    if (baseRead.status === 'invalid') {
      throw new BotSkillSyncError(
        `Bot Skill sync-base is invalid: ${baseRead.reason}`,
        'BOT_SKILL_SYNC_BASE_INVALID',
        true,
        manifest,
      );
    }
    const prepared = knownPrepared ?? await this.preparePush(
      manifest,
      context,
      baseRead.status === 'valid' ? baseRead.base : undefined,
    );
    const confirmed = await botSkills.scanManifest();
    this.requireCompleteLocal(confirmed, context.botId, context.workspaceId);
    if (
      localProjectionDigest(projectLocalManifest(confirmed))
      !== localProjectionDigest(prepared.localEntries)
    ) {
      throw new BotSkillSyncError(
        'Local Skills changed while the upload was being prepared.',
        'BOT_SKILL_SYNC_LOCAL_CHANGED',
        true,
        confirmed,
      );
    }
    let base: BotSkillSyncBase | undefined;
    const sync = this.definitionService.updateSkills(
      context.botId,
      prepared.cloudSkills,
      committed => {
        base = createBotSkillSyncBase({
          botId: context.botId,
          workspaceId: context.workspaceId,
          localEntries: prepared.localEntries,
          bindings: prepared.bindings,
          cloudSkills: committed.definition.skills ?? [],
        });
        this.baseRepository.write(base);
      },
    );
    const definition = sync.definition;
    if (!base) throw new Error('Bot Skill Base was not committed');
    return {
      botId: context.botId,
      workspaceId: context.workspaceId,
      direction: 'local_to_cloud',
      reason,
      manifest: confirmed,
      base,
      definition,
    };
  }

  private async preparePush(
    manifest: LocalSkillManifest,
    context: { botId: string; workspaceId: string },
    previousBase?: BotSkillSyncBase,
  ): Promise<PreparedPush> {
    const localEntries = projectLocalManifest(manifest);
    const bindings: BotSkillSyncBinding[] = [];
    const cloudSkills: BotSkillRef[] = [];
    const previousBindings = new Map(
      (previousBase?.bindings ?? []).map(binding => [binding.localSkillId, binding]),
    );
    const previousLocalEntries = new Map(
      (previousBase?.local.entries ?? []).map(entry => [entry.localSkillId, entry]),
    );
    for (const entry of manifest.entries) {
      const publicRef = unmodifiedPublicRef(entry);
      const previous = previousBindings.get(entry.localSkillId);
      const previousLocal = previousLocalEntries.get(entry.localSkillId);
      const reusablePrivate = (
        !publicRef
        && this.artifactTransport
        && previous?.storage === 'skillhub-private'
        && previousLocal?.contentHash === entry.contentHash
      );
      if (reusablePrivate) {
        bindings.push({ ...previous, ref: { ...previous.ref } });
        if (entry.enabled) cloudSkills.push(previous.ref);
        continue;
      }
      const snapshotOptions = {
        botId: required(manifest.botId, 'manifest.botId'),
        skillsRoot: this.skillsRoot(),
        entry,
        ...(publicRef ? { publicRef } : {}),
      };
      const artifact = await this.prepareArtifactForPush(
        snapshotOptions,
        entry,
        publicRef,
        context,
      );
      if (
        previous
        && (
          previous.storage === 'simulated-private'
          || previous.storage === 'skillhub-private'
        )
        && artifact.storage === previous.storage
        && previous.ref.skillId !== artifact.ref.skillId
      ) {
        throw new Error(`Private Skill identity changed for ${entry.localSkillId}`);
      }
      if (
        !publicRef
        && this.artifactTransport
        && (
          artifact.storage !== 'skillhub-private'
          || artifact.botId !== context.botId
          || artifact.localSkillId !== entry.localSkillId
          || artifact.contentHash !== entry.contentHash
        )
      ) {
        throw new Error(`Private Skill upload verification failed for ${entry.localSkillId}`);
      }
      bindings.push({
        localSkillId: entry.localSkillId,
        ref: artifact.ref,
        storage: artifact.storage,
        artifactDigest: artifact.artifactDigest,
      });
      if (entry.enabled) cloudSkills.push(artifact.ref);
    }
    return {
      localEntries,
      bindings,
      cloudSkills: projectCloudSkills(cloudSkills),
    };
  }

  private async prepareArtifactForPush(
    snapshotOptions: Parameters<SimulatedSkillArtifactStore['snapshot']>[0],
    entry: LocalSkillManifestEntry,
    publicRef: BotSkillRef | undefined,
    context: { botId: string; workspaceId: string },
  ): Promise<SimulatedSkillArtifact> {
    const snapshot = !publicRef && this.artifactTransport
      ? this.artifactStore.snapshot(snapshotOptions)
      : this.artifactStore.put(snapshotOptions);
    if (publicRef || !this.artifactTransport) return snapshot;
    return this.artifactTransport.upsertPrivate({
      ...context,
      artifact: snapshot,
      ...(entry.skillId && entry.version
        ? { forkedFrom: { skillId: entry.skillId, version: entry.version } }
        : {}),
    });
  }

  private async pull(
    _botSkills: BotSkillService,
    context: { botId: string; workspaceId: string },
    manifest: LocalSkillManifest,
    cloud: BotDefinition,
    baseRead: BotSkillSyncBaseReadResult,
  ): Promise<BotSkillSyncResult> {
    this.requireCompleteLocal(manifest, context.botId, context.workspaceId);
    const cloudSkills = projectCloudSkills(cloud.skills ?? []);
    const previousBase = baseRead.status === 'valid' ? baseRead.base : undefined;
    const previousBindings = previousBase?.bindings ?? [];
    const bindingsByExactRef = new Map(
      previousBindings.map(binding => [refKey(binding.ref), binding]),
    );
    const bindingsBySkillId = new Map(
      previousBindings.map(binding => [binding.ref.skillId, binding]),
    );
    const desired: BotSkillWorkspaceDesiredEntry[] = [];
    const desiredArtifacts = new Map<string, SimulatedSkillArtifact>();
    for (const ref of cloudSkills) {
      const artifact = await this.resolveArtifact(ref, context);
      if (
        (artifact.storage === 'simulated-private' || artifact.storage === 'skillhub-private')
        && artifact.botId !== context.botId
      ) {
        throw new BotSkillSyncError(
          `Private Skill artifact belongs to another Bot: ${ref.skillId}@${ref.version}`,
          'BOT_SKILL_ARTIFACT_OWNER_MISMATCH',
          true,
          manifest,
        );
      }
      const previous = bindingsByExactRef.get(refKey(ref))
        ?? bindingsBySkillId.get(ref.skillId);
      const localSkillId = previous?.localSkillId
        ?? ((
          artifact.storage === 'simulated-private'
          || artifact.storage === 'skillhub-private'
        )
          ? artifact.localSkillId
          : restoredPublicLocalSkillId(context.workspaceId, ref));
      desired.push({
        artifact,
        localSkillId,
        enabled: true,
      });
      desiredArtifacts.set(localSkillId, artifact);
    }

    if (previousBase) {
      const cloudKeys = new Set(cloudSkills.map(refKey));
      const localById = new Map(
        projectLocalManifest(manifest).map(entry => [entry.localSkillId, entry]),
      );
      for (const local of previousBase.local.entries) {
        if (local.enabled) continue;
        const binding = previousBindings.find(item => item.localSkillId === local.localSkillId);
        if (!binding || cloudKeys.has(refKey(binding.ref))) continue;
        const current = localById.get(local.localSkillId);
        if (!current || localProjectionDigest([current]) !== localProjectionDigest([local])) {
          throw new BotSkillSyncError(
            `Disabled Local Skill changed before Cloud pull: ${local.name}`,
            'BOT_SKILL_SYNC_LOCAL_CHANGED',
            true,
            manifest,
          );
        }
        const artifact = await this.resolveArtifact(binding.ref, context);
        desired.push({
          artifact,
          localSkillId: local.localSkillId,
          enabled: false,
        });
        desiredArtifacts.set(local.localSkillId, artifact);
      }
    }

    let committedDefinition = cloud;
    const reconciled = reconcileBotSkillWorkspace({
      runtimeRoot: this.runtimeRoot,
      skillsRoot: this.skillsRoot(),
      botId: context.botId,
      workspaceId: context.workspaceId,
      currentManifest: manifest,
      desired,
      cloudSkills,
      artifactStore: this.artifactStore,
      onPhasePersisted: this.onPullPhasePersisted,
    }, activeManifest => {
      let committedBase: BotSkillSyncBase | undefined;
      committedDefinition = this.writeCacheFromLatestCanonical(
        context.botId,
        cloudSkills,
        activeManifest,
        false,
        () => {
          const activeLocal = projectLocalManifest(activeManifest);
          const bindings: BotSkillSyncBinding[] = activeLocal.map(local => {
            const artifact = desiredArtifacts.get(local.localSkillId);
            if (!artifact) throw new Error(`Restored Skill has no artifact binding: ${local.name}`);
            return {
              localSkillId: local.localSkillId,
              ref: artifact.ref,
              storage: artifact.storage,
              artifactDigest: artifact.artifactDigest,
            };
          });
          committedBase = createBotSkillSyncBase({
            botId: context.botId,
            workspaceId: context.workspaceId,
            localEntries: activeLocal,
            bindings,
            cloudSkills,
          });
          this.baseRepository.write(committedBase);
        },
      );
      if (!committedBase) throw new Error('Bot Skill Base was not committed');
      return committedBase;
    });
    return {
      botId: context.botId,
      workspaceId: context.workspaceId,
      direction: 'cloud_to_local',
      reason: baseRead.status === 'missing' ? 'workspace_restore' : 'cloud_changed',
      manifest: reconciled.manifest,
      base: reconciled.result,
      definition: committedDefinition,
    };
  }

  private async pullSafely(
    botSkills: BotSkillService,
    context: { botId: string; workspaceId: string },
    manifest: LocalSkillManifest,
    cloud: BotDefinition,
    baseRead: BotSkillSyncBaseReadResult,
    safeToUseLocal: boolean,
  ): Promise<BotSkillSyncResult> {
    try {
      return await this.pull(botSkills, context, manifest, cloud, baseRead);
    } catch (error) {
      if (error instanceof BotSkillSyncError) {
        if (error.safeToUseLocal === safeToUseLocal) throw error;
        const wrapped = new BotSkillSyncError(
          error.message,
          error.code,
          safeToUseLocal,
          error.manifest ?? manifest,
        );
        (wrapped as any).cause = error;
        throw wrapped;
      }
      const wrapped = new BotSkillSyncError(
        `Cloud Skill restore did not complete: ${errorMessage(error)}`,
        'BOT_SKILL_PULL_FAILED',
        safeToUseLocal,
        manifest,
      );
      (wrapped as any).cause = error;
      throw wrapped;
    }
  }

  private async resolveArtifact(
    ref: BotSkillRef,
    context: { botId: string; workspaceId: string },
  ): Promise<SimulatedSkillArtifact> {
    try {
      return this.artifactStore.read(ref);
    } catch (error: any) {
      if (error?.code !== 'SIMULATED_SKILL_ARTIFACT_MISSING') throw error;
    }
    if (ref.skillId.startsWith('sim-private:')) {
      const error: NodeJS.ErrnoException = new Error(
        `Legacy private Skill artifact is missing: ${ref.skillId}@${ref.version}; its original device must migrate it before another device can restore it.`,
      );
      error.code = 'BOT_SKILL_LEGACY_ARTIFACT_MIGRATION_REQUIRED';
      throw error;
    }
    if (!this.artifactTransport) {
      const error: NodeJS.ErrnoException = new Error(
        `Skill artifact is not cached: ${ref.skillId}@${ref.version}`,
      );
      error.code = 'BOT_SKILL_ARTIFACT_TRANSPORT_UNAVAILABLE';
      throw error;
    }
    return this.artifactTransport.fetchVerified(ref, context);
  }

  private requireCloud(botId: string, manifest: LocalSkillManifest): BotDefinition {
    const cloud = this.definitionRepository.inspectCanonical(botId);
    if (cloud.status === 'valid') return cloud.definition;
    throw new BotSkillSyncError(
      cloud.status === 'invalid'
        ? 'Canonical BotDefinition is invalid.'
        : 'Canonical BotDefinition is missing.',
      cloud.status === 'invalid' ? 'BOT_SKILL_CLOUD_INVALID' : 'BOT_SKILL_CLOUD_MISSING',
      manifest.status === 'complete',
      manifest,
    );
  }

  private writeCacheFromLatestCanonical(
    botId: string,
    expectedSkills: readonly BotSkillRef[],
    manifest: LocalSkillManifest,
    safeToUseLocal: boolean,
    afterCache?: (definition: BotDefinition) => void,
  ): BotDefinition {
    const commit = (): BotDefinition => {
      const latest = this.definitionRepository.inspectCanonical(botId);
      if (
        latest.status !== 'valid'
        || !Array.isArray(latest.definition.skills)
        || cloudProjectionDigest(latest.definition.skills)
          !== cloudProjectionDigest(expectedSkills)
      ) {
        throw new BotSkillSyncError(
          'Canonical BotDefinition changed while Skill synchronization was committing.',
          'BOT_SKILL_CLOUD_CHANGED',
          safeToUseLocal,
          manifest,
        );
      }
      this.definitionRepository.writeCache(latest.definition);
      afterCache?.(latest.definition);
      return latest.definition;
    };
    return this.definitionRepository.withCanonicalLock
      ? this.definitionRepository.withCanonicalLock(botId, commit)
      : commit();
  }

  private requireCompleteLocal(
    manifest: LocalSkillManifest,
    botId: string,
    workspaceId: string,
  ): void {
    if (
      manifest.status !== 'complete'
      || manifest.botId !== botId
      || manifest.workspaceId !== workspaceId
    ) {
      throw new BotSkillSyncError(
        `Local Skill manifest is ${manifest.status}; synchronization stopped.`,
        'BOT_SKILL_LOCAL_INCOMPLETE',
        false,
        manifest,
      );
    }
  }

  private skillsRoot(): string {
    return path.join(this.runtimeRoot, 'skills');
  }
}

interface PreparedPush {
  localEntries: BotSkillSyncLocalEntry[];
  bindings: BotSkillSyncBinding[];
  cloudSkills: BotSkillRef[];
}

type PushReason =
  | 'local_changed'
  | 'cloud_missing'
  | 'legacy_migration'
  | 'transport_migration';

export function createBotSkillSyncService(
  options: BotSkillSyncServiceOptions = {},
): BotSkillSyncService {
  return new BotSkillSyncService(options);
}

function unmodifiedPublicRef(entry: LocalSkillManifestEntry): BotSkillRef | undefined {
  if (
    entry.source !== 'skillhub'
    || entry.sourceVisibility === 'private'
    || !entry.skillId
    || !entry.version
    || !entry.installedContentHash
    || entry.installedContentHash !== entry.contentHash
  ) return undefined;
  return { skillId: entry.skillId, version: entry.version };
}

function refKey(ref: BotSkillRef): string {
  return `${ref.skillId}\0${ref.version}`;
}

function restoredPublicLocalSkillId(workspaceId: string, ref: BotSkillRef): string {
  const hex = crypto.createHash('sha256')
    .update(`${workspaceId}\0${ref.skillId}\0${ref.version}`, 'utf8')
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optional(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
