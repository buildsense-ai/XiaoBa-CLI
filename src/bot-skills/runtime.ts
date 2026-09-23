import * as path from 'path';
import {
  createCatsCoLocalConfigService,
  type CatsCoAuthSnapshot,
} from '../catscompany/local-config';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import {
  createBotDefinitionSyncService,
  type BotDefinitionSyncService,
} from '../bot-definition/service';
import { withBotSkillWorkspaceLock } from './lock';
import {
  BotSkillCloudRestoreError,
  BotSkillSyncService,
  type FinalizePublicBotSkillInput,
  type FinalizePublicBotSkillOptions,
  type BotSkillSyncResult,
} from './sync-service';
import {
  BotSkillWorkspaceService,
  type BotSkillWorkspaceActivation,
} from './workspace';
import type { BotSkillRef } from '../bot-definition/types';

export interface PrepareBoundBotSkillsOptions {
  runtimeRoot: string;
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
  definitionService: BotDefinitionSyncService;
  /**
   * Reuse is allowed only after workspace ownership, Base metadata, and local
   * package hashes are verified under the normal cross-process Skill lock.
   */
  reuseVerifiedLocal?: {
    skills: readonly BotSkillRef[];
    definitionRevision: number;
  };
  /**
   * The caller proved that the previous and desired BotDefinitions both list no
   * synchronized Skill references. Activate this Bot's workspace so the
   * ownership invariant still holds (a foreign workspace gets parked and this
   * Bot's own workspace is restored), but skip Cloud package reconciliation so
   * local-only content is neither read, uploaded, nor deleted.
   */
  preserveLocalOnlyWorkspace?: {
    definitionRevision: number;
  };
  /** Refuse to activate another Bot's workspace for a live Runtime apply. */
  requireActiveWorkspace?: boolean;
}

export interface PreparedBoundBotSkills {
  sync?: BotSkillSyncResult;
  workspaceExisted: boolean;
  activation: BotSkillWorkspaceActivation;
}

export interface CurrentBotSkillWorkspaceWriteContext {
  runtimeRoot: string;
  skillsRoot: string;
  botId?: string;
  activeBotId?: string;
}

export interface CurrentBotSkillWorkspaceWriteOptions {
  runtimeRoot?: string;
  lockWaitMs?: number;
}

export interface PushCurrentBotSkillWorkspaceOptions
  extends CurrentBotSkillWorkspaceWriteOptions {
  validateScope?: () => Promise<void> | void;
  validateWorkspace?: (
    context: CurrentBotSkillWorkspaceWriteContext,
  ) => Promise<void> | void;
}

export class BotSkillWorkspaceChangingError extends Error {
  readonly code = 'WORKSPACE_SWITCHING';

  constructor(
    public readonly activeBotId: string,
    public readonly targetBotId: string,
  ) {
    super(`Bot Skill workspace ownership is changing (${activeBotId} -> ${targetBotId}); retry the write.`);
    this.name = 'BotSkillWorkspaceChangingError';
  }
}

/**
 * Serializes every writer of the active Skill directory with Bot activation,
 * restore, rollback, and after-turn sync. The ownership snapshot is captured
 * while holding the same cross-process lock as the write itself.
 */
export async function withCurrentBotSkillWorkspaceWrite<T>(
  operation: (context: CurrentBotSkillWorkspaceWriteContext) => Promise<T> | T,
  options: CurrentBotSkillWorkspaceWriteOptions = {},
): Promise<T> {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
  return withBotSkillWorkspaceLock(runtimeRoot, async () => {
    const context = currentBotSkillWorkspaceWriteContext(runtimeRoot);
    assertCurrentBotSkillWorkspaceIsWritable(context);
    const result = await operation(context);
    const reviewed = currentBotSkillWorkspaceWriteContext(runtimeRoot);
    if (reviewed.activeBotId !== context.activeBotId || reviewed.skillsRoot !== context.skillsRoot) {
      throw new Error('The active Bot Skill workspace changed during a serialized write.');
    }
    assertCurrentBotSkillWorkspaceIsWritable(reviewed);
    return result;
  }, { waitMs: options.lockWaitMs });
}

export async function prepareBoundBotSkills(
  options: PrepareBoundBotSkillsOptions,
): Promise<PreparedBoundBotSkills> {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  return withBotSkillWorkspaceLock(runtimeRoot, async () => {
    let workspace: BotSkillWorkspaceService | undefined;
    let activation: BotSkillWorkspaceActivation | undefined;
    try {
      const activeRoot = PathResolver.getRuntimeDataRoot() === runtimeRoot
        ? PathResolver.getSkillsPath()
        : path.join(runtimeRoot, 'skills');
      workspace = new BotSkillWorkspaceService(runtimeRoot, activeRoot);
      const activeBotId = workspace.getActiveBotId();
      if (activeBotId) {
        BotSkillSyncService.recoverInterruptedRestore(runtimeRoot, activeBotId, activeRoot);
      }
      if (options.requireActiveWorkspace && activeBotId !== options.botId) {
        throw new BotSkillWorkspaceChangingError(activeBotId || '(none)', options.botId);
      }
      activation = workspace.activate(options.botId);
      if (options.preserveLocalOnlyWorkspace) {
        const revision = options.preserveLocalOnlyWorkspace.definitionRevision;
        return {
          sync: {
            botId: options.botId,
            direction: 'none',
            cloudRevision: revision,
            observedRevision: revision,
            desiredRevision: revision,
            appliedRevision: revision,
            applyStatus: 'already_applied',
            skills: [],
          },
          workspaceExisted: activation.existed,
          activation,
        };
      }
      const syncService = new BotSkillSyncService({
        runtimeRoot,
        botId: options.botId,
        auth: options.auth,
        skillsRoot: activation.path,
        workspaceExisted: activation.existed,
        fetchImpl: options.fetchImpl,
        definitionService: options.definitionService,
      });
      const reused = options.reuseVerifiedLocal
        ? syncService.reuseVerifiedActivation(
            options.reuseVerifiedLocal.skills,
            options.reuseVerifiedLocal.definitionRevision,
          )
        : undefined;
      const sync = reused ?? await syncService.reconcileActivationFromCloudOnly();
      return { sync, workspaceExisted: activation.existed, activation };
    } catch (error) {
      if (error instanceof BotSkillWorkspaceChangingError) throw error;
      const failure = error instanceof BotSkillCloudRestoreError
        ? error
        : new BotSkillCloudRestoreError(
          `Bot Skill activation failed closed: ${errorMessage(error)}`,
          { cause: error },
        );
      if (workspace && activation) {
        try {
          workspace.rollback(activation);
        } catch (rollbackError) {
          throw new BotSkillCloudRestoreError(
            `Bot Skill cloud restore failed and workspace rollback also failed: ${errorMessage(failure)}; ${errorMessage(rollbackError)}`,
            { cause: rollbackError },
          );
        }
      }
      throw failure;
    }
  });
}

export async function rollbackPreparedBotSkills(
  runtimeRoot: string,
  prepared: PreparedBoundBotSkills | undefined,
): Promise<void> {
  if (!prepared?.activation.previousBotId) return;
  const resolvedRoot = path.resolve(runtimeRoot);
  await withBotSkillWorkspaceLock(resolvedRoot, () => {
    const activeRoot = PathResolver.getRuntimeDataRoot() === resolvedRoot
      ? PathResolver.getSkillsPath()
      : path.join(resolvedRoot, 'skills');
    new BotSkillWorkspaceService(resolvedRoot, activeRoot).rollback(prepared.activation);
  });
}

let currentBotSyncRunning = false;
let currentBotSyncPending = false;

/**
 * Runs after a turn has finished. It deliberately refuses to switch workspaces:
 * startup/bot activation owns switching, while this path only publishes edits
 * from the workspace that is already active for the currently bound Bot.
 */
export function scheduleCurrentBotSkillSync(): void {
  currentBotSyncPending = true;
  if (currentBotSyncRunning) return;
  currentBotSyncRunning = true;
  void (async () => {
    try {
      while (currentBotSyncPending) {
        currentBotSyncPending = false;
        try {
          await syncCurrentBotSkillsNow();
        } catch (error) {
          Logger.warning(`Bot Skill cloud sync failed; local workspace is preserved: ${errorMessage(error)}`);
        }
      }
    } finally {
      currentBotSyncRunning = false;
      if (currentBotSyncPending) scheduleCurrentBotSkillSync();
    }
  })();
}

export async function syncCurrentBotSkillsNow(): Promise<BotSkillSyncResult | undefined> {
  const runtimeRoot = path.resolve(PathResolver.getRuntimeDataRoot());
  return withBotSkillWorkspaceLock(runtimeRoot, async () => {
    const configService = createCatsCoLocalConfigService({ runtimeRoot });
    const localConfig = configService.load();
    const botId = String(localConfig.currentBot?.uid || '').trim();
    if (!botId) return undefined;

    const activeRoot = PathResolver.getRuntimeDataRoot() === runtimeRoot
      ? PathResolver.getSkillsPath()
      : path.join(runtimeRoot, 'skills');
    const workspace = new BotSkillWorkspaceService(runtimeRoot, activeRoot);
    if (workspace.getActiveBotId() !== botId) return undefined;
    BotSkillSyncService.recoverInterruptedRestore(runtimeRoot, botId, activeRoot);

    const definitionService = createBotDefinitionSyncService({ runtimeRoot });
    return new BotSkillSyncService({
      runtimeRoot,
      botId,
      auth: configService.getAuthState(),
      skillsRoot: workspace.getActivePath(),
      workspaceExisted: true,
      definitionService,
    }).sync();
  });
}

/**
 * Owner-initiated Runtime workspace publication. The currently active local
 * workspace is authoritative for this call and is uploaded as Bot-private
 * packages where no existing public/private reference can be reused.
 */
export async function pushCurrentBotSkillWorkspaceToCloudNow(
  botId: string,
  options: PushCurrentBotSkillWorkspaceOptions = {},
): Promise<BotSkillSyncResult> {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
  return withCurrentBotSkillWorkspaceWrite(async (context) => {
    if (context.botId !== botId || context.activeBotId !== botId) {
      throw new Error('The selected Bot workspace is not active on this device.');
    }
    await options.validateScope?.();
    await options.validateWorkspace?.(context);
    const configService = createCatsCoLocalConfigService({ runtimeRoot });
    const definitionService = createBotDefinitionSyncService({ runtimeRoot });
    return new BotSkillSyncService({
      runtimeRoot,
      botId,
      auth: configService.getAuthState(),
      skillsRoot: context.skillsRoot,
      workspaceExisted: true,
      definitionService,
    }).pushWorkspaceToCloud({
      validateScope: options.validateScope,
      validateWorkspace: () => options.validateWorkspace?.(context),
    });
  }, options);
}

export interface FinalizeCurrentBotPublicSkillOptions
  extends FinalizePublicBotSkillOptions, CurrentBotSkillWorkspaceWriteOptions {}

export async function finalizeCurrentBotPublicSkillNow(
  botId: string,
  input: FinalizePublicBotSkillInput,
  options: FinalizeCurrentBotPublicSkillOptions = {},
): Promise<BotSkillSyncResult> {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
  return withCurrentBotSkillWorkspaceWrite(async (context) => {
    if (context.botId !== botId || context.activeBotId !== botId) {
      throw new Error('The selected Bot workspace is not active on this device.');
    }
    await options.validateScope?.();
    const configService = createCatsCoLocalConfigService({ runtimeRoot });
    const definitionService = createBotDefinitionSyncService({ runtimeRoot });
    return new BotSkillSyncService({
      runtimeRoot,
      botId,
      auth: configService.getAuthState(),
      skillsRoot: context.skillsRoot,
      workspaceExisted: true,
      definitionService,
    }).finalizePublicSkill(input, options);
  }, {
    runtimeRoot,
    lockWaitMs: options.lockWaitMs,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentBotSkillWorkspaceWriteContext(
  runtimeRoot: string,
): CurrentBotSkillWorkspaceWriteContext {
  const skillsRoot = PathResolver.getRuntimeDataRoot() === runtimeRoot
    ? path.resolve(PathResolver.getSkillsPath())
    : path.join(runtimeRoot, 'skills');
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  const botId = String(configService.load().currentBot?.uid || '').trim() || undefined;
  const activeBotId = new BotSkillWorkspaceService(runtimeRoot, skillsRoot).getActiveBotId();
  return {
    runtimeRoot,
    skillsRoot,
    ...(botId ? { botId } : {}),
    ...(activeBotId ? { activeBotId } : {}),
  };
}

function assertCurrentBotSkillWorkspaceIsWritable(
  context: CurrentBotSkillWorkspaceWriteContext,
): void {
  if (context.botId && context.activeBotId && context.botId !== context.activeBotId) {
    throw new BotSkillWorkspaceChangingError(context.activeBotId, context.botId);
  }
}
