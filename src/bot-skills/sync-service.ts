import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import {
  createBotDefinitionSyncService,
  type BotDefinitionSyncService,
} from '../bot-definition/service';
import type { BotDefinition, BotSkillRef } from '../bot-definition/types';
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
  BOT_SKILL_LOCAL_MARKER_FILE,
  computeBotSkillPackageHash,
  readBotSkillLocalMarker,
  scanBotSkillWorkspace,
  type BotSkillWorkspaceValidationFailure,
  type ScanBotSkillWorkspaceOptions,
  writeBotSkillLocalMarker,
} from './local-manifest';
import { BotPrivateSkillClient } from './private-package-client';
import { renameBotSkillWorkspaceSync } from './workspace-fs';
import type {
  BotSkillPackage,
  BotSkillPackageFile,
  BotSkillSyncBase,
  BotSkillSyncBaseEntry,
  LocalBotSkillManifestEntry,
} from './types';
import { applySkillHubLocalMetadata } from '../skillhub/local-skill-metadata';
import { snapshotPendingBotSkillWorkspace } from './pending-snapshot';

export type BotSkillSyncDirection =
  | 'none'
  | 'local_to_cloud'
  | 'cloud_to_local'
  | 'feature_unavailable';

export type BotSkillApplyStatus =
  | 'applied'
  | 'already_applied'
  | 'deferred'
  | 'failed';

export interface BotSkillSyncResult {
  botId: string;
  direction: BotSkillSyncDirection;
  /** @deprecated Use observedRevision for new activation decisions. */
  cloudRevision?: number;
  observedRevision?: number;
  desiredRevision?: number;
  appliedRevision?: number;
  applyStatus: BotSkillApplyStatus;
  errorCode?: string;
  skills: BotSkillRef[];
  localPendingEvidence?: {
    path: string;
    fingerprint: string;
    fileCount: number;
  };
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

export interface FinalizePublicBotSkillInput {
  localSkillId: string;
  skillName: string;
  reference: BotSkillRef;
}

export interface FinalizePublicBotSkillOptions {
  publicationWaitMs?: number;
  pollDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  validateScope?: () => Promise<void> | void;
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

interface BotSkillFinalizeJournal {
  schema: 'xiaoba.bot-skill-finalize-journal.v1';
  botId: string;
  skillsRoot: string;
  skillPath: string;
  localSkillId: string;
  skillName: string;
  previousContentHash: string;
  nextContentHash: string;
  reference: BotSkillRef;
  previousSkill: string;
  nextSkill: string;
  previousMarker: string;
}

interface PublicFinalizeLocalManifest {
  entries: LocalBotSkillManifestEntry[];
  rejectedLocalSkillIds: ReadonlySet<string>;
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
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(this.botId)) throw new Error('Invalid Bot ID for Skill sync');
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
      renameBotSkillWorkspaceSync(journal.backup, journal.skillsRoot);
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
    let local = this.readLocalManifest();
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

    this.recoverInterruptedFinalizes(cloud);
    local = this.readLocalManifest();

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
          observedRevision: cloud.revision,
          desiredRevision: cloud.revision,
          appliedRevision: cloud.revision,
          applyStatus: 'already_applied',
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
      observedRevision: cloud.revision,
      desiredRevision: cloud.revision,
      appliedRevision: cloud.revision,
      applyStatus: 'already_applied',
      skills: cloud.skills,
    };
  }

  /**
   * Reconciles the formal Skill workspace while a Bot is being activated.
   * Cloud BotDefinition is the only authority in this path: local changes are
   * preserved as evidence and are never uploaded or written back to Cloud.
   */
  async reconcileActivationFromCloudOnly(): Promise<BotSkillSyncResult> {
    try {
      BotSkillSyncService.recoverInterruptedRestore(
        this.runtimeRoot,
        this.botId,
        this.skillsRoot,
      );
      const base = this.baseStore.read(this.botId);
      let local: LocalBotSkillManifestEntry[] = [];
      let localReadable = true;
      try {
        local = this.readLocalManifest();
      } catch {
        localReadable = false;
      }
      const verifiedExisting = Boolean(
        localReadable
        && this.workspaceExisted
        && fs.existsSync(this.skillsRoot)
        && base
        && localMatchesBase(local, base),
      );

      let cloud: CloudBotSkills | undefined;
      try {
        cloud = await pullCloudBotSkills(this.cloudOptions);
      } catch (error) {
        if (verifiedExisting) {
          return this.featureUnavailable({
            appliedRevision: base!.definitionRevision,
            errorCode: 'cloud_unavailable',
          });
        }
        throw new BotSkillCloudRestoreError(
          `Bot Skill activation requires Cloud or a verified local workspace: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (!cloud?.definition) {
        if (verifiedExisting) {
          return this.featureUnavailable({
            ...(cloud ? { observedRevision: cloud.revision } : {}),
            appliedRevision: base!.definitionRevision,
            errorCode: 'cloud_definition_unavailable',
          });
        }
        throw new BotSkillCloudRestoreError(
          'Bot Skill activation requires a canonical Cloud BotDefinition.',
        );
      }

      if (localReadable) {
        try {
          this.recoverInterruptedFinalizes(cloud);
          local = this.readLocalManifest();
        } catch {
          localReadable = false;
        }
      }
      const workspaceHasEvidence = fs.existsSync(this.skillsRoot)
        && (!localReadable || local.length > 0 || hasWorkspaceEntries(this.skillsRoot));
      const localChanged = !localReadable || (base
        ? !localMatchesBase(local, base)
        : workspaceHasEvidence);

      // An explicit empty Cloud Definition is a valid deletion only when the
      // active workspace still matches its verified Base. Without a Base, or
      // after Local changed, replacing a non-empty workspace with an empty
      // stage would turn a first migration / unresolved edit into silent data
      // removal. Keep Local active and record recoverable evidence instead.
      if (
        cloud.skills.length === 0
        && workspaceHasEvidence
        && (!base || localChanged)
      ) {
        const snapshot = snapshotPendingBotSkillWorkspace({
          runtimeRoot: this.runtimeRoot,
          botId: this.botId,
          sourcePath: this.skillsRoot,
          recordedSourcePath: this.skillsRoot,
          reason: base ? 'activation_local_changed' : 'activation_without_base',
          ...(base ? { baseRevision: base.definitionRevision } : {}),
          cloudRevision: cloud.revision,
        });
        return {
          ...this.featureUnavailable({
            observedRevision: cloud.revision,
            desiredRevision: cloud.revision,
            errorCode: 'local_workspace_unverified',
          }),
          cloudRevision: cloud.revision,
          localPendingEvidence: {
            path: snapshot.path,
            fingerprint: snapshot.fingerprint,
            fileCount: snapshot.fileCount,
          },
        };
      }

      if (
        verifiedExisting
        && !localChanged
        && base
        && botSkillRefsEqual(cloud.skills, base.skills.map(entry => entry.reference))
      ) {
        this.acceptCloudDefinition(cloud);
        if (cloud.revision !== base.definitionRevision) this.writeBase(cloud, base.skills);
        return {
          botId: this.botId,
          direction: 'none',
          cloudRevision: cloud.revision,
          observedRevision: cloud.revision,
          desiredRevision: cloud.revision,
          appliedRevision: cloud.revision,
          applyStatus: 'already_applied',
          skills: cloud.skills,
        };
      }

      return this.restoreCloud(cloud, {
        preserveUnmanaged: false,
        pendingSnapshot: {
          reason: localChanged
            ? base ? 'activation_local_changed' : 'activation_without_base'
            : 'activation_cloud_reconcile',
          ...(base ? { baseRevision: base.definitionRevision } : {}),
        },
      });
    } catch (error) {
      if (error instanceof BotSkillCloudRestoreError) throw error;
      throw new BotSkillCloudRestoreError(
        `Bot Skill Cloud-only activation failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Completes the second phase of sharing a local Skill. CatsCo has already
   * bound the public reference to BotDefinition; this method proves that the
   * published package is downloadable and still matches the selected local
   * Skill before making local/Base agree with that public reference.
   */
  async finalizePublicSkill(
    input: FinalizePublicBotSkillInput,
    options: FinalizePublicBotSkillOptions = {},
  ): Promise<BotSkillSyncResult> {
    const localSkillId = String(input.localSkillId || '').trim();
    const skillName = String(input.skillName || '').trim();
    const reference = input.reference;
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(localSkillId)) {
      throw new Error('A valid local Skill ID is required for public finalization.');
    }
    if (
      reference?.source !== 'skillhub'
      || !String(reference.skillId || '').trim()
      || isPrivateSkillReference(reference.skillId)
      || !String(reference.version || '').trim()
      || !/^[a-f0-9]{64}$/.test(String(reference.contentHash || ''))
    ) {
      throw new Error('A valid public SkillHub reference is required for finalization.');
    }

    BotSkillSyncService.recoverInterruptedRestore(
      this.runtimeRoot,
      this.botId,
      this.skillsRoot,
    );
    const initialCloud = await pullCloudBotSkills(this.cloudOptions);
    if (!initialCloud) throw new Error('Bot Skill cloud sync is unavailable for public finalization.');
    await options.validateScope?.();
    this.recoverInterruptedFinalizes(initialCloud);
    const base = this.baseStore.read(this.botId);
    const localSnapshot = this.readLocalManifestForPublicFinalize(localSkillId);
    const local = localSnapshot.entries;
    const selected = local.find(entry => (
      entry.localSkillId === localSkillId && entry.name === skillName
    ));
    if (!selected) throw new Error('The selected local Skill no longer exists or changed identity.');
    if (!initialCloud.definition || !initialCloud.skills.some(item => botSkillRefEqual(item, reference))) {
      throw new Error('The public Skill reference is not present in the current BotDefinition.');
    }

    const packageValue = await this.waitForPublicPackage(reference, options);
    const refreshed = this.readLocalManifestForPublicFinalize(localSkillId).entries.find(entry => (
      entry.localSkillId === localSkillId && entry.name === skillName
    ));
    if (!refreshed || refreshed.contentHash !== selected.contentHash) {
      throw new Error('The selected local Skill changed while its public package was being published.');
    }
    const nextSkillMarkdown = publishedSkillMarkdown(refreshed, packageValue);
    await options.validateScope?.();
    const currentCloud = await pullCloudBotSkills(this.cloudOptions);
    if (!currentCloud?.definition || !currentCloud.skills.some(item => botSkillRefEqual(item, reference))) {
      throw new Error('The public Skill reference was removed from BotDefinition during finalization.');
    }
    const readyToWrite = this.readLocalManifestForPublicFinalize(localSkillId).entries.find(entry => (
      entry.localSkillId === localSkillId && entry.name === skillName
    ));
    if (!readyToWrite || readyToWrite.contentHash !== refreshed.contentHash) {
      throw new Error('The selected local Skill changed before public finalization could be committed.');
    }

    // Keep the final local journal/file write behind the same lifecycle fence as
    // the cloud checks. Once this synchronous block starts, no JS shutdown hook
    // can interleave between its individual filesystem writes.
    await options.validateScope?.();
    const skillFile = path.join(readyToWrite.path, 'SKILL.md');
    const markerFile = path.join(readyToWrite.path, BOT_SKILL_LOCAL_MARKER_FILE);
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    const previousMarkerValue = readBotSkillLocalMarker(readyToWrite.path);
    const journal: BotSkillFinalizeJournal = {
      schema: 'xiaoba.bot-skill-finalize-journal.v1',
      botId: this.botId,
      skillsRoot: this.skillsRoot,
      skillPath: readyToWrite.path,
      localSkillId,
      skillName,
      previousContentHash: readyToWrite.contentHash,
      nextContentHash: reference.contentHash,
      reference,
      previousSkill,
      nextSkill: nextSkillMarkdown,
      previousMarker,
    };
    try {
      this.writeFinalizeJournal(journal);
      writeTextFileAtomically(skillFile, nextSkillMarkdown);
      writeBotSkillLocalMarker(readyToWrite.path, {
        schema: 'xiaoba.bot-skill-local.v1',
        localSkillId,
        reference,
        origin: previousMarkerValue?.origin ?? readyToWrite.origin ?? {
          skillId: reference.skillId,
          version: reference.version,
        },
      });

      const updatedSnapshot = this.readLocalManifestForPublicFinalize(localSkillId);
      const updatedLocal = updatedSnapshot.entries;
      const updated = updatedLocal.find(entry => entry.localSkillId === localSkillId);
      if (
        !updated
        || updated.contentHash !== reference.contentHash
        || !updated.reference
        || !botSkillRefEqual(updated.reference, reference)
      ) {
        throw new Error('The local Skill does not match the published SkillHub package.');
      }
      await options.validateScope?.();
      const result = await this.pushLocal(updatedLocal, currentCloud, base, {
        requiredCloudReference: reference,
        preserveBaseLocalSkillIds: updatedSnapshot.rejectedLocalSkillIds,
        validateScope: options.validateScope,
      });
      try {
        this.removeFinalizeJournal(localSkillId);
      } catch {
        // A committed journal safely rolls forward and will be removed on next sync.
      }
      return result;
    } catch (error) {
      try {
        writeTextFileAtomically(skillFile, previousSkill);
        writeTextFileAtomically(markerFile, previousMarker);
        this.removeFinalizeJournal(localSkillId);
      } catch (rollbackError) {
        throw new Error(
          `The public Skill failed local verification and rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  private recoverInterruptedFinalizes(cloud: CloudBotSkills): void {
    const directory = finalizeJournalDirectory(this.runtimeRoot, this.botId);
    if (!fs.existsSync(directory)) return;
    const journals = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => readFinalizeJournal(
        path.join(directory, entry.name),
        this.runtimeRoot,
        this.botId,
        this.skillsRoot,
      ));
    for (const journal of journals) {
      const current = this.readLocalManifest().find(entry => (
        entry.localSkillId === journal.localSkillId
      ));
      if (!current) {
        // A deletion after the interruption is a local user decision. Let the
        // regular Base rules decide whether it propagates or is restored.
        this.removeFinalizeJournal(journal.localSkillId);
        continue;
      }
      const markerFile = path.join(current.path, BOT_SKILL_LOCAL_MARKER_FILE);
      const cloudHasReference = cloud.skills.some(item => botSkillRefEqual(item, journal.reference));
      const identityChanged = current.name !== journal.skillName
        || path.resolve(current.path) !== journal.skillPath;
      const writePublicMarker = (): void => {
        const previousMarker = JSON.parse(journal.previousMarker) as {
          origin?: { skillId: string; version: string };
        };
        writeBotSkillLocalMarker(current.path, {
          schema: 'xiaoba.bot-skill-local.v1',
          localSkillId: journal.localSkillId,
          reference: journal.reference,
          origin: previousMarker.origin ?? current.origin ?? {
            skillId: journal.reference.skillId,
            version: journal.reference.version,
          },
        });
      };
      if (identityChanged) {
        // A rename or move after the interruption wins over the pending finalize.
        writeTextFileAtomically(markerFile, journal.previousMarker);
      } else if (current.contentHash === journal.nextContentHash && cloudHasReference) {
        writePublicMarker();
      } else if (current.contentHash === journal.previousContentHash) {
        if (cloudHasReference) {
          writeTextFileAtomically(path.join(current.path, 'SKILL.md'), journal.nextSkill);
          const rolledForward = this.readLocalManifest().find(entry => (
            entry.localSkillId === journal.localSkillId && entry.name === journal.skillName
          ));
          if (!rolledForward || rolledForward.contentHash !== journal.nextContentHash) {
            writeTextFileAtomically(path.join(current.path, 'SKILL.md'), journal.previousSkill);
            writeTextFileAtomically(markerFile, journal.previousMarker);
            this.removeFinalizeJournal(journal.localSkillId);
            throw new Error('Interrupted public Skill finalization could not be rolled forward safely.');
          }
          writePublicMarker();
        } else {
          writeTextFileAtomically(markerFile, journal.previousMarker);
        }
      } else if (current.contentHash === journal.nextContentHash) {
        writeTextFileAtomically(path.join(current.path, 'SKILL.md'), journal.previousSkill);
        writeTextFileAtomically(markerFile, journal.previousMarker);
        const rolledBack = this.readLocalManifest().find(entry => (
          entry.localSkillId === journal.localSkillId && entry.name === journal.skillName
        ));
        if (!rolledBack || rolledBack.contentHash !== journal.previousContentHash) {
          throw new Error('Interrupted public Skill finalization could not be rolled back safely.');
        }
      } else {
        // A user edit after the interruption wins. Restore only the internal marker
        // so the edited workspace is uploaded as a new private snapshot normally.
        writeTextFileAtomically(markerFile, journal.previousMarker);
      }
      this.removeFinalizeJournal(journal.localSkillId);
    }
  }

  private writeFinalizeJournal(journal: BotSkillFinalizeJournal): void {
    const filePath = finalizeJournalPath(this.runtimeRoot, this.botId, journal.localSkillId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextFileAtomically(filePath, `${JSON.stringify(journal, null, 2)}\n`);
  }

  private removeFinalizeJournal(localSkillId: string): void {
    const filePath = finalizeJournalPath(this.runtimeRoot, this.botId, localSkillId);
    fs.rmSync(filePath, { force: true });
    const directory = path.dirname(filePath);
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
      }
    } catch {
      // An empty journal directory is harmless, and another finalization may use it.
    }
  }

  private featureUnavailable(options: {
    observedRevision?: number;
    desiredRevision?: number;
    appliedRevision?: number;
    errorCode?: string;
  } = {}): BotSkillSyncResult {
    return {
      botId: this.botId,
      direction: 'feature_unavailable',
      applyStatus: 'deferred',
      ...(options.observedRevision !== undefined
        ? { cloudRevision: options.observedRevision }
        : {}),
      ...options,
      skills: this.definitionService.read(this.botId)?.skills ?? [],
    };
  }

  private readLocalManifest(
    options: ScanBotSkillWorkspaceOptions = {},
  ): LocalBotSkillManifestEntry[] {
    if (!fs.existsSync(this.skillsRoot)) {
      if (this.workspaceExisted) {
        throw new Error('The active Bot Skill workspace disappeared unexpectedly.');
      }
      return [];
    }
    return scanBotSkillWorkspace(this.skillsRoot, options);
  }

  private readLocalManifestForPublicFinalize(
    selectedLocalSkillId: string,
  ): PublicFinalizeLocalManifest {
    const rejected: BotSkillWorkspaceValidationFailure[] = [];
    const entries = this.readLocalManifest({
      onValidationFailure: failure => rejected.push(failure),
    });
    const selectedFailure = rejected.find(entry => entry.localSkillId === selectedLocalSkillId);
    if (selectedFailure) throw selectedFailure.error;
    return {
      entries,
      rejectedLocalSkillIds: new Set(rejected.map(entry => entry.localSkillId)),
    };
  }

  private async pushLocal(
    local: LocalBotSkillManifestEntry[],
    initialCloud: CloudBotSkills,
    base: BotSkillSyncBase | undefined,
    options: {
      preserveBaseLocalSkillIds?: ReadonlySet<string>;
      requiredCloudReference?: BotSkillRef;
      validateScope?: () => Promise<void> | void;
    } = {},
  ): Promise<BotSkillSyncResult> {
    if (
      options.requiredCloudReference
      && !initialCloud.skills.some(item => botSkillRefEqual(item, options.requiredCloudReference!))
    ) {
      throw new Error('The public Skill reference is no longer present in BotDefinition.');
    }
    const previousByLocalID = new Map(base?.skills.map(entry => [entry.localSkillId, entry]) ?? []);
    const nextEntries: BotSkillSyncBaseEntry[] = (base?.skills ?? []).filter(entry => (
      options.preserveBaseLocalSkillIds?.has(entry.localSkillId)
      && initialCloud.skills.some(reference => botSkillRefEqual(reference, entry.reference))
    ));
    const pendingMarkers: Array<{
      path: string;
      marker: Parameters<typeof writeBotSkillLocalMarker>[1];
    }> = [];
    for (const entry of local) {
      const previous = previousByLocalID.get(entry.localSkillId);
      let reference: BotSkillRef | undefined;
      const markerChanged = Boolean(
        entry.reference
        && (!previous || !botSkillRefEqual(entry.reference, previous.reference)),
      );
      if (entry.reference && markerChanged) {
        try {
          const existing = await this.privateClient.download(entry.reference);
          if (existing.contentHash === entry.contentHash) reference = entry.reference;
        } catch (error: any) {
          if (![400, 404].includes(Number(error?.status))) throw error;
          if (!isPrivateSkillReference(entry.reference.skillId)) throw error;
        }
      }
      if (!reference && previous?.contentHash === entry.contentHash) {
        reference = previous.reference;
      } else if (!reference && entry.reference && !markerChanged) {
        reference = entry.reference;
      }
      if (!reference && entry.origin && !isPrivateSkillReference(entry.origin.skillId)) {
        const publicReference: BotSkillRef = {
          source: 'skillhub',
          skillId: entry.origin.skillId,
          version: entry.origin.version,
          contentHash: entry.contentHash,
        };
        try {
          const installed = await this.privateClient.download(publicReference);
          if (installed.source === 'public') reference = publicReference;
        } catch (error: any) {
          const isExpectedPublicMismatch = (
            [400, 404].includes(Number(error?.status))
            || error?.message === 'SkillHub package does not match the BotDefinition contentHash.'
          );
          if (!isExpectedPublicMismatch) throw error;
        }
      }
      if (!reference) {
        await options.validateScope?.();
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
      pendingMarkers.push({
        path: entry.path,
        marker: {
          schema: 'xiaoba.bot-skill-local.v1',
          localSkillId: entry.localSkillId,
          reference,
          origin: marker?.origin ?? entry.origin ?? {
            skillId: reference.skillId,
            version: reference.version,
          },
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
    nextEntries.sort((left, right) => (
      left.localSkillId < right.localSkillId ? -1 : left.localSkillId > right.localSkillId ? 1 : 0
    ));
    await options.validateScope?.();
    const refs = canonicalizeBotSkillRefs(nextEntries.map(entry => entry.reference));
    if (
      base
      && !botSkillRefsEqual(initialCloud.skills, base.skills.map(entry => entry.reference))
    ) {
      await options.validateScope?.();
      this.writeConflictSnapshot(initialCloud, refs);
    }
    let cloud = initialCloud;
    try {
      await options.validateScope?.();
      cloud = await replaceCloudBotSkills(this.cloudOptions, cloud, refs);
    } catch (error) {
      if (!(error instanceof BotSkillsCloudConflictError)) throw error;
      const latest = await pullCloudBotSkills(this.cloudOptions);
      if (!latest) throw error;
      if (
        options.requiredCloudReference
        && !latest.skills.some(item => botSkillRefEqual(item, options.requiredCloudReference!))
      ) {
        throw new Error('The public Skill reference was removed from BotDefinition during finalization.');
      }
      if (!base || !botSkillRefsEqual(latest.skills, base.skills.map(entry => entry.reference))) {
        await options.validateScope?.();
        this.writeConflictSnapshot(latest, refs);
      }
      // The current single-device contract explicitly protects local changes.
      await options.validateScope?.();
      cloud = await replaceCloudBotSkills(this.cloudOptions, latest, refs);
    }
    await options.validateScope?.();
    for (const item of pendingMarkers) {
      writeBotSkillLocalMarker(item.path, item.marker);
    }
    this.acceptCloudDefinition(cloud);
    this.writeBase(cloud, nextEntries);
    return {
      botId: this.botId,
      direction: 'local_to_cloud',
      cloudRevision: cloud.revision,
      observedRevision: cloud.revision,
      desiredRevision: cloud.revision,
      appliedRevision: cloud.revision,
      applyStatus: 'applied',
      skills: cloud.skills,
    };
  }

  private async waitForPublicPackage(
    reference: BotSkillRef,
    options: FinalizePublicBotSkillOptions,
  ): Promise<BotSkillPackage> {
    const publicationWaitMs = Math.max(0, Math.min(
      Number(options.publicationWaitMs ?? 45_000),
      120_000,
    ));
    const pollDelayMs = Math.max(25, Math.min(Number(options.pollDelayMs ?? 500), 5_000));
    const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    const deadline = Date.now() + publicationWaitMs;
    let lastError: unknown;
    let firstAttempt = true;
    while (true) {
      await options.validateScope?.();
      const remainingMs = deadline - Date.now();
      if (!firstAttempt && remainingMs <= 0) break;
      firstAttempt = false;
      try {
        const packageValue = await this.privateClient.download(reference, {
          timeoutMs: Math.max(1, Math.min(10_000, remainingMs > 0 ? remainingMs : 1)),
        });
        if (
          packageValue.source !== 'public'
          || packageValue.contentHash !== reference.contentHash
        ) {
          throw new Error('SkillHub returned a package that does not match the public reference.');
        }
        return packageValue;
      } catch (error: any) {
        lastError = error;
        if (Number(error?.status) !== 404) throw error;
        if (Date.now() >= deadline) break;
      }
      await sleep(Math.min(pollDelayMs, Math.max(0, deadline - Date.now())));
    }
    const error = new Error('The public Skill package is not ready yet. Please retry finalization.');
    (error as Error & { code?: string; status?: number; cause?: unknown }).code = 'PUBLIC_SKILL_NOT_READY';
    (error as Error & { code?: string; status?: number; cause?: unknown }).status = 409;
    (error as Error & { code?: string; status?: number; cause?: unknown }).cause = lastError;
    throw error;
  }

  private async restoreCloud(
    cloud: CloudBotSkills,
    options: {
      preserveUnmanaged?: boolean;
      validateScope?: () => Promise<void> | void;
      pendingSnapshot?: {
        reason: 'activation_local_changed'
          | 'activation_without_base'
          | 'activation_cloud_reconcile';
        baseRevision?: number;
      };
    } = {},
  ): Promise<BotSkillSyncResult> {
    try {
      return await this.restoreCloudUnchecked(cloud, options);
    } catch (error) {
      if (error instanceof BotSkillCloudRestoreError) throw error;
      throw new BotSkillCloudRestoreError(
        `Bot Skill cloud workspace restore failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async restoreCloudUnchecked(
    cloud: CloudBotSkills,
    options: {
      preserveUnmanaged?: boolean;
      validateScope?: () => Promise<void> | void;
      pendingSnapshot?: {
        reason: 'activation_local_changed'
          | 'activation_without_base'
          | 'activation_cloud_reconcile';
        baseRevision?: number;
      };
    },
  ): Promise<BotSkillSyncResult> {
    const parent = path.dirname(this.skillsRoot);
    const operationID = `${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const stage = path.join(parent, `.bot-skills-stage-${operationID}`);
    const backup = path.join(parent, `.bot-skills-backup-${operationID}`);
    const packages: BotSkillPackage[] = [];
    const previousManagedRoots = fs.existsSync(this.skillsRoot) && options.preserveUnmanaged !== false
      ? scanBotSkillWorkspace(this.skillsRoot).map(entry => path.resolve(entry.path))
      : [];
    const previousDefinition = this.definitionService.read(this.botId);
    let entries: BotSkillSyncBaseEntry[] = [];
    let localPendingEvidence: BotSkillSyncResult['localPendingEvidence'];
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
        await options.validateScope?.();
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
      if (fs.existsSync(this.skillsRoot) && options.preserveUnmanaged !== false) {
        copyUnmanagedWorkspaceContent(
          this.skillsRoot,
          stage,
          previousManagedRoots,
          stagedLocal.map(entry => path.resolve(entry.path)),
        );
        entries = verifiedRestoredEntries(stage, packages, cloud.skills);
      }

      if (fs.existsSync(this.skillsRoot)) {
        await options.validateScope?.();
        this.writeRestoreJournal({ stage, backup, phase: 'backup_pending' });
        renameBotSkillWorkspaceSync(this.skillsRoot, backup);
        backedUp = true;
        if (options.pendingSnapshot && hasWorkspaceEntries(backup)) {
          const snapshot = snapshotPendingBotSkillWorkspace({
            runtimeRoot: this.runtimeRoot,
            botId: this.botId,
            sourcePath: backup,
            recordedSourcePath: this.skillsRoot,
            ...options.pendingSnapshot,
            cloudRevision: cloud.revision,
          });
          localPendingEvidence = {
            path: snapshot.path,
            fingerprint: snapshot.fingerprint,
            fileCount: snapshot.fileCount,
          };
        }
      }
      this.writeRestoreJournal({ stage, backup, phase: 'backed_up' });
      this.writeRestoreJournal({ stage, backup, phase: 'activation_pending' });
      renameBotSkillWorkspaceSync(stage, this.skillsRoot);
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
        renameBotSkillWorkspaceSync(backup, this.skillsRoot);
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
      observedRevision: cloud.revision,
      desiredRevision: cloud.revision,
      appliedRevision: cloud.revision,
      applyStatus: 'applied',
      skills: cloud.skills,
      ...(localPendingEvidence ? { localPendingEvidence } : {}),
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
    if (cloud.definition.model.kind === 'local') {
      throw new Error('CatsCo cloud local handoff requires an existing runnable local BotDefinition.');
    }
    this.definitionService.acceptCanonical(cloud.definition as BotDefinition);
  }
}

function publishedSkillMarkdown(
  local: LocalBotSkillManifestEntry,
  packageValue: BotSkillPackage,
): string {
  const publishedSkillFile = packageValue.files.find(file => file.path === 'SKILL.md');
  const localSkillFile = local.files.find(file => file.path === 'SKILL.md');
  if (!publishedSkillFile || !localSkillFile) {
    throw new Error('The public or local Skill package is missing SKILL.md.');
  }
  const publishedMarkdown = Buffer.from(publishedSkillFile.contentBase64, 'base64').toString('utf8');
  const metadata = matter(publishedMarkdown).data;
  const author = String(metadata?.skillhub_author || '').trim();
  const version = String(metadata?.skillhub_version || '').trim();
  const uploadedAt = String(metadata?.skillhub_uploaded_at || '').trim();
  if (!author || !version || !uploadedAt) {
    throw new Error('The public Skill package is missing SkillHub publication metadata.');
  }

  const localMarkdown = Buffer.from(localSkillFile.contentBase64, 'base64').toString('utf8');
  const nextMarkdown = applySkillHubLocalMetadata(localMarkdown, {
    author,
    version,
    uploadedAt,
  });
  const nextBytes = Buffer.from(nextMarkdown.replace(/\r\n/g, '\n'), 'utf8');
  const candidateFiles: BotSkillPackageFile[] = local.files.map(file => {
    if (file.path !== 'SKILL.md') return file;
    return {
      path: file.path,
      size: nextBytes.length,
      sha256: crypto.createHash('sha256').update(nextBytes).digest('hex'),
      contentBase64: nextBytes.toString('base64'),
    };
  });
  const expected = [...packageValue.files].sort(comparePackageFiles);
  const candidate = [...candidateFiles].sort(comparePackageFiles);
  if (
    candidate.length !== expected.length
    || candidate.some((file, index) => (
      file.path !== expected[index]?.path
      || file.size !== expected[index]?.size
      || file.sha256 !== expected[index]?.sha256
    ))
    || computeBotSkillPackageHash(candidate) !== packageValue.contentHash
  ) {
    throw new Error('The selected local Skill changed after it was shared.');
  }
  return nextBytes.toString('utf8');
}

function botSkillRefEqual(left: BotSkillRef, right: BotSkillRef): boolean {
  return left.source === right.source
    && left.skillId === right.skillId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function isPrivateSkillReference(skillId: string): boolean {
  const value = String(skillId || '');
  return value.startsWith('priv_') || value.startsWith('private/');
}

function hasWorkspaceEntries(workspaceRoot: string): boolean {
  try {
    return fs.readdirSync(workspaceRoot).length > 0;
  } catch {
    // If the workspace cannot be inspected, keep the conservative
    // data-preserving behavior and treat it as containing evidence.
    return true;
  }
}

function comparePackageFiles(left: BotSkillPackageFile, right: BotSkillPackageFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
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

function finalizeJournalDirectory(runtimeRoot: string, botId: string): string {
  return path.join(
    path.resolve(runtimeRoot),
    'data',
    'bot-skills',
    'finalize-journal',
    String(botId).trim(),
  );
}

function finalizeJournalPath(runtimeRoot: string, botId: string, localSkillId: string): string {
  return path.join(
    finalizeJournalDirectory(runtimeRoot, botId),
    `${String(localSkillId).trim()}.json`,
  );
}

function readFinalizeJournal(
  filePath: string,
  runtimeRoot: string,
  botId: string,
  skillsRoot: string,
): BotSkillFinalizeJournal {
  let value: BotSkillFinalizeJournal;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BotSkillFinalizeJournal;
  } catch {
    throw new Error('Bot Skill finalize journal cannot be read safely');
  }
  const expectedRoot = path.resolve(skillsRoot);
  const skillPath = path.resolve(String(value.skillPath || ''));
  const relativeSkillPath = path.relative(expectedRoot, skillPath);
  let previousMarker: any;
  try {
    previousMarker = JSON.parse(String(value.previousMarker || ''));
  } catch {
    throw new Error('Bot Skill finalize journal contains an invalid previous marker');
  }
  if (
    value.schema !== 'xiaoba.bot-skill-finalize-journal.v1'
    || value.botId !== String(botId).trim()
    || path.resolve(value.skillsRoot || '') !== expectedRoot
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(String(value.localSkillId || ''))
    || String(value.skillName || '').trim().length === 0
    || String(value.skillName || '').length > 256
    || relativeSkillPath === ''
    || relativeSkillPath.startsWith(`..${path.sep}`)
    || relativeSkillPath === '..'
    || path.isAbsolute(relativeSkillPath)
    || !/^[a-f0-9]{64}$/.test(String(value.previousContentHash || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.nextContentHash || ''))
    || !validFinalizeReference(value.reference)
    || typeof value.previousSkill !== 'string'
    || value.previousSkill.length > 2 * 1024 * 1024
    || typeof value.nextSkill !== 'string'
    || value.nextSkill.length > 2 * 1024 * 1024
    || typeof value.previousMarker !== 'string'
    || value.previousMarker.length > 64 * 1024
    || previousMarker?.schema !== 'xiaoba.bot-skill-local.v1'
    || previousMarker?.localSkillId !== value.localSkillId
    || path.resolve(filePath) !== finalizeJournalPath(runtimeRoot, botId, value.localSkillId)
  ) {
    throw new Error('Bot Skill finalize journal is invalid');
  }
  return {
    ...value,
    skillsRoot: expectedRoot,
    skillPath,
  };
}

function validFinalizeReference(reference: BotSkillRef | undefined): reference is BotSkillRef {
  return Boolean(
    reference
    && reference.source === 'skillhub'
    && String(reference.skillId || '').length > 0
    && String(reference.skillId || '').length <= 256
    && !isPrivateSkillReference(reference.skillId)
    && String(reference.version || '').length > 0
    && String(reference.version || '').length <= 128
    && /^[a-f0-9]{64}$/.test(String(reference.contentHash || '')),
  );
}

function writeTextFileAtomically(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
