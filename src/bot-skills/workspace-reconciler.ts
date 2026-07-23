import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotDefinitionRepository } from '../bot-definition/repository';
import type { BotSkillRef } from '../bot-definition/types';
import {
  BOT_SKILL_LOCAL_IDENTITY_SCHEMA,
  scanLocalSkillManifest,
  writeLocalSkillIdentity,
  type LocalSkillManifest,
} from './local-manifest';
import {
  BOT_SKILL_WORKSPACE_MARKER_FILE,
  BOT_SKILL_WORKSPACE_MARKER_SCHEMA,
} from './workspace-service';
import {
  cloudProjectionDigest,
  FileBotSkillSyncBaseRepository,
  projectLocalManifest,
  localProjectionDigest,
  type BotSkillSyncBaseRepository,
} from './sync-base';
import type {
  SimulatedSkillArtifact,
  SimulatedSkillArtifactStore,
} from './simulated-artifact-store';

export const BOT_SKILL_PULL_JOURNAL_SCHEMA = 'xiaoba.bot-skill-pull-journal.v1';

type PullPhase = 'prepared' | 'source-backed-up' | 'target-active' | 'base-committed';

interface BotSkillPullJournal {
  schema: typeof BOT_SKILL_PULL_JOURNAL_SCHEMA;
  transactionId: string;
  botId: string;
  workspaceId: string;
  phase: PullPhase;
  oldLocalDigest: string;
  targetLocalDigest: string;
  targetCloudDigest: string;
  startedAt: string;
}

export interface BotSkillWorkspaceDesiredEntry {
  artifact: SimulatedSkillArtifact;
  localSkillId: string;
  enabled: boolean;
}

export interface ReconcileBotSkillWorkspaceOptions {
  runtimeRoot: string;
  skillsRoot: string;
  botId: string;
  workspaceId: string;
  currentManifest: LocalSkillManifest;
  desired: BotSkillWorkspaceDesiredEntry[];
  cloudSkills: BotSkillRef[];
  artifactStore: SimulatedSkillArtifactStore;
  onPhasePersisted?: (phase: PullPhase) => void;
}

export function reconcileBotSkillWorkspace<T>(
  options: ReconcileBotSkillWorkspaceOptions,
  commit: (manifest: LocalSkillManifest) => T,
): { manifest: LocalSkillManifest; result: T } {
  if (options.currentManifest.status !== 'complete') {
    throw new Error(`Cannot reconcile Local Skill manifest: ${options.currentManifest.status}`);
  }
  if (
    options.currentManifest.botId !== options.botId
    || options.currentManifest.workspaceId !== options.workspaceId
  ) {
    throw new Error('Local Skill manifest identity changed before reconcile');
  }
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const skillsRoot = path.resolve(options.skillsRoot);
  const operationsRoot = operationScopeRoot(runtimeRoot, options.workspaceId);
  ensureSafeDirectory(path.join(runtimeRoot, 'data', 'bot-skills'), operationsRoot);
  const operationDir = path.join(operationsRoot, `pull-${crypto.randomUUID()}`);
  fs.mkdirSync(operationDir, { mode: 0o700 });
  const stagedRoot = path.join(operationDir, 'staged');
  const backupRoot = path.join(operationDir, 'backup');
  const journalPath = path.join(operationDir, 'journal.json');

  let journal: BotSkillPullJournal | undefined;
  let targetManifest: LocalSkillManifest | undefined;
  let swapped = false;
  let committed = false;
  try {
    copyTreeStrict(skillsRoot, stagedRoot);
    for (const entry of options.currentManifest.entries) {
      const target = resolveManifestPath(stagedRoot, entry.path);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: false });
    }

    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    for (const desired of options.desired) {
      const installName = normalizeInstallName(desired.artifact.installName);
      const portable = installName.normalize('NFC').toLocaleLowerCase('en-US');
      if (seenPaths.has(portable)) throw new Error(`Duplicate restored Skill path: ${installName}`);
      if (seenIds.has(desired.localSkillId)) {
        throw new Error(`Duplicate restored localSkillId: ${desired.localSkillId}`);
      }
      seenPaths.add(portable);
      seenIds.add(desired.localSkillId);
      const targetDir = path.join(stagedRoot, installName);
      options.artifactStore.materialize(desired.artifact, targetDir);
      writeLocalSkillIdentity(targetDir, {
        schema: BOT_SKILL_LOCAL_IDENTITY_SCHEMA,
        localSkillId: required(desired.localSkillId, 'localSkillId'),
        workspaceId: options.workspaceId,
        identityName: desired.artifact.name,
        createdAt: new Date().toISOString(),
      });
      if (!desired.enabled) {
        const active = path.join(targetDir, 'SKILL.md');
        const disabled = path.join(targetDir, 'SKILL.md.disabled');
        if (!fs.existsSync(active) || fs.existsSync(disabled)) {
          throw new Error(`Restored Skill entrypoint is invalid: ${installName}`);
        }
        fs.renameSync(active, disabled);
      }
    }

    targetManifest = scanLocalSkillManifest({
      skillsRoot: stagedRoot,
      botId: options.botId,
      workspaceId: options.workspaceId,
      createIdentities: false,
    });
    if (targetManifest.status !== 'complete') {
      throw new Error(`Staged Local Skill manifest is ${targetManifest.status}`);
    }
    const targetLocalDigest = localProjectionDigest(projectLocalManifest(targetManifest));
    const targetCloudDigest = cloudProjectionDigest(options.cloudSkills);
    journal = {
      schema: BOT_SKILL_PULL_JOURNAL_SCHEMA,
      transactionId: crypto.randomUUID(),
      botId: options.botId,
      workspaceId: options.workspaceId,
      phase: 'prepared',
      oldLocalDigest: localProjectionDigest(projectLocalManifest(options.currentManifest)),
      targetLocalDigest,
      targetCloudDigest,
      startedAt: new Date().toISOString(),
    };
    writeJournal(journalPath, journal);
    options.onPhasePersisted?.('prepared');

    fs.renameSync(skillsRoot, backupRoot);
    journal.phase = 'source-backed-up';
    writeJournal(journalPath, journal);
    options.onPhasePersisted?.('source-backed-up');

    fs.renameSync(stagedRoot, skillsRoot);
    swapped = true;
    journal.phase = 'target-active';
    writeJournal(journalPath, journal);
    options.onPhasePersisted?.('target-active');

    const activeManifest = scanLocalSkillManifest({
      skillsRoot,
      botId: options.botId,
      workspaceId: options.workspaceId,
      createIdentities: false,
    });
    if (
      activeManifest.status !== 'complete'
      || localProjectionDigest(projectLocalManifest(activeManifest)) !== targetLocalDigest
    ) {
      throw new Error('Active Skill workspace does not match the staged target');
    }
    const result = commit(activeManifest);
    committed = true;
    try {
      journal.phase = 'base-committed';
      writeJournal(journalPath, journal);
      options.onPhasePersisted?.('base-committed');
      fs.rmSync(operationDir, { recursive: true, force: true });
    } catch {
      // Base is the commit point. Recovery can safely remove the stale backup.
    }
    return { manifest: activeManifest, result };
  } catch (error) {
    if (!committed && journal) {
      rollbackAppliedWorkspace({
        skillsRoot,
        backupRoot,
        operationDir,
        journal,
        targetMayBeActive: swapped,
      });
    } else if (!journal) {
      fs.rmSync(operationDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export interface RecoverBotSkillWorkspaceReconcileOptions {
  runtimeRoot: string;
  skillsRoot?: string;
  definitionRepository: BotDefinitionRepository;
  baseRepository?: BotSkillSyncBaseRepository;
}

export function recoverBotSkillWorkspaceReconciles(
  options: RecoverBotSkillWorkspaceReconcileOptions,
): void {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const skillsRoot = path.resolve(options.skillsRoot ?? path.join(runtimeRoot, 'skills'));
  const root = path.join(runtimeRoot, 'data', 'bot-skills', 'sync-operations');
  if (!fs.existsSync(root)) return;
  assertRealDirectory(root, 'Bot Skill sync operations root');
  const baseRepository = options.baseRepository
    ?? new FileBotSkillSyncBaseRepository({ runtimeRoot });
  for (const scope of fs.readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.isSymbolicLink()) {
      throw new Error(`Unsafe Bot Skill sync operation scope: ${scope.name}`);
    }
    const scopePath = path.join(root, scope.name);
    for (const operation of fs.readdirSync(scopePath, { withFileTypes: true })) {
      if (!operation.isDirectory() || operation.isSymbolicLink()) {
        throw new Error(`Unsafe Bot Skill sync operation: ${operation.name}`);
      }
      recoverOperation({
        operationDir: path.join(scopePath, operation.name),
        skillsRoot,
        definitionRepository: options.definitionRepository,
        baseRepository,
      });
    }
  }
}

function recoverOperation(options: {
  operationDir: string;
  skillsRoot: string;
  definitionRepository: BotDefinitionRepository;
  baseRepository: BotSkillSyncBaseRepository;
}): void {
  const journalPath = path.join(options.operationDir, 'journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Bot Skill sync operation has no journal: ${options.operationDir}`);
  }
  const journal = parseJournal(readJson(journalPath));
  const expectedScope = `w_${sha256(journal.workspaceId)}`;
  if (path.basename(path.dirname(options.operationDir)) !== expectedScope) {
    throw new Error(`Bot Skill pull journal is stored in the wrong workspace scope: ${journal.transactionId}`);
  }
  const stagedRoot = path.join(options.operationDir, 'staged');
  const backupRoot = path.join(options.operationDir, 'backup');
  if (journal.phase === 'prepared') {
    const activeDigest = inspectWorkspaceDigest(
      options.skillsRoot,
      journal.botId,
      journal.workspaceId,
    );
    if (activeDigest === journal.oldLocalDigest) {
      fs.rmSync(options.operationDir, { recursive: true, force: true });
      return;
    }
    const backupDigest = inspectWorkspaceDigest(backupRoot, journal.botId, journal.workspaceId);
    const stagedDigest = inspectWorkspaceDigest(stagedRoot, journal.botId, journal.workspaceId);
    if (
      activeDigest === undefined
      && backupDigest === journal.oldLocalDigest
      && stagedDigest === journal.targetLocalDigest
      && !fs.existsSync(options.skillsRoot)
    ) {
      fs.renameSync(backupRoot, options.skillsRoot);
      fs.rmSync(options.operationDir, { recursive: true, force: true });
      return;
    }
    throw new Error(`Prepared Bot Skill pull is ambiguous: ${journal.transactionId}`);
  }
  if (journal.phase === 'source-backed-up') {
    const backupDigest = inspectWorkspaceDigest(backupRoot, journal.botId, journal.workspaceId);
    if (backupDigest !== journal.oldLocalDigest) {
      throw new Error(`Bot Skill pull backup is invalid: ${journal.transactionId}`);
    }
    if (!fs.existsSync(options.skillsRoot)) {
      const stagedDigest = inspectWorkspaceDigest(stagedRoot, journal.botId, journal.workspaceId);
      if (stagedDigest !== journal.targetLocalDigest) {
        throw new Error(`Bot Skill pull staged target is invalid: ${journal.transactionId}`);
      }
      fs.renameSync(backupRoot, options.skillsRoot);
      fs.rmSync(options.operationDir, { recursive: true, force: true });
      return;
    }
    const activeDigest = inspectWorkspaceDigest(
      options.skillsRoot,
      journal.botId,
      journal.workspaceId,
    );
    if (activeDigest !== journal.targetLocalDigest || fs.existsSync(stagedRoot)) {
      throw new Error(`Source-backed-up Bot Skill pull has an unexpected active workspace: ${journal.transactionId}`);
    }
    // The second rename completed before target-active was persisted. From here
    // the same Base commit-point logic as target-active recovery is safe.
  }

  const activeDigest = inspectWorkspaceDigest(
    options.skillsRoot,
    journal.botId,
    journal.workspaceId,
  );
  const backupDigest = inspectWorkspaceDigest(backupRoot, journal.botId, journal.workspaceId);
  if (
    activeDigest !== journal.targetLocalDigest
    || backupDigest !== journal.oldLocalDigest
  ) {
    throw new Error(`Bot Skill pull recovery is ambiguous: ${journal.transactionId}`);
  }
  const base = options.baseRepository.inspect(journal.botId, journal.workspaceId);
  const committed = (
    base.status === 'valid'
    && base.base.local.digest === journal.targetLocalDigest
    && base.base.cloud.digest === journal.targetCloudDigest
  );
  if (committed || journal.phase === 'base-committed') {
    fs.rmSync(options.operationDir, { recursive: true, force: true });
    return;
  }
  fs.rmSync(options.skillsRoot, { recursive: true, force: false });
  fs.renameSync(backupRoot, options.skillsRoot);
  fs.rmSync(options.operationDir, { recursive: true, force: true });
  if (fs.existsSync(stagedRoot)) {
    throw new Error(`Unexpected staged workspace remained after recovery: ${stagedRoot}`);
  }
}

function rollbackAppliedWorkspace(options: {
  skillsRoot: string;
  backupRoot: string;
  operationDir: string;
  journal: BotSkillPullJournal;
  targetMayBeActive: boolean;
}): void {
  if (options.targetMayBeActive && fs.existsSync(options.skillsRoot)) {
    const activeDigest = inspectWorkspaceDigest(
      options.skillsRoot,
      options.journal.botId,
      options.journal.workspaceId,
    );
    if (activeDigest !== options.journal.targetLocalDigest) {
      throw new Error(`Refusing to roll back an ambiguous Skill workspace: ${options.journal.transactionId}`);
    }
    fs.rmSync(options.skillsRoot, { recursive: true, force: false });
  }
  if (fs.existsSync(options.backupRoot)) {
    const backupDigest = inspectWorkspaceDigest(
      options.backupRoot,
      options.journal.botId,
      options.journal.workspaceId,
    );
    if (backupDigest !== options.journal.oldLocalDigest) {
      throw new Error(`Refusing to restore an invalid Skill backup: ${options.journal.transactionId}`);
    }
    fs.renameSync(options.backupRoot, options.skillsRoot);
  }
  fs.rmSync(options.operationDir, { recursive: true, force: true });
}

function inspectWorkspaceDigest(
  root: string,
  botId: string,
  workspaceId: string,
): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  if (!workspaceIdentityMatches(root, botId, workspaceId)) return undefined;
  const manifest = scanLocalSkillManifest({
    skillsRoot: root,
    botId,
    workspaceId,
    createIdentities: false,
  });
  if (manifest.status !== 'complete') return undefined;
  return localProjectionDigest(projectLocalManifest(manifest));
}

function workspaceIdentityMatches(
  root: string,
  botId: string,
  workspaceId: string,
): boolean {
  try {
    const markerPath = path.join(root, BOT_SKILL_WORKSPACE_MARKER_FILE);
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return false;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as any;
    return (
      marker?.schema === BOT_SKILL_WORKSPACE_MARKER_SCHEMA
      && marker.workspaceOwnerBotId === botId
      && marker.workspaceId === workspaceId
    );
  } catch {
    return false;
  }
}

function operationScopeRoot(runtimeRoot: string, workspaceId: string): string {
  return path.join(
    runtimeRoot,
    'data',
    'bot-skills',
    'sync-operations',
    `w_${sha256(workspaceId)}`,
  );
}

function resolveManifestPath(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized)
    || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) throw new Error(`Unsafe Local Skill path: ${relative}`);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const parent = path.dirname(resolved);
  assertContained(root, resolved, 'Local Skill path');
  assertRealDirectory(parent, 'Local Skill parent');
  return resolved;
}

function copyTreeStrict(source: string, target: string): void {
  assertRealDirectory(source, 'Skill workspace');
  fs.mkdirSync(target, { mode: 0o700 });
  const visit = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.join(to, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error(`Skill workspace contains a link: ${sourcePath}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(targetPath, { mode: 0o700 });
        visit(sourcePath, targetPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      } else {
        throw new Error(`Skill workspace contains a non-file: ${sourcePath}`);
      }
    }
  };
  try {
    visit(source, target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function writeJournal(filePath: string, journal: BotSkillPullJournal): void {
  const serialized = `${JSON.stringify(journal, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function parseJournal(value: unknown): BotSkillPullJournal {
  const raw = value as Partial<BotSkillPullJournal> | null;
  if (
    raw?.schema !== BOT_SKILL_PULL_JOURNAL_SCHEMA
    || !['prepared', 'source-backed-up', 'target-active', 'base-committed'].includes(String(raw.phase))
  ) throw new Error('Invalid Bot Skill pull journal');
  return {
    schema: BOT_SKILL_PULL_JOURNAL_SCHEMA,
    transactionId: required(raw.transactionId, 'transactionId'),
    botId: required(raw.botId, 'botId'),
    workspaceId: required(raw.workspaceId, 'workspaceId'),
    phase: raw.phase as PullPhase,
    oldLocalDigest: requiredHash(raw.oldLocalDigest, 'oldLocalDigest'),
    targetLocalDigest: requiredHash(raw.targetLocalDigest, 'targetLocalDigest'),
    targetCloudDigest: requiredHash(raw.targetCloudDigest, 'targetCloudDigest'),
    startedAt: new Date(required(raw.startedAt, 'startedAt')).toISOString(),
  };
}

function readJson(filePath: string): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
    throw new Error(`Invalid Bot Skill pull journal: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureSafeDirectory(rootPath: string, targetPath: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  assertContained(root, target, 'Bot Skill sync operation directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertRealDirectory(root, 'Bot Skill sync operation root');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertRealDirectory(current, 'Bot Skill sync operation directory');
  }
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !samePath(path.resolve(directory), fs.realpathSync.native(directory))
  ) throw new Error(`Unsafe ${label}: ${directory}`);
}

function normalizeInstallName(value: unknown): string {
  const name = required(value, 'installName').normalize('NFC');
  if (
    name !== path.basename(name)
    || name === '.'
    || name === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /[ .]$/u.test(name)
  ) throw new Error(`Unsafe restored Skill path: ${name}`);
  return name;
}

function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1024) throw new Error(`${field} is required or too long`);
  return text;
}

function requiredHash(value: unknown, field: string): string {
  const text = required(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be SHA-256`);
  return text;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
