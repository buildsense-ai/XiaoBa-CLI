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

  read(botId: string): BotSkillSyncBase | undefined {
    const filePath = this.pathFor(botId);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        schema?: string;
        botId: string;
        cloudRevision?: number;
        definitionRevision?: number;
        skills: BotSkillSyncBase['skills'];
        updatedAt: string;
      };
      const value: BotSkillSyncBase = raw.schema === LEGACY_BASE_SCHEMA
        ? {
            schema: BASE_SCHEMA,
            botId: raw.botId,
            definitionRevision: Number(raw.cloudRevision),
            skills: raw.skills,
            updatedAt: raw.updatedAt,
          }
        : raw as BotSkillSyncBase;
      if (
        value?.schema !== BASE_SCHEMA
        || value.botId !== normalizeBotId(botId)
        || !Number.isInteger(value.definitionRevision)
        || value.definitionRevision < 0
        || !Array.isArray(value.skills)
        || !String(value.updatedAt || '').trim()
        || !validBaseEntries(value.skills)
      ) {
        throw new Error('Bot Skill sync Base is invalid');
      }
      return {
        ...value,
        skills: [...value.skills].sort((left, right) => (
          left.localSkillId < right.localSkillId ? -1 : left.localSkillId > right.localSkillId ? 1 : 0
        )),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Bot Skill sync Base is invalid') throw error;
      throw new Error('Bot Skill sync Base cannot be read safely');
    }
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

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid Bot ID for Skill state');
  return value;
}
