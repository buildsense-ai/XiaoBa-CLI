import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * 显式结束当前这一轮推理，等待新的外部事件。
 * 适用于消息面会话：已经把当前该说的话说完了，或者当前先暂停。
 */
export class PauseTurnTool implements Tool {
  definition: ToolDefinition = {
    name: 'pause_turn',
    description: '显式结束当前这一轮对话推理，等待新的外部消息或后续事件。当你已经把当前该发给用户的话发完了，或者当前先暂停到这里时使用。',
    transcriptMode: 'suppress',
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '暂停原因，简短说明即可，例如 "当前回复已完成"、"后台任务继续运行"',
        },
      },
      required: [],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
    return reason
      ? `当前这一轮已暂停：${reason}`
      : '当前这一轮已暂停';
  }
}
