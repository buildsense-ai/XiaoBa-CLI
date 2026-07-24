import * as fs from 'fs';
import * as path from 'path';
import type { BotDefinition, BotSkillReference } from '../bot-definition/types';
import { assertValidBotDefinition } from '../bot-definition/validation';
import { normalizeBotSkillReferences } from './canonical';
import {
  BotDefinitionCloudError,
  type BotDefinitionCloudClient,
  type BotDefinitionCloudReadResult,
  type BotDefinitionCloudSnapshot,
} from './definition-cloud';
import { withBotSkillWorkspaceLock } from './workspace-lock';

interface StoredFileDefinition {
  revision: number;
  definition: BotDefinition;
}

export interface FileBotDefinitionCloudClientOptions {
  root: string;
  botId: string;
}

export class FileBotDefinitionCloudClient implements BotDefinitionCloudClient {
  private readonly root: string;
  private readonly botId: string;

  constructor(options: FileBotDefinitionCloudClientOptions) {
    this.root = path.resolve(options.root);
    this.botId = normalizeBotId(options.botId);
  }

  async read(): Promise<BotDefinitionCloudReadResult> {
    const stored = this.readStored();
    return stored
      ? { kind: 'found', ...snapshot(stored) }
      : { kind: 'missing' };
  }

  async create(definition: BotDefinition): Promise<BotDefinitionCloudSnapshot> {
    return withBotSkillWorkspaceLock(this.getPath(), async () => {
      assertValidBotDefinition(definition, this.botId);
      if (this.readStored()) {
        throw new BotDefinitionCloudError(
          'Bot Definition already exists.',
          'BOT_DEFINITION_PRECONDITION_FAILED',
          412,
        );
      }
      const stored = { revision: 1, definition: structuredClone(definition) };
      this.writeStored(stored);
      return snapshot(stored);
    });
  }

  async patchSkills(
    skills: BotSkillReference[],
    ifMatch: string,
  ): Promise<BotDefinitionCloudSnapshot> {
    return withBotSkillWorkspaceLock(this.getPath(), async () => {
      const stored = this.readStored();
      if (!stored) {
        throw new BotDefinitionCloudError('Bot Definition does not exist.', 'BOT_DEFINITION_NOT_FOUND', 404);
      }
      if (ifMatch !== etagOf(stored.revision)) {
        throw new BotDefinitionCloudError(
          'Bot Definition changed since it was read.',
          'BOT_DEFINITION_PRECONDITION_FAILED',
          412,
        );
      }
      const next: StoredFileDefinition = {
        revision: stored.revision + 1,
        definition: {
          ...stored.definition,
          skills: normalizeBotSkillReferences(skills),
        },
      };
      assertValidBotDefinition(next.definition, this.botId);
      this.writeStored(next);
      return snapshot(next);
    });
  }

  getPath(): string {
    return path.join(this.root, 'bots', `${this.botId}.json`);
  }

  private readStored(): StoredFileDefinition | undefined {
    const filePath = this.getPath();
    if (!fs.existsSync(filePath)) return undefined;
    let parsed: StoredFileDefinition;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredFileDefinition;
      if (!Number.isInteger(parsed?.revision) || parsed.revision < 1) throw new Error('revision invalid');
      assertValidBotDefinition(parsed.definition, this.botId);
    } catch {
      throw new BotDefinitionCloudError(
        'Simulated Bot Definition is corrupt.',
        'BOT_DEFINITION_STORAGE_CORRUPT',
      );
    }
    return parsed;
  }

  private writeStored(stored: StoredFileDefinition): void {
    const filePath = this.getPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }
}

function snapshot(stored: StoredFileDefinition): BotDefinitionCloudSnapshot {
  return {
    definition: structuredClone(stored.definition),
    etag: etagOf(stored.revision),
  };
}

function etagOf(revision: number): string {
  return `"definition-${revision}"`;
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(value)) throw new Error('botId contains unsupported characters');
  return value;
}
