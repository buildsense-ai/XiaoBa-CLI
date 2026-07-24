import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { normalizeBotSkillSyncBaseEntries } from './canonical';
import {
  BOT_SKILL_SYNC_BASE_SCHEMA,
  type BotSkillSyncBase,
  type BotSkillSyncBaseReadResult,
} from './types';

export interface FileBotSkillSyncBaseStoreOptions {
  runtimeRoot?: string;
  root?: string;
  authority?: string;
}

export class FileBotSkillSyncBaseStore {
  private readonly root: string;
  private readonly authority?: string;

  constructor(options: FileBotSkillSyncBaseStoreOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.authority = cleanOptional(options.authority);
    const scope = authorityScope(this.authority);
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, 'data', 'bot-skill-sync-base', scope));
  }

  read(botId: string, expectedWorkspaceId?: string): BotSkillSyncBaseReadResult {
    const filePath = this.getPath(botId);
    if (!fs.existsSync(filePath)) return { kind: 'missing' };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BotSkillSyncBase;
      const base = validateBase(parsed, normalizeBotId(botId), this.authority);
      if (expectedWorkspaceId && base.workspaceId !== expectedWorkspaceId) {
        throw new Error('Bot Skill sync base belongs to another workspace.');
      }
      return { kind: 'valid', base };
    } catch (error: any) {
      return { kind: 'corrupt', error: error?.message || String(error) };
    }
  }

  write(base: BotSkillSyncBase): void {
    const normalized = validateBase(base, normalizeBotId(base.botId), this.authority);
    const filePath = this.getPath(normalized.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Some mounted filesystems do not expose POSIX modes.
      }
    }
  }

  getPath(botId: string): string {
    return path.join(this.root, `${normalizeBotId(botId)}.json`);
  }
}

function validateBase(
  value: BotSkillSyncBase,
  expectedBotId: string,
  expectedAuthority?: string,
): BotSkillSyncBase {
  if (
    value?.schema !== BOT_SKILL_SYNC_BASE_SCHEMA
    || value.botId !== expectedBotId
    || !validId(value.workspaceId)
    || !Array.isArray(value.entries)
    || !Number.isFinite(Date.parse(String(value.updatedAt || '')))
  ) {
    throw new Error('Bot Skill sync base is invalid.');
  }
  const authority = cleanOptional(value.authority);
  if (authority !== expectedAuthority) {
    throw new Error('Bot Skill sync base belongs to another authority.');
  }
  const definitionETag = cleanOptional(value.definitionETag);
  if (definitionETag && (!/^"[^"\r\n]{1,200}"$/.test(definitionETag) || definitionETag.startsWith('W/'))) {
    throw new Error('Bot Skill sync base ETag is invalid.');
  }
  return {
    schema: BOT_SKILL_SYNC_BASE_SCHEMA,
    botId: expectedBotId,
    workspaceId: value.workspaceId,
    ...(authority ? { authority } : {}),
    ...(definitionETag ? { definitionETag } : {}),
    entries: normalizeBotSkillSyncBaseEntries(value.entries),
    updatedAt: value.updatedAt,
  };
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(value)) throw new Error('botId contains unsupported characters');
  return value;
}

function validId(value: unknown): boolean {
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(String(value || ''));
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function authorityScope(authority?: string): string {
  if (!authority) return 'default';
  return `authority-${crypto.createHash('sha256').update(authority).digest('hex').slice(0, 24)}`;
}
