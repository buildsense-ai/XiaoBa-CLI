import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SkillParser } from '../skills/skill-parser';
import { computeLocalSkillContentHash } from '../skillhub/local-skill-metadata';
import { readSkillHubInstallMarker } from '../skillhub/install-marker';
import { PathResolver } from '../utils/path-resolver';
import {
  BOT_LOCAL_SKILL_SCHEMA,
  BOT_SKILL_WORKSPACE_SCHEMA,
  type BotLocalSkillIdentity,
  type BotLocalSkillSnapshot,
  type BotSkillWorkspaceIdentity,
  type BotSkillWorkspaceInspection,
} from './types';

export const BOT_SKILL_WORKSPACE_IDENTITY_FILE = '.xiaoba-workspace.json';
export const BOT_LOCAL_SKILL_IDENTITY_FILE = '.xiaoba-local-skill.json';

export interface BotSkillWorkspaceOwner {
  botId: string;
  authority?: string;
  ownerUserId?: string;
}

export interface BotSkillWorkspaceServiceOptions {
  runtimeRoot?: string;
  skillsRoot?: string;
  now?: () => Date;
  createId?: () => string;
}

export class BotSkillWorkspaceService {
  readonly root: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: BotSkillWorkspaceServiceOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.root = path.resolve(options.skillsRoot ?? path.join(runtimeRoot, 'skills'));
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  inspect(expectedOwner?: BotSkillWorkspaceOwner): BotSkillWorkspaceInspection {
    if (!fs.existsSync(this.root)) return { kind: 'missing', root: this.root };
    try {
      const rootStat = fs.lstatSync(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { kind: 'unreadable', root: this.root, error: 'Skill workspace root is not a real directory.' };
      }
      fs.accessSync(this.root, fs.constants.R_OK);
      const skillFiles = PathResolver.findSkillFiles(this.root);
      const identityPath = path.join(this.root, BOT_SKILL_WORKSPACE_IDENTITY_FILE);
      if (!fs.existsSync(identityPath)) {
        return { kind: 'unowned', root: this.root, skillCount: skillFiles.length };
      }
      const identity = readWorkspaceIdentity(identityPath);
      if (expectedOwner && !workspaceOwnerMatches(identity, expectedOwner)) {
        return { kind: 'owner_mismatch', root: this.root, identity };
      }
      const skills = this.scanSkillFiles(skillFiles, true);
      return { kind: 'valid', root: this.root, identity, skills };
    } catch (error: any) {
      return {
        kind: 'unreadable',
        root: this.root,
        error: error?.message || String(error),
      };
    }
  }

  initializeEmpty(owner: BotSkillWorkspaceOwner): BotSkillWorkspaceIdentity {
    validateOwner(owner);
    if (fs.existsSync(this.root)) {
      const entries = fs.readdirSync(this.root);
      if (entries.length > 0) {
        throw new Error('Cannot initialize a non-empty Skill workspace.');
      }
    } else {
      fs.mkdirSync(this.root, { recursive: true });
    }
    const identity = this.newWorkspaceIdentity(owner);
    writeJsonAtomic(path.join(this.root, BOT_SKILL_WORKSPACE_IDENTITY_FILE), identity);
    return identity;
  }

  /**
   * Explicit one-time migration for a legacy workspace. Per-Skill identities
   * are committed first and the workspace owner marker last, so a crash cannot
   * leave a partially identified directory looking fully owned.
   */
  claimExisting(owner: BotSkillWorkspaceOwner): BotSkillWorkspaceIdentity {
    validateOwner(owner);
    if (!fs.existsSync(this.root)) throw new Error('Cannot claim a missing Skill workspace.');
    const rootStat = fs.lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Cannot claim a Skill workspace that is not a real directory.');
    }
    const identityPath = path.join(this.root, BOT_SKILL_WORKSPACE_IDENTITY_FILE);
    if (fs.existsSync(identityPath)) {
      const existing = readWorkspaceIdentity(identityPath);
      if (!workspaceOwnerMatches(existing, owner)) {
        throw new Error('Skill workspace is already owned by another Bot or authority.');
      }
      return existing;
    }
    this.scanSkillFiles(PathResolver.findSkillFiles(this.root), true);
    const identity = this.newWorkspaceIdentity(owner);
    writeJsonAtomic(identityPath, identity);
    return identity;
  }

  private scanSkillFiles(skillFiles: string[], assignMissingIds: boolean): BotLocalSkillSnapshot[] {
    const snapshots: BotLocalSkillSnapshot[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const skillFilePath of skillFiles.sort((a, b) => a.localeCompare(b))) {
      const directoryPath = path.dirname(skillFilePath);
      const localIdentity = this.readOrCreateLocalSkillIdentity(directoryPath, assignMissingIds);
      if (seenIds.has(localIdentity.localSkillId)) {
        throw new Error(`Duplicate localSkillId detected in Skill workspace: ${localIdentity.localSkillId}`);
      }
      const skill = SkillParser.parse(skillFilePath);
      const name = String(skill.metadata.name || '').trim();
      const portableName = name.toLocaleLowerCase('en-US');
      if (seenNames.has(portableName)) {
        throw new Error(`Duplicate Skill name detected in Skill workspace: ${name}`);
      }
      seenIds.add(localIdentity.localSkillId);
      seenNames.add(portableName);
      const installMarker = readSkillHubInstallMarker(directoryPath);
      snapshots.push({
        localSkillId: localIdentity.localSkillId,
        name,
        directoryName: path.basename(directoryPath),
        directoryPath,
        skillFilePath,
        contentHash: computeLocalSkillContentHash(directoryPath),
        ...(installMarker ? {
          cloudOrigin: {
            skillId: installMarker.skillId,
            version: installMarker.version,
          },
        } : {}),
      });
    }
    return snapshots.sort((a, b) => a.localSkillId.localeCompare(b.localSkillId));
  }

  private readOrCreateLocalSkillIdentity(
    directoryPath: string,
    assignMissing: boolean,
  ): BotLocalSkillIdentity {
    const markerPath = path.join(directoryPath, BOT_LOCAL_SKILL_IDENTITY_FILE);
    if (fs.existsSync(markerPath)) return readLocalSkillIdentity(markerPath);
    if (!assignMissing) throw new Error(`Skill identity is missing: ${directoryPath}`);
    const identity: BotLocalSkillIdentity = {
      schema: BOT_LOCAL_SKILL_SCHEMA,
      localSkillId: this.createId(),
      createdAt: this.now().toISOString(),
    };
    writeJsonAtomic(markerPath, identity);
    return identity;
  }

  private newWorkspaceIdentity(owner: BotSkillWorkspaceOwner): BotSkillWorkspaceIdentity {
    return {
      schema: BOT_SKILL_WORKSPACE_SCHEMA,
      workspaceId: this.createId(),
      workspaceOwnerBotId: String(owner.botId).trim(),
      ...(String(owner.authority || '').trim() ? { authority: String(owner.authority).trim() } : {}),
      ...(String(owner.ownerUserId || '').trim() ? { ownerUserId: String(owner.ownerUserId).trim() } : {}),
      createdAt: this.now().toISOString(),
    };
  }
}

function readWorkspaceIdentity(filePath: string): BotSkillWorkspaceIdentity {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BotSkillWorkspaceIdentity;
  if (
    value?.schema !== BOT_SKILL_WORKSPACE_SCHEMA
    || !validId(value.workspaceId)
    || !String(value.workspaceOwnerBotId || '').trim()
    || !validTimestamp(value.createdAt)
  ) {
    throw new Error('Skill workspace identity is invalid.');
  }
  return value;
}

function readLocalSkillIdentity(filePath: string): BotLocalSkillIdentity {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BotLocalSkillIdentity;
  if (
    value?.schema !== BOT_LOCAL_SKILL_SCHEMA
    || !validId(value.localSkillId)
    || !validTimestamp(value.createdAt)
  ) {
    throw new Error(`Local Skill identity is invalid: ${filePath}`);
  }
  return value;
}

function validateOwner(owner: BotSkillWorkspaceOwner): void {
  if (!String(owner.botId || '').trim()) throw new Error('workspace owner botId is required');
}

function workspaceOwnerMatches(
  identity: BotSkillWorkspaceIdentity,
  expected: BotSkillWorkspaceOwner,
): boolean {
  return (
    identity.workspaceOwnerBotId === String(expected.botId).trim()
    && String(identity.authority || '') === String(expected.authority || '').trim()
    && (!expected.ownerUserId || identity.ownerUserId === String(expected.ownerUserId).trim())
  );
}

function validId(value: unknown): boolean {
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(String(value || ''));
}

function validTimestamp(value: unknown): boolean {
  return Number.isFinite(Date.parse(String(value || '')));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Some mounted filesystems do not expose POSIX modes.
    }
  }
}
