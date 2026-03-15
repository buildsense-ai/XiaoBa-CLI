import * as fs from 'fs';
import * as path from 'path';
import { Message, ContentBlock } from '../types';

const SESSION_LOG_DIR = path.resolve('logs/sessions');

interface TurnLog {
  turn: number;
  timestamp: string;
  session_id: string;
  session_type: string;
  user: {
    text: string;
    images?: string[];
  };
  assistant: {
    text: string;
    tool_calls: ToolCallLog[];
  };
  tokens: {
    prompt: number;
    completion: number;
  };
}

interface ToolCallLog {
  id: string;
  name: string;
  arguments: any;
  result: string;
  duration_ms?: number;
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
    this.logFilePath = path.join(dir, `${sessionId}.jsonl`);
  }

  /**
   * 记录一轮对话
   */
  logTurn(
    userInput: string | ContentBlock[],
    assistantText: string,
    toolCalls: ToolCallLog[],
    tokens: { prompt: number; completion: number }
  ): void {
    this.turnCounter++;

    const userText = this.extractText(userInput);
    const userImages = this.extractImages(userInput);

    const turnLog: TurnLog = {
      turn: this.turnCounter,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      session_type: this.sessionType,
      user: {
        text: userText,
        ...(userImages.length > 0 && { images: userImages }),
      },
      assistant: {
        text: assistantText,
        tool_calls: toolCalls.map(tc => ({
          ...tc,
          result: this.truncate(tc.result, 1000),
        })),
      },
      tokens,
    };

    this.appendLog(turnLog);
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

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '... [truncated]';
  }

  private appendLog(entry: any): void {
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n');
    } catch (error) {
      // 日志写入失败不影响主流程
      console.error('[SessionTurnLogger] Failed to write log:', error);
    }
  }
}
