import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 飞书文件发送工具
 * 允许 AI 在处理过程中主动给用户发送文件
 *
 * chatId 和 sender 由 FeishuBot 在每次消息处理前动态注入
 */
export class FeishuSendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_send_file',
    description: '给老师发送一个文件。用于发送产出的文档、PPT等成果文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的文件的绝对路径',
        },
        file_name: {
          type: 'string',
          description: '文件名（含扩展名），如 "论文精读.md"',
        },
      },
      required: ['file_path', 'file_name'],
    },
  };

  private sessions = new Map<string, {
    chatId: string;
    sendFileFn: (chatId: string, filePath: string, fileName: string) => Promise<void>;
  }>();

  /**
   * 绑定当前会话的 chatId 和文件发送函数
   */
  bindSession(
    sessionId: string,
    chatId: string,
    sendFileFn: (chatId: string, filePath: string, fileName: string) => Promise<void>
  ): void {
    this.sessions.set(sessionId, { chatId, sendFileFn });
  }

  /**
   * 兼容旧调用
   */
  bind(chatId: string, sendFileFn: (chatId: string, filePath: string, fileName: string) => Promise<void>): void {
    this.bindSession('default', chatId, sendFileFn);
  }

  /**
   * 解绑（消息处理完毕后调用）
   */
  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 兼容旧调用
   */
  unbind(): void {
    this.unbindSession('default');
  }

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { file_path, file_name } = args;
    const sessionId = _context.sessionId || 'default';
    const session = this.sessions.get(sessionId);

    if (!session) {
      return '当前不在飞书会话中，无法发送文件';
    }

    if (!file_path || typeof file_path !== 'string') {
      return '文件路径不能为空';
    }

    if (!file_name || typeof file_name !== 'string') {
      return '文件名不能为空';
    }

    try {
      await session.sendFileFn(session.chatId, file_path, file_name);
      Logger.info(`[feishu_send_file] 已发送: ${file_name}`);
      return `文件 "${file_name}" 已发送`;
    } catch (err: any) {
      Logger.error(`[feishu_send_file] 发送失败: ${err.message}`);
      return `文件发送失败: ${err.message}`;
    }
  }
}
