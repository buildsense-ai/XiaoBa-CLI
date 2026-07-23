import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOT_SKILL_WORKSPACE_MARKER_SCHEMA = 'xiaoba.bot-skill-workspace.v1';
export const BOT_SKILL_WORKSPACE_STATE_SCHEMA = 'xiaoba.bot-skill-workspace-state.v1';

export type BotSkillWorkspaceSwitchPhase =
  | 'prepared'
  | 'source-parked'
  | 'target-active';

export interface BotSkillWorkspaceIdentity {
  botId: string;
  workspaceId: string;
}

export interface BotSkillWorkspaceMarker {
  schema: typeof BOT_SKILL_WORKSPACE_MARKER_SCHEMA;
  workspaceOwnerBotId: string;
  workspaceId: string;
  createdAt: string;
}

export interface BotSkillWorkspaceSwitchJournal {
  transactionId: string;
  from: BotSkillWorkspaceIdentity;
  to: BotSkillWorkspaceIdentity;
  phase: BotSkillWorkspaceSwitchPhase;
  targetWasCreated: boolean;
  startedAt: string;
}

export interface BotSkillWorkspaceState {
  schema: typeof BOT_SKILL_WORKSPACE_STATE_SCHEMA;
  revision: number;
  workspaceOwnerBotId: string;
  workspaceId: string;
  switchJournal?: BotSkillWorkspaceSwitchJournal;
}

export interface BotSkillWorkspaceSwitch {
  transactionId?: string;
  fromBotId: string;
  toBotId: string;
  changed: boolean;
}

export interface BotSkillWorkspaceActivationLock {
  lockId: string;
  release: () => void;
}

export interface BotSkillWorkspaceServiceOptions {
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Test-only crash injection point. Production callers should not set this.
   */
  onPhasePersisted?: (phase: BotSkillWorkspaceSwitchPhase) => void;
}

export const BOT_SKILL_WORKSPACE_MARKER_FILE = '.xiaoba-bot-workspace.json';
const MARKER_FILE = BOT_SKILL_WORKSPACE_MARKER_FILE;
const MAX_JSON_BYTES = 256 * 1024;

export class BotSkillWorkspaceService {
  readonly runtimeRoot: string;
  readonly activePath: string;
  readonly dataRoot: string;
  readonly parkedRoot: string;
  readonly statePath: string;
  readonly lockPath: string;

  private readonly phaseHook?: (phase: BotSkillWorkspaceSwitchPhase) => void;

  constructor(options: BotSkillWorkspaceServiceOptions) {
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.activePath = path.join(this.runtimeRoot, 'skills');
    this.dataRoot = path.join(this.runtimeRoot, 'data', 'bot-skills');
    this.parkedRoot = path.join(this.dataRoot, 'by-bot');
    this.statePath = path.join(this.dataRoot, 'workspace-state.json');
    this.lockPath = path.join(this.dataRoot, 'switch.lock');
    this.phaseHook = options.onPhasePersisted;

    const override = String((options.env ?? process.env).XIAOBA_SKILLS_DIR || '').trim();
    if (override && !samePath(path.resolve(override), this.activePath)) {
      throw new Error(
        `Bot-managed Skill workspaces require XIAOBA_SKILLS_DIR to resolve to ${this.activePath}.`,
      );
    }
    this.assertSafeRoot(this.runtimeRoot, 'runtime root');
  }

  readState(): BotSkillWorkspaceState | undefined {
    if (!fs.existsSync(this.statePath)) return undefined;
    return parseState(readJsonFile(this.statePath));
  }

  getParkedPath(botId: string): string {
    const normalized = normalizeBotId(botId);
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
    return path.join(this.parkedRoot, `b_${digest}`);
  }

  /**
   * Adopts the legacy active directory for the currently bound Bot. No content
   * is copied or moved, so offline edits remain owned by that Bot.
   */
  ensureActive(
    botId: string,
    options: { allowCreate?: boolean; lock?: BotSkillWorkspaceActivationLock } = {},
  ): BotSkillWorkspaceState {
    return this.withLock(() => {
      this.recoverInterruptedSwitchUnlocked();
      const normalizedBotId = normalizeBotId(botId);
      const state = this.readState();
      if (state) {
        const marker = this.readRequiredMarker(this.activePath);
        assertIdentity(marker, {
          botId: state.workspaceOwnerBotId,
          workspaceId: state.workspaceId,
        }, 'active workspace');
        if (state.workspaceOwnerBotId !== normalizedBotId) {
          throw new Error(
            `Active Skill workspace belongs to Bot ${state.workspaceOwnerBotId}, not ${normalizedBotId}.`,
          );
        }
        return state;
      }

      this.ensureManagedRoots();
      if (!fs.existsSync(this.activePath)) {
        if (!options.allowCreate) {
          throw new Error(
            `No active Skill workspace exists for Bot ${normalizedBotId}; explicit creation or restore is required.`,
          );
        }
        fs.mkdirSync(this.activePath, { recursive: false, mode: 0o700 });
      }
      this.assertDirectoryIsSafe(this.activePath, 'active Skill workspace');

      const existingMarker = this.readMarker(this.activePath);
      if (existingMarker && existingMarker.workspaceOwnerBotId !== normalizedBotId) {
        throw new Error(
          `Active Skill workspace marker belongs to Bot ${existingMarker.workspaceOwnerBotId}.`,
        );
      }
      if (!existingMarker && this.hasParkedWorkspaces()) {
        throw new Error(
          'Cannot claim an unmarked active Skill workspace while parked workspaces already exist.',
        );
      }
      const marker = existingMarker ?? this.createMarker(this.activePath, normalizedBotId);
      const initial: BotSkillWorkspaceState = {
        schema: BOT_SKILL_WORKSPACE_STATE_SCHEMA,
        revision: 1,
        workspaceOwnerBotId: normalizedBotId,
        workspaceId: marker.workspaceId,
      };
      this.writeState(initial);
      return initial;
    }, options.lock);
  }

  /**
   * Activates a target Bot but leaves the journal open. Call commitSwitch only
   * after binding/preflight/connector startup succeeds. A crash before commit
   * is recovered to the previous Bot.
   */
  beginSwitch(
    botId: string,
    options: {
      allowCreate?: boolean;
      transactionId?: string;
      lock?: BotSkillWorkspaceActivationLock;
    } = {},
  ): BotSkillWorkspaceSwitch {
    return this.withLock(() => {
      this.recoverInterruptedSwitchUnlocked();
      const targetBotId = normalizeBotId(botId);
      const state = this.readState();
      if (!state) {
        const claimed = this.ensureActiveUnlocked(targetBotId, options.allowCreate === true);
        return {
          fromBotId: claimed.workspaceOwnerBotId,
          toBotId: targetBotId,
          changed: false,
        };
      }
      if (state.workspaceOwnerBotId === targetBotId) {
        this.assertActiveMatches(state);
        return {
          fromBotId: targetBotId,
          toBotId: targetBotId,
          changed: false,
        };
      }

      this.assertActiveMatches(state);
      this.ensureManagedRoots();
      const sourcePath = this.getParkedPath(state.workspaceOwnerBotId);
      const targetPath = this.getParkedPath(targetBotId);
      if (fs.existsSync(sourcePath)) {
        throw new Error(`Cannot park source Skill workspace because destination already exists: ${sourcePath}`);
      }

      let targetWasCreated = false;
      if (!fs.existsSync(targetPath)) {
        if (!options.allowCreate) {
          throw new Error(
            `No local Skill workspace exists for Bot ${targetBotId}; restore or explicit empty creation is required.`,
          );
        }
        fs.mkdirSync(targetPath, { recursive: false, mode: 0o700 });
        this.createMarker(targetPath, targetBotId);
        targetWasCreated = true;
      }
      this.assertDirectoryIsSafe(targetPath, 'target parked Skill workspace');
      const targetMarker = this.readRequiredMarker(targetPath);
      if (targetMarker.workspaceOwnerBotId !== targetBotId) {
        throw new Error(`Target Skill workspace marker does not belong to Bot ${targetBotId}.`);
      }

      const journal: BotSkillWorkspaceSwitchJournal = {
        transactionId: options.transactionId || crypto.randomUUID(),
        from: {
          botId: state.workspaceOwnerBotId,
          workspaceId: state.workspaceId,
        },
        to: {
          botId: targetBotId,
          workspaceId: targetMarker.workspaceId,
        },
        phase: 'prepared',
        targetWasCreated,
        startedAt: new Date().toISOString(),
      };
      this.persistJournal(state, journal);

      fs.renameSync(this.activePath, sourcePath);
      journal.phase = 'source-parked';
      this.persistJournal(state, journal);

      fs.renameSync(targetPath, this.activePath);
      journal.phase = 'target-active';
      this.persistJournal(state, journal);

      return {
        transactionId: journal.transactionId,
        fromBotId: journal.from.botId,
        toBotId: journal.to.botId,
        changed: true,
      };
    }, options.lock);
  }

  commitSwitch(
    transactionId: string,
    lock?: BotSkillWorkspaceActivationLock,
  ): BotSkillWorkspaceState {
    return this.withLock(() => {
      const state = this.readState();
      const journal = state?.switchJournal;
      if (!state || !journal || journal.transactionId !== transactionId) {
        throw new Error('Bot Skill workspace switch transaction is missing or no longer current.');
      }
      if (journal.phase !== 'target-active') {
        throw new Error(`Bot Skill workspace switch is not ready to commit (${journal.phase}).`);
      }
      const marker = this.readRequiredMarker(this.activePath);
      assertIdentity(marker, journal.to, 'active target workspace');
      const committed: BotSkillWorkspaceState = {
        schema: BOT_SKILL_WORKSPACE_STATE_SCHEMA,
        revision: state.revision + 1,
        workspaceOwnerBotId: journal.to.botId,
        workspaceId: journal.to.workspaceId,
      };
      this.writeState(committed);
      return committed;
    }, lock);
  }

  rollbackSwitch(
    transactionId?: string,
    lock?: BotSkillWorkspaceActivationLock,
  ): BotSkillWorkspaceState | undefined {
    return this.withLock(() => {
      const state = this.readState();
      if (transactionId && state?.switchJournal?.transactionId !== transactionId) {
        throw new Error('Refusing to roll back a different Bot Skill workspace transaction.');
      }
      return this.recoverInterruptedSwitchUnlocked();
    }, lock);
  }

  recoverInterruptedSwitch(
    lock?: BotSkillWorkspaceActivationLock,
  ): BotSkillWorkspaceState | undefined {
    return this.withLock(() => this.recoverInterruptedSwitchUnlocked(), lock);
  }

  acquireActivationLock(): BotSkillWorkspaceActivationLock {
    this.ensureManagedRoots();
    const lockId = this.acquireLock();
    let released = false;
    return {
      lockId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseLock(lockId);
      },
    };
  }

  assertPendingTarget(transactionId: string, botId: string): BotSkillWorkspaceSwitchJournal {
    const state = this.readState();
    const journal = state?.switchJournal;
    if (
      !journal ||
      journal.transactionId !== transactionId ||
      journal.phase !== 'target-active' ||
      journal.to.botId !== normalizeBotId(botId)
    ) {
      throw new Error('Connector activation transaction does not match the pending target workspace.');
    }
    const marker = this.readRequiredMarker(this.activePath);
    assertIdentity(marker, journal.to, 'pending target Skill workspace');
    return journal;
  }

  assertActive(botId: string): BotSkillWorkspaceState {
    const normalizedBotId = normalizeBotId(botId);
    const state = this.readState();
    if (!state || state.switchJournal || state.workspaceOwnerBotId !== normalizedBotId) {
      throw new Error(`Stable active Skill workspace does not belong to Bot ${normalizedBotId}.`);
    }
    this.assertActiveMatches(state);
    return state;
  }

  releaseInitialClaim(
    botId: string,
    lock?: BotSkillWorkspaceActivationLock,
  ): void {
    this.withLock(() => {
      const state = this.readState();
      if (
        !state ||
        state.switchJournal ||
        state.revision !== 1 ||
        state.workspaceOwnerBotId !== normalizeBotId(botId) ||
        this.hasParkedWorkspaces()
      ) {
        throw new Error('Initial Skill workspace claim can no longer be safely released.');
      }
      const marker = this.readRequiredMarker(this.activePath);
      assertIdentity(marker, {
        botId: state.workspaceOwnerBotId,
        workspaceId: state.workspaceId,
      }, 'initial Skill workspace');
      fs.rmSync(path.join(this.activePath, MARKER_FILE), { force: true });
      fs.rmSync(this.statePath, { force: true });
    }, lock);
  }

  private ensureActiveUnlocked(botId: string, allowCreate: boolean): BotSkillWorkspaceState {
    const state = this.readState();
    if (state) return state;
    this.ensureManagedRoots();
    if (!fs.existsSync(this.activePath)) {
      if (!allowCreate) {
        throw new Error(
          `No active Skill workspace exists for Bot ${botId}; explicit creation or restore is required.`,
        );
      }
      fs.mkdirSync(this.activePath, { recursive: false, mode: 0o700 });
    }
    this.assertDirectoryIsSafe(this.activePath, 'active Skill workspace');
    const existingMarker = this.readMarker(this.activePath);
    if (existingMarker && existingMarker.workspaceOwnerBotId !== botId) {
      throw new Error(`Active Skill workspace marker belongs to Bot ${existingMarker.workspaceOwnerBotId}.`);
    }
    if (!existingMarker && this.hasParkedWorkspaces()) {
      throw new Error(
        'Cannot claim an unmarked active Skill workspace while parked workspaces already exist.',
      );
    }
    const marker = existingMarker ?? this.createMarker(this.activePath, botId);
    const initial: BotSkillWorkspaceState = {
      schema: BOT_SKILL_WORKSPACE_STATE_SCHEMA,
      revision: 1,
      workspaceOwnerBotId: botId,
      workspaceId: marker.workspaceId,
    };
    this.writeState(initial);
    return initial;
  }

  private recoverInterruptedSwitchUnlocked(): BotSkillWorkspaceState | undefined {
    const state = this.readState();
    const journal = state?.switchJournal;
    if (!state || !journal) return state;

    const sourcePath = this.getParkedPath(journal.from.botId);
    const targetPath = this.getParkedPath(journal.to.botId);
    const activeExists = fs.existsSync(this.activePath);
    const sourceExists = fs.existsSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);
    const active = this.readMarker(this.activePath);
    const source = this.readMarker(sourcePath);
    const target = this.readMarker(targetPath);

    const activeIsSource = markerMatches(active, journal.from);
    const activeIsTarget = markerMatches(active, journal.to);
    const parkedSourceMatches = markerMatches(source, journal.from);
    const parkedTargetMatches = markerMatches(target, journal.to);

    if (activeIsSource && !sourceExists && parkedTargetMatches) {
      return this.clearJournal(state);
    }
    if (!activeExists && parkedSourceMatches && parkedTargetMatches) {
      fs.renameSync(sourcePath, this.activePath);
      return this.clearJournal(state);
    }
    if (activeIsTarget && parkedSourceMatches && !targetExists) {
      fs.renameSync(this.activePath, targetPath);
      fs.renameSync(sourcePath, this.activePath);
      return this.clearJournal(state);
    }

    throw new Error(
      `Cannot safely recover Bot Skill workspace transaction ${journal.transactionId}; directory markers are ambiguous.`,
    );
  }

  private clearJournal(state: BotSkillWorkspaceState): BotSkillWorkspaceState {
    const restored: BotSkillWorkspaceState = {
      schema: BOT_SKILL_WORKSPACE_STATE_SCHEMA,
      revision: state.revision + 1,
      workspaceOwnerBotId: state.workspaceOwnerBotId,
      workspaceId: state.workspaceId,
    };
    this.writeState(restored);
    return restored;
  }

  private assertActiveMatches(state: BotSkillWorkspaceState): void {
    const marker = this.readRequiredMarker(this.activePath);
    assertIdentity(marker, {
      botId: state.workspaceOwnerBotId,
      workspaceId: state.workspaceId,
    }, 'active Skill workspace');
  }

  private persistJournal(
    state: BotSkillWorkspaceState,
    journal: BotSkillWorkspaceSwitchJournal,
  ): void {
    this.writeState({
      ...state,
      revision: state.revision + 1,
      switchJournal: { ...journal },
    });
    state.revision += 1;
    this.phaseHook?.(journal.phase);
  }

  private ensureManagedRoots(): void {
    const dataParent = path.join(this.runtimeRoot, 'data');
    this.ensureManagedDirectory(dataParent, 'runtime data directory');
    this.ensureManagedDirectory(this.dataRoot, 'Bot Skill workspace data root');
    this.ensureManagedDirectory(this.parkedRoot, 'parked Skill workspace root');
  }

  private ensureManagedDirectory(target: string, label: string): void {
    if (fs.existsSync(target)) {
      this.assertDirectoryIsSafe(target, label);
      return;
    }
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
    this.assertDirectoryIsSafe(target, label);
  }

  private hasParkedWorkspaces(): boolean {
    if (!fs.existsSync(this.parkedRoot)) return false;
    return fs.readdirSync(this.parkedRoot).length > 0;
  }

  private createMarker(workspacePath: string, botId: string): BotSkillWorkspaceMarker {
    const marker: BotSkillWorkspaceMarker = {
      schema: BOT_SKILL_WORKSPACE_MARKER_SCHEMA,
      workspaceOwnerBotId: normalizeBotId(botId),
      workspaceId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(workspacePath, MARKER_FILE), marker);
    return marker;
  }

  private readMarker(workspacePath: string): BotSkillWorkspaceMarker | undefined {
    if (!fs.existsSync(workspacePath)) return undefined;
    this.assertDirectoryIsSafe(workspacePath, 'Skill workspace');
    const markerPath = path.join(workspacePath, MARKER_FILE);
    if (!fs.existsSync(markerPath)) return undefined;
    return parseMarker(readJsonFile(markerPath));
  }

  private readRequiredMarker(workspacePath: string): BotSkillWorkspaceMarker {
    const marker = this.readMarker(workspacePath);
    if (!marker) throw new Error(`Skill workspace marker is missing: ${workspacePath}`);
    return marker;
  }

  private writeState(state: BotSkillWorkspaceState): void {
    this.ensureManagedRoots();
    atomicWriteJson(this.statePath, state);
  }

  private withLock<T>(
    action: () => T,
    existingLock?: BotSkillWorkspaceActivationLock,
  ): T {
    this.ensureManagedRoots();
    if (existingLock) {
      const owner = readLockOwner(this.lockPath);
      if (
        !owner ||
        owner.lockId !== existingLock.lockId ||
        owner.pid !== process.pid
      ) {
        throw new Error('Bot Skill workspace activation lock is no longer owned by this process.');
      }
      return action();
    }
    const lockId = this.acquireLock();
    try {
      return action();
    } finally {
      this.releaseLock(lockId);
    }
  }

  private acquireLock(): string {
    const lockId = crypto.randomUUID();
    try {
      fs.mkdirSync(this.lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readLockOwner(this.lockPath);
      if (!owner) {
        const ageMs = Date.now() - fs.statSync(this.lockPath).mtimeMs;
        if (ageMs < 30_000) {
          throw new Error('Bot Skill workspace switch lock is being initialized.');
        }
      } else if (isProcessAlive(owner.pid)) {
        throw new Error(`Bot Skill workspace switch is already locked by pid ${owner.pid}.`);
      }
      const stalePath = `${this.lockPath}.stale.${crypto.randomUUID()}`;
      try {
        fs.renameSync(this.lockPath, stalePath);
      } catch {
        throw new Error('Bot Skill workspace switch lock changed while checking stale ownership.');
      }
      fs.rmSync(stalePath, { recursive: true, force: true });
      fs.mkdirSync(this.lockPath, { mode: 0o700 });
    }
    try {
      atomicWriteJson(path.join(this.lockPath, 'owner.json'), {
        lockId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
    } catch (error) {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
      throw error;
    }
    return lockId;
  }

  private releaseLock(lockId: string): void {
    const owner = readLockOwner(this.lockPath);
    if (owner?.lockId === lockId && owner.pid === process.pid) {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private assertSafeRoot(target: string, label: string): void {
    if (!fs.existsSync(target)) return;
    this.assertDirectoryIsSafe(target, label);
  }

  private assertDirectoryIsSafe(target: string, label: string): void {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory, not a symlink or file: ${target}`);
    }
    const resolved = path.resolve(target);
    if (resolved !== this.runtimeRoot && !resolved.startsWith(`${this.runtimeRoot}${path.sep}`)) {
      throw new Error(`${label} escapes the runtime root: ${target}`);
    }
    const realRuntimeRoot = fs.realpathSync.native(this.runtimeRoot);
    const realTarget = fs.realpathSync.native(target);
    const relative = path.relative(realRuntimeRoot, realTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${label} resolves outside the runtime root: ${target}`);
    }
    if (!samePath(resolved, realTarget)) {
      throw new Error(`${label} traverses a symlink or junction: ${target}`);
    }
  }
}

export function createBotSkillWorkspaceService(
  options: BotSkillWorkspaceServiceOptions,
): BotSkillWorkspaceService {
  return new BotSkillWorkspaceService(options);
}

function normalizeBotId(botId: string): string {
  const normalized = String(botId || '').trim();
  if (!normalized) throw new Error('Bot id is required for Skill workspace ownership.');
  if (normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new Error('Bot id is invalid for Skill workspace ownership.');
  }
  return normalized;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Rename is the commit point; permission hardening must not report a
        // committed metadata write as failed.
      }
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readJsonFile(filePath: string): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw new Error(`Bot Skill workspace metadata is invalid or too large: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Bot Skill workspace metadata is not valid JSON: ${filePath}: ${message}`);
  }
}

function parseMarker(value: unknown): BotSkillWorkspaceMarker {
  const marker = value as Partial<BotSkillWorkspaceMarker>;
  if (
    !marker ||
    marker.schema !== BOT_SKILL_WORKSPACE_MARKER_SCHEMA ||
    typeof marker.workspaceOwnerBotId !== 'string' ||
    !marker.workspaceOwnerBotId.trim() ||
    typeof marker.workspaceId !== 'string' ||
    !marker.workspaceId.trim() ||
    typeof marker.createdAt !== 'string'
  ) {
    throw new Error('Bot Skill workspace marker has an unsupported schema or invalid fields.');
  }
  return marker as BotSkillWorkspaceMarker;
}

function parseState(value: unknown): BotSkillWorkspaceState {
  const state = value as Partial<BotSkillWorkspaceState>;
  if (
    !state ||
    state.schema !== BOT_SKILL_WORKSPACE_STATE_SCHEMA ||
    !Number.isInteger(state.revision) ||
    Number(state.revision) < 1 ||
    typeof state.workspaceOwnerBotId !== 'string' ||
    !state.workspaceOwnerBotId.trim() ||
    typeof state.workspaceId !== 'string' ||
    !state.workspaceId.trim()
  ) {
    throw new Error('Bot Skill workspace state has an unsupported schema or invalid fields.');
  }
  if (state.switchJournal) {
    const journal = state.switchJournal as Partial<BotSkillWorkspaceSwitchJournal>;
    if (
      typeof journal.transactionId !== 'string' ||
      !journal.transactionId ||
      !journal.from ||
      !journal.to ||
      typeof journal.from.botId !== 'string' ||
      typeof journal.from.workspaceId !== 'string' ||
      typeof journal.to.botId !== 'string' ||
      typeof journal.to.workspaceId !== 'string' ||
      !['prepared', 'source-parked', 'target-active'].includes(String(journal.phase)) ||
      typeof journal.targetWasCreated !== 'boolean' ||
      typeof journal.startedAt !== 'string'
    ) {
      throw new Error('Bot Skill workspace switch journal has invalid fields.');
    }
    if (
      journal.from.botId !== state.workspaceOwnerBotId ||
      journal.from.workspaceId !== state.workspaceId ||
      journal.from.botId === journal.to.botId
    ) {
      throw new Error('Bot Skill workspace switch journal is inconsistent with committed state.');
    }
  }
  return state as BotSkillWorkspaceState;
}

function assertIdentity(
  marker: BotSkillWorkspaceMarker,
  identity: BotSkillWorkspaceIdentity,
  label: string,
): void {
  if (
    marker.workspaceOwnerBotId !== identity.botId ||
    marker.workspaceId !== identity.workspaceId
  ) {
    throw new Error(`${label} identity does not match workspace state.`);
  }
}

function markerMatches(
  marker: BotSkillWorkspaceMarker | undefined,
  identity: BotSkillWorkspaceIdentity,
): boolean {
  return Boolean(
    marker &&
    marker.workspaceOwnerBotId === identity.botId &&
    marker.workspaceId === identity.workspaceId,
  );
}

function readLockOwner(lockPath: string): { lockId: string; pid: number } | undefined {
  const ownerPath = path.join(lockPath, 'owner.json');
  if (!fs.existsSync(ownerPath)) return undefined;
  try {
    const value = readJsonFile(ownerPath) as { lockId?: unknown; pid?: unknown };
    if (typeof value.lockId === 'string' && Number.isInteger(value.pid) && Number(value.pid) > 0) {
      return { lockId: value.lockId, pid: Number(value.pid) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
