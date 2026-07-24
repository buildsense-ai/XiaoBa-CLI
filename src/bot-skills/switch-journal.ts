import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';

export const BOT_SKILL_SWITCH_JOURNAL_SCHEMA = 'xiaoba.bot-skill-switch-journal.v1';

export type BotSkillSwitchPhase =
  | 'PREPARING_TARGET'
  | 'OLD_CONNECTOR_STOPPED'
  | 'PARKING_OLD'
  | 'OLD_WORKSPACE_PARKED'
  | 'ACTIVATING_TARGET'
  | 'TARGET_ACTIVATED'
  | 'TARGET_PREFLIGHT_OK'
  | 'COMMITTING_BINDING'
  | 'BINDING_COMMITTED'
  | 'COMMITTED';

export interface BotSkillSwitchJournal {
  schema: typeof BOT_SKILL_SWITCH_JOURNAL_SCHEMA;
  transactionId: string;
  phase: BotSkillSwitchPhase;
  fromBotId: string;
  fromWorkspaceId: string;
  toBotId: string;
  toWorkspaceId?: string;
  oldConnectorWasRunning?: boolean;
  activeRoot: string;
  fromParkedRoot: string;
  targetPreparedRoot: string;
  startedAt: string;
  updatedAt: string;
}

export class FileBotSkillSwitchJournalStore {
  private readonly filePath: string;

  constructor(options: { runtimeRoot?: string; filePath?: string } = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.filePath = path.resolve(
      options.filePath ?? path.join(runtimeRoot, 'data', 'bot-skill-switch', 'journal.json'),
    );
  }

  read(): BotSkillSwitchJournal | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    let value: BotSkillSwitchJournal;
    try {
      value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BotSkillSwitchJournal;
    } catch {
      throw journalError('Bot Skill switch journal is corrupt.', 'BOT_SKILL_SWITCH_JOURNAL_CORRUPT');
    }
    if (
      value?.schema !== BOT_SKILL_SWITCH_JOURNAL_SCHEMA
      || !value.transactionId
      || !isPhase(value.phase)
      || !value.fromBotId
      || !value.fromWorkspaceId
      || !value.toBotId
      || !path.isAbsolute(value.activeRoot)
      || !path.isAbsolute(value.fromParkedRoot)
      || !path.isAbsolute(value.targetPreparedRoot)
      || !Number.isFinite(Date.parse(value.startedAt))
      || !Number.isFinite(Date.parse(value.updatedAt))
    ) {
      throw journalError('Bot Skill switch journal is invalid.', 'BOT_SKILL_SWITCH_JOURNAL_CORRUPT');
    }
    return value;
  }

  write(journal: BotSkillSwitchJournal): void {
    const filePath = this.filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, filePath);
  }

  delete(): void {
    fs.rmSync(this.filePath, { force: true });
  }

  getPath(): string {
    return this.filePath;
  }
}

function isPhase(value: string): value is BotSkillSwitchPhase {
  return [
    'PREPARING_TARGET',
    'OLD_CONNECTOR_STOPPED',
    'PARKING_OLD',
    'OLD_WORKSPACE_PARKED',
    'ACTIVATING_TARGET',
    'TARGET_ACTIVATED',
    'TARGET_PREFLIGHT_OK',
    'COMMITTING_BINDING',
    'BINDING_COMMITTED',
    'COMMITTED',
  ].includes(value);
}

function journalError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}
