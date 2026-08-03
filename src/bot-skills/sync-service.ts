import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import {
  createBotDefinitionSyncService,
  type BotDefinitionSyncService,
} from '../bot-definition/service';
import type { BotSkillRef } from '../bot-definition/types';
import { canonicalizeBotSkillRefs, botSkillRefsEqual } from './canonical';
import {
  BotSkillsCloudConflictError,
  pullCloudBotSkills,
  replaceCloudBotSkills,
  type BotSkillsCloudClientOptions,
  type CloudBotSkills,
} from './cloud-client';
import { BotSkillBaseStore } from './base-store';
import {
  readBotSkillLocalMarker,
  scanBotSkillWorkspace,
  writeBotSkillLocalMarker,
} from './local-manifest';
import { BotPrivateSkillClient } from './private-package-client';
import type {
  BotSkillPackage,
  BotSkillSyncBase,
  BotSkillSyncBaseEntry,
  LocalBotSkillManifestEntry,
} from './types';

export type BotSkillSyncDirection =
  | 'none'
  | 'local_to_cloud'
  | 'cloud_to_local'
  | 'feature_unavailable';

export interface BotSkillSyncResult {
  botId: string;
  direction: BotSkillSyncDirection;
  cloudRevision?: number;
  skills: BotSkillRef[];
}

export interface BotSkillSyncServiceOptions {
  runtimeRoot: string;
  botId: string;
  auth: CatsCoAuthSnapshot;
  skillsRoot?: string;
  workspaceExisted: boolean;
  fetchImpl?: typeof fetch;
  skillHubBaseUrl?: string;
  definitionService?: BotDefinitionSyncService;
  baseStore?: BotSkillBaseStore;
  privateClient?: BotPrivateSkillClient;
}

export class BotSkillCloudRestoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BotSkillCloudRestoreError';
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

interface BotSkillRestoreJournal {
  schema: 'xiaoba.bot-skill-restore-journal.v1';
  botId: string;
  skillsRoot: string;
  stage: string;
  backup: string;
  phase:
    | 'prepared'
    | 'backup_pending'
    | 'backed_up'
    | 'activation_pending'
    | 'activated'
    | 'committed';
}

export class BotSkillSyncService {
  private readonly runtimeRoot: string;
  private readonly botId: string;
  private readonly skillsRoot: string;
  private readonly workspaceExisted: boolean;
  private readonly cloudOptions: BotSkillsCloudClientOptions;
  private readonly definitionService: BotDefinitionSyncService;
  private readonly baseStore: BotSkillBaseStore;
  private readonly privateClient: BotPrivateSkillClient;

  constructor(options: BotSkillSyncServiceOptions) {
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.botId = String(options.botId || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(this.botId)) throw new Error('Invalid Bot ID for Skill sync');
    this.skillsRoot = path.resolve(options.skillsRoot ?? path.join(this.runtimeRoot, 'skills'));
    this.workspaceExisted = options.workspaceExisted;
    this.cloudOptions = {
      botId: this.botId,
      auth: options.auth,
      fetchImpl: options.fetchImpl,
    };
    this.definitionService = options.definitionService
      ?? createBotDefinitionSyncService({ runtimeRoot: this.runtimeRoot });
    this.baseStore = options.baseStore ?? new BotSkillBaseStore(this.runtimeRoot);
    this.privateClient = options.privateClient ?? new BotPrivateSkillClient({
      auth: options.auth,
      botId: this.botId,
      baseUrl: options.skillHubBaseUrl,
      fetchImpl: options.fetchImpl,
    });
  }

  static recoverInterruptedRestore(runtimeRoot: string, botId: string, skillsRoot: string): void {
    const journalPath = restoreJournalPath(runtimeRoot, botId);
    if (!fs.existsSync(journalPath)) return;
    const journal = readRestoreJournal(journalPath, runtimeRoot, botId, skillsRoot);
    if (journal.phase === 'prepared') {
      if (fs.existsSync(journal.stage)) fs.rmSync(journal.stage, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      return;
    }
    if (journal.phase === 'activated' || journal.phase === 'committed') {
      // The staged workspace was fully downloaded and verified before it became
      // active. Keep it and let the next sync roll metadata forward if a crash
      // happened before Definition/Base were committed.
      if (!fs.existsSync(journal.skillsRoot)) {
        throw new Error('Activated Bot Skill restore is missing its workspace');
      }
      if (fs.existsSync(journal.stage)) fs.rmSync(journal.stage, { recursive: true, force: true });
      if (fs.existsSync(journal.backup)) fs.rmSync(journal.backup, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      return;
    }
    if (journal.phase === 'activation_pending' && !fs.existsSync(journal.stage)) {
      if (!fs.existsSync(journal.skillsRoot)) {
        throw new Error('Activated Bot Skill restore is missing its workspace');
      }
      if (fs.existsSync(journal.backup)) fs.rmSync(journal.backup, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      return;
    }
    if (fs.existsSync(journal.skillsRoot) && fs.existsSync(journal.backup)) {
      throw new Error('Interrupted Bot Skill restore has ambiguous active and backup workspaces');
    }
    if (!fs.existsSync(journal.skillsRoot) && fs.existsSync(journal.backup)) {
      fs.renameSync(journal.backup, journal.skillsRoot);
    }
    if (fs.existsSync(journal.stage)) fs.rmSync(journal.stage, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
  }

  async sync(): Promise<BotSkillSyncResult> {
    BotSkillSyncService.recoverInterruptedRestore(
      this.runtimeRoot,
      this.botId,
      this.skillsRoot,
    );
    const base = this.baseStore.read(this.botId);
    const local = this.readLocalManifest();
    let cloud: CloudBotSkills | undefined;
    try {
      cloud = await pullCloudBotSkills(this.cloudOptions);
    } catch (error) {
      if (!this.workspaceExisted || !fs.existsSync(this.skillsRoot)) throw error;
      return this.featureUnavailable();
    }
    if (!cloud) {
      if (!fs.existsSync(this.skillsRoot)) fs.mkdirSync(this.skillsRoot, { recursive: true });
      return this.featureUnavailable();
    }

    if (!cloud.definition) {
      if (!this.workspaceExisted && base?.skills.length) {
        const baseRefs = canonicalizeBotSkillRefs(base.skills.map(entry => entry.reference));
        try {
          const recreated = await replaceCloudBotSkills(this.cloudOptions, cloud, baseRefs);
          return this.restoreCloud(recreated);
        } catch (error) {
          if (!(error instanceof BotSkillsCloudConflictError)) throw error;
          const latest = await pullCloudBotSkills(this.cloudOptions);
          if (!latest) throw error;
          return this.restoreCloud(latest);
        }
      }
      return this.pushLocal(local, cloud, base);
    }

    if (!this.workspaceExisted && base) {
      return this.restoreCloud(cloud);
    }

    if (!base) {
      if (!this.workspaceExisted || local.length === 0) {
        if (cloud.skills.length > 0) return this.restoreCloud(cloud);
        if (!fs.existsSync(this.skillsRoot)) fs.mkdirSync(this.skillsRoot, { recursive: true });
        this.acceptCloudDefinition(cloud);
        this.writeBase(cloud, []);
        return {
          botId: this.botId,
          direction: 'none',
          cloudRevision: cloud.revision,
          skills: cloud.skills,
        };
      }
      return this.pushLocal(local, cloud, undefined);
    }

    const localChanged = !localMatchesBase(local, base);
    const cloudChanged = !botSkillRefsEqual(cloud.skills, base.skills.map(entry => entry.reference));
    if (localChanged) return this.pushLocal(local, cloud, base);
    if (cloudChanged) return this.restoreCloud(cloud);
    this.acceptCloudDefinition(cloud);
    if (cloud.revision !== base.definitionRevision) this.writeBase(cloud, base.skills);
    return {
      botId: this.botId,
      direction: 'none',
      cloudRevision: cloud.revision,
      skills: cloud.skills,
    };
  }

  private featureUnavailable(): BotSkillSyncResult {
    return {
      botId: this.botId,
      direction: 'feature_unavailable',
      skills: this.definitionService.read(this.botId)?.skills ?? [],
    };
  }

  private readLocalManifest(): LocalBotSkillManifestEntry[] {
    if (!fs.existsSync(this.skillsRoot)) {
      if (this.workspaceExisted) {
        throw new Error('The active Bot Skill workspace disappeared unexpectedly.');
      }
      return [];
    }
    return scanBotSkillWorkspace(this.skillsRoot);
  }

  private async pushLocal(
    local: LocalBotSkillManifestEntry[],
    initialCloud: CloudBotSkills,
    base: BotSkillSyncBase | undefined,
  ): Promise<BotSkillSyncResult> {
    const previousByLocalID = new Map(base?.skills.map(entry => [entry.localSkillId, entry]) ?? []);
    const nextEntries: BotSkillSyncBaseEntry[] = [];
    for (const entry of local) {
      const previous = previousByLocalID.get(entry.localSkillId);
      let reference: BotSkillRef | undefined;
      if (previous?.contentHash === entry.contentHash) {
        reference = previous.reference;
      } else if (entry.reference) {
        try {
          const existing = await this.privateClient.download(entry.reference);
          if (existing.contentHash === entry.contentHash) reference = entry.reference;
        } catch (error: any) {
          if (![400, 404].includes(Number(error?.status))) throw error;
        }
      }
      if (!reference) {
        const uploaded = await this.privateClient.upsert(entry);
        if (uploaded.contentHash !== entry.contentHash) {
          throw new Error(`SkillHub returned a mismatched content hash for ${entry.name}`);
        }
        reference = {
          source: 'skillhub',
          ...uploaded.reference,
          contentHash: uploaded.contentHash,
        };
      }
      const marker = readBotSkillLocalMarker(entry.path);
      writeBotSkillLocalMarker(entry.path, {
        schema: 'xiaoba.bot-skill-local.v1',
        localSkillId: entry.localSkillId,
        reference,
        origin: marker?.origin ?? entry.origin ?? {
          skillId: reference.skillId,
          version: reference.version,
        },
      });
      nextEntries.push({
        localSkillId: entry.localSkillId,
        name: entry.name,
        installName: entry.installName,
        contentHash: entry.contentHash,
        reference,
        ...(entry.origin ? { origin: entry.origin } : {}),
      });
    }
    const refs = canonicalizeBotSkillRefs(nextEntries.map(entry => entry.reference));
    if (
      base
      && !botSkillRefsEqual(initialCloud.skills, base.skills.map(entry => entry.reference))
    ) {
      this.writeConflictSnapshot(initialCloud, refs);
    }
    let cloud = initialCloud;
    try {
      cloud = await replaceCloudBotSkills(this.cloudOptions, cloud, refs);
    } catch (error) {
      if (!(error instanceof BotSkillsCloudConflictError)) throw error;
      const latest = await pullCloudBotSkills(this.cloudOptions);
      if (!latest) throw error;
      if (!base || !botSkillRefsEqual(latest.skills, base.skills.map(entry => entry.reference))) {
        this.writeConflictSnapshot(latest, refs);
      }
      // The current single-device contract explicitly protects local changes.
      cloud = await replaceCloudBotSkills(this.cloudOptions, latest, refs);
    }
    this.acceptCloudDefinition(cloud);
    this.writeBase(cloud, nextEntries);
    return {
      botId: this.botId,
      direction: 'local_to_cloud',
      cloudRevision: cloud.revision,
      skills: cloud.skills,
    };
  }

  private async restoreCloud(cloud: CloudBotSkills): Promise<BotSkillSyncResult> {
    try {
      return await this.restoreCloudUnchecked(cloud);
    } catch (error) {
      if (error instanceof BotSkillCloudRestoreError) throw error;
      throw new BotSkillCloudRestoreError(
        `Bot Skill cloud workspace restore failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async restoreCloudUnchecked(cloud: CloudBotSkills): Promise<BotSkillSyncResult> {
    const parent = path.dirname(this.skillsRoot);
    const operationID = `${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const stage = path.join(parent, `.bot-skills-stage-${operationID}`);
    const backup = path.join(parent, `.bot-skills-backup-${operationID}`);
    const packages: BotSkillPackage[] = [];
    const previousManagedRoots = fs.existsSync(this.skillsRoot)
      ? scanBotSkillWorkspace(this.skillsRoot).map(entry => path.resolve(entry.path))
      : [];
    const previousDefinition = this.definitionService.read(this.botId);
    let entries: BotSkillSyncBaseEntry[] = [];
    let backedUp = false;
    let activatedStage = false;
    fs.mkdirSync(stage, { recursive: true });
    try {
      this.writeRestoreJournal({ stage, backup, phase: 'prepared' });
      const previousInstallNames = new Map(
        (this.baseStore.read(this.botId)?.skills ?? []).map(entry => [
          referenceKey(entry.reference),
          entry.installName,
        ]),
      );
      for (const reference of cloud.skills) {
        const packageValue = await this.privateClient.download(reference);
        await this.privateClient.materialize(
          packageValue,
          stage,
          previousInstallNames.get(referenceKey(reference)),
        );
        packages.push(packageValue);
      }
      const stagedLocal = scanBotSkillWorkspace(stage);
      const packageByLocalID = new Map(packages.map(item => [item.localSkillId, item]));
      entries = stagedLocal.map(entry => {
        const packageValue = packageByLocalID.get(entry.localSkillId);
        if (!packageValue || packageValue.contentHash !== entry.contentHash || !entry.reference) {
          throw new Error(`Restored Bot Skill failed verification: ${entry.name}`);
        }
        return {
          localSkillId: entry.localSkillId,
          name: entry.name,
          installName: entry.installName,
          contentHash: entry.contentHash,
          reference: entry.reference,
          ...(entry.origin ? { origin: entry.origin } : {}),
        };
      });
      const restoredRefs = canonicalizeBotSkillRefs(entries.map(entry => entry.reference));
      if (!botSkillRefsEqual(restoredRefs, cloud.skills)) {
        throw new Error('Restored Bot Skill workspace does not match its cloud Definition.');
      }
      if (fs.existsSync(this.skillsRoot)) {
        copyUnmanagedWorkspaceContent(
          this.skillsRoot,
          stage,
          previousManagedRoots,
          stagedLocal.map(entry => path.resolve(entry.path)),
        );
        entries = verifiedRestoredEntries(stage, packages, cloud.skills);
      }

      if (fs.existsSync(this.skillsRoot)) {
        this.writeRestoreJournal({ stage, backup, phase: 'backup_pending' });
        fs.renameSync(this.skillsRoot, backup);
        backedUp = true;
      }
      this.writeRestoreJournal({ stage, backup, phase: 'backed_up' });
      this.writeRestoreJournal({ stage, backup, phase: 'activation_pending' });
      fs.renameSync(stage, this.skillsRoot);
      activatedStage = true;
      this.writeRestoreJournal({ stage, backup, phase: 'activated' });
      this.acceptCloudDefinition(cloud);
      this.writeBase(cloud, entries);
      try {
        this.writeRestoreJournal({ stage, backup, phase: 'committed' });
      } catch {
        // `activated` recovery is deliberately roll-forward, so a failed
        // journal phase update cannot make a committed workspace unsafe.
      }
      if (backedUp) {
        try {
          fs.rmSync(backup, { recursive: true, force: true });
        } catch {
          // A stale backup is safe to remove on a later maintenance pass.
        }
      }
      try {
        fs.rmSync(restoreJournalPath(this.runtimeRoot, this.botId), { force: true });
      } catch {
        // A committed journal is safe for the next startup to clean up.
      }
    } catch (error) {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      if (activatedStage && fs.existsSync(this.skillsRoot)) {
        fs.rmSync(this.skillsRoot, { recursive: true, force: true });
      }
      if (backedUp && fs.existsSync(backup) && !fs.existsSync(this.skillsRoot)) {
        fs.renameSync(backup, this.skillsRoot);
      }
      if (activatedStage) {
        try {
          if (previousDefinition) this.definitionService.acceptCanonical(previousDefinition);
        } catch {
          // Preserve the original restore error; the next startup will reconcile
          // Definition from the workspace/Base pair again.
        }
      }
      fs.rmSync(restoreJournalPath(this.runtimeRoot, this.botId), { force: true });
      throw error;
    }
    return {
      botId: this.botId,
      direction: 'cloud_to_local',
      cloudRevision: cloud.revision,
      skills: cloud.skills,
    };
  }

  private writeRestoreJournal(
    value: Pick<BotSkillRestoreJournal, 'stage' | 'backup' | 'phase'>,
  ): void {
    const filePath = restoreJournalPath(this.runtimeRoot, this.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const journal: BotSkillRestoreJournal = {
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: this.botId,
      skillsRoot: this.skillsRoot,
      ...value,
    };
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  }

  private writeBase(cloud: CloudBotSkills, entries: BotSkillSyncBaseEntry[]): void {
    this.baseStore.write({
      schema: 'xiaoba.bot-skill-sync-base.v2',
      botId: this.botId,
      definitionRevision: cloud.revision,
      skills: entries,
      updatedAt: new Date().toISOString(),
    });
  }

  private writeConflictSnapshot(cloud: CloudBotSkills, localSkills: BotSkillRef[]): void {
    const root = path.join(this.runtimeRoot, 'data', 'bot-skills', 'conflicts', this.botId);
    fs.mkdirSync(root, { recursive: true });
    const observedAt = new Date().toISOString();
    const filePath = path.join(
      root,
      `${observedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`,
    );
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      schema: 'xiaoba.bot-skill-conflict-snapshot.v1',
      botId: this.botId,
      observedAt,
      cloud: {
        revision: cloud.revision,
        skills: cloud.skills,
      },
      local: { skills: localSkills },
      resolution: 'local_wins_first_phase',
    }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  }

  private acceptCloudDefinition(cloud: CloudBotSkills): void {
    if (!cloud.definition) {
      throw new Error('CatsCo cloud returned skills without a canonical BotDefinition.');
    }
    if (this.definitionService.read(this.botId)) {
      this.definitionService.updateSkills(this.botId, cloud.skills);
      return;
    }
    this.definitionService.acceptCanonical(cloud.definition);
  }
}

function localMatchesBase(
  local: LocalBotSkillManifestEntry[],
  base: BotSkillSyncBase,
): boolean {
  if (local.length !== base.skills.length) return false;
  const baseByID = new Map(base.skills.map(entry => [entry.localSkillId, entry]));
  return local.every(entry => {
    const previous = baseByID.get(entry.localSkillId);
    return Boolean(
      previous
      && previous.contentHash === entry.contentHash
      && previous.name === entry.name
      && previous.installName === entry.installName
    );
  });
}

function restoreJournalPath(runtimeRoot: string, botId: string): string {
  return path.join(
    path.resolve(runtimeRoot),
    'data',
    'bot-skills',
    'restore-journal',
    `${String(botId).trim()}.json`,
  );
}

function readRestoreJournal(
  journalPath: string,
  runtimeRoot: string,
  botId: string,
  skillsRoot: string,
): BotSkillRestoreJournal {
  let value: BotSkillRestoreJournal;
  try {
    value = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as BotSkillRestoreJournal;
  } catch {
    throw new Error('Bot Skill restore journal cannot be read safely');
  }
  const expectedRoot = path.resolve(skillsRoot);
  const parent = path.dirname(expectedRoot);
  const stage = path.resolve(String(value.stage || ''));
  const backup = path.resolve(String(value.backup || ''));
  if (
    value.schema !== 'xiaoba.bot-skill-restore-journal.v1'
    || value.botId !== String(botId).trim()
    || path.resolve(value.skillsRoot || '') !== expectedRoot
    || path.dirname(stage) !== parent
    || path.dirname(backup) !== parent
    || !path.basename(stage).startsWith('.bot-skills-stage-')
    || !path.basename(backup).startsWith('.bot-skills-backup-')
    || ![
      'prepared',
      'backup_pending',
      'backed_up',
      'activation_pending',
      'activated',
      'committed',
    ].includes(value.phase)
    || !restoreJournalPath(runtimeRoot, botId).startsWith(path.resolve(runtimeRoot))
  ) {
    throw new Error('Bot Skill restore journal is invalid');
  }
  return { ...value, skillsRoot: expectedRoot, stage, backup };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function referenceKey(reference: BotSkillRef): string {
  return `${reference.skillId}\0${reference.version}`;
}

function copyUnmanagedWorkspaceContent(
  sourceRoot: string,
  targetRoot: string,
  managedRoots: string[],
  targetManagedRoots: string[],
): void {
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const source = path.join(current, entry.name);
      const resolvedSource = path.resolve(source);
      if (managedRoots.includes(resolvedSource)) continue;
      const relative = path.relative(sourceRoot, source);
      const target = path.join(targetRoot, relative);
      if (targetManagedRoots.some(managed => (
        target === managed || target.startsWith(`${managed}${path.sep}`)
      ))) {
        throw new Error(`Unmanaged workspace content conflicts with a restored Skill: ${relative}`);
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        visit(source);
      } else if (entry.isFile() && !fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
    }
  };
  visit(sourceRoot);
}

function verifiedRestoredEntries(
  stage: string,
  packages: BotSkillPackage[],
  expectedRefs: BotSkillRef[],
): BotSkillSyncBaseEntry[] {
  const finalLocal = scanBotSkillWorkspace(stage);
  const packageByLocalID = new Map(packages.map(item => [item.localSkillId, item]));
  const entries = finalLocal.map(entry => {
    const packageValue = packageByLocalID.get(entry.localSkillId);
    if (!packageValue || packageValue.contentHash !== entry.contentHash || !entry.reference) {
      throw new Error(`Restored Bot Skill failed post-copy verification: ${entry.name}`);
    }
    return {
      localSkillId: entry.localSkillId,
      name: entry.name,
      installName: entry.installName,
      contentHash: entry.contentHash,
      reference: entry.reference,
      ...(entry.origin ? { origin: entry.origin } : {}),
    };
  });
  const restoredRefs = canonicalizeBotSkillRefs(entries.map(entry => entry.reference));
  if (!botSkillRefsEqual(restoredRefs, expectedRefs)) {
    throw new Error('Restored Bot Skill workspace changed after unmanaged content was copied.');
  }
  return entries;
}
