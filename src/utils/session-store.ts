import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { Logger } from './logger';

const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');
const SESSION_STATE_DIR = path.resolve(process.cwd(), 'data', 'session-state');
const PROVIDER_REPLAY_PLACEHOLDER_LINE =
  /^\[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。.*\]$/;
const PROVIDER_REPLAY_RESULT_SUMMARY_HEADER = '[历史工具结果摘要]';

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

function hasHiddenProviderReplay(message: Message): boolean {
  return Array.isArray(message.providerContent)
    && message.providerContent.some(block => (
      block?.type === 'thinking'
      || block?.type === 'redacted_thinking'
    ));
}

function contentToText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

function stripProviderReplayArtifacts(text: string): string {
  const summaryIndex = text.indexOf(PROVIDER_REPLAY_RESULT_SUMMARY_HEADER);
  const withoutSummaries = summaryIndex >= 0 ? text.slice(0, summaryIndex) : text;
  return withoutSummaries
    .split(/\r?\n/)
    .filter(line => !PROVIDER_REPLAY_PLACEHOLDER_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeForPersistence(messages: Message[]): Message[] {
  const hiddenReplayToolCallIds = new Set<string>();
  const durable: Message[] = [];

  for (const message of messages) {
    if ((message as any).__injected || message.role === 'system') {
      continue;
    }

    if (message.role === 'tool' && message.tool_call_id && hiddenReplayToolCallIds.has(message.tool_call_id)) {
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
      const publicText = stripProviderReplayArtifacts(contentToText(message.content));
      if (publicText) {
        durable.push({
          ...message,
          content: publicText,
          tool_calls: undefined,
          providerContent: undefined,
        });
      }
      continue;
    }

    if (typeof message.content === 'string') {
      const cleanedText = stripProviderReplayArtifacts(message.content);
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
}
