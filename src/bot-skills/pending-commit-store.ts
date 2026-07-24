import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { normalizeBotSkillReferences, normalizeBotSkillSyncBaseEntries } from './canonical';
import type { BotSkillReference } from '../bot-definition/types';
import type { BotSkillSyncBaseEntry } from './types';

export const BOT_SKILL_PENDING_COMMIT_SCHEMA = 'xiaoba.bot-skill-pending-commit.v1';

export interface BotSkillPendingCommit {
  schema: typeof BOT_SKILL_PENDING_COMMIT_SCHEMA;
  kind: 'cloud_update' | 'restore';
  phase: 'prepared' | 'old_parked' | 'activated' | 'base_committed';
  botId: string;
  workspaceId: string;
  authority?: string;
  definitionETag?: string;
  cloudReferences: BotSkillReference[];
  entries: BotSkillSyncBaseEntry[];
  createdAt: string;
  updatedAt: string;
  restore?: {
    activeRoot: string;
    stagingRoot: string;
    backupRoot: string;
    hadActive: boolean;
  };
}

export class FileBotSkillPendingCommitStore {
  private readonly filePath: string;
  private readonly authority?: string;

  constructor(options: {
    runtimeRoot?: string;
    filePath?: string;
    authority?: string;
    botId?: string;
  } = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.filePath = path.resolve(
      options.filePath ?? path.join(
        runtimeRoot,
        'data',
        'bot-skill-sync-pending',
        safeScope(options.authority || 'local'),
        options.botId ? safeScope(options.botId) : '',
        'pending.json',
      ),
    );
    this.authority = cleanOptional(options.authority);
  }

  read(): BotSkillPendingCommit | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BotSkillPendingCommit;
      if (
        parsed?.schema !== BOT_SKILL_PENDING_COMMIT_SCHEMA
        || !['cloud_update', 'restore'].includes(parsed.kind)
        || !['prepared', 'old_parked', 'activated', 'base_committed'].includes(parsed.phase)
        || !parsed.botId
        || !parsed.workspaceId
        || cleanOptional(parsed.authority) !== this.authority
        || !Array.isArray(parsed.cloudReferences)
        || !Array.isArray(parsed.entries)
        || !Number.isFinite(Date.parse(parsed.createdAt))
        || !Number.isFinite(Date.parse(parsed.updatedAt))
      ) {
        throw new Error('invalid pending commit');
      }
      if (
        parsed.kind === 'restore'
        && (
          !parsed.restore
          || !path.isAbsolute(parsed.restore.activeRoot)
          || !path.isAbsolute(parsed.restore.stagingRoot)
          || !path.isAbsolute(parsed.restore.backupRoot)
        )
      ) {
        throw new Error('invalid restore pending commit');
      }
      return {
        ...parsed,
        cloudReferences: normalizeBotSkillReferences(parsed.cloudReferences),
        entries: normalizeBotSkillSyncBaseEntries(parsed.entries),
      };
    } catch {
      const error: any = new Error('Bot Skill pending commit is corrupt.');
      error.code = 'BOT_SKILL_PENDING_COMMIT_CORRUPT';
      throw error;
    }
  }

  write(pending: BotSkillPendingCommit): void {
    const normalized: BotSkillPendingCommit = {
      ...pending,
      ...(this.authority ? { authority: this.authority } : {}),
      cloudReferences: normalizeBotSkillReferences(pending.cloudReferences),
      entries: normalizeBotSkillSyncBaseEntries(pending.entries),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  delete(): void {
    fs.rmSync(this.filePath, { force: true });
  }

  getPath(): string {
    return this.filePath;
  }
}

function safeScope(value: string): string {
  return Buffer.from(String(value || '').trim(), 'utf8').toString('base64url') || 'unknown';
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}
