import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { BridgeClient } from '../bridge/bridge-client';
import { Logger } from '../utils/logger';

/**
 * 飞书 @人 工具
 * 允许 AI 在群聊中 @指定用户 发送消息
 *
 * chatId 和 sender 由 FeishuBot 在每次消息处理前动态注入
 */
export class FeishuMentionTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_mention',
    description: '在飞书群聊中 @指定用户 发送消息。需要提供用户的 open_id。可同时 @多个用户。支持跨群发送：指定 chat_id 可往其他群聊发消息（chat_id 可从 Group/*.md 文件中查找）。',
    parameters: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: '目标群聊的 chat_id（如 oc_xxx）。不传则发送到当前会话的群聊。跨群发送时必填，可从 Group/*.md 文件中查找。',
        },
        mentions: {
          type: 'array',
          description: '要 @的用户列表',
          items: {
            type: 'object',
            properties: {
              open_id: {
                type: 'string',
                description: '用户的 open_id（如 ou_xxx），可从收到的消息 mentions 中获取',
              },
              name: {
                type: 'string',
                description: '用户显示名称（如"张三"），不确定可填"用户"',
              },
            },
            required: ['open_id', 'name'],
          },
        },
        message: {
          type: 'string',
          description: '要发送的消息内容（@标记会自动加在消息前面）',
        },
      },
      required: ['mentions', 'message'],
    },
  };

  private sessions = new Map<string, {
    chatId: string;
    sendFn: (chatId: string, text: string) => Promise<void>;
  }>();

  private bridgeClient: BridgeClient | null = null;
  private bridgeSelfName: string = '';

  bindSession(sessionId: string, chatId: string, sendFn: (chatId: string, text: string) => Promise<void>): void {
    this.sessions.set(sessionId, { chatId, sendFn });
  }

  /**
   * 绑定 Bot Bridge，@bot peer 时自动通过 Bridge 派任务
   */
  bindBridge(client: BridgeClient, selfName: string): void {
    this.bridgeClient = client;
    this.bridgeSelfName = selfName;
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { mentions, message, chat_id } = args;
    const sessionId = _context.sessionId || 'default';
    const session = this.sessions.get(sessionId);

    if (!session) {
      return '当前不在飞书会话中，无法发送消息';
    }

    if (!mentions || !Array.isArray(mentions) || mentions.length === 0) {
      return '请提供至少一个要 @的用户';
    }

    if (!message || typeof message !== 'string') {
      return '消息内容不能为空';
    }

    const targetChatId = chat_id || session.chatId;

    // 构造 @标记：飞书文本消息格式 <at user_id="ou_xxx">名字</at>
    const atTags = mentions
      .map((m: { open_id: string; name: string }) => `<at user_id="${m.open_id}">${m.name}</at>`)
      .join(' ');

    const fullText = `${atTags} ${message}`;

    try {
      await session.sendFn(targetChatId, fullText);
      const names = mentions.map((m: { name: string }) => m.name).join(', ');
      const dest = chat_id ? ` -> ${chat_id}` : '';
      Logger.info(`[feishu_mention${dest}] 已发送 @${names}: ${message.slice(0, 50)}...`);

      // 自动通过 Bridge 派任务给 bot peer
      const bridgeResults: string[] = [];
      if (this.bridgeClient) {
        const peerNames = this.bridgeClient.getPeerNames();
        for (const m of mentions as { open_id: string; name: string }[]) {
          if (peerNames.includes(m.name)) {
            const result = await this.bridgeClient.send(m.name, { chat_id: targetChatId, message }, this.bridgeSelfName);
            if (result.ok) {
              bridgeResults.push(`已通过 Bridge 派任务给 ${m.name}`);
              Logger.info(`[feishu_mention] 自动派任务给 ${m.name} via Bridge`);
            } else {
              bridgeResults.push(`Bridge 派任务给 ${m.name} 失败: ${result.error}`);
              Logger.error(`[feishu_mention] Bridge 派任务给 ${m.name} 失败: ${result.error}`);
            }
          }
        }
      }

      const base = `消息已发送，已 @${names}`;
      return bridgeResults.length > 0 ? `${base}\n${bridgeResults.join('\n')}` : base;
    } catch (err: any) {
      Logger.error(`[feishu_mention] 发送失败: ${err.message}`);
      return `发送失败: ${err.message}`;
    }
  }
}
