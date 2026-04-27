import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 文件发送工具（平台通用）
 * 允许 AI 在处理过程中主动给用户发送文件
 *
 * 发送能力通过 ToolExecutionContext.channel 注入，无需 bind/unbind。
 */
export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: `发送文件给用户（用于详细报告、长分析）。

使用场景：
- 内容超过 1000 字的详细报告或分析
- 包含大量数据、代码、详细说明
- 发送文件后，只需用 reply 工具简短说明"详情看文件"即可

避免在聊天中发送大段文字，改用文件。`,
    transcriptMode: 'outbound_file',
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

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { file_path, file_name } = args;
    const channel = context.channel;

    if (!channel) {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '当前不在聊天会话中，无法发送文件' };
    }

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '文件路径不能为空' };
    }

    if (!file_name || typeof file_name !== 'string') {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '文件名不能为空' };
    }

    try {
      await channel.sendFile(channel.chatId, file_path, file_name);
      Logger.info(`[send_file] 已发送: ${file_name}`);
      return { ok: true, content: `文件 "${file_name}" 已发送` };
    } catch (error: any) {
      Logger.error(`文件发送失败 (sendFile): ${error.message}`);
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `文件发送失败: ${error.message}` };
    }
  }
}
