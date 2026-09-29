import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { Logger } from './logger';
import {
  contentToText,
  stripAssistantTranscriptArtifacts,
} from './transcript-artifacts';
import { PathResolver } from './path-resolver';

const SESSIONS_DIR = PathResolver.getDataPath('sessions');
const SESSION_STATE_DIR = PathResolver.getDataPath('session-state');

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
      || block?.type === 'openai_reasoning'
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
        providerState: undefined,
      });
      continue;
    }

    if (message.role !== 'assistant') {
      durable.push({ ...message, providerContent: undefined, providerState: undefined });
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
        providerState: undefined,
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
          providerState: undefined,
        });
        continue;
      }
    } else if (message.content !== null) {
      durable.push({ ...message, providerContent: undefined, providerState: undefined });
      continue;
    }

    if (message.tool_calls?.length) {
      durable.push({
        ...message,
        content: null,
        providerContent: undefined,
        providerState: undefined,
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
  remoteContextCursors?: Record<string, number>;
  updatedAt?: string;
  /**
   * Set while a conversation turn has not reached a terminal state because the
   * worker process died (OOM killer, host reboot). Cleared on every terminal
   * outcome — including the user's own /stop — so the next start() only
   * resumes turns nobody finished on purpose.
   */
  interruptedTurn?: InterruptedTurnState;
}

export interface InterruptedTurnState {
  /** Conversation topic the turn belonged to, used to reply in the right place. */
  topic: string;
  /** Why the turn stopped: currently 'oom-kill' (SIGKILL from the kernel). */
  reason: string;
  /** Last known recipient, so the resume notice reaches the same conversation. */
  senderId?: string;
  /**
   * The session key this marker belongs to.
   *
   * Stored explicitly because keyToFilename() maps every character outside
   * [a-zA-Z0-9_-] to '_', which is lossy: 'cc_user:usr38' becomes
   * 'cc_user_usr38' and 'session:v2:...' loses every separator, so the key
   * cannot be reconstructed from the file name. Recovery has to load the exact
   * conversation, so it reads the key from here.
   */
  sessionKey?: string;
  /** ISO timestamp of the interruption; recovery ignores markers older than the window. */
  startedAt: string;
  /** How many times this interruption has already been auto-resumed. */
  attempts: number;
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  /** 保存完整 context（覆盖写入）；返回是否真实落盘成功。 */
  saveContext(sessionKey: string, messages: Message[]): boolean {
    try {
      ensureDir();
      const fp = filePath(sessionKey);
      const lines = sanitizeForPersistence(messages)
        .map(m => JSON.stringify(m));
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
      return true;
    } catch (err) {
      Logger.error(`保存 context 失败 [${sessionKey}]: ${err}`);
      return false;
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

  /** 删除会话文件；返回是否真实删除成功或本就不存在。 */
  deleteSession(sessionKey: string): boolean {
    try {
      const fp = filePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      Logger.info(`会话已删除: ${sessionKey}`);
      return true;
    } catch (err) {
      Logger.error(`删除会话失败 [${sessionKey}]: ${err}`);
      return false;
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

  saveRuntimeState(sessionKey: string, state: SessionRuntimeState): boolean {
    try {
      if (!fs.existsSync(SESSION_STATE_DIR)) fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
      const target = stateFilePath(sessionKey);
      const payload = JSON.stringify({
        ...state,
        updatedAt: new Date().toISOString(),
      }, null, 2);
      // Write-then-rename: the interruption marker is written by a process the
      // kernel is already killing, and this file also carries the remote
      // context cursors. Overwriting in place means a kill mid-write leaves a
      // truncated file, which loses the marker (recovery silently never fires)
      // and the cursors (history has to be re-pulled). rename() is atomic
      // within a directory, so a reader sees either the old file or the
      // complete new one, never a half-written one.
      //
      // Sweep earlier staging files first. A kill between writeFileSync() and
      // renameSync() is exactly the event this file is written for, so those
      // leftovers are expected rather than exceptional: without this they
      // accumulate one per crash forever. The scan ignores them (they do not
      // end in .json), so this is hygiene, not correctness.
      this.removeStaleStagingFiles(target);
      const temp = `${target}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temp, payload, 'utf-8');
        fs.renameSync(temp, target);
      } catch (writeError) {
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch { /* best effort */ }
        throw writeError;
      }
      return true;
    } catch (err) {
      Logger.error(`Failed to save session state [${sessionKey}]: ${err}`);
      return false;
    }
  }

  /**
   * Removes `<target>.<pid>.tmp` files left by writes that never reached their
   * rename. Best-effort: a stale file is harmless, so failures are ignored.
   */
  private removeStaleStagingFiles(target: string): void {
    const dir = path.dirname(target);
    const stem = `${path.basename(target)}.`;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(stem) || !name.endsWith('.tmp')) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch { /* best effort */ }
    }
  }

  deleteRuntimeState(sessionKey: string): boolean {
    try {
      const fp = stateFilePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return true;
    } catch (err) {
      Logger.error(`Failed to delete session state [${sessionKey}]: ${err}`);
      return false;
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

    const actorV2Encoded = new RegExp(`^session_v2_catscompany_group_${escapedGroup}_3Aactor_3A.+_agent_.+${escapedExtension}$`);
    const actorV2Plain = new RegExp(`^session_v2_catscompany_group_${escapedGroup}_actor_.+_agent_.+${escapedExtension}$`);
    const topicV2 = new RegExp(`^session_v2_catscompany_group_${escapedGroup}_agent_[^_]+${escapedExtension}$`);

    const actorSource = newestExistingFile(entries
      .filter(name => actorV2Encoded.test(name) || actorV2Plain.test(name))
      .map(name => path.join(dir, name)));
    if (actorSource) return actorSource;

    return newestExistingFile(entries
      .filter(name => topicV2.test(name))
      .map(name => path.join(dir, name)));
  }
}
