import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
  FileBotSkillSwitchJournalStore,
  type BotSkillSwitchJournal,
  type BotSkillSwitchPhase,
} from './switch-journal';
import {
  BOT_SKILL_WORKSPACE_IDENTITY_FILE,
  BotSkillWorkspaceService,
  type BotSkillWorkspaceOwner,
} from './workspace';
import { withBotSkillWorkspaceLock } from './workspace-lock';

export interface BotSkillWorkspaceSwitchRequest {
  fromOwner: BotSkillWorkspaceOwner;
  toOwner: BotSkillWorkspaceOwner;
  fromParkedRoot: string;
  targetPreparedRoot: string;
  oldConnectorWasRunning?: boolean;
  prepareTarget(targetRoot: string): Promise<void>;
  stopOldConnector(): Promise<void>;
  syncOldWorkspace(): Promise<unknown>;
  preflightTarget(): Promise<void>;
  commitTargetBinding(): Promise<void>;
  rollbackSourceBinding?(): Promise<void>;
  startTargetConnector(): Promise<void>;
  stopTargetConnector?(): Promise<void>;
  restartOldConnector?(): Promise<void>;
}

export interface BotSkillWorkspaceSwitchRecoveryOptions {
  currentBotId?: string;
  restartConnector?(result: 'rolled_back' | 'committed'): Promise<void>;
}

export interface BotSkillWorkspaceSwitchServiceOptions {
  workspace: BotSkillWorkspaceService;
  journalStore: FileBotSkillSwitchJournalStore;
  createId?: () => string;
  now?: () => Date;
}

export class BotSkillWorkspaceSwitchService {
  private readonly workspace: BotSkillWorkspaceService;
  private readonly journalStore: FileBotSkillSwitchJournalStore;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: BotSkillWorkspaceSwitchServiceOptions) {
    this.workspace = options.workspace;
    this.journalStore = options.journalStore;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  async switch(request: BotSkillWorkspaceSwitchRequest): Promise<void> {
    const activeRoot = path.resolve(this.workspace.root);
    const fromParkedRoot = path.resolve(request.fromParkedRoot);
    const targetPreparedRoot = path.resolve(request.targetPreparedRoot);
    let journal: BotSkillSwitchJournal | undefined;
    let bindingCommitAttempted = false;
    let oldStopped = false;
    let targetStarted = false;
    try {
      await withBotSkillWorkspaceLock(this.workspace.root, async () => {
        if (this.journalStore.read()) {
          throw switchError('An unfinished Bot Skill switch must be recovered first.', 'BOT_SKILL_SWITCH_IN_PROGRESS');
        }
        const source = this.workspace.inspect(request.fromOwner);
        if (source.kind !== 'valid') {
          throw switchError('Source Bot Skill workspace is not safe to switch.', 'BOT_SKILL_SWITCH_SOURCE_INVALID');
        }
        assertSameVolume(activeRoot, fromParkedRoot, targetPreparedRoot);
        if (fs.existsSync(fromParkedRoot)) {
          throw switchError('Source parked workspace already exists.', 'BOT_SKILL_SWITCH_PATH_COLLISION');
        }
        const timestamp = this.now().toISOString();
        journal = {
          schema: BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
          transactionId: this.createId(),
          phase: 'PREPARING_TARGET',
          fromBotId: request.fromOwner.botId,
          fromWorkspaceId: source.identity.workspaceId,
          toBotId: request.toOwner.botId,
          ...(request.oldConnectorWasRunning !== undefined
            ? { oldConnectorWasRunning: request.oldConnectorWasRunning }
            : {}),
          activeRoot,
          fromParkedRoot,
          targetPreparedRoot,
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        this.journalStore.write(journal);

        await request.prepareTarget(targetPreparedRoot);
        const target = new BotSkillWorkspaceService({ skillsRoot: targetPreparedRoot })
          .inspect(request.toOwner);
        if (target.kind !== 'valid') {
          throw switchError('Target Bot Skill workspace failed preparation.', 'BOT_SKILL_SWITCH_TARGET_INVALID');
        }
        journal = {
          ...journal,
          toWorkspaceId: target.identity.workspaceId,
          updatedAt: this.now().toISOString(),
        };
        this.journalStore.write(journal);
      });

      // A graceful child shutdown may flush a pending sync. Stop it without
      // holding the active workspace lock, then perform the parent's final sync.
      await request.stopOldConnector();
      oldStopped = true;
      await withBotSkillWorkspaceLock(this.workspace.root, async () => {
        const persisted = this.journalStore.read();
        if (!persisted || persisted.transactionId !== journal?.transactionId) {
          throw switchError('Bot Skill switch journal changed before workspace activation.', 'BOT_SKILL_SWITCH_JOURNAL_MISMATCH');
        }
        journal = persisted;
        journal = this.advance(journal, 'OLD_CONNECTOR_STOPPED');
        await request.syncOldWorkspace();

        journal = this.advance(journal, 'PARKING_OLD');
        fs.mkdirSync(path.dirname(fromParkedRoot), { recursive: true });
        fs.renameSync(activeRoot, fromParkedRoot);
        journal = this.advance(journal, 'OLD_WORKSPACE_PARKED');

        journal = this.advance(journal, 'ACTIVATING_TARGET');
        fs.mkdirSync(path.dirname(activeRoot), { recursive: true });
        fs.renameSync(targetPreparedRoot, activeRoot);
        journal = this.advance(journal, 'TARGET_ACTIVATED');

        await request.preflightTarget();
        journal = this.advance(journal, 'TARGET_PREFLIGHT_OK');
        journal = this.advance(journal, 'COMMITTING_BINDING');
        bindingCommitAttempted = true;
        await request.commitTargetBinding();
        journal = this.advance(journal, 'BINDING_COMMITTED');
      });

      // The connector performs its own startup sync and therefore must never
      // be started while the parent process owns the cross-process workspace lock.
      await request.startTargetConnector();
      targetStarted = true;
      await withBotSkillWorkspaceLock(this.workspace.root, async () => {
        const persisted = this.journalStore.read();
        if (!persisted || persisted.transactionId !== journal?.transactionId) {
          throw switchError('Bot Skill switch journal changed before connector commit.', 'BOT_SKILL_SWITCH_JOURNAL_MISMATCH');
        }
        journal = persisted;
        journal = this.advance(journal, 'COMMITTED');
        this.journalStore.delete();
      });
    } catch (error) {
      try {
        if (targetStarted) await request.stopTargetConnector?.();
        await withBotSkillWorkspaceLock(this.workspace.root, async () => {
          const persisted = this.journalStore.read();
          if (persisted) journal = persisted;
          if (!journal) return;
          if (bindingCommitAttempted) await request.rollbackSourceBinding?.();
          this.rollbackDirectories(journal);
          this.journalStore.delete();
        });
        if (oldStopped) await request.restartOldConnector?.();
      } catch (rollbackError: any) {
        const failure = switchError(
          'Bot Skill switch failed and rollback could not complete.',
          'BOT_SKILL_SWITCH_ROLLBACK_FAILED',
        ) as Error & { cause?: unknown; originalError?: unknown };
        failure.cause = rollbackError;
        failure.originalError = error;
        throw failure;
      }
      throw error;
    }
  }

  async recover(
    options: BotSkillWorkspaceSwitchRecoveryOptions = {},
  ): Promise<'none' | 'rolled_back' | 'committed'> {
    let shouldRestart = false;
    const result = await withBotSkillWorkspaceLock(this.workspace.root, async () => {
      const journal = this.journalStore.read();
      if (!journal) return 'none';
      const currentBotId = String(options.currentBotId || '').trim();
      const bindingPointsToTarget = currentBotId === journal.toBotId;
      const bindingPointsToSource = currentBotId === journal.fromBotId;
      if (
        ((journal.phase === 'BINDING_COMMITTED' || journal.phase === 'COMMITTED') && bindingPointsToTarget)
        || (journal.phase === 'COMMITTING_BINDING' && bindingPointsToTarget)
      ) {
        this.assertCommittedLayout(journal);
        this.journalStore.delete();
        shouldRestart = true;
        return 'committed';
      }
      if (
        (journal.phase === 'BINDING_COMMITTED' || journal.phase === 'COMMITTED')
        && !bindingPointsToSource
      ) {
        throw switchError(
          'Bot binding does not match either side of the unfinished workspace switch.',
          'BOT_SKILL_SWITCH_BINDING_MISMATCH',
        );
      }
      if (
        bindingPointsToTarget
        && journal.phase !== 'COMMITTING_BINDING'
      ) {
        throw switchError(
          'Bot binding advanced before the workspace switch reached its commit phase.',
          'BOT_SKILL_SWITCH_BINDING_MISMATCH',
        );
      }
      this.rollbackDirectories(journal);
      this.journalStore.delete();
      shouldRestart = Boolean(journal.oldConnectorWasRunning);
      return 'rolled_back';
    });
    if (shouldRestart && result !== 'none') await options.restartConnector?.(result);
    return result;
  }

  private advance(
    journal: BotSkillSwitchJournal,
    phase: BotSkillSwitchPhase,
  ): BotSkillSwitchJournal {
    const next = { ...journal, phase, updatedAt: this.now().toISOString() };
    this.journalStore.write(next);
    return next;
  }

  private rollbackDirectories(journal: BotSkillSwitchJournal): void {
    const activeExists = fs.existsSync(journal.activeRoot);
    const sourceParkedExists = fs.existsSync(journal.fromParkedRoot);
    const targetPreparedExists = fs.existsSync(journal.targetPreparedRoot);
    const sourceStillActive = activeExists && !sourceParkedExists;
    if (sourceStillActive) return;

    if (activeExists && sourceParkedExists) {
      if (targetPreparedExists) {
        throw switchError('Target workspace collision prevents rollback.', 'BOT_SKILL_SWITCH_PATH_COLLISION');
      }
      fs.renameSync(journal.activeRoot, journal.targetPreparedRoot);
    }
    if (!fs.existsSync(journal.activeRoot) && fs.existsSync(journal.fromParkedRoot)) {
      fs.mkdirSync(path.dirname(journal.activeRoot), { recursive: true });
      fs.renameSync(journal.fromParkedRoot, journal.activeRoot);
    }
    if (!fs.existsSync(journal.activeRoot)) {
      throw switchError('Source workspace could not be restored.', 'BOT_SKILL_SWITCH_ROLLBACK_FAILED');
    }
  }

  private assertCommittedLayout(journal: BotSkillSwitchJournal): void {
    if (!fs.existsSync(journal.activeRoot) || fs.existsSync(journal.targetPreparedRoot)) {
      throw switchError('Committed Bot Skill switch layout is inconsistent.', 'BOT_SKILL_SWITCH_LAYOUT_INVALID');
    }
    try {
      const identity = JSON.parse(fs.readFileSync(
        path.join(journal.activeRoot, BOT_SKILL_WORKSPACE_IDENTITY_FILE),
        'utf8',
      ));
      if (
        identity?.workspaceOwnerBotId !== journal.toBotId
        || (journal.toWorkspaceId && identity?.workspaceId !== journal.toWorkspaceId)
      ) {
        throw new Error('identity mismatch');
      }
    } catch {
      throw switchError('Committed Bot Skill workspace identity is inconsistent.', 'BOT_SKILL_SWITCH_LAYOUT_INVALID');
    }
  }
}

function assertSameVolume(...roots: string[]): void {
  const volumes = new Set(roots.map(root => path.parse(root).root.toLowerCase()));
  if (volumes.size !== 1) {
    throw switchError('Bot Skill workspaces must be on the same volume.', 'BOT_SKILL_SWITCH_CROSS_VOLUME');
  }
}

function switchError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}
