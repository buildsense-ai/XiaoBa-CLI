import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BotSkillRef } from '../bot-definition/types';
import { botSkillRefsEqual, canonicalizeBotSkillRefs } from './canonical';
import { scanBotSkillWorkspace } from './local-manifest';
import { renameBotSkillWorkspaceSync } from './workspace-fs';

const APPLIED_MARKER_SCHEMA = 'xiaoba.bot-skill-applied.v1';
const ACTIVATION_JOURNAL_SCHEMA = 'xiaoba.bot-skill-activation-journal.v2';

export type BotSkillActivationPhase =
  | 'prepared'
  | 'backup_moved'
  | 'live_switched'
  | 'catalog_switched'
  | 'locally_applied'
  | 'acked';

export interface BotSkillActivationIdentity {
  definitionRevision: number;
  skillSetHash: string;
  mutationId?: string;
}

export interface BotSkillAppliedMarker extends BotSkillActivationIdentity {
  schema: typeof APPLIED_MARKER_SCHEMA;
  botId: string;
  skills: BotSkillRef[];
  appliedAt: string;
  runtimeBodyIdHash?: string;
}

export interface BotSkillActivationJournal extends BotSkillActivationIdentity {
  schema: typeof ACTIVATION_JOURNAL_SCHEMA;
  botId: string;
  skillsRoot: string;
  stage: string;
  backup: string;
  skills: BotSkillRef[];
  phase: BotSkillActivationPhase;
  startedAt: string;
  updatedAt: string;
  runtimeBodyIdHash?: string;
}

export interface BeginBotSkillActivationInput extends BotSkillActivationIdentity {
  botId: string;
  skillsRoot: string;
  stage: string;
  backup: string;
  skills: BotSkillRef[];
  runtimeBodyIdHash?: string;
  startedAt?: string;
}

export type BotSkillActivationRecovery =
  | { status: 'none' }
  | { status: 'discarded_prepared'; journal: BotSkillActivationJournal }
  | { status: 'restored_backup'; journal: BotSkillActivationJournal }
  | { status: 'resume_local_apply'; journal: BotSkillActivationJournal }
  | { status: 'retry_ack'; journal: BotSkillActivationJournal; marker: BotSkillAppliedMarker }
  | { status: 'acked'; journal: BotSkillActivationJournal; marker: BotSkillAppliedMarker };

export type BotSkillActivationAckInspection =
  | { status: 'none' }
  | { status: 'not_ready'; journal: BotSkillActivationJournal }
  | { status: 'retry_ack'; journal: BotSkillActivationJournal; marker: BotSkillAppliedMarker }
  | { status: 'acked'; journal: BotSkillActivationJournal; marker: BotSkillAppliedMarker };

/**
 * Computes a stable hash for the complete BotDefinition Skill reference set.
 * This intentionally hashes reference facts only; it is not a workspace-content
 * hash and never includes paths or Skill source text.
 */
export function computeCanonicalBotSkillSetHash(skills: readonly BotSkillRef[]): string {
  const canonical = canonicalizeBotSkillRefs(skills);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Durable primitives for the future Runtime activation saga. Nothing in the
 * production sync path constructs this store yet; E1 keeps the new behavior
 * unreachable until the dedicated activation ACK worker is implemented.
 */
export class BotSkillActivationStateStore {
  private readonly runtimeRoot: string;
  private readonly appliedRoot: string;
  private readonly journalRoot: string;

  constructor(runtimeRoot: string) {
    this.runtimeRoot = path.resolve(runtimeRoot);
    const stateRoot = path.join(this.runtimeRoot, 'data', 'bot-skills');
    this.appliedRoot = path.join(stateRoot, 'applied');
    this.journalRoot = path.join(stateRoot, 'activation-journal');
  }

  begin(input: BeginBotSkillActivationInput): BotSkillActivationJournal {
    const value = normalizeJournal({
      schema: ACTIVATION_JOURNAL_SCHEMA,
      ...input,
      phase: 'prepared',
      startedAt: input.startedAt ?? new Date().toISOString(),
      updatedAt: input.startedAt ?? new Date().toISOString(),
    }, input.botId, input.skillsRoot);
    const existing = this.readJournal(input.botId, input.skillsRoot);
    if (existing) {
      if (sameActivation(existing, value)) return existing;
      throw new Error('A different Bot Skill activation is already in progress');
    }
    this.writeJournal(value);
    return value;
  }

  readApplied(botId: string): BotSkillAppliedMarker | undefined {
    const normalizedBotId = normalizeBotId(botId);
    const filePath = path.join(this.appliedRoot, `${normalizedBotId}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    return readJsonState(
      filePath,
      value => normalizeAppliedMarker(value, normalizedBotId),
      'Bot Skill applied marker cannot be read safely',
    );
  }

  readJournal(botId: string, skillsRoot: string): BotSkillActivationJournal | undefined {
    const normalizedBotId = normalizeBotId(botId);
    const filePath = path.join(this.journalRoot, `${normalizedBotId}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    return readJsonState(
      filePath,
      value => normalizeJournal(value, normalizedBotId, skillsRoot),
      'Bot Skill activation journal cannot be read safely',
    );
  }

  advance(
    botId: string,
    skillsRoot: string,
    identity: BotSkillActivationIdentity,
    nextPhase: BotSkillActivationPhase,
  ): BotSkillActivationJournal {
    const journal = this.requireJournal(botId, skillsRoot, identity);
    if (journal.phase === nextPhase) return journal;
    if (!LEGAL_TRANSITIONS[journal.phase].includes(nextPhase)) {
      throw new Error(`Invalid Bot Skill activation transition: ${journal.phase} -> ${nextPhase}`);
    }
    const next = normalizeJournal({
      ...journal,
      phase: nextPhase,
      updatedAt: new Date().toISOString(),
    }, botId, skillsRoot);
    this.writeJournal(next);
    return next;
  }

  recordLocallyApplied(
    botId: string,
    skillsRoot: string,
    identity: BotSkillActivationIdentity,
    appliedAt = new Date().toISOString(),
  ): BotSkillAppliedMarker {
    let journal = this.requireJournal(botId, skillsRoot, identity);
    if (journal.phase !== 'catalog_switched' && journal.phase !== 'locally_applied') {
      throw new Error(`Cannot record applied Bot Skills during phase ${journal.phase}`);
    }
    const marker = normalizeAppliedMarker({
      schema: APPLIED_MARKER_SCHEMA,
      botId: journal.botId,
      definitionRevision: journal.definitionRevision,
      skillSetHash: journal.skillSetHash,
      skills: journal.skills,
      appliedAt,
      ...(journal.mutationId ? { mutationId: journal.mutationId } : {}),
      ...(journal.runtimeBodyIdHash ? { runtimeBodyIdHash: journal.runtimeBodyIdHash } : {}),
    }, journal.botId);
    const existing = this.readApplied(journal.botId);
    if (existing && !sameAppliedFact(existing, marker)) {
      throw new Error('Existing Bot Skill applied marker conflicts with this activation');
    }
    if (!existing) this.writeApplied(marker);
    if (journal.phase !== 'locally_applied') {
      journal = this.advance(journal.botId, journal.skillsRoot, identity, 'locally_applied');
    }
    return this.readApplied(journal.botId) ?? marker;
  }

  markAcked(
    botId: string,
    skillsRoot: string,
    identity: BotSkillActivationIdentity,
  ): BotSkillActivationJournal {
    const journal = this.requireJournal(botId, skillsRoot, identity);
    if (journal.phase === 'acked') return journal;
    if (journal.phase !== 'locally_applied') {
      throw new Error(`Cannot acknowledge Bot Skill activation during phase ${journal.phase}`);
    }
    const marker = this.readApplied(journal.botId);
    if (!marker || !appliedMatchesJournal(marker, journal)) {
      throw new Error('Bot Skill activation cannot be acknowledged without its applied marker');
    }
    // The backup and journal are deliberately retained. A later, separately
    // reviewed GC step may remove ACKed evidence after the retention window.
    return this.advance(journal.botId, journal.skillsRoot, identity, 'acked');
  }

  recover(botId: string, skillsRoot: string): BotSkillActivationRecovery {
    let journal = this.readJournal(botId, skillsRoot);
    if (!journal) return { status: 'none' };
    assertSafeWorkspacePathType(journal.skillsRoot, 'live');
    assertSafeWorkspacePathType(journal.stage, 'stage');
    assertSafeWorkspacePathType(journal.backup, 'backup');
    const liveExists = fs.existsSync(journal.skillsRoot);
    const stageExists = fs.existsSync(journal.stage);
    const backupExists = fs.existsSync(journal.backup);

    if (journal.phase === 'prepared') {
      if (liveExists && backupExists) {
        throw new Error('Prepared Bot Skill activation has ambiguous live and backup workspaces');
      }
      if (!liveExists && backupExists) {
        renameBotSkillWorkspaceSync(journal.backup, journal.skillsRoot);
        removeDirectoryIfPresent(journal.stage);
        this.removeJournal(journal.botId);
        return { status: 'restored_backup', journal };
      }
      removeDirectoryIfPresent(journal.stage);
      this.removeJournal(journal.botId);
      return { status: 'discarded_prepared', journal };
    }

    if (journal.phase === 'backup_moved') {
      if (!liveExists) {
        if (!backupExists) {
          throw new Error('Bot Skill activation lost both live and backup workspaces');
        }
        renameBotSkillWorkspaceSync(journal.backup, journal.skillsRoot);
        removeDirectoryIfPresent(journal.stage);
        this.removeJournal(journal.botId);
        return { status: 'restored_backup', journal };
      }
      if (stageExists) {
        throw new Error('Bot Skill activation has ambiguous live and staged workspaces');
      }
      assertLiveMatchesJournal(journal);
      journal = this.advance(journal.botId, journal.skillsRoot, journal, 'live_switched');
      return { status: 'resume_local_apply', journal };
    }

    assertLiveMatchesJournal(journal);
    if (journal.phase === 'live_switched' || journal.phase === 'catalog_switched') {
      const marker = this.readApplied(journal.botId);
      if (marker && appliedMatchesJournal(marker, journal)) {
        if (journal.phase === 'live_switched') {
          journal = this.advance(journal.botId, journal.skillsRoot, journal, 'catalog_switched');
        }
        journal = this.advance(journal.botId, journal.skillsRoot, journal, 'locally_applied');
        return { status: 'retry_ack', journal, marker };
      }
      return { status: 'resume_local_apply', journal };
    }

    const marker = this.readApplied(journal.botId);
    if (!marker || !appliedMatchesJournal(marker, journal)) {
      throw new Error('Bot Skill activation journal does not match its applied marker');
    }
    return journal.phase === 'acked'
      ? { status: 'acked', journal, marker }
      : { status: 'retry_ack', journal, marker };
  }

  /**
   * Read-only E3 boundary. Unlike recover(), this never removes a stage,
   * restores a backup, advances a phase, or writes any workspace state. It
   * only proves whether an already locally_applied activation may be ACKed.
   */
  inspectForAck(botId: string, skillsRoot: string): BotSkillActivationAckInspection {
    const journal = this.readJournal(botId, skillsRoot);
    if (!journal) return { status: 'none' };
    if (journal.phase !== 'locally_applied' && journal.phase !== 'acked') {
      return { status: 'not_ready', journal };
    }
    const marker = this.readApplied(journal.botId);
    if (!marker || !appliedMatchesJournal(marker, journal)) {
      throw new Error('Bot Skill activation journal does not match its applied marker');
    }
    if (journal.phase === 'acked') return { status: 'acked', journal, marker };
    assertSafeWorkspacePathType(journal.skillsRoot, 'live');
    assertSafeWorkspacePathType(journal.stage, 'stage');
    assertSafeWorkspacePathType(journal.backup, 'backup');
    assertLiveMatchesJournal(journal);
    return { status: 'retry_ack', journal, marker };
  }

  private requireJournal(
    botId: string,
    skillsRoot: string,
    identity: BotSkillActivationIdentity,
  ): BotSkillActivationJournal {
    const journal = this.readJournal(botId, skillsRoot);
    if (!journal) throw new Error('Bot Skill activation journal does not exist');
    if (!sameIdentity(journal, identity)) {
      throw new Error('Bot Skill activation journal identity does not match');
    }
    return journal;
  }

  private writeApplied(value: BotSkillAppliedMarker): void {
    atomicWriteJson(path.join(this.appliedRoot, `${value.botId}.json`), value);
  }

  private writeJournal(value: BotSkillActivationJournal): void {
    atomicWriteJson(path.join(this.journalRoot, `${value.botId}.json`), value);
  }

  private removeJournal(botId: string): void {
    fs.rmSync(path.join(this.journalRoot, `${normalizeBotId(botId)}.json`), { force: true });
  }
}

const LEGAL_TRANSITIONS: Record<BotSkillActivationPhase, BotSkillActivationPhase[]> = {
  prepared: ['backup_moved', 'live_switched'],
  backup_moved: ['live_switched'],
  live_switched: ['catalog_switched'],
  catalog_switched: ['locally_applied'],
  locally_applied: ['acked'],
  acked: [],
};

function normalizeAppliedMarker(value: unknown, expectedBotId: string): BotSkillAppliedMarker {
  const input = value as Partial<BotSkillAppliedMarker> | undefined;
  const botId = normalizeBotId(String(input?.botId || ''));
  const skills = canonicalizeBotSkillRefs(input?.skills as BotSkillRef[]);
  const marker: BotSkillAppliedMarker = {
    schema: input?.schema as typeof APPLIED_MARKER_SCHEMA,
    botId,
    definitionRevision: Number(input?.definitionRevision),
    skillSetHash: String(input?.skillSetHash || ''),
    skills,
    appliedAt: String(input?.appliedAt || ''),
    ...(input?.mutationId ? { mutationId: String(input.mutationId) } : {}),
    ...(input?.runtimeBodyIdHash ? { runtimeBodyIdHash: String(input.runtimeBodyIdHash) } : {}),
  };
  if (
    marker.schema !== APPLIED_MARKER_SCHEMA
    || marker.botId !== normalizeBotId(expectedBotId)
    || !validRevision(marker.definitionRevision)
    || !validHash(marker.skillSetHash)
    || computeCanonicalBotSkillSetHash(marker.skills) !== marker.skillSetHash
    || !validTimestamp(marker.appliedAt)
    || !validOptionalIdentity(marker.mutationId)
    || !validOptionalHash(marker.runtimeBodyIdHash)
  ) {
    throw new Error('Bot Skill applied marker is invalid');
  }
  return marker;
}

function normalizeJournal(
  value: unknown,
  expectedBotId: string,
  expectedSkillsRoot: string,
): BotSkillActivationJournal {
  const input = value as Partial<BotSkillActivationJournal> | undefined;
  const botId = normalizeBotId(String(input?.botId || ''));
  const skillsRoot = path.resolve(String(input?.skillsRoot || ''));
  const stage = path.resolve(String(input?.stage || ''));
  const backup = path.resolve(String(input?.backup || ''));
  const skills = canonicalizeBotSkillRefs(input?.skills as BotSkillRef[]);
  const journal: BotSkillActivationJournal = {
    schema: input?.schema as typeof ACTIVATION_JOURNAL_SCHEMA,
    botId,
    skillsRoot,
    stage,
    backup,
    definitionRevision: Number(input?.definitionRevision),
    skillSetHash: String(input?.skillSetHash || ''),
    skills,
    phase: input?.phase as BotSkillActivationPhase,
    startedAt: String(input?.startedAt || ''),
    updatedAt: String(input?.updatedAt || ''),
    ...(input?.mutationId ? { mutationId: String(input.mutationId) } : {}),
    ...(input?.runtimeBodyIdHash ? { runtimeBodyIdHash: String(input.runtimeBodyIdHash) } : {}),
  };
  if (
    journal.schema !== ACTIVATION_JOURNAL_SCHEMA
    || journal.botId !== normalizeBotId(expectedBotId)
    || journal.skillsRoot !== path.resolve(expectedSkillsRoot)
    || !validActivationWorkspacePaths(journal.skillsRoot, journal.stage, journal.backup)
    || !validRevision(journal.definitionRevision)
    || !validHash(journal.skillSetHash)
    || computeCanonicalBotSkillSetHash(journal.skills) !== journal.skillSetHash
    || !Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, journal.phase)
    || !validTimestamp(journal.startedAt)
    || !validTimestamp(journal.updatedAt)
    || !validOptionalIdentity(journal.mutationId)
    || !validOptionalHash(journal.runtimeBodyIdHash)
  ) {
    throw new Error('Bot Skill activation journal is invalid');
  }
  return journal;
}

function assertLiveMatchesJournal(journal: BotSkillActivationJournal): void {
  if (!fs.existsSync(journal.skillsRoot)) {
    throw new Error('Activated Bot Skill workspace is missing');
  }
  const references = scanBotSkillWorkspace(journal.skillsRoot)
    .flatMap(entry => entry.reference ? [entry.reference] : []);
  const actualHash = computeCanonicalBotSkillSetHash(references);
  if (actualHash !== journal.skillSetHash || !botSkillRefsEqual(references, journal.skills)) {
    throw new Error('Activated Bot Skill workspace does not match its journal');
  }
}

function sameActivation(left: BotSkillActivationJournal, right: BotSkillActivationJournal): boolean {
  return sameIdentity(left, right)
    && left.skillsRoot === right.skillsRoot
    && left.stage === right.stage
    && left.backup === right.backup
    && left.runtimeBodyIdHash === right.runtimeBodyIdHash
    && botSkillRefsEqual(left.skills, right.skills);
}

function sameIdentity(left: BotSkillActivationIdentity, right: BotSkillActivationIdentity): boolean {
  return left.definitionRevision === right.definitionRevision
    && left.skillSetHash === right.skillSetHash
    && left.mutationId === right.mutationId;
}

function sameAppliedFact(left: BotSkillAppliedMarker, right: BotSkillAppliedMarker): boolean {
  return sameIdentity(left, right)
    && left.botId === right.botId
    && left.runtimeBodyIdHash === right.runtimeBodyIdHash
    && botSkillRefsEqual(left.skills, right.skills);
}

function appliedMatchesJournal(
  marker: BotSkillAppliedMarker,
  journal: BotSkillActivationJournal,
): boolean {
  return marker.botId === journal.botId
    && sameIdentity(marker, journal)
    && marker.runtimeBodyIdHash === journal.runtimeBodyIdHash
    && botSkillRefsEqual(marker.skills, journal.skills);
}

function validActivationWorkspacePaths(skillsRoot: string, stage: string, backup: string): boolean {
  const parent = path.dirname(skillsRoot);
  return stage !== backup
    && stage !== skillsRoot
    && backup !== skillsRoot
    && path.dirname(stage) === parent
    && path.dirname(backup) === parent
    && path.basename(stage).startsWith('.bot-skills-stage-')
    && path.basename(backup).startsWith('.bot-skills-backup-');
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validOptionalHash(value: string | undefined): boolean {
  return value === undefined || validHash(value);
}

function validOptionalIdentity(value: string | undefined): boolean {
  return value === undefined || /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(value)) throw new Error('Invalid Bot ID for Skill activation state');
  return value;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readJsonState<T>(
  filePath: string,
  normalize: (value: unknown) => T,
  message: string,
): T {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'Bot Skill applied marker is invalid'
      || error.message === 'Bot Skill activation journal is invalid'
      || error.message === 'Invalid Bot ID for Skill activation state'
    )) {
      throw error;
    }
    throw new Error(message);
  }
}

function removeDirectoryIfPresent(directory: string): void {
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}

function assertSafeWorkspacePathType(target: string, label: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Bot Skill activation ${label} path is not a safe directory`);
  }
}
