import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { BridgeClient } from '../bridge/bridge-client';
import { Logger } from '../utils/logger';

/**
 * 发送任务给其他 Bot 的工具
 * 通过 HTTP Bridge 实现 bot-to-bot 通信
 */
export class SendToBotTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_to_bot',
    description: '把任务派给其他 bot（如 ErGoz）。通过本地 HTTP 通信，对方 bot 会处理任务并把结果发到指定群聊。配合 feishu_mention 使用：先在群里 @对方 bot，再用此工具实际触发任务。',
    parameters: {
      type: 'object',
      properties: {
        bot_name: {
          type: 'string',
          description: '目标 bot 名称（如 "ErGoz"），需在 BOT_PEERS 中配置',
        },
        chat_id: {
          type: 'string',
          description: '目标群聊的 chat_id，bot 处理完后往这个群发结果。可从 Group/*.md 文件中查找。',
        },
        message: {
          type: 'string',
          description: '要派给对方 bot 的任务内容',
        },
      },
      required: ['bot_name', 'chat_id', 'message'],
    },
  };

  constructor(
    private client: BridgeClient,
    private selfName: string,
  ) {}

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { bot_name, chat_id, message } = args;

    if (!bot_name || !chat_id || !message) {
      return '缺少必填参数: bot_name, chat_id, message';
    }

    const result = await this.client.send(bot_name, { chat_id, message }, this.selfName);

    if (result.ok) {
      Logger.info(`[send_to_bot] 任务已派给 ${bot_name}`);
      return `任务已发送给 ${bot_name}，对方会处理后在群里回复`;
    } else {
      Logger.error(`[send_to_bot] 派任务失败: ${result.error}`);
      return `发送失败: ${result.error}`;
    }
  }
}
