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

export interface PrepareBoundBotSkillsOptions {
  runtimeRoot: string;
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
  definitionService: BotDefinitionSyncService;
}

export interface PreparedBoundBotSkills {
  sync?: BotSkillSyncResult;
  workspaceExisted: boolean;
  localPreservedAfterError?: string;
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
    const activeRoot = PathResolver.getRuntimeDataRoot() === runtimeRoot
      ? PathResolver.getSkillsPath()
      : path.join(runtimeRoot, 'skills');
    const workspace = new BotSkillWorkspaceService(runtimeRoot, activeRoot);
    const activeBotId = workspace.getActiveBotId();
    if (activeBotId) {
      BotSkillSyncService.recoverInterruptedRestore(runtimeRoot, activeBotId, activeRoot);
    }
    const activation = workspace.activate(options.botId);
    try {
      const sync = await new BotSkillSyncService({
        runtimeRoot,
        botId: options.botId,
        auth: options.auth,
        skillsRoot: activation.path,
        workspaceExisted: activation.existed,
        fetchImpl: options.fetchImpl,
        definitionService: options.definitionService,
      }).sync();
      return { sync, workspaceExisted: activation.existed, activation };
    } catch (error) {
      const message = errorMessage(error);
      if (activation.existed && !(error instanceof BotSkillCloudRestoreError)) {
        Logger.warning(`Bot Skill 云同步暂时失败，继续使用本地工作区: ${message}`);
        return {
          workspaceExisted: true,
          localPreservedAfterError: message,
          activation,
        };
      }
      try {
        workspace.rollback(activation);
      } catch (rollbackError) {
        throw new Error(
          `Bot Skill 云端恢复失败，且工作区回滚失败: ${message}; ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
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
    throw new Error(
      `Bot Skill workspace ownership is changing (${context.activeBotId} -> ${context.botId}); retry the write.`,
    );
  }
}
