import * as fs from 'fs';
import * as path from 'path';
import { canonicalizeBotSkillRefs } from './canonical';
import { isPortablePackagePath } from './local-manifest';
import type { BotSkillSyncBase } from './types';

const BASE_SCHEMA = 'xiaoba.bot-skill-sync-base.v2';
const LEGACY_BASE_SCHEMA = 'xiaoba.bot-skill-sync-base.v1';

export class BotSkillBaseStore {
  private readonly root: string;

  constructor(runtimeRoot: string) {
    this.root = path.join(path.resolve(runtimeRoot), 'data', 'bot-skills', 'sync-base');
  }

  /**
   * Read a Base, tolerating files the current build cannot interpret.
   *
   * A Base written by an older build can be structurally unusable here: v1
   * snapshots stored non-SkillHub references for local Skills, and the current
   * `canonicalizeBotSkillRefs` only accepts SkillHub references. Throwing on
   * those entries fails the whole BotDefinition closed (model switches
   * included) until an operator deletes the file.
   *
   * Treating "cannot describe this workspace" as "no Base" is safe because the
   * activation path never deletes what a Base did not claim: without a Base
   * nothing is replaceable, so sync only adds Cloud Skills while every local
   * Skill on disk stays untouched.
   *
   * Identity is different from format: a Base written for another Bot must
   * still fail loudly rather than be silently ignored.
   */
  read(botId: string): BotSkillSyncBase | undefined {
    const normalizedBotId = normalizeBotId(botId);
    const filePath = this.pathFor(normalizedBotId);
    if (!fs.existsSync(filePath)) return undefined;
    let raw: RecordedBase;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RecordedBase;
    } catch (error) {
      return discardBase(normalizedBotId, `unreadable JSON (${describeError(error)})`);
    }
    const recordedBotId = String(raw?.botId ?? '').trim();
    if (recordedBotId && recordedBotId !== normalizedBotId) {
      throw new Error('Bot Skill sync Base belongs to a different Bot');
    }
    const value: BotSkillSyncBase = raw.schema === LEGACY_BASE_SCHEMA
      ? {
          schema: BASE_SCHEMA,
          botId: raw.botId as string,
          definitionRevision: Number(raw.cloudRevision),
          skills: raw.skills as BotSkillSyncBase['skills'],
          updatedAt: raw.updatedAt as string,
        }
      : raw as BotSkillSyncBase;
    const invalid = describeInvalidBase(value, normalizedBotId);
    if (invalid) return discardBase(normalizedBotId, invalid);
    return {
      ...value,
      skills: [...value.skills].sort((left, right) => (
        left.localSkillId < right.localSkillId ? -1 : left.localSkillId > right.localSkillId ? 1 : 0
      )),
      ...(value.unavailableSkills?.length
        ? { unavailableSkills: canonicalizeBotSkillRefs(value.unavailableSkills) }
        : {}),
    };
  }

  write(base: BotSkillSyncBase): void {
    if (
      base.schema !== BASE_SCHEMA
      || base.botId !== normalizeBotId(base.botId)
      || !Number.isInteger(base.definitionRevision)
      || base.definitionRevision < 0
      || !Array.isArray(base.skills)
      || !String(base.updatedAt || '').trim()
      || !validBaseEntries(base.skills)
      || !validUnavailableSkills(base.unavailableSkills)
    ) {
      throw new Error('Bot Skill sync base is invalid');
    }
    const filePath = this.pathFor(base.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const value: BotSkillSyncBase = {
      ...base,
      skills: [...base.skills].sort((left, right) => (
        left.localSkillId < right.localSkillId ? -1 : left.localSkillId > right.localSkillId ? 1 : 0
      )),
      ...(base.unavailableSkills?.length
        ? { unavailableSkills: canonicalizeBotSkillRefs(base.unavailableSkills) }
        : {}),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  }

  private pathFor(botId: string): string {
    return path.join(this.root, `${normalizeBotId(botId)}.json`);
  }
}

function validBaseEntries(entries: BotSkillSyncBase['skills']): boolean {
  const ids = new Set<string>();
  return entries.every(entry => {
    const localSkillId = String(entry?.localSkillId || '').trim();
    if (
      !/^[A-Za-z0-9._:-]+$/.test(localSkillId)
      || ids.has(localSkillId)
      || !String(entry.name || '').trim()
      || !isPortablePackagePath(String(entry.installName || ''))
      || !/^[a-f0-9]{64}$/.test(String(entry.contentHash || ''))
    ) {
      return false;
    }
    try {
      canonicalizeBotSkillRefs([entry.reference]);
    } catch {
      return false;
    }
    ids.add(localSkillId);
    return true;
  });
}

function validUnavailableSkills(entries: BotSkillSyncBase['unavailableSkills']): boolean {
  if (entries === undefined) return true;
  try {
    canonicalizeBotSkillRefs(entries);
    return true;
  } catch {
    return false;
  }
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid Bot ID for Skill state');
  return value;
}

/** Shape read off disk before any validation or v1 migration. */
interface RecordedBase {
  schema?: string;
  botId?: string;
  cloudRevision?: number;
  definitionRevision?: number;
  skills?: BotSkillSyncBase['skills'];
  unavailableSkills?: BotSkillSyncBase['unavailableSkills'];
  updatedAt?: string;
}

/**
 * describeInvalidBase reports why a parsed Base cannot describe this workspace,
 * or undefined when it is usable. Identity mismatches are deliberately not
 * reported here: {@link BotSkillBaseStore.read} throws on them so a Base for
 * another Bot can never be diffed against this one.
 */
function describeInvalidBase(value: BotSkillSyncBase, normalizedBotId: string): string | undefined {
  if (value?.schema !== BASE_SCHEMA) return `unsupported schema ${String(value?.schema ?? '(none)')}`;
  if (String(value.botId ?? '').trim() !== normalizedBotId) return 'missing or mismatched botId';
  if (!Number.isInteger(value.definitionRevision) || value.definitionRevision < 0) {
    return 'invalid definitionRevision';
  }
  if (!Array.isArray(value.skills)) return 'skills is not an array';
  if (!String(value.updatedAt || '').trim()) return 'missing updatedAt';
  if (!validBaseEntries(value.skills)) return 'invalid skill entries';
  if (!validUnavailableSkills(value.unavailableSkills)) return 'invalid unavailableSkills';
  return undefined;
}

/**
 * discardBase degrades an unusable Base to "no Base" instead of failing the
 * whole activation closed. The file is kept: it is the only evidence of what
 * the older build wrote, and the next successful sync rewrites it atomically.
 */
function discardBase(botId: string, reason: string): undefined {
  console.warn(
    `[bot-skills] ignoring sync Base for bot ${botId}: ${reason}; `
    + 'keeping local Skills and rewriting the Base on the next successful sync',
  );
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
