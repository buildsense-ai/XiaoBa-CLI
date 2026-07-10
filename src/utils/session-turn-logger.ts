import * as fs from 'fs';
import * as path from 'path';
import { Message, ContentBlock } from '../types';
import type {
  SessionLogEntry,
  SessionPromptTraceLogEntry,
  SessionPromptTurnLog,
  SessionRuntimeLogEntry,
  SessionRuntimeLogEvent,
  SessionSubAgentEventLogEntry,
  SessionToolCallLog,
  SessionTurnLogEntry,
} from './session-log-schema';
import type { SubAgentRuntimeEvent } from '../core/sub-agent-events';
import type { SubAgentInfo } from '../core/sub-agent-session';
import type { PromptTraceSnapshot } from './prompt-observability';
import { PathResolver } from './path-resolver';

export type {
  LegacySessionTurnLogEntry,
  ParsedSessionLogEntry,
  SessionLogEntry,
  SessionPromptTurnLog,
  SessionRuntimeLogEntry,
  SessionRuntimeLogEvent,
  SessionSubAgentEventLogEntry,
  SessionToolCallLog,
  SessionTurnLogEntry,
} from './session-log-schema';

const SESSION_LOG_DIR = PathResolver.getLogsPath('sessions');
const MAX_TOOL_RESULT_LENGTH = parseOptionalLimit(process.env.XIAOBA_SESSION_TOOL_RESULT_LIMIT);
const MAX_RUNTIME_FEEDBACK_LENGTH = Number(process.env.XIAOBA_SESSION_RUNTIME_FEEDBACK_LIMIT || 4000);

function parseOptionalLimit(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export interface LogTurnOptions {
  runtimeFeedback?: string[];
  runtimeObservationSource?: string;
  episodeId?: string;
  prompt?: SessionPromptTurnLog;
}

/**
 * SessionTurnLogger - 记录每轮对话的完整交互
 *
 * 默认开启，永久保留，用于分析、日报生成、skill 提取
 */
export class SessionTurnLogger {
  private sessionType: string;
  private sessionId: string;
  private logFilePath: string;
  private turnCounter = 0;

  constructor(sessionType: string, sessionId: string) {
    this.sessionType = sessionType;
    this.sessionId = sessionId;

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dir = path.join(SESSION_LOG_DIR, sessionType, dateStr);

    fs.mkdirSync(dir, { recursive: true });
    const safeSessionId = sessionId.replace(/[:<>"|?*]/g, '_');
    this.logFilePath = path.join(dir, `${sessionType}_${safeSessionId}.jsonl`);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  /**
   * 记录一轮对话
   */
  logTurn(
    userInput: string | ContentBlock[],
    assistantText: string,
    toolCalls: SessionToolCallLog[],
    tokens: { prompt: number; completion: number },
    options: LogTurnOptions = {},
  ): void {
    this.turnCounter++;

    const userText = this.extractText(userInput);
    const userImages = this.extractImages(userInput);
    const runtimeFeedback = (options.runtimeFeedback || [])
      .filter(Boolean)
      .map(feedback => this.truncate(feedback, MAX_RUNTIME_FEEDBACK_LENGTH));

    const turnLog: SessionTurnLogEntry = {
      entry_type: 'turn',
      turn: this.turnCounter,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      ...(options.episodeId && { episode_id: options.episodeId }),
      session_type: this.sessionType,
      user: {
        text: userText,
        ...(userImages.length > 0 && { images: userImages }),
        ...(runtimeFeedback.length > 0 && { runtime_feedback: runtimeFeedback }),
        ...(options.runtimeObservationSource && { runtime_observation_source: options.runtimeObservationSource }),
      },
      assistant: {
        text: assistantText,
        tool_calls: toolCalls.map(tc => ({
          ...tc,
          result: this.truncate(tc.result, MAX_TOOL_RESULT_LENGTH),
        })),
      },
      tokens,
      ...(options.prompt && { prompt: options.prompt }),
    };

    this.appendLog(turnLog);
  }

  logPromptTrace(snapshot: PromptTraceSnapshot): void {
    const entry: SessionPromptTraceLogEntry = {
      entry_type: 'prompt_trace',
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
      prompt: snapshot,
    };
    this.appendLog(entry);
  }

  logRuntime(level: string, message: string, event?: SessionRuntimeLogEvent): void {
    const runtimeEntry: SessionRuntimeLogEntry = {
      entry_type: 'runtime',
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
      level,
      message,
      ...(event && { event }),
    };
    this.appendLog(runtimeEntry);
  }

  logSubAgentEvent(event: SubAgentRuntimeEvent, info?: SubAgentInfo): void {
    const entry: SessionSubAgentEventLogEntry = {
      entry_type: 'subagent_event',
      timestamp: new Date(event.timestamp).toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
      subagent: {
        id: event.subAgentId,
        ...(event.subAgentName && { name: event.subAgentName }),
        ...(info?.agentType && { type: info.agentType }),
        ...(info?.status && { status: info.status }),
        seq: event.seq,
      },
      event: {
        type: event.type,
        summary: this.truncate(event.summary, MAX_RUNTIME_FEEDBACK_LENGTH),
        ...(event.payload && { payload: event.payload }),
      },
    };
    this.appendLog(entry);
  }

  private extractText(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');
  }

  private extractImages(content: string | ContentBlock[]): string[] {
    if (typeof content === 'string') return [];
    return content
      .filter(block => block.type === 'image')
      .map((block, idx) => `image_${idx}`);
  }

  private truncate(text: string, maxLength: number | null): string {
    if (maxLength === null) return text;
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '... [truncated]';
  }

  private appendLog(entry: SessionLogEntry): void {
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n');
    } catch (error) {
      // 日志写入失败不影响主流程
      console.error('[SessionTurnLogger] Failed to write log:', error);
    }
  }
}
