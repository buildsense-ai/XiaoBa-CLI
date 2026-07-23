import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import {
  BotSkillWorkspaceActivationLock,
  BotSkillWorkspaceService,
  createBotSkillWorkspaceService,
} from './workspace-service';

const SNAPSHOT_SCHEMA = 'xiaoba.bot-skill-binding-rollback.v1';
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

interface FileSnapshot {
  exists: boolean;
  content?: string;
}

interface BindingEnvSnapshot {
  fileExisted: boolean;
  values: Record<string, string | null>;
  processValues: Record<string, string | null>;
}

interface BotSkillBindingRollbackSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  transactionId: string;
  createdAt: string;
  configPath: string;
  config: FileSnapshot;
  env: BindingEnvSnapshot;
}

const BINDING_ENV_KEYS = [
  'CATSCO_HTTP_BASE_URL',
  'CATSCO_SERVER_URL',
  'CATSCO_USER_TOKEN',
  'CATSCO_USER_UID',
  'CATSCO_USER_NAME',
  'CATSCO_USER_DISPLAY_NAME',
  'CATSCO_BOT_UID',
  'CATSCO_API_KEY',
  'CATSCO_DEVICE_ID',
  'CATSCO_BODY_ID',
  'CATSCO_INSTALLATION_ID',
  'CATSCOMPANY_HTTP_BASE_URL',
  'CATSCOMPANY_SERVER_URL',
  'CATSCOMPANY_USER_TOKEN',
  'CATSCOMPANY_USER_UID',
  'CATSCOMPANY_USER_NAME',
  'CATSCOMPANY_USER_DISPLAY_NAME',
  'CATSCOMPANY_BOT_UID',
  'CATSCOMPANY_API_KEY',
  'CATSCOMPANY_DEVICE_ID',
  'CATSCOMPANY_BODY_ID',
  'CATSCOMPANY_INSTALLATION_ID',
] as const;

export interface BotSkillActivationRecoveryResult {
  recovered: boolean;
  restoredBotId?: string;
  pendingTargetBotId?: string;
}

export function persistBotSkillBindingRollback(
  runtimeRoot: string,
  transactionId: string,
): void {
  const service = createCatsCoLocalConfigService({ runtimeRoot });
  const snapshot: BotSkillBindingRollbackSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    transactionId,
    createdAt: new Date().toISOString(),
    configPath: path.resolve(service.getConfigPath()),
    config: snapshotFile(service.getConfigPath()),
    env: snapshotBindingEnv(path.join(runtimeRoot, '.env')),
  };
  atomicWriteSnapshot(snapshotPath(runtimeRoot), snapshot);
}

export function discardBotSkillBindingRollback(
  runtimeRoot: string,
  transactionId?: string,
): void {
  const filePath = snapshotPath(runtimeRoot);
  if (!fs.existsSync(filePath)) return;
  if (transactionId) {
    const snapshot = readSnapshot(filePath);
    if (snapshot.transactionId !== transactionId) {
      throw new Error('Refusing to discard a different Bot binding rollback snapshot.');
    }
  }
  fs.rmSync(filePath, { force: true });
}

/**
 * Restores binding first and workspace second. If the process stops between the
 * two operations, the still-open workspace journal makes the next recovery
 * repeat the idempotent binding restore before touching directories.
 */
export function recoverBotSkillActivation(
  runtimeRoot: string,
  workspaceService: BotSkillWorkspaceService = createBotSkillWorkspaceService({ runtimeRoot }),
  options: {
    expectedLiveTransactionId?: string;
    lock?: BotSkillWorkspaceActivationLock;
  } = {},
): BotSkillActivationRecoveryResult {
  const expectedTransactionId = String(options.expectedLiveTransactionId || '').trim();
  const initialJournal = workspaceService.readState()?.switchJournal;
  if (expectedTransactionId && initialJournal?.transactionId === expectedTransactionId) {
    const currentBotId = String(
      createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid || '',
    ).trim();
    workspaceService.assertPendingTarget(expectedTransactionId, currentBotId);
    return {
      recovered: false,
      pendingTargetBotId: currentBotId,
    };
  }
  if (expectedTransactionId.startsWith('initial:') && !initialJournal) {
    const currentBotId = String(
      createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid || '',
    ).trim();
    workspaceService.assertActive(currentBotId);
    return {
      recovered: false,
      pendingTargetBotId: currentBotId,
    };
  }

  const lock = options.lock ?? workspaceService.acquireActivationLock();
  const ownsLock = !options.lock;
  try {
    const state = workspaceService.readState();
    const journal = state?.switchJournal;
    const filePath = snapshotPath(runtimeRoot);

    if (!journal) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      return { recovered: false };
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Bot Skill workspace transaction ${journal.transactionId} is missing its binding rollback snapshot.`,
      );
    }
    const snapshot = readSnapshot(filePath);
    if (snapshot.transactionId !== journal.transactionId) {
      throw new Error('Bot Skill workspace journal and binding rollback snapshot do not match.');
    }
    const currentConfigPath = path.resolve(
      createCatsCoLocalConfigService({ runtimeRoot }).getConfigPath(),
    );
    if (currentConfigPath !== snapshot.configPath) {
      throw new Error('Bot binding config path changed during an interrupted Skill workspace switch.');
    }

    restoreFile(snapshot.configPath, snapshot.config);
    restoreBindingEnv(path.join(runtimeRoot, '.env'), snapshot.env);
    restoreBindingProcessEnv(snapshot.env);
    const restored = workspaceService.rollbackSwitch(journal.transactionId, lock);
    fs.rmSync(filePath, { force: true });
    return {
      recovered: true,
      restoredBotId: restored?.workspaceOwnerBotId,
    };
  } finally {
    if (ownsLock) lock.release();
  }
}

function snapshotPath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), 'data', 'bot-skills', 'binding-rollback.json');
}

function snapshotFile(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Bot binding file is invalid or too large to snapshot: ${filePath}`);
  }
  return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
}

function snapshotBindingEnv(filePath: string): BindingEnvSnapshot {
  const file = snapshotFile(filePath);
  const content = file.content ?? '';
  const values: Record<string, string | null> = {};
  const processValues: Record<string, string | null> = {};
  for (const key of BINDING_ENV_KEYS) {
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    values[key] = match ? match[1].replace(/\r$/, '') : null;
    processValues[key] = process.env[key] ?? null;
  }
  return { fileExisted: file.exists, values, processValues };
}

function restoreBindingEnv(filePath: string, snapshot: BindingEnvSnapshot): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to restore Bot binding through a symlink: ${filePath}`);
  }
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  for (const key of BINDING_ENV_KEYS) {
    content = content.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'gm'), '');
  }
  const restoredLines = BINDING_ENV_KEYS
    .filter(key => snapshot.values[key] !== null)
    .map(key => `${key}=${snapshot.values[key]}`);
  content = content.replace(/^\s*\r?\n/gm, '').replace(/\s+$/, '');
  if (restoredLines.length > 0) {
    content = `${content}${content ? '\n' : ''}${restoredLines.join('\n')}\n`;
  } else if (content) {
    content = `${content}\n`;
  }
  if (!snapshot.fileExisted && !content) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  restoreFile(filePath, { exists: true, content });
}

function restoreBindingProcessEnv(snapshot: BindingEnvSnapshot): void {
  for (const key of BINDING_ENV_KEYS) {
    const value = snapshot.processValues[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreFile(filePath: string, snapshot: FileSnapshot): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to restore Bot binding through a symlink: ${filePath}`);
  }
  if (!snapshot.exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.restore.tmp`;
  fs.writeFileSync(tempPath, snapshot.content ?? '', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Restore rename is the commit point.
    }
  }
}

function atomicWriteSnapshot(
  filePath: string,
  snapshot: BotSkillBindingRollbackSnapshot,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Bot binding rollback snapshot exceeds the safe size limit.');
  }
  fs.writeFileSync(tempPath, serialized, {
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
        // Snapshot rename is the commit point.
      }
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readSnapshot(filePath: string): BotSkillBindingRollbackSnapshot {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error('Bot binding rollback snapshot is invalid or too large.');
  }
  let parsed: Partial<BotSkillBindingRollbackSnapshot>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('Bot binding rollback snapshot is not valid JSON.');
  }
  if (
    parsed.schema !== SNAPSHOT_SCHEMA ||
    typeof parsed.transactionId !== 'string' ||
    !parsed.transactionId ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.configPath !== 'string' ||
    !isFileSnapshot(parsed.config) ||
    !isBindingEnvSnapshot(parsed.env)
  ) {
    throw new Error('Bot binding rollback snapshot has invalid fields.');
  }
  return parsed as BotSkillBindingRollbackSnapshot;
}

function isBindingEnvSnapshot(value: unknown): value is BindingEnvSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<BindingEnvSnapshot>;
  if (
    typeof snapshot.fileExisted !== 'boolean' ||
    !snapshot.values ||
    typeof snapshot.values !== 'object' ||
    !snapshot.processValues ||
    typeof snapshot.processValues !== 'object'
  ) {
    return false;
  }
  return BINDING_ENV_KEYS.every(key =>
    [snapshot.values?.[key], snapshot.processValues?.[key]]
      .every(entry => entry === null || typeof entry === 'string'),
  );
}

function isFileSnapshot(value: unknown): value is FileSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<FileSnapshot>;
  return typeof snapshot.exists === 'boolean' &&
    (!snapshot.exists || typeof snapshot.content === 'string');
}
