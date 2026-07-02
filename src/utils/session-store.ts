import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { Logger } from './logger';
import {
  contentToText,
  stripAssistantTranscriptArtifacts,
} from './transcript-artifacts';

const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');
const SESSION_STATE_DIR = path.resolve(process.cwd(), 'data', 'session-state');

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl';
}

function filePath(key: string): string {
  return path.join(SESSIONS_DIR, keyToFilename(key));
}

function stateFilePath(key: string): string {
  return path.join(SESSION_STATE_DIR, keyToFilename(key).replace(/\.jsonl$/, '.json'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function catsCoGroupIdFromLegacyKey(key: string): string | undefined {
  const match = key.match(/^cc_group:(.+)$/);
  return match?.[1]?.trim() || undefined;
}

function newestExistingFile(files: string[]): string | undefined {
  return files
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function hasHiddenProviderReplay(message: Message): boolean {
  return Array.isArray(message.providerContent)
    && message.providerContent.some(block => (
      block?.type === 'thinking'
      || block?.type === 'redacted_thinking'
    ));
}

function summarizeHiddenReplayToolResult(message: Message): string {
  const toolName = String(message.name || 'tool').trim() || 'tool';
  return `[历史工具结果已省略；${toolName} 已完成。]`;
}

function sanitizeForPersistence(messages: Message[]): Message[] {
  const hiddenReplayToolCallIds = new Set<string>();
  const durable: Message[] = [];

  for (const message of messages) {
    if ((message as any).__injected || message.role === 'system') {
      continue;
    }

    if (message.role === 'tool' && message.tool_call_id && hiddenReplayToolCallIds.has(message.tool_call_id)) {
      durable.push({
        ...message,
        content: summarizeHiddenReplayToolResult(message),
        providerContent: undefined,
      });
      continue;
    }

    if (message.role !== 'assistant') {
      durable.push({ ...message, providerContent: undefined });
      continue;
    }

    if (hasHiddenProviderReplay(message) && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        hiddenReplayToolCallIds.add(toolCall.id);
      }
      const publicText = stripAssistantTranscriptArtifacts(contentToText(message.content));
      durable.push({
        ...message,
        content: publicText || null,
        providerContent: undefined,
      });
      continue;
    }

    if (typeof message.content === 'string') {
      const cleanedText = stripAssistantTranscriptArtifacts(message.content);
      if (cleanedText) {
        durable.push({
          ...message,
          content: cleanedText,
          providerContent: undefined,
        });
        continue;
      }
    } else if (message.content !== null) {
      durable.push({ ...message, providerContent: undefined });
      continue;
    }

    if (message.tool_calls?.length) {
      durable.push({
        ...message,
        content: null,
        providerContent: undefined,
      });
    }
  }

  return durable;
}

function serializeMessages(messages: Message[]): string {
  return messages.map(message => JSON.stringify(message)).join('\n') + '\n';
}

export interface SessionRuntimeState {
  currentDirectory?: string;
  updatedAt?: string;
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  /** 保存完整 context（覆盖写入） */
  saveContext(sessionKey: string, messages: Message[]): void {
    try {
      ensureDir();
      const fp = filePath(sessionKey);
      const lines = sanitizeForPersistence(messages)
        .map(m => JSON.stringify(m));
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      Logger.error(`保存 context 失败 [${sessionKey}]: ${err}`);
    }
  }

  /** 加载完整 context */
  loadContext(sessionKey: string): Message[] {
    try {
      const fp = filePath(sessionKey);
      if (!fs.existsSync(fp)) return [];
      const content = fs.readFileSync(fp, 'utf-8').trim();
      if (!content) return [];
      const msgs: Message[] = [];
      for (const line of content.split('\n')) {
        try { msgs.push(JSON.parse(line) as Message); }
        catch { Logger.warning(`跳过损坏的 JSONL 行 [${sessionKey}]: ${line.slice(0, 50)}`); }
      }
      const sanitized = sanitizeForPersistence(msgs);
      const migratedContent = serializeMessages(sanitized).trim();
      if (migratedContent !== content) {
        fs.writeFileSync(fp, serializeMessages(sanitized), 'utf-8');
        Logger.info(`会话已迁移清理 provider replay: ${sessionKey}`);
      }
      return sanitized;
    } catch (err) {
      Logger.error(`加载 context 失败 [${sessionKey}]: ${err}`);
      return [];
    }
  }

  /** 检查是否有会话文件 */
  hasSession(sessionKey: string): boolean {
    this.migrateCatsCoGroupSessionIfNeeded(sessionKey);
    return fs.existsSync(filePath(sessionKey));
  }

  /** 删除会话文件 */
  deleteSession(sessionKey: string): void {
    try {
      const fp = filePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      Logger.info(`会话已删除: ${sessionKey}`);
    } catch (err) {
      Logger.error(`删除会话失败 [${sessionKey}]: ${err}`);
    }
  }

  loadRuntimeState(sessionKey: string): SessionRuntimeState {
    try {
      this.migrateCatsCoGroupStateIfNeeded(sessionKey);
      const fp = stateFilePath(sessionKey);
      if (!fs.existsSync(fp)) return {};
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionRuntimeState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      Logger.error(`Failed to load session state [${sessionKey}]: ${err}`);
      return {};
    }
  }

  saveRuntimeState(sessionKey: string, state: SessionRuntimeState): void {
    try {
      if (!fs.existsSync(SESSION_STATE_DIR)) fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
      fs.writeFileSync(stateFilePath(sessionKey), JSON.stringify({
        ...state,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch (err) {
      Logger.error(`Failed to save session state [${sessionKey}]: ${err}`);
    }
  }

  deleteRuntimeState(sessionKey: string): void {
    try {
      const fp = stateFilePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (err) {
      Logger.error(`Failed to delete session state [${sessionKey}]: ${err}`);
    }
  }

  private migrateCatsCoGroupSessionIfNeeded(sessionKey: string): void {
    this.migrateCatsCoGroupFileIfNeeded(sessionKey, SESSIONS_DIR, '.jsonl');
  }

  private migrateCatsCoGroupStateIfNeeded(sessionKey: string): void {
    this.migrateCatsCoGroupFileIfNeeded(sessionKey, SESSION_STATE_DIR, '.json');
  }

  private migrateCatsCoGroupFileIfNeeded(sessionKey: string, dir: string, extension: '.jsonl' | '.json'): void {
    const groupId = catsCoGroupIdFromLegacyKey(sessionKey);
    if (!groupId) return;

    const target = extension === '.jsonl' ? filePath(sessionKey) : stateFilePath(sessionKey);
    if (fs.existsSync(target) || !fs.existsSync(dir)) return;

    const source = this.findCatsCoGroupCompatibilityFile(dir, groupId, extension);
    if (!source) return;

    try {
      if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      Logger.info(`CatsCo group session migrated to legacy key: ${path.basename(source)} -> ${path.basename(target)}`);
    } catch (err) {
      Logger.error(`Failed to migrate CatsCo group session [${sessionKey}]: ${err}`);
    }
  }

  private findCatsCoGroupCompatibilityFile(dir: string, groupId: string, extension: '.jsonl' | '.json'): string | undefined {
    const escapedGroup = escapeRegExp(groupId);
    const escapedExtension = escapeRegExp(extension);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);

    const actorV2 = new RegExp(`^session_v2_catscompany_group_${escapedGroup}_3Aactor_3A[^_]+_agent_[^_]+${escapedExtension}$`);
    const topicV2 = new RegExp(`^session_v2_catscompany_group_${escapedGroup}_agent_[^_]+${escapedExtension}$`);

    const actorSource = newestExistingFile(entries
      .filter(name => actorV2.test(name))
      .map(name => path.join(dir, name)));
    if (actorSource) return actorSource;

    return newestExistingFile(entries
      .filter(name => topicV2.test(name))
      .map(name => path.join(dir, name)));
  }
}
