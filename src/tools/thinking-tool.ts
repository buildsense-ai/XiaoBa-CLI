import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * Thinking 工具 - 用于 AI 内部推理
 *
 * 在 message-based mode 中，AI 可以通过此工具记录思考过程。
 * thinking 内容不会发送给用户，但会保留在 session 历史中，
 * 让 AI 能够回顾自己的推理过程。
 */
export class ThinkingTool implements Tool {
  definition: ToolDefinition = {
    name: 'thinking',
    description: `内部推理工具，记录思考过程（用户看不到）。

使用场景：
- 分析问题、规划步骤
- 权衡方案、中间推理
- 任何不需要用户看到的思考过程

重要规则：
- thinking 内容不会发送给用户
- 可以多次调用逐步推理
- 只有最终不调用任何工具时，你的文本才会发给用户
- thinking 会保留在对话历史中，你能看到自己的推理过程`,

    transcriptMode: 'default',

    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '思考内容',
        },
      },
      required: ['content'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { content } = args;

    if (!content || typeof content !== 'string') {
      return '思考内容不能为空';
    }

    Logger.info(`[thinking] ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`);

    return '继续推理';
  }
}
