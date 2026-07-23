import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { SkillParser } from '../skills/skill-parser';
import {
  readSkillHubInstallMarker,
} from '../skillhub/install-marker';
import {
  SkillHubInstallError,
  claimSkillHubPackageOwnership,
  installVerifiedSkillHubPackage,
  recoverSkillHubPackageOperations,
  type ClaimSkillHubPackageOwnershipOptions,
  type InstallVerifiedSkillHubPackageOptions,
  type InstallVerifiedSkillHubPackageResult,
  type UninstallSkillHubPackageOptions,
} from '../skillhub/package-installer';
import {
  computeLocalSkillContentHash,
  writeSkillHubLocalMetadata,
  type SkillHubLocalMetadata,
} from '../skillhub/local-skill-metadata';
import { PathResolver } from '../utils/path-resolver';
import {
  BotSkillWorkspaceService,
  createBotSkillWorkspaceService,
  type BotSkillWorkspaceActivationLock,
  type BotSkillWorkspaceState,
} from './workspace-service';
import {
  BOT_SKILL_LOCAL_IDENTITY_FILE,
  newLocalSkillIdentity,
  readLocalSkillIdentity,
  scanLocalSkillManifest,
  writeLocalSkillIdentity,
  type LocalSkillManifest,
} from './local-manifest';

export interface BotSkillServiceOptions {
  runtimeRoot?: string;
  skillsRoot?: string;
  operationsRoot?: string;
  env?: NodeJS.ProcessEnv;
  expectedBotId?: string;
  workspaceService?: BotSkillWorkspaceService;
  activationLock?: BotSkillWorkspaceActivationLock;
  activationTransactionId?: string;
  allowUnmanagedWorkspace?: boolean;
}

export interface BotSkillMutationResult<T = unknown> {
  result: T;
  manifest: LocalSkillManifest;
}

export class BotSkillServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 409,
    public readonly manifest?: LocalSkillManifest,
  ) {
    super(message);
    this.name = 'BotSkillServiceError';
  }
}

export class BotSkillService {
  readonly runtimeRoot: string;
  readonly skillsRoot: string;
  readonly operationsRoot: string;
  readonly expectedBotId?: string;

  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceService: BotSkillWorkspaceService;
  private readonly managedWorkspace: boolean;
  private readonly localLockPath: string;
  private readonly existingActivationLock?: BotSkillWorkspaceActivationLock;
  private readonly allowUnmanagedWorkspace: boolean;
  private readonly activationTransactionId?: string;

  constructor(options: BotSkillServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.runtimeRoot = path.resolve(
      options.runtimeRoot ?? PathResolver.getRuntimeDataRoot(this.env),
    );
    this.skillsRoot = path.resolve(
      options.skillsRoot
        ?? (options.runtimeRoot ? path.join(this.runtimeRoot, 'skills') : PathResolver.getSkillsPath()),
    );
    const managedSkillsRoot = path.join(this.runtimeRoot, 'skills');
    this.managedWorkspace = samePath(this.skillsRoot, managedSkillsRoot);
    this.workspaceService = options.workspaceService
      ?? createBotSkillWorkspaceService({
        runtimeRoot: this.runtimeRoot,
        env: this.managedWorkspace ? this.env : { ...this.env, XIAOBA_SKILLS_DIR: undefined },
      });
    this.expectedBotId = normalizedOptional(options.expectedBotId)
      ?? (this.managedWorkspace ? currentBotId(this.runtimeRoot) : undefined);
    const workspaceState = this.managedWorkspace
      ? this.workspaceService.readState()
      : undefined;
    const pendingSwitch = workspaceState?.switchJournal;
    const operationScope = (
      pendingSwitch && pendingSwitch.to.botId === this.expectedBotId
        ? pendingSwitch.to.workspaceId
        : workspaceState?.workspaceId
    ) ?? this.skillsRoot;
    const operationsBase = sameFilesystem(this.runtimeRoot, this.skillsRoot)
      ? path.join(this.runtimeRoot, 'data', 'bot-skills', 'operations')
      : path.join(path.dirname(this.skillsRoot), '.xiaoba-skill-operations');
    this.operationsRoot = path.resolve(
      options.operationsRoot
        ?? path.join(operationsBase, `w_${sha256(operationScope)}`),
    );
    this.localLockPath = path.join(this.operationsRoot, 'service.lock');
    this.existingActivationLock = options.activationLock;
    this.activationTransactionId = normalizedOptional(options.activationTransactionId);
    this.allowUnmanagedWorkspace = options.allowUnmanagedWorkspace === true;
  }

  async scanManifest(): Promise<LocalSkillManifest> {
    return this.runExclusive(() => this.scanManifestUnlocked());
  }

  async withWorkspaceLock<T>(action: () => Promise<T> | T): Promise<T> {
    return this.runExclusive(async () => {
      this.requireCompleteManifest();
      return action();
    });
  }

  async installVerifiedSkillHubPackage(
    options: InstallVerifiedSkillHubPackageOptions,
  ): Promise<BotSkillMutationResult<InstallVerifiedSkillHubPackageResult>> {
    return this.runExclusive(() => {
      const current = this.requireCompleteManifest();
      const incoming = this.inspectVerifiedPackage(options);
      this.assertProspectiveEntry(current, incoming);
      const targetDir = this.resolveDirectChild(incoming.path);
      const existingIdentity = fs.existsSync(targetDir)
        ? readLocalSkillIdentity(targetDir)
        : undefined;
      const workspace = this.workspaceContext();
      const localIdentity = existingIdentity
        ? {
          ...existingIdentity,
          identityName: incoming.name,
          workspaceId: existingIdentity.workspaceId ?? workspace.workspaceId,
        }
        : newLocalSkillIdentity(incoming.name, workspace.workspaceId);
      const result = installVerifiedSkillHubPackage({
        ...options,
        skillsRoot: this.skillsRoot,
        operationsRoot: this.operationsRoot,
        localIdentity,
      });
      return { result, manifest: this.scanManifestUnlocked() };
    });
  }

  async uninstallSkillHubPackage(
    options: UninstallSkillHubPackageOptions,
  ): Promise<BotSkillMutationResult<{ removed: boolean; path: string }>> {
    return this.runExclusive(() => {
      const current = this.requireCompleteManifest();
      const targetDir = this.resolveDirectChild(options.installName);
      if (!fs.existsSync(targetDir)) {
        return {
          result: { removed: false, path: targetDir },
          manifest: current,
        };
      }
      this.assertSafeSkillDirectory(targetDir);
      const marker = readSkillHubInstallMarker(targetDir);
      if (!marker || marker.skillId !== options.skillId) {
        throw new SkillHubInstallError(
          'The target directory is not the requested SkillHub Skill.',
          'UNINSTALL_TARGET_MISMATCH',
        );
      }
      if (options.userId && marker.userId && marker.userId !== options.userId) {
        throw new SkillHubInstallError(
          'The target Skill belongs to another SkillHub user.',
          'USER_CONFLICT',
        );
      }
      this.quarantineRemove(targetDir);
      return {
        result: { removed: true, path: targetDir },
        manifest: this.scanManifestUnlocked(),
      };
    });
  }

  async claimInstalledSkillOwnership(
    options: ClaimSkillHubPackageOwnershipOptions,
  ): Promise<boolean> {
    return this.runExclusive(() => claimSkillHubPackageOwnership({
      ...options,
      skillsRoot: this.skillsRoot,
    }));
  }

  async installLocalDirectory(options: {
    sourceDir: string;
    installName: string;
    overwrite?: boolean;
  }): Promise<BotSkillMutationResult<{
    installed: boolean;
    existing: boolean;
    path: string;
  }>> {
    return this.runExclusive(() => {
      const current = this.requireCompleteManifest();
      const sourceDir = path.resolve(options.sourceDir);
      this.assertRealTree(sourceDir, 'Local Skill source');
      const targetDir = this.resolveDirectChild(options.installName);
      if (fs.existsSync(targetDir) && !options.overwrite) {
        return {
          result: { installed: false, existing: true, path: targetDir },
          manifest: current,
        };
      }
      if (fs.existsSync(targetDir)) this.assertSafeSkillDirectory(targetDir);
      const existingWasDisabled = fs.existsSync(path.join(targetDir, 'SKILL.md.disabled'))
        && !fs.existsSync(path.join(targetDir, 'SKILL.md'));

      const operationDir = this.newOperationDirectory('local-install');
      const stagedDir = path.join(operationDir, 'staged');
      try {
        copyDirectoryStrict(sourceDir, stagedDir);
        const stagedSkillFile = path.join(stagedDir, 'SKILL.md');
        if (!fs.existsSync(stagedSkillFile)) {
          throw new BotSkillServiceError(
            'Local Skill source is missing SKILL.md.',
            'LOCAL_SKILL_ENTRY_MISSING',
            400,
          );
        }
        const stagedSkill = SkillParser.parse(stagedSkillFile);
        const existingIdentity = fs.existsSync(targetDir)
          ? readLocalSkillIdentity(targetDir)
          : undefined;
        const workspace = this.workspaceContext();
        const identity = existingIdentity?.identityName === stagedSkill.metadata.name
          ? {
            ...existingIdentity,
            workspaceId: existingIdentity.workspaceId ?? workspace.workspaceId,
          }
          : newLocalSkillIdentity(stagedSkill.metadata.name, workspace.workspaceId);
        writeLocalSkillIdentity(stagedDir, identity);
        if (existingWasDisabled) {
          fs.renameSync(stagedSkillFile, `${stagedSkillFile}.disabled`);
        }
        const stagedManifest = scanLocalSkillManifest({
          skillsRoot: operationDir,
          botId: workspace.botId,
          workspaceId: workspace.workspaceId,
          createIdentities: false,
        });
        if (stagedManifest.status !== 'complete' || stagedManifest.entries.length !== 1) {
          throw new BotSkillServiceError(
            'Local Skill source does not produce one complete Skill manifest entry.',
            'LOCAL_SKILL_SOURCE_INVALID',
            400,
            stagedManifest,
          );
        }
        const stagedEntry = stagedManifest.entries[0];
        this.assertProspectiveEntry(current, {
          name: stagedEntry.name,
          key: stagedEntry.key,
          path: path.basename(targetDir),
        });
        this.commitStagedDirectory(operationDir, stagedDir, targetDir);
      } catch (error) {
        this.recoverLocalOperations();
        throw error;
      }
      return {
        result: {
          installed: true,
          existing: false,
          path: targetDir,
        },
        manifest: this.scanManifestUnlocked(),
      };
    });
  }

  async removeByName(
    name: string,
  ): Promise<BotSkillMutationResult<{ removed: boolean; path: string }>> {
    return this.runExclusive(() => {
      const entry = this.findUniqueEntry(name);
      const targetDir = path.join(this.skillsRoot, ...entry.path.split('/'));
      this.assertSafeSkillDirectory(targetDir);
      this.quarantineRemove(targetDir);
      return {
        result: { removed: true, path: targetDir },
        manifest: this.scanManifestUnlocked(),
      };
    });
  }

  async setEnabledByName(
    name: string,
    enabled: boolean,
  ): Promise<BotSkillMutationResult<{ enabled: boolean; path: string }>> {
    return this.runExclusive(() => {
      const entry = this.findUniqueEntry(name);
      const targetDir = path.join(this.skillsRoot, ...entry.path.split('/'));
      this.assertSafeSkillDirectory(targetDir);
      const active = path.join(targetDir, 'SKILL.md');
      const disabled = path.join(targetDir, 'SKILL.md.disabled');
      const source = enabled ? disabled : active;
      const destination = enabled ? active : disabled;
      if (!fs.existsSync(source)) {
        throw new BotSkillServiceError(
          enabled ? 'Disabled Skill not found.' : 'Active Skill not found.',
          'SKILL_STATE_MISMATCH',
          404,
        );
      }
      assertRegularFile(source, 'Skill entry file');
      if (fs.existsSync(destination)) {
        throw new BotSkillServiceError(
          'Both enabled and disabled Skill entry files exist.',
          'SKILL_STATE_AMBIGUOUS',
        );
      }
      fs.renameSync(source, destination);
      return {
        result: { enabled, path: destination },
        manifest: this.scanManifestUnlocked(),
      };
    });
  }

  async writeSharedMetadata(
    name: string,
    metadata: Required<SkillHubLocalMetadata>,
  ): Promise<LocalSkillManifest> {
    return this.runExclusive(() => {
      const matches = PathResolver.findSkillFiles(this.skillsRoot)
        .map(filePath => ({ filePath, skill: SkillParser.parse(filePath) }))
        .filter(item => item.skill.metadata.name === String(name || '').trim());
      if (matches.length !== 1) {
        throw new BotSkillServiceError(
          matches.length ? 'Skill name is ambiguous.' : 'Skill not found.',
          matches.length ? 'SKILL_NAME_AMBIGUOUS' : 'SKILL_NOT_FOUND',
          matches.length ? 409 : 404,
        );
      }
      const skillDir = path.dirname(matches[0].filePath);
      this.assertSafeSkillDirectory(skillDir);
      const skillFile = matches[0].filePath;
      assertRegularFile(skillFile, 'Skill entry file');
      writeSkillHubLocalMetadata(skillFile, metadata);
      return this.scanManifestUnlocked();
    });
  }

  private async runExclusive<T>(action: () => Promise<T> | T): Promise<T> {
    let activationLock: BotSkillWorkspaceActivationLock | undefined;
    let localLockId: string | undefined;
    if (this.existingActivationLock) {
      activationLock = this.existingActivationLock;
    } else if (this.managedWorkspace) {
      activationLock = this.workspaceService.acquireActivationLock();
    } else {
      localLockId = this.acquireLocalLock();
    }
    try {
      this.guardExpectedWorkspace(activationLock);
      ensureDirectoryWithoutLinks(this.operationsRoot);
      this.assertOperationsRoot();
      this.recoverLocalOperations();
      recoverSkillHubPackageOperations({
        skillsRoot: this.skillsRoot,
        operationsRoot: this.operationsRoot,
      });
      return await action();
    } finally {
      if (activationLock && activationLock !== this.existingActivationLock) {
        activationLock.release();
      }
      if (localLockId) this.releaseLocalLock(localLockId);
    }
  }

  private guardExpectedWorkspace(
    lock?: BotSkillWorkspaceActivationLock,
  ): void {
    const state = this.managedWorkspace ? this.workspaceService.readState() : undefined;
    if (!state) {
      if (this.managedWorkspace && !this.allowUnmanagedWorkspace) {
        throw new BotSkillServiceError(
          'The managed Skill workspace has not been claimed by an active Bot.',
          'SKILL_WORKSPACE_UNCLAIMED',
          409,
        );
      }
      if (!fs.existsSync(this.skillsRoot)) {
        throw new BotSkillServiceError(
          'The active Skill workspace does not exist.',
          'SKILL_WORKSPACE_MISSING',
          409,
        );
      }
      this.assertWorkspaceRoot();
      return;
    }
    if (!this.expectedBotId) {
      throw new BotSkillServiceError(
        'A Bot-managed Skill workspace has no active Bot binding.',
        'SKILL_WORKSPACE_UNBOUND',
        409,
      );
    }
    const current = currentBotId(this.runtimeRoot);
    if (current !== this.expectedBotId) {
      throw new BotSkillServiceError(
        `The active Bot changed from ${this.expectedBotId || '(none)'} to ${current || '(none)'} before the Skill operation committed.`,
        'SKILL_WORKSPACE_OWNER_CHANGED',
        409,
      );
    }
    if (state.switchJournal) {
      if (!this.activationTransactionId) {
        throw new BotSkillServiceError(
          'The Bot Skill workspace is currently switching.',
          'SKILL_WORKSPACE_SWITCHING',
          423,
        );
      }
      this.workspaceService.assertPendingTarget(
        this.activationTransactionId,
        this.expectedBotId,
      );
    } else {
      this.workspaceService.assertActive(this.expectedBotId);
    }
    this.assertWorkspaceRoot();
    if (lock) {
      const owner = readLockOwner(this.workspaceService.lockPath);
      if (!owner || owner.lockId !== lock.lockId || owner.pid !== process.pid) {
        throw new BotSkillServiceError(
          'The Bot Skill activation lock is no longer owned by this process.',
          'SKILL_WORKSPACE_LOCK_LOST',
          409,
        );
      }
    }
  }

  private scanManifestUnlocked(): LocalSkillManifest {
    const workspace = this.workspaceContext();
    return scanLocalSkillManifest({
      skillsRoot: this.skillsRoot,
      botId: workspace.botId,
      workspaceId: workspace.workspaceId,
      createIdentities: true,
    });
  }

  private requireCompleteManifest(): LocalSkillManifest {
    const manifest = this.scanManifestUnlocked();
    if (manifest.status !== 'complete') {
      throw new BotSkillServiceError(
        `Local Skill manifest is ${manifest.status}; refusing to treat it as a complete desired state.`,
        'LOCAL_SKILL_MANIFEST_INCOMPLETE',
        409,
        manifest,
      );
    }
    return manifest;
  }

  private findUniqueEntry(name: string) {
    const manifest = this.requireCompleteManifest();
    const normalized = String(name || '').trim();
    const matches = manifest.entries.filter(entry => entry.name === normalized);
    if (matches.length !== 1) {
      throw new BotSkillServiceError(
        matches.length ? 'Skill name is ambiguous.' : 'Skill not found.',
        matches.length ? 'SKILL_NAME_AMBIGUOUS' : 'SKILL_NOT_FOUND',
        matches.length ? 409 : 404,
      );
    }
    return matches[0];
  }

  private inspectVerifiedPackage(
    options: InstallVerifiedSkillHubPackageOptions,
  ): { name: string; key: string; path: string } {
    const packageObject = options.verification.packageObject;
    const packageManifest = packageObject.payload.manifest as any;
    const entry = packageObject.payload.files.find(file => file.path === 'SKILL.md');
    if (!entry) {
      throw new BotSkillServiceError(
        'SkillHub package is missing a root SKILL.md.',
        'SKILLHUB_SKILL_ENTRY_MISSING',
        400,
      );
    }
    let data: Record<string, any>;
    try {
      data = matter(Buffer.from(entry.contentBase64, 'base64').toString('utf8')).data;
    } catch (error) {
      throw new BotSkillServiceError(
        `SkillHub SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`,
        'SKILLHUB_SKILL_ENTRY_INVALID',
        400,
      );
    }
    const name = normalizedOptional(data.name);
    const description = normalizedOptional(data.description);
    const skillId = normalizedOptional(packageManifest.id)
      ?? normalizedOptional(options.registryEntry.skillId);
    const installName = normalizedOptional(packageManifest.name)
      ?? normalizedOptional(options.registryEntry.name);
    if (!name || !description || !skillId || !installName) {
      throw new BotSkillServiceError(
        'SkillHub package SKILL.md or manifest is missing required fields.',
        'SKILLHUB_SKILL_ENTRY_INVALID',
        400,
      );
    }
    return {
      name,
      key: `skillhub:${skillId}`,
      path: path.basename(this.resolveDirectChild(installName)),
    };
  }

  private assertProspectiveEntry(
    current: LocalSkillManifest,
    incoming: { name: string; key: string; path: string },
  ): void {
    const targetPath = portableKey(incoming.path);
    const conflict = current.entries.find(entry =>
      portableKey(entry.path) !== targetPath
      && (
        portableKey(entry.name) === portableKey(incoming.name)
        || portableKey(entry.key) === portableKey(incoming.key)
      ));
    if (conflict) {
      throw new BotSkillServiceError(
        `Incoming Skill conflicts with ${conflict.name} at ${conflict.path}.`,
        'SKILL_MANIFEST_CONFLICT',
        409,
        current,
      );
    }
  }

  private workspaceContext(): {
    botId?: string;
    workspaceId?: string;
  } {
    const state: BotSkillWorkspaceState | undefined = this.managedWorkspace
      ? this.workspaceService.readState()
      : undefined;
    const pendingTarget = state?.switchJournal?.to;
    if (
      pendingTarget
      && pendingTarget.botId === this.expectedBotId
      && this.activationTransactionId
    ) {
      return {
        botId: pendingTarget.botId,
        workspaceId: pendingTarget.workspaceId,
      };
    }
    return {
      botId: state?.workspaceOwnerBotId ?? this.expectedBotId,
      workspaceId: state?.workspaceId,
    };
  }

  private quarantineRemove(targetDir: string): void {
    const operationDir = this.newOperationDirectory('remove');
    const trashDir = path.join(operationDir, 'trash');
    writeJsonAtomic(path.join(operationDir, 'remove-journal.json'), {
      schema: 'xiaoba.local-skill-remove.v1',
      phase: 'prepared',
      targetDir,
    });
    fs.renameSync(targetDir, trashDir);
    try {
      writeJsonAtomic(path.join(operationDir, 'remove-journal.json'), {
        schema: 'xiaoba.local-skill-remove.v1',
        phase: 'removed',
        targetDir,
      });
    } catch {
      // The target-to-trash rename is the removal commit point.
    }
    try {
      fs.rmSync(operationDir, { recursive: true, force: true });
    } catch {
      // Removal was committed by rename; stale trash is cleaned next time.
    }
  }

  private commitStagedDirectory(
    operationDir: string,
    stagedDir: string,
    targetDir: string,
  ): void {
    const backupDir = path.join(operationDir, 'backup');
    const journalPath = path.join(operationDir, 'local-install-journal.json');
    const stagedIdentity = readLocalSkillIdentity(stagedDir);
    const journalBase = {
      schema: 'xiaoba.local-skill-install.v1' as const,
      targetDir,
      targetExisted: fs.existsSync(targetDir),
      expectedLocalSkillId: stagedIdentity?.localSkillId,
      expectedContentHash: computeLocalSkillContentHash(stagedDir),
    };
    writeJsonAtomic(journalPath, {
      ...journalBase,
      phase: 'prepared',
    });
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      writeJsonAtomic(journalPath, {
        ...journalBase,
        phase: 'target-backed-up',
      });
    }
    fs.renameSync(stagedDir, targetDir);
    try {
      writeJsonAtomic(journalPath, {
        ...journalBase,
        phase: 'target-active',
      });
    } catch {
      // The target rename is the commit point. The prior journal phase is
      // sufficient for recovery to keep the new active target.
    }
    try {
      fs.rmSync(operationDir, { recursive: true, force: true });
    } catch {
      // The target rename committed the install. Stale operation data is
      // recoverable and must not turn a successful local install into failure.
    }
  }

  private recoverLocalOperations(): void {
    if (!fs.existsSync(this.operationsRoot)) return;
    this.assertOperationsRoot();
    for (const entry of fs.readdirSync(this.operationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const operationDir = path.join(this.operationsRoot, entry.name);
      if (entry.name.startsWith('remove-')) {
        fs.rmSync(operationDir, { recursive: true, force: true });
        continue;
      }
      if (!entry.name.startsWith('local-install-')) continue;
      const journalPath = path.join(operationDir, 'local-install-journal.json');
      const stagedDir = path.join(operationDir, 'staged');
      const backupDir = path.join(operationDir, 'backup');
      if (!fs.existsSync(journalPath)) {
        fs.rmSync(operationDir, { recursive: true, force: true });
        continue;
      }
      const journal = readJsonFile(journalPath) as {
        schema?: string;
        phase?: string;
        targetDir?: string;
        targetExisted?: boolean;
        expectedLocalSkillId?: string;
        expectedContentHash?: string;
      };
      if (
        journal.schema !== 'xiaoba.local-skill-install.v1'
        || !['prepared', 'target-backed-up', 'target-active'].includes(String(journal.phase))
        || !journal.targetDir
        || (journal.targetExisted !== undefined && typeof journal.targetExisted !== 'boolean')
        || (
          journal.expectedLocalSkillId !== undefined
          && typeof journal.expectedLocalSkillId !== 'string'
        )
        || (
          journal.expectedContentHash !== undefined
          && typeof journal.expectedContentHash !== 'string'
        )
      ) {
        throw new BotSkillServiceError(
          'Local Skill install transaction journal is invalid.',
          'LOCAL_INSTALL_JOURNAL_INVALID',
        );
      }
      const targetDir = this.assertContainedTarget(journal.targetDir);
      if (fs.existsSync(stagedDir)) {
        assertRealDirectoryContained(operationDir, stagedDir, 'Recovered staged Skill');
      }
      if (fs.existsSync(backupDir)) {
        assertRealDirectoryContained(operationDir, backupDir, 'Recovered backup Skill');
      }
      if (
        ['prepared', 'target-backed-up'].includes(String(journal.phase))
        && !fs.existsSync(targetDir)
        && fs.existsSync(backupDir)
      ) {
        fs.renameSync(backupDir, targetDir);
      }
      if (
        journal.phase === 'target-active'
        && !fs.existsSync(targetDir)
        && fs.existsSync(backupDir)
      ) {
        throw new BotSkillServiceError(
          'The committed local Skill target is missing while its backup still exists.',
          'LOCAL_INSTALL_RECOVERY_AMBIGUOUS',
        );
      }
      const targetExists = fs.existsSync(targetDir);
      const backupExists = fs.existsSync(backupDir);
      if (
        targetExists
        && (
          backupExists
          || journal.targetExisted === false
          || journal.phase === 'target-active'
        )
      ) {
        this.assertRecoveredLocalTarget(targetDir, journal, backupExists);
      }
      if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir) && fs.existsSync(targetDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      fs.rmSync(operationDir, { recursive: true, force: true });
    }
  }

  private assertRecoveredLocalTarget(
    targetDir: string,
    journal: {
      expectedLocalSkillId?: string;
      expectedContentHash?: string;
    },
    hasBackup: boolean,
  ): void {
    this.assertSafeSkillDirectory(targetDir);
    if (!journal.expectedLocalSkillId || !journal.expectedContentHash) {
      if (hasBackup) {
        throw new BotSkillServiceError(
          'Cannot verify the recovered active Skill while a unique backup exists.',
          'LOCAL_INSTALL_RECOVERY_AMBIGUOUS',
        );
      }
      return;
    }
    const identity = readLocalSkillIdentity(targetDir);
    if (
      identity?.localSkillId !== journal.expectedLocalSkillId
      || computeLocalSkillContentHash(targetDir) !== journal.expectedContentHash
    ) {
      throw new BotSkillServiceError(
        'Recovered active Skill does not match its transaction journal.',
        'LOCAL_INSTALL_RECOVERY_AMBIGUOUS',
      );
    }
  }

  private newOperationDirectory(prefix: string): string {
    const operationDir = path.join(
      this.operationsRoot,
      `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
    );
    fs.mkdirSync(operationDir, { recursive: false, mode: 0o700 });
    return operationDir;
  }

  private resolveDirectChild(installName: string): string {
    const normalized = String(installName || '').trim();
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(normalized)
      || /[. ]$/.test(normalized)
      || isWindowsReservedName(normalized)
    ) {
      throw new BotSkillServiceError(
        `Unsafe Skill install name: ${installName}`,
        'SKILL_INSTALL_NAME_UNSAFE',
        400,
      );
    }
    return this.assertContainedTarget(path.join(this.skillsRoot, normalized));
  }

  private assertContainedTarget(target: string): string {
    const resolved = path.resolve(target);
    const relative = path.relative(this.skillsRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new BotSkillServiceError(
        `Skill target escapes the active workspace: ${target}`,
        'SKILL_PATH_UNSAFE',
        400,
      );
    }
    return resolved;
  }

  private assertWorkspaceRoot(): void {
    assertRealDirectoryContained(this.skillsRoot, this.skillsRoot, 'Skill workspace');
  }

  private assertOperationsRoot(): void {
    assertRealDirectoryContained(this.operationsRoot, this.operationsRoot, 'Skill operation root');
    if (!sameFilesystem(this.operationsRoot, this.skillsRoot)) {
      throw new BotSkillServiceError(
        'Skill operation staging must use the same filesystem as the workspace.',
        'SKILL_OPERATION_FILESYSTEM_MISMATCH',
      );
    }
  }

  private assertSafeSkillDirectory(target: string): void {
    assertRealDirectoryContained(this.skillsRoot, target, 'Skill directory');
  }

  private assertRealTree(target: string, label: string): void {
    assertRealDirectoryContained(target, target, label);
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          throw new BotSkillServiceError(
            `${label} contains a symlink or junction: ${entryPath}`,
            'SKILL_SOURCE_LINK_UNSAFE',
            400,
          );
        }
        if (stat.isDirectory()) visit(entryPath);
      }
    };
    visit(target);
  }

  private acquireLocalLock(): string {
    ensureDirectoryWithoutLinks(this.operationsRoot);
    this.assertOperationsRoot();
    const lockId = crypto.randomUUID();
    try {
      fs.mkdirSync(this.localLockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readLockOwner(this.localLockPath);
      if (owner && isProcessAlive(owner.pid)) {
        throw new BotSkillServiceError(
          `Another Skill operation is active in pid ${owner.pid}.`,
          'SKILL_OPERATION_LOCKED',
          423,
        );
      }
      if (!owner && Date.now() - fs.statSync(this.localLockPath).mtimeMs < 30_000) {
        throw new BotSkillServiceError(
          'Another Skill operation lock is still being initialized.',
          'SKILL_OPERATION_LOCKED',
          423,
        );
      }
      const stale = `${this.localLockPath}.stale.${crypto.randomUUID()}`;
      try {
        fs.renameSync(this.localLockPath, stale);
      } catch {
        throw new BotSkillServiceError(
          'The Skill operation lock changed while checking stale ownership.',
          'SKILL_OPERATION_LOCKED',
          423,
        );
      }
      fs.rmSync(stale, { recursive: true, force: true });
      fs.mkdirSync(this.localLockPath, { mode: 0o700 });
    }
    writeJsonAtomic(path.join(this.localLockPath, 'owner.json'), {
      lockId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    return lockId;
  }

  private releaseLocalLock(lockId: string): void {
    const owner = readLockOwner(this.localLockPath);
    if (owner?.lockId === lockId && owner.pid === process.pid) {
      fs.rmSync(this.localLockPath, { recursive: true, force: true });
    }
  }
}

export function createBotSkillService(
  options: BotSkillServiceOptions = {},
): BotSkillService {
  return new BotSkillService(options);
}

function currentBotId(runtimeRoot: string): string | undefined {
  return normalizedOptional(
    createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid,
  );
}

function copyDirectoryStrict(sourceDir: string, targetDir: string): void {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: source => {
      const name = path.basename(source);
      if (['.git', 'node_modules', '__pycache__'].includes(name)) return false;
      if ([
        BOT_SKILL_LOCAL_IDENTITY_FILE,
        '.xiaoba-skillhub-install.json',
      ].includes(name)) return false;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) {
        throw new BotSkillServiceError(
          `Local Skill source contains a symlink or junction: ${source}`,
          'SKILL_SOURCE_LINK_UNSAFE',
          400,
        );
      }
      return true;
    },
  });
}

function assertRegularFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BotSkillServiceError(`${label} must be a regular file.`, 'SKILL_PATH_UNSAFE', 400);
  }
}

function assertRealDirectoryContained(root: string, target: string, label: string): void {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const targetStat = fs.lstatSync(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new BotSkillServiceError(`${label} must be a real directory.`, 'SKILL_PATH_UNSAFE', 400);
  }
  const relative = path.relative(rootPath, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BotSkillServiceError(`${label} escapes its root.`, 'SKILL_PATH_UNSAFE', 400);
  }
  const realRoot = fs.realpathSync.native(rootPath);
  const realTarget = fs.realpathSync.native(targetPath);
  const realRelative = path.relative(realRoot, realTarget);
  if (
    realRelative === '..'
    || realRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(realRelative)
    || !samePath(targetPath, realTarget)
  ) {
    throw new BotSkillServiceError(
      `${label} traverses a symlink or junction.`,
      'SKILL_PATH_UNSAFE',
      400,
    );
  }
}

function ensureDirectoryWithoutLinks(target: string): void {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(current, fs.realpathSync.native(current))) {
      throw new BotSkillServiceError(
        `Skill operation path traverses a symlink or junction: ${current}`,
        'SKILL_OPERATION_PATH_UNSAFE',
        400,
      );
    }
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, filePath);
}

function readJsonFile(filePath: string): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
    throw new BotSkillServiceError('Skill operation metadata is invalid.', 'SKILL_OPERATION_METADATA_INVALID');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readLockOwner(lockPath: string): { lockId: string; pid: number } | undefined {
  const filePath = path.join(lockPath, 'owner.json');
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const value = readJsonFile(filePath) as { lockId?: unknown; pid?: unknown };
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

function normalizedOptional(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function sameFilesystem(left: string, right: string): boolean {
  try {
    return fs.statSync(left).dev === fs.statSync(right).dev;
  } catch {
    // Fall back to volume roots before both paths have been materialized.
  }
  return path.parse(path.resolve(left)).root.toLowerCase()
    === path.parse(path.resolve(right)).root.toLowerCase();
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function portableKey(value: string): string {
  return String(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.replace(/[. ]+$/g, '').split('.')[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}
