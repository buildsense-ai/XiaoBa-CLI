import * as fs from 'fs';
import * as path from 'path';

export interface BotSkillNewBotIntent {
  schema: 'xiaoba.bot-skill-new-bot-intent.v1';
  botId: string;
  authority: string;
  ownerUserId: string;
  createdAt: string;
}

export class FileBotSkillNewBotIntentStore {
  constructor(private readonly runtimeRoot: string) {}

  write(input: Omit<BotSkillNewBotIntent, 'schema' | 'createdAt'>): void {
    const intent: BotSkillNewBotIntent = {
      schema: 'xiaoba.bot-skill-new-bot-intent.v1',
      botId: clean(input.botId),
      authority: normalizeAuthority(input.authority),
      ownerUserId: clean(input.ownerUserId),
      createdAt: new Date().toISOString(),
    };
    if (!intent.botId || !intent.ownerUserId) throw new Error('New Bot intent identity is incomplete.');
    const filePath = this.getPath(intent.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  matches(input: { botId: string; authority: string; ownerUserId?: string }): boolean {
    const filePath = this.getPath(input.botId);
    if (!fs.existsSync(filePath)) return false;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BotSkillNewBotIntent;
      return Boolean(
        value?.schema === 'xiaoba.bot-skill-new-bot-intent.v1'
        && value.botId === clean(input.botId)
        && value.authority === normalizeAuthority(input.authority)
        && value.ownerUserId === clean(input.ownerUserId)
        && Date.now() - Date.parse(value.createdAt) <= 7 * 24 * 60 * 60 * 1000,
      );
    } catch {
      return false;
    }
  }

  delete(botId: string): void {
    fs.rmSync(this.getPath(botId), { force: true });
  }

  private getPath(botId: string): string {
    const key = Buffer.from(clean(botId), 'utf8').toString('base64url');
    if (!key) throw new Error('botId is required');
    return path.join(
      path.resolve(this.runtimeRoot),
      'data',
      'bot-skills',
      'new-bot-intents',
      `${key}.json`,
    );
  }
}

function normalizeAuthority(value: string): string {
  return new URL(String(value || '').trim()).origin.toLowerCase();
}

function clean(value: unknown): string {
  return String(value || '').trim();
}
